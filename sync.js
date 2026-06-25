require("dotenv").config();
const fs = require("fs");

const SHOPIFY_STORE         = "e1c5f3-7e.myshopify.com";
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const TW_API_KEY            = process.env.TW_API_KEY;
const SSK_API_KEY           = process.env.SSK_API_KEY;

// ── SKU master — maps ShipSidekick SKU → product info ──────────────────────
// SSK is source of truth for inventory; Shopify SKU used for sales velocity
const PRODUCTS = [
  { name:"Bio Collagen Mask",  sskSku:"GLOWUP-ORIGINAL-QUAS", shopifySku:"QUASI-GLOWUP-OG",     dropship:false },
  { name:"Salmon PDRM Mask",   sskSku:"SALMON-MASK-QUAS",     shopifySku:"QUASI-GLOWUP-SALMON",  dropship:false },
  { name:"Neck Mask",          sskSku:"NECK-QUAS",             shopifySku:"199284415690",          dropship:false },
  { name:"Night Sealing Mask", sskSku:"SEALING-OIL-QUAS",     shopifySku:"25341366",              dropship:false },
  { name:"Chest Mask",         sskSku:"CHEST-QUAS",            shopifySku:"199284450646",          dropship:false },
  { name:"Multi Balm Stick",   sskSku:null,                    shopifySku:null,                    dropship:true  },
  { name:"Eye Patches",        sskSku:null,                    shopifySku:null,                    dropship:true  },
];

const LEAD_TIME_PKG_READY  = 9;   // weeks
const LEAD_TIME_NO_PKG     = 11;  // weeks
const SAFETY_STOCK_DAYS    = 21;
const TARGET_COVERAGE_DAYS = 90;

function log(msg){ console.log(`[${new Date().toISOString()}] ${msg}`); }

function todayStr(){
  // Use ET timezone for "today"
  return new Date().toLocaleDateString("en-CA", {timeZone:"America/New_York"});
}
function daysAgoStr(n){
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("en-CA", {timeZone:"America/New_York"});
}
function startOfTodayET(){
  const d = new Date().toLocaleDateString("en-CA", {timeZone:"America/New_York"});
  return d + "T00:00:00-04:00"; // ET offset
}

// ── Shopify auth ─────────────────────────────────────────────────────────────
let _token = null;
async function getToken(){
  if(_token) return _token;
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`,{
    method:"POST",
    headers:{"Content-Type":"application/json",
      "Authorization":"Basic "+Buffer.from(`${SHOPIFY_CLIENT_ID}:${SHOPIFY_CLIENT_SECRET}`).toString("base64")},
    body:JSON.stringify({client_id:SHOPIFY_CLIENT_ID,client_secret:SHOPIFY_CLIENT_SECRET,grant_type:"client_credentials"}),
  });
  if(!res.ok){ _token=SHOPIFY_CLIENT_SECRET; return _token; }
  const d=await res.json(); _token=d.access_token; return _token;
}

async function shopifyREST(path){
  const token = await getToken();
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04${path}`,{
    headers:{"X-Shopify-Access-Token":token,"Content-Type":"application/json"},
  });
  if(!res.ok) throw new Error(`Shopify ${res.status}: ${path}`);
  return res.json();
}

// ── ShipSidekick inventory (source of truth) ─────────────────────────────────
async function getSSKInventory(){
  log("Fetching ShipSidekick inventory...");
  try{
    const res = await fetch("https://www.shipsidekick.com/api/v1/inventory",{
      headers:{"Authorization":`Bearer ${SSK_API_KEY}`,"Content-Type":"application/json"},
    });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = Array.isArray(data) ? data : (data?.inventory ?? data?.items ?? data?.products ?? []);
    const inv = {};
    for(const item of items){
      const sku = item.sku ?? item.SKU ?? item.product_sku ?? item.productSku;
      // Use "available" as primary, fall back to on_hand
      const qty = item.available ?? item.Available ?? item.quantity ?? item.onHand ?? item.on_hand ?? 0;
      if(sku) inv[sku] = Math.max(0, qty); // never show negative
    }
    log(`SSK inventory: ${Object.keys(inv).length} SKUs`);
    return inv;
  }catch(e){
    log(`SSK error (non-fatal): ${e.message}`);
    return null;
  }
}

async function getSSKInbound(){
  log("Fetching ShipSidekick inbound POs...");
  try{
    const res = await fetch("https://www.shipsidekick.com/api/v1/purchase-orders",{
      headers:{"Authorization":`Bearer ${SSK_API_KEY}`,"Content-Type":"application/json"},
    });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const orders = Array.isArray(data) ? data : (data?.purchaseOrders ?? data?.orders ?? []);
    return orders
      .filter(o=>["pending","in_transit","shipped","open"].includes((o.status??"").toLowerCase()))
      .map(o=>({
        poNumber:    o.poNumber ?? o.po_number ?? o.id,
        status:      o.status,
        qty:         o.totalQuantity ?? o.quantity ?? 0,
        expectedDate:o.expectedDate ?? o.expected_date ?? o.eta,
      }));
  }catch(e){
    log(`SSK inbound error (non-fatal): ${e.message}`);
    return [];
  }
}

// ── Shopify orders — today ────────────────────────────────────────────────────
async function getShopifyOrdersToday(){
  log("Fetching Shopify orders today...");
  // Use ET start of day
  const since = startOfTodayET();
  const data = await shopifyREST(
    `/orders.json?status=any&financial_status=paid&created_at_min=${encodeURIComponent(since)}&limit=250&fields=id,total_price,line_items,tags`
  );
  let orders=0, revenue=0, units=0, preorders=0;
  const skuSalesToday = {};
  for(const o of data.orders){
    orders++;
    revenue += parseFloat(o.total_price||0);
    if((o.tags||"").toLowerCase().includes("pre-order")) preorders++;
    for(const item of o.line_items){
      units += item.quantity;
      if(!item.sku) continue;
      if(!skuSalesToday[item.sku]) skuSalesToday[item.sku]={units:0,revenue:0};
      skuSalesToday[item.sku].units += item.quantity;
      skuSalesToday[item.sku].revenue += item.quantity*parseFloat(item.price||0);
    }
  }
  log(`Today: ${orders} orders, $${revenue.toFixed(2)}, ${units} units`);
  return {ordersToday:orders, revenueToday:Math.round(revenue), unitsToday:units, preOrdersPending:preorders, skuSalesToday};
}

// ── Shopify orders — last 7 days (for velocity) ───────────────────────────────
async function getShopifyOrders7d(){
  log("Fetching Shopify orders (7d velocity)...");
  const since = daysAgoStr(7);
  const data = await shopifyREST(
    `/orders.json?status=any&financial_status=paid&created_at_min=${since}T00:00:00-04:00&limit=250&fields=id,total_price,line_items`
  );
  const skuSales7d = {};
  for(const o of data.orders){
    for(const item of o.line_items){
      if(!item.sku) continue;
      if(!skuSales7d[item.sku]) skuSales7d[item.sku]={units:0,revenue:0};
      skuSales7d[item.sku].units += item.quantity;
      skuSales7d[item.sku].revenue += item.quantity*parseFloat(item.price||0);
    }
  }
  log(`7d sales: ${Object.keys(skuSales7d).length} SKUs with sales`);
  return skuSales7d;
}

// ── Triple Whale ──────────────────────────────────────────────────────────────
async function getTripleWhale(){
  log("Fetching Triple Whale...");
  try{
    // Try summary stats endpoint
    const res = await fetch("https://api.triplewhale.com/api/v2/tw-metrics/get-metrics-data",{
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":TW_API_KEY},
      body:JSON.stringify({
        shopDomain: SHOPIFY_STORE,
        startDate:  todayStr(),
        endDate:    todayStr(),
        metrics:["blended-roas","total-spend","net-revenue","orders","blended-sales"],
      }),
    });
    if(!res.ok) throw new Error(`TW HTTP ${res.status}`);
    const d = await res.json();
    log(`TW: ROAS=${d?.["blended-roas"]}, spend=${d?.["total-spend"]}`);
    return {
      blendedROAS:   d?.["blended-roas"]   ?? null,
      totalSpend:    d?.["total-spend"]    ?? null,
      netRevenue:    d?.["net-revenue"]    ?? null,
      blendedSales:  d?.["blended-sales"]  ?? null,
    };
  }catch(e){
    log(`TW error (non-fatal): ${e.message}`);
    return {blendedROAS:null,totalSpend:null,netRevenue:null,blendedSales:null};
  }
}

// ── Calculations ──────────────────────────────────────────────────────────────
function calcProducts(sskInv, skuSales7d, skuSalesToday){
  return PRODUCTS.map((p, i) => {
    if(p.dropship){
      return {
        name:p.name, sskSku:"dropship", dropship:true,
        stock:"dropship", units7d:0, unitsToday:0,
        dailyAvg:0, daysOfSupply:null, reorderPoint:0,
        needsReorder:false, reorderQty:0, status:"dropship",
      };
    }

    // Inventory from ShipSidekick (available column), floor at 0
    const stock = sskInv ? Math.max(0, sskInv[p.sskSku] ?? 0) : 0;

    // Sales from Shopify
    const units7d      = skuSales7d[p.shopifySku]?.units      ?? 0;
    const unitsToday   = skuSalesToday[p.shopifySku]?.units   ?? 0;
    const revenue7d    = skuSales7d[p.shopifySku]?.revenue    ?? 0;
    const dailyAvg     = Math.round((units7d / 7) * 10) / 10;

    const daysOfSupply = dailyAvg > 0
      ? Math.round(stock / dailyAvg)
      : (stock > 0 ? 999 : 0);

    const reorderPoint = Math.round(dailyAvg * LEAD_TIME_PKG_READY * 7);
    const targetUnits  = Math.round(dailyAvg * (TARGET_COVERAGE_DAYS + SAFETY_STOCK_DAYS));
    const reorderQty   = Math.max(0, targetUnits - stock);
    const needsReorder = stock <= reorderPoint && !p.dropship;

    let status = "healthy";
    if(stock === 0)          status = "stockout";
    else if(daysOfSupply < 14) status = "critical";
    else if(daysOfSupply < 30) status = "low";

    return {
      name:p.name, sskSku:p.sskSku, shopifySku:p.shopifySku, dropship:false,
      stock, units7d, unitsToday, revenue7d:Math.round(revenue7d),
      dailyAvg, daysOfSupply,
      weeksOfSupply: Math.round(daysOfSupply/7*10)/10,
      reorderPoint, needsReorder, reorderQty, status,
    };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(){
  log("=== Supply Chain Sync Starting ===");
  if(!SHOPIFY_CLIENT_ID)     throw new Error("Missing SHOPIFY_CLIENT_ID");
  if(!SHOPIFY_CLIENT_SECRET) throw new Error("Missing SHOPIFY_CLIENT_SECRET");
  if(!TW_API_KEY)            throw new Error("Missing TW_API_KEY");
  if(!SSK_API_KEY)           throw new Error("Missing SSK_API_KEY");

  const [sskInv, sskInbound, today, sales7d, tw] = await Promise.all([
    getSSKInventory(),
    getSSKInbound(),
    getShopifyOrdersToday(),
    getShopifyOrders7d(),
    getTripleWhale(),
  ]);

  const products = calcProducts(sskInv, sales7d, today.skuSalesToday);
  const tracked  = products.filter(p => !p.dropship);

  const reorderAlerts = tracked
    .filter(p => p.needsReorder)
    .map(p => ({
      name:p.name, sskSku:p.sskSku, stock:p.stock,
      daysLeft:p.daysOfSupply, orderQty:p.reorderQty,
      urgency: p.status==="stockout" ? "IMMEDIATE" : p.daysOfSupply<21 ? "HIGH" : "MEDIUM",
    }));

  const report = {
    syncedAt: new Date().toISOString(),
    summary: {
      totalUnitsAllSKUs: tracked.reduce((a,p) => a + (typeof p.stock==="number" ? p.stock : 0), 0),
      skusInStockout:    tracked.filter(p=>p.status==="stockout").length,
      skusCritical:      tracked.filter(p=>p.status==="critical").length,
      // Today from Shopify
      ordersToday:       today.ordersToday,
      revenueToday:      today.revenueToday,
      unitsToday:        today.unitsToday,
      preOrdersPending:  today.preOrdersPending,
      // Marketing from Triple Whale (today)
      blendedROAS:       tw.blendedROAS,
      adSpend:           tw.totalSpend,
      blendedSales:      tw.blendedSales,
      netRevenue:        tw.netRevenue,
    },
    products, reorderAlerts,
    inboundContainers: sskInbound,
    dataSourceNote: "Inventory: ShipSidekick (available units) | Sales: Shopify | Marketing: Triple Whale",
  };

  fs.writeFileSync("./supply-chain-data.json", JSON.stringify(report, null, 2));

  log("=== SYNC COMPLETE ===");
  log(`Total available units: ${report.summary.totalUnitsAllSKUs.toLocaleString()}`);
  log(`Today: ${today.ordersToday} orders / $${today.revenueToday.toLocaleString()}`);
  log(`TW ROAS: ${tw.blendedROAS} | Spend: $${tw.totalSpend}`);
  log(`Reorder alerts: ${reorderAlerts.length}`);
  for(const a of reorderAlerts){
    log(`  ${a.urgency} — ${a.name}: ${a.stock} units (${a.daysLeft}d), order ${a.orderQty}`);
  }
}

main().catch(err => { console.error("SYNC FAILED:", err.message); process.exit(1); });
