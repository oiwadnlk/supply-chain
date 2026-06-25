require("dotenv").config();
const fs = require("fs");

const SHOPIFY_STORE        = "e1c5f3-7e.myshopify.com";
const SHOPIFY_CLIENT_ID    = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET= process.env.SHOPIFY_CLIENT_SECRET;
const TW_API_KEY           = process.env.TW_API_KEY;
const SSK_API_KEY          = process.env.SSK_API_KEY;

// ── Real SKU map (dropship SKUs excluded from inventory tracking) ──
const SKU_MAP = {
  "QUASI-GLOWUP-OG":     { name: "Bio Collagen Mask",   dropship: false },
  "QUASI-GLOWUP-SALMON": { name: "Salmon PDRM Mask",    dropship: false },
  "199284450646":        { name: "Chest Mask",           dropship: false },
  "199284415690":        { name: "Neck Mask",            dropship: false },
  "25341366":            { name: "Night Sealing Mask",   dropship: false },
  "MULTI-BALM-STICK":    { name: "Multi Balm Stick",     dropship: true  },
  "EYE-PATCHES":         { name: "Eye Patches",          dropship: true  },
};

const LEAD_TIME_PKG_READY  = 9;
const LEAD_TIME_NO_PKG     = 11;
const SAFETY_STOCK_DAYS    = 21;
const TARGET_COVERAGE_DAYS = 90;

function log(msg){ console.log(`[${new Date().toISOString()}] ${msg}`); }
function today(){ return new Date().toISOString().split("T")[0]; }
function daysAgo(n){ const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().split("T")[0]; }

// ── Shopify auth ──────────────────────────────────────────────────
let _token = null;
async function getToken(){
  if(_token) return _token;
  const creds = Buffer.from(`${SHOPIFY_CLIENT_ID}:${SHOPIFY_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`,{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Basic ${creds}`},
    body:JSON.stringify({client_id:SHOPIFY_CLIENT_ID,client_secret:SHOPIFY_CLIENT_SECRET,grant_type:"client_credentials"}),
  });
  if(!res.ok){ _token=SHOPIFY_CLIENT_SECRET; return _token; }
  const d=await res.json(); _token=d.access_token; return _token;
}

async function shopifyREST(path){
  const token=await getToken();
  const res=await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04${path}`,{
    headers:{"X-Shopify-Access-Token":token,"Content-Type":"application/json"},
  });
  if(!res.ok) throw new Error(`Shopify REST ${res.status}: ${path}`);
  return res.json();
}

// ── Inventory ─────────────────────────────────────────────────────
async function getInventory(){
  log("Fetching Shopify inventory...");
  const data = await shopifyREST("/products.json?limit=250&fields=title,variants");
  const inv = {};
  for(const p of data.products){
    for(const v of p.variants){
      if(!v.sku) continue;
      inv[v.sku] = { productName: p.title, stock: v.inventory_quantity ?? 0 };
    }
  }
  log(`Inventory: ${Object.keys(inv).length} variants found`);
  return inv;
}

// ── Orders 7d ────────────────────────────────────────────────────
async function getOrders7d(){
  log("Fetching 7-day orders...");
  const data = await shopifyREST(
    `/orders.json?status=any&financial_status=paid&created_at_min=${daysAgo(7)}T00:00:00Z&limit=250&fields=id,total_price,line_items,tags`
  );
  const skuSales={}, tags={preorder:0};
  let totalOrders=0, totalRevenue=0;
  for(const order of data.orders){
    totalOrders++;
    totalRevenue+=parseFloat(order.total_price||0);
    if((order.tags||"").toLowerCase().includes("pre-order")) tags.preorder++;
    for(const item of order.line_items){
      if(!item.sku) continue;
      if(!skuSales[item.sku]) skuSales[item.sku]={units:0,revenue:0};
      skuSales[item.sku].units+=item.quantity;
      skuSales[item.sku].revenue+=item.quantity*parseFloat(item.price||0);
    }
  }
  log(`Orders 7d: ${totalOrders} orders, $${totalRevenue.toFixed(2)}`);
  return {skuSales,totalOrders,totalRevenue,preOrderCount:tags.preorder};
}

// ── Orders today ─────────────────────────────────────────────────
async function getOrdersToday(){
  log("Fetching today's orders...");
  const data = await shopifyREST(
    `/orders.json?status=any&financial_status=paid&created_at_min=${today()}T00:00:00Z&limit=250&fields=id,total_price,line_items`
  );
  let orders=0,revenue=0,units=0;
  for(const o of data.orders){
    orders++; revenue+=parseFloat(o.total_price||0);
    for(const i of o.line_items) units+=i.quantity;
  }
  return {ordersToday:orders,revenueToday:revenue,unitsToday:units};
}

// ── Triple Whale ─────────────────────────────────────────────────
async function getTW(){
  log("Fetching Triple Whale...");
  try{
    const res=await fetch("https://api.triplewhale.com/api/v2/tw-metrics/get-metrics-data",{
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":TW_API_KEY},
      body:JSON.stringify({shopDomain:SHOPIFY_STORE,startDate:daysAgo(7),endDate:today(),
        metrics:["blended-roas","total-spend","net-revenue","orders","cpa"]}),
    });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const d=await res.json();
    return {blendedROAS:d?.["blended-roas"]??null,totalSpend:d?.["total-spend"]??null,netRevenue:d?.["net-revenue"]??null};
  }catch(e){ log(`TW error (non-fatal): ${e.message}`); return {blendedROAS:null,totalSpend:null,netRevenue:null}; }
}

// ── ShipSidekick ─────────────────────────────────────────────────
async function getSSK(){
  log("Fetching ShipSidekick inventory...");
  try{
    const res=await fetch("https://www.shipsidekick.com/api/v1/inventory",{
      headers:{"Authorization":`Bearer ${SSK_API_KEY}`,"Content-Type":"application/json"},
    });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const d=await res.json();
    const inv={};
    for(const item of Array.isArray(d)?d:(d?.inventory??d?.items??[])){
      const sku=item.sku??item.SKU??item.product_sku;
      const qty=item.quantity??item.available??item.onHand??0;
      if(sku) inv[sku]=qty;
    }
    log(`SSK: ${Object.keys(inv).length} SKUs`);
    return inv;
  }catch(e){ log(`SSK error (non-fatal): ${e.message}`); return null; }
}

async function getSSKInbound(){
  try{
    const res=await fetch("https://www.shipsidekick.com/api/v1/purchase-orders",{
      headers:{"Authorization":`Bearer ${SSK_API_KEY}`,"Content-Type":"application/json"},
    });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const d=await res.json();
    const orders=Array.isArray(d)?d:(d?.purchaseOrders??d?.orders??[]);
    return orders.filter(o=>["pending","in_transit","shipped","open"].includes((o.status??"").toLowerCase()))
      .map(o=>({poNumber:o.poNumber??o.po_number??o.id,status:o.status,qty:o.totalQuantity??o.quantity??0,expectedDate:o.expectedDate??o.expected_date??o.eta}));
  }catch(e){ log(`SSK inbound error (non-fatal): ${e.message}`); return []; }
}

// ── Calculations ─────────────────────────────────────────────────
function calcSKUs(shopifyInv, skuSales7d, sskInv){
  return Object.entries(SKU_MAP).map(([sku, meta], i) => {
    if(meta.dropship){
      return {sku, name:meta.name, dropship:true, stock:"dropship",
        units7d:skuSales7d[sku]?.units??0, dailyAvg:0, daysOfSupply:999,
        reorderPoint:0, needsReorder:false, reorderQty:0, status:"dropship"};
    }
    const shopifyStock = shopifyInv[sku]?.stock ?? 0;
    const stock = sskInv?.[sku] ?? shopifyStock;
    const units7d = skuSales7d[sku]?.units ?? 0;
    const revenue7d = skuSales7d[sku]?.revenue ?? 0;
    const dailyAvg = Math.round((units7d/7)*10)/10;
    const daysOfSupply = dailyAvg>0 ? Math.round(stock/dailyAvg) : (stock>0?999:0);
    const reorderPoint = Math.round(dailyAvg*LEAD_TIME_PKG_READY*7);
    const targetUnits = Math.round(dailyAvg*(TARGET_COVERAGE_DAYS+SAFETY_STOCK_DAYS));
    const reorderQty = Math.max(0, targetUnits-stock);
    let status="healthy";
    if(stock===0) status="stockout";
    else if(daysOfSupply<14) status="critical";
    else if(daysOfSupply<30) status="low";
    return {sku,name:meta.name,dropship:false,stock,units7d,revenue7d:Math.round(revenue7d),
      dailyAvg,daysOfSupply,weeksOfSupply:Math.round(daysOfSupply/7*10)/10,
      reorderPoint,needsReorder:stock<=reorderPoint,reorderQty,status};
  });
}

// ── Main ─────────────────────────────────────────────────────────
async function main(){
  log("=== Supply Chain Sync Starting ===");
  if(!SHOPIFY_CLIENT_ID) throw new Error("Missing SHOPIFY_CLIENT_ID");
  if(!TW_API_KEY)        throw new Error("Missing TW_API_KEY");
  if(!SSK_API_KEY)       throw new Error("Missing SSK_API_KEY");

  const [inv, orders7d, ordersToday, tw, sskInv, sskInbound] = await Promise.all([
    getInventory(), getOrders7d(), getOrdersToday(), getTW(), getSSK(), getSSKInbound()
  ]);

  const skus = calcSKUs(inv, orders7d.skuSales, sskInv);
  const tracked = skus.filter(s=>!s.dropship);
  const reorderAlerts = tracked.filter(s=>s.needsReorder).map(s=>({
    sku:s.sku, name:s.name, stock:s.stock, daysLeft:s.daysOfSupply, orderQty:s.reorderQty,
    urgency:s.status==="stockout"?"IMMEDIATE":s.daysOfSupply<21?"HIGH":"MEDIUM",
  }));

  const report = {
    syncedAt: new Date().toISOString(),
    summary: {
      totalUnitsAllSKUs: tracked.reduce((a,s)=>a+(typeof s.stock==="number"?s.stock:0),0),
      skusInStockout:    tracked.filter(s=>s.status==="stockout").length,
      skusCritical:      tracked.filter(s=>s.status==="critical").length,
      ordersToday:       ordersToday.ordersToday,
      revenueToday:      Math.round(ordersToday.revenueToday),
      unitsToday:        ordersToday.unitsToday,
      blendedROAS7d:     tw.blendedROAS,
      adSpend7d:         tw.totalSpend,
      revenue7d:         tw.netRevenue,
      preOrdersPending:  orders7d.preOrderCount,
    },
    skus, reorderAlerts, inboundContainers: sskInbound,
  };

  fs.writeFileSync("./supply-chain-data.json", JSON.stringify(report, null, 2));
  log("=== SYNC COMPLETE ===");
  log(`Total stock (tracked SKUs): ${report.summary.totalUnitsAllSKUs.toLocaleString()}`);
  log(`Orders today: ${report.summary.ordersToday} ($${report.summary.revenueToday.toLocaleString()})`);
  log(`Reorder alerts: ${reorderAlerts.length}`);
  for(const a of reorderAlerts) log(`  ${a.urgency} — ${a.name}: ${a.stock} units, order ${a.orderQty}`);
}

main().catch(err=>{ console.error("SYNC FAILED:",err.message); process.exit(1); });
