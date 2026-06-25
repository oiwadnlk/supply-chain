require("dotenv").config();
const fs = require("fs");

const SHOPIFY_STORE         = "e1c5f3-7e.myshopify.com";
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const TW_API_KEY            = process.env.TW_API_KEY;
const SSK_API_KEY           = process.env.SSK_API_KEY;

const PRODUCTS = [
  { name:"Bio Collagen Mask",  sskSku:"GLOWUP-ORIGINAL-QUAS", shopifySku:"QUASI-GLOWUP-OG",    dropship:false },
  { name:"Salmon PDRM Mask",   sskSku:"SALMON-MASK-QUAS",     shopifySku:"QUASI-GLOWUP-SALMON", dropship:false },
  { name:"Neck Mask",          sskSku:"NECK-QUAS",             shopifySku:"199284415690",         dropship:false },
  { name:"Night Sealing Mask", sskSku:"SEALING-OIL-QUAS",     shopifySku:"25341366",             dropship:false },
  { name:"Chest Mask",         sskSku:"CHEST-QUAS",            shopifySku:"199284450646",         dropship:false },
  { name:"Multi Balm Stick",   sskSku:null,                    shopifySku:null,                   dropship:true  },
  { name:"Eye Patches",        sskSku:null,                    shopifySku:null,                   dropship:true  },
];

const LEAD_TIME_WEEKS      = 9;
const SAFETY_STOCK_DAYS    = 21;
const TARGET_COVERAGE_DAYS = 90;

function log(msg){ console.log(`[${new Date().toISOString()}] ${msg}`); }

// Get today's date in ET as YYYY-MM-DD
function todayET(){
  return new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
}
// Get start of today in ET as ISO string for Shopify
function startOfTodayET(){
  const d = todayET(); // YYYY-MM-DD
  // Convert ET midnight to UTC ISO
  const et = new Date(d+"T04:00:00.000Z"); // ET is UTC-4 in summer (EDT)
  return et.toISOString();
}
function daysAgoET(n){
  const d = new Date();
  d.setDate(d.getDate()-n);
  return d.toLocaleDateString("en-CA",{timeZone:"America/New_York"});
}

// ── Shopify auth ──────────────────────────────────────────────────────────────
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
  const d=await res.json(); _token=d.access_token;
  log(`Shopify token acquired (${_token.substring(0,8)}...)`);
  return _token;
}
async function shopifyREST(path){
  const token=await getToken();
  const res=await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04${path}`,{
    headers:{"X-Shopify-Access-Token":token,"Content-Type":"application/json"},
  });
  if(!res.ok) throw new Error(`Shopify ${res.status}: ${path}`);
  return res.json();
}

// ── ShipSidekick ──────────────────────────────────────────────────────────────
async function getSSKInventory(){
  log("Fetching ShipSidekick inventory...");
  try{
    // Try multiple possible endpoints
    const endpoints = [
      "https://www.shipsidekick.com/api/v1/inventory",
      "https://www.shipsidekick.com/api/v1/products/inventory",
      "https://www.shipsidekick.com/api/v1/stock",
    ];

    for(const url of endpoints){
      log(`Trying SSK endpoint: ${url}`);
      const res = await fetch(url,{
        headers:{"Authorization":`Bearer ${SSK_API_KEY}`,"Content-Type":"application/json"},
      });
      log(`SSK response status: ${res.status} for ${url}`);
      if(!res.ok) continue;

      const raw = await res.text();
      log(`SSK raw response (first 500 chars): ${raw.substring(0,500)}`);

      let data;
      try{ data=JSON.parse(raw); } catch(e){ log("SSK parse error: "+e.message); continue; }

      // Try to find the inventory array in the response
      const items = Array.isArray(data) ? data
        : (data?.inventory ?? data?.items ?? data?.products
        ?? data?.data?.inventory ?? data?.data ?? []);

      log(`SSK items found: ${Array.isArray(items)?items.length:0}`);
      if(Array.isArray(items) && items.length>0){
        log(`SSK first item sample: ${JSON.stringify(items[0])}`);
        const inv={};
        for(const item of items){
          // Try every possible field name
          const sku = item.sku ?? item.SKU ?? item.product_sku ?? item.productSku
            ?? item.item_number ?? item.itemNumber ?? item.code;
          const qty = item.available ?? item.Available ?? item.available_quantity
            ?? item.qty_available ?? item.quantity ?? item.onHand ?? item.on_hand
            ?? item.qty ?? item.stock ?? 0;
          if(sku){
            inv[sku] = Math.max(0, Number(qty)||0);
            log(`SSK mapped: ${sku} = ${inv[sku]}`);
          }
        }
        if(Object.keys(inv).length>0) return inv;
      }
    }
    log("SSK: no inventory data found from any endpoint");
    return null;
  }catch(e){
    log(`SSK error: ${e.message}`);
    return null;
  }
}

async function getSSKInbound(){
  try{
    const res=await fetch("https://www.shipsidekick.com/api/v1/purchase-orders",{
      headers:{"Authorization":`Bearer ${SSK_API_KEY}`,"Content-Type":"application/json"},
    });
    if(!res.ok) return [];
    const data=await res.json();
    const orders=Array.isArray(data)?data:(data?.purchaseOrders??data?.orders??[]);
    return orders
      .filter(o=>["pending","in_transit","shipped","open"].includes((o.status??"").toLowerCase()))
      .map(o=>({poNumber:o.poNumber??o.po_number??o.id,status:o.status,
        qty:o.totalQuantity??o.quantity??0,expectedDate:o.expectedDate??o.expected_date??o.eta}));
  }catch(e){ return []; }
}

// ── Shopify orders today (ET) ─────────────────────────────────────────────────
async function getShopifyOrdersToday(){
  log("Fetching Shopify orders today (ET)...");
  const since = startOfTodayET();
  log(`Filtering orders since: ${since}`);
  const data = await shopifyREST(
    `/orders.json?status=any&financial_status=paid&created_at_min=${encodeURIComponent(since)}&limit=250&fields=id,total_price,line_items,tags,created_at`
  );
  let orders=0,revenue=0,units=0,preorders=0;
  const skuSalesToday={};
  for(const o of data.orders){
    orders++; revenue+=parseFloat(o.total_price||0);
    if((o.tags||"").toLowerCase().includes("pre-order")) preorders++;
    for(const item of o.line_items){
      units+=item.quantity;
      if(!item.sku) continue;
      if(!skuSalesToday[item.sku]) skuSalesToday[item.sku]={units:0,revenue:0};
      skuSalesToday[item.sku].units+=item.quantity;
      skuSalesToday[item.sku].revenue+=item.quantity*parseFloat(item.price||0);
    }
  }
  log(`Orders today: ${orders}, revenue: $${revenue.toFixed(2)}, units: ${units}`);
  return {ordersToday:orders,revenueToday:Math.round(revenue),unitsToday:units,preOrdersPending:preorders,skuSalesToday};
}

// ── Shopify orders 7d ─────────────────────────────────────────────────────────
async function getShopifyOrders7d(){
  log("Fetching Shopify orders 7d...");
  const since = daysAgoET(7)+"T04:00:00.000Z";
  const data = await shopifyREST(
    `/orders.json?status=any&financial_status=paid&created_at_min=${encodeURIComponent(since)}&limit=250&fields=id,line_items`
  );
  const skuSales7d={};
  for(const o of data.orders){
    for(const item of o.line_items){
      if(!item.sku) continue;
      if(!skuSales7d[item.sku]) skuSales7d[item.sku]={units:0,revenue:0};
      skuSales7d[item.sku].units+=item.quantity;
      skuSales7d[item.sku].revenue+=item.quantity*parseFloat(item.price||0);
    }
  }
  return skuSales7d;
}

// ── Triple Whale ──────────────────────────────────────────────────────────────
async function getTripleWhale(){
  log("Fetching Triple Whale...");
  try{
    const today = todayET();
    // Try the summary page API endpoint
    const endpoints = [
      {
        url:"https://api.triplewhale.com/api/v2/tw-metrics/get-metrics-data",
        method:"POST",
        body:JSON.stringify({shopDomain:SHOPIFY_STORE,startDate:today,endDate:today,
          metrics:["blended-roas","total-spend","net-revenue","blended-sales"]}),
        headers:{"Content-Type":"application/json","x-api-key":TW_API_KEY},
      },
      {
        url:`https://api.triplewhale.com/api/v2/attribution/get-summary-stats?shop=${SHOPIFY_STORE}&start=${today}&end=${today}`,
        method:"GET",
        headers:{"x-api-key":TW_API_KEY},
      },
      {
        url:"https://api.triplewhale.com/api/v2/summary-page/get-stats",
        method:"POST",
        body:JSON.stringify({shopDomain:SHOPIFY_STORE,startDate:today,endDate:today}),
        headers:{"Content-Type":"application/json","x-api-key":TW_API_KEY},
      },
    ];

    for(const ep of endpoints){
      log(`Trying TW: ${ep.url}`);
      const res = await fetch(ep.url,{method:ep.method,headers:ep.headers,body:ep.body});
      log(`TW status: ${res.status}`);
      if(!res.ok){
        const txt=await res.text();
        log(`TW error body: ${txt.substring(0,200)}`);
        continue;
      }
      const raw=await res.text();
      log(`TW raw (first 500): ${raw.substring(0,500)}`);
      const data=JSON.parse(raw);
      const roas  = data?.["blended-roas"] ?? data?.blendedRoas ?? data?.roas ?? data?.data?.blendedRoas ?? null;
      const spend = data?.["total-spend"]  ?? data?.totalSpend  ?? data?.spend ?? data?.data?.totalSpend ?? null;
      const sales = data?.["blended-sales"]?? data?.blendedSales?? data?.data?.blendedSales ?? null;
      const rev   = data?.["net-revenue"]  ?? data?.netRevenue  ?? data?.data?.netRevenue ?? null;
      if(roas!==null||spend!==null){
        log(`TW success: ROAS=${roas}, spend=${spend}`);
        return {blendedROAS:roas,totalSpend:spend,blendedSales:sales,netRevenue:rev};
      }
    }
    log("TW: no data from any endpoint");
    return {blendedROAS:null,totalSpend:null,blendedSales:null,netRevenue:null};
  }catch(e){
    log(`TW error: ${e.message}`);
    return {blendedROAS:null,totalSpend:null,blendedSales:null,netRevenue:null};
  }
}

// ── Calculations ──────────────────────────────────────────────────────────────
function calcProducts(sskInv, skuSales7d, skuSalesToday){
  return PRODUCTS.map(p=>{
    if(p.dropship) return {name:p.name,sskSku:"dropship",dropship:true,
      stock:"dropship",units7d:0,unitsToday:0,dailyAvg:0,daysOfSupply:null,
      reorderPoint:0,needsReorder:false,reorderQty:0,status:"dropship"};

    const stock    = sskInv ? Math.max(0, sskInv[p.sskSku]??0) : 0;
    const units7d  = skuSales7d[p.shopifySku]?.units ?? 0;
    const unitsToday = skuSalesToday[p.shopifySku]?.units ?? 0;
    const revenue7d  = skuSales7d[p.shopifySku]?.revenue ?? 0;
    const dailyAvg   = Math.round((units7d/7)*10)/10;
    const daysOfSupply = dailyAvg>0 ? Math.round(stock/dailyAvg) : (stock>0?999:0);
    const reorderPoint = Math.round(dailyAvg*LEAD_TIME_WEEKS*7);
    const reorderQty   = Math.max(0, Math.round(dailyAvg*(TARGET_COVERAGE_DAYS+SAFETY_STOCK_DAYS))-stock);
    const needsReorder = stock<=reorderPoint;
    let status="healthy";
    if(stock===0) status="stockout";
    else if(daysOfSupply<14) status="critical";
    else if(daysOfSupply<30) status="low";
    return {name:p.name,sskSku:p.sskSku,shopifySku:p.shopifySku,dropship:false,
      stock,units7d,unitsToday,revenue7d:Math.round(revenue7d),dailyAvg,daysOfSupply,
      weeksOfSupply:Math.round(daysOfSupply/7*10)/10,reorderPoint,needsReorder,reorderQty,status};
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
    getSSKInventory(), getSSKInbound(),
    getShopifyOrdersToday(), getShopifyOrders7d(), getTripleWhale(),
  ]);

  const products = calcProducts(sskInv, sales7d, today.skuSalesToday);
  const tracked  = products.filter(p=>!p.dropship);
  const reorderAlerts = tracked.filter(p=>p.needsReorder).map(p=>({
    name:p.name,sskSku:p.sskSku,stock:p.stock,daysLeft:p.daysOfSupply,orderQty:p.reorderQty,
    urgency:p.status==="stockout"?"IMMEDIATE":p.daysOfSupply<21?"HIGH":"MEDIUM",
  }));

  const report={
    syncedAt:new Date().toISOString(),
    summary:{
      totalUnitsAllSKUs:tracked.reduce((a,p)=>a+(typeof p.stock==="number"?p.stock:0),0),
      skusInStockout:tracked.filter(p=>p.status==="stockout").length,
      skusCritical:tracked.filter(p=>p.status==="critical").length,
      ordersToday:today.ordersToday, revenueToday:today.revenueToday,
      unitsToday:today.unitsToday,   preOrdersPending:today.preOrdersPending,
      blendedROAS:tw.blendedROAS,    adSpend:tw.totalSpend,
      blendedSales:tw.blendedSales,  netRevenue:tw.netRevenue,
    },
    products, reorderAlerts, inboundContainers:sskInbound,
  };

  fs.writeFileSync("./supply-chain-data.json",JSON.stringify(report,null,2));
  log("=== SYNC COMPLETE ===");
  log(`Total units: ${report.summary.totalUnitsAllSKUs}`);
  log(`Orders today: ${today.ordersToday} / $${today.revenueToday}`);
  log(`TW: ROAS=${tw.blendedROAS}, spend=${tw.totalSpend}`);
  log(`SSK inv keys: ${sskInv?Object.keys(sskInv).join(", "):"null"}`);
}

main().catch(err=>{ console.error("SYNC FAILED:",err.message); process.exit(1); });
