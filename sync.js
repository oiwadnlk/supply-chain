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

function todayET(){
  return new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
}
function startOfTodayET(){
  // EDT = UTC-4
  const d = todayET();
  return new Date(d+"T04:00:00.000Z").toISOString();
}
function daysAgoET(n){
  const d=new Date(); d.setDate(d.getDate()-n);
  return d.toLocaleDateString("en-CA",{timeZone:"America/New_York"});
}

// ── Shopify auth ──────────────────────────────────────────────────────────────
let _token=null;
async function getToken(){
  if(_token) return _token;
  const res=await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`,{
    method:"POST",
    headers:{"Content-Type":"application/json",
      "Authorization":"Basic "+Buffer.from(`${SHOPIFY_CLIENT_ID}:${SHOPIFY_CLIENT_SECRET}`).toString("base64")},
    body:JSON.stringify({client_id:SHOPIFY_CLIENT_ID,client_secret:SHOPIFY_CLIENT_SECRET,grant_type:"client_credentials"}),
  });
  if(!res.ok){_token=SHOPIFY_CLIENT_SECRET;return _token;}
  const d=await res.json();_token=d.access_token;
  log(`Shopify token: ${_token.substring(0,10)}...`);
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
  const headers = {
    "Authorization":`Bearer ${SSK_API_KEY}`,
    "Content-Type":"application/json",
    "Accept":"application/json",
  };

  // Try GET and POST variants of multiple endpoints
  const attempts = [
    { method:"GET",  url:"https://www.shipsidekick.com/api/v1/products" },
    { method:"GET",  url:"https://www.shipsidekick.com/api/v1/inventory/levels" },
    { method:"GET",  url:"https://www.shipsidekick.com/api/v2/inventory" },
    { method:"GET",  url:"https://www.shipsidekick.com/api/v1/warehouses/inventory" },
    { method:"POST", url:"https://www.shipsidekick.com/api/v1/inventory", body:JSON.stringify({}) },
    { method:"GET",  url:"https://www.shipsidekick.com/api/v1/sku" },
    { method:"GET",  url:"https://www.shipsidekick.com/api/v1/skus" },
  ];

  for(const att of attempts){
    try{
      log(`SSK trying: ${att.method} ${att.url}`);
      const res=await fetch(att.url,{method:att.method,headers,body:att.body});
      log(`SSK status: ${res.status}`);
      if(!res.ok){
        const t=await res.text();
        log(`SSK error: ${t.substring(0,100)}`);
        continue;
      }
      const raw=await res.text();
      log(`SSK success! Response: ${raw.substring(0,300)}`);
      const data=JSON.parse(raw);
      const items=Array.isArray(data)?data:(data?.inventory??data?.items??data?.products??data?.data??[]);
      if(Array.isArray(items)&&items.length>0){
        log(`SSK first item: ${JSON.stringify(items[0])}`);
        const inv={};
        for(const item of items){
          const sku=item.sku??item.SKU??item.product_sku??item.productSku??item.item_number??item.code;
          const qty=item.available??item.Available??item.available_quantity??item.qty_available??item.quantity??item.onHand??item.on_hand??item.stock??0;
          if(sku) inv[sku]=Math.max(0,Number(qty)||0);
        }
        if(Object.keys(inv).length>0){
          log(`SSK inventory mapped: ${JSON.stringify(inv)}`);
          return inv;
        }
      }
    }catch(e){ log(`SSK attempt error: ${e.message}`); }
  }
  log("SSK: all endpoints failed — using Shopify inventory as fallback");
  return null;
}

async function getSSKInbound(){
  try{
    const res=await fetch("https://www.shipsidekick.com/api/v1/purchase-orders",{
      headers:{"Authorization":`Bearer ${SSK_API_KEY}`,"Content-Type":"application/json"},
    });
    if(!res.ok) return [];
    const data=await res.json();
    const orders=Array.isArray(data)?data:(data?.purchaseOrders??data?.orders??[]);
    return orders.filter(o=>["pending","in_transit","shipped","open"].includes((o.status??"").toLowerCase()))
      .map(o=>({poNumber:o.poNumber??o.po_number??o.id,status:o.status,
        qty:o.totalQuantity??o.quantity??0,expectedDate:o.expectedDate??o.expected_date??o.eta}));
  }catch(e){ return []; }
}

// ── Shopify inventory fallback ────────────────────────────────────────────────
async function getShopifyInventory(){
  log("Fetching Shopify inventory as fallback...");
  const data=await shopifyREST("/products.json?limit=250&fields=title,variants");
  const inv={};
  for(const p of data.products){
    for(const v of p.variants){
      if(!v.sku) continue;
      // Floor at 0 — Shopify can go negative during stockouts
      inv[v.sku]=Math.max(0, v.inventory_quantity??0);
    }
  }
  return inv;
}

// ── Triple Whale — correct endpoint ──────────────────────────────────────────
async function getTripleWhale(){
  log("Fetching Triple Whale summary...");
  try{
    const today=todayET();
    // Correct endpoint per official docs: /api/v2/summary-page/get-data
    const res=await fetch("https://api.triplewhale.com/api/v2/summary-page/get-data",{
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":TW_API_KEY},
      body:JSON.stringify({
        shopDomain: SHOPIFY_STORE,
        startDate:  today,
        endDate:    today,
      }),
    });
    log(`TW status: ${res.status}`);
    if(!res.ok){
      const t=await res.text();
      log(`TW error: ${t.substring(0,300)}`);
      return {blendedROAS:null,totalSpend:null,blendedSales:null,netRevenue:null};
    }
    const raw=await res.text();
    log(`TW raw (first 600): ${raw.substring(0,600)}`);
    const data=JSON.parse(raw);

    // Try to extract values from multiple possible response shapes
    const metrics=data?.metrics??data?.data?.metrics??data?.summary??data?.data??data;
    log(`TW metrics keys: ${Object.keys(metrics||{}).join(", ")}`);

    const roas  = metrics?.["blended-roas"]     ?? metrics?.blendedRoas     ?? metrics?.roas        ?? null;
    const spend = metrics?.["total-spend"]       ?? metrics?.totalSpend      ?? metrics?.spend       ?? metrics?.adSpend ?? null;
    const sales = metrics?.["blended-sales"]     ?? metrics?.blendedSales    ?? metrics?.totalSales  ?? null;
    const rev   = metrics?.["net-revenue"]       ?? metrics?.netRevenue      ?? metrics?.revenue     ?? null;

    log(`TW extracted: ROAS=${roas}, spend=${spend}, sales=${sales}`);
    return {blendedROAS:roas, totalSpend:spend, blendedSales:sales, netRevenue:rev};
  }catch(e){
    log(`TW error: ${e.message}`);
    return {blendedROAS:null,totalSpend:null,blendedSales:null,netRevenue:null};
  }
}

// ── Shopify orders today ──────────────────────────────────────────────────────
async function getShopifyOrdersToday(){
  log("Fetching today's orders (ET)...");
  const since=startOfTodayET();
  log(`Since: ${since}`);
  const data=await shopifyREST(
    `/orders.json?status=any&financial_status=paid&created_at_min=${encodeURIComponent(since)}&limit=250&fields=id,total_price,line_items,tags`
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
  log(`Today: ${orders} orders / $${revenue.toFixed(2)} / ${units} units`);
  return {ordersToday:orders,revenueToday:Math.round(revenue),unitsToday:units,preOrdersPending:preorders,skuSalesToday};
}

// ── Shopify orders 7d ─────────────────────────────────────────────────────────
async function getShopifyOrders7d(){
  log("Fetching 7d orders...");
  const since=new Date(daysAgoET(7)+"T04:00:00.000Z").toISOString();
  const data=await shopifyREST(
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
  log(`7d: ${Object.keys(skuSales7d).length} SKUs with sales`);
  return skuSales7d;
}

// ── Calculations ──────────────────────────────────────────────────────────────
function calcProducts(inv, skuSales7d, skuSalesToday){
  return PRODUCTS.map(p=>{
    if(p.dropship) return {name:p.name,sskSku:"dropship",dropship:true,
      stock:"dropship",units7d:0,unitsToday:0,dailyAvg:0,daysOfSupply:null,
      reorderPoint:0,needsReorder:false,reorderQty:0,status:"dropship"};
    const stock    = Math.max(0, inv[p.sskSku]??inv[p.shopifySku]??0);
    const units7d  = skuSales7d[p.shopifySku]?.units??0;
    const unitsToday=skuSalesToday[p.shopifySku]?.units??0;
    const revenue7d =skuSales7d[p.shopifySku]?.revenue??0;
    const dailyAvg  =Math.round((units7d/7)*10)/10;
    const daysOfSupply=dailyAvg>0?Math.round(stock/dailyAvg):(stock>0?999:0);
    const reorderPoint=Math.round(dailyAvg*LEAD_TIME_WEEKS*7);
    const reorderQty=Math.max(0,Math.round(dailyAvg*(TARGET_COVERAGE_DAYS+SAFETY_STOCK_DAYS))-stock);
    let status="healthy";
    if(stock===0)status="stockout";
    else if(daysOfSupply<14)status="critical";
    else if(daysOfSupply<30)status="low";
    return {name:p.name,sskSku:p.sskSku,shopifySku:p.shopifySku,dropship:false,
      stock,units7d,unitsToday,revenue7d:Math.round(revenue7d),dailyAvg,daysOfSupply,
      weeksOfSupply:Math.round(daysOfSupply/7*10)/10,reorderPoint,
      needsReorder:stock<=reorderPoint,reorderQty,status};
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(){
  log("=== Supply Chain Sync Starting ===");
  if(!SHOPIFY_CLIENT_ID)     throw new Error("Missing SHOPIFY_CLIENT_ID");
  if(!SHOPIFY_CLIENT_SECRET) throw new Error("Missing SHOPIFY_CLIENT_SECRET");
  if(!TW_API_KEY)            throw new Error("Missing TW_API_KEY");
  if(!SSK_API_KEY)           throw new Error("Missing SSK_API_KEY");

  const [sskInvRaw, sskInbound, today, sales7d, tw] = await Promise.all([
    getSSKInventory(), getSSKInbound(),
    getShopifyOrdersToday(), getShopifyOrders7d(), getTripleWhale(),
  ]);

  // Use SSK inventory if available, otherwise fall back to Shopify
  let inv = sskInvRaw;
  if(!inv || Object.keys(inv).length===0){
    log("Using Shopify inventory as fallback for SSK");
    inv = await getShopifyInventory();
  }

  const products=calcProducts(inv,sales7d,today.skuSalesToday);
  const tracked=products.filter(p=>!p.dropship);
  const reorderAlerts=tracked.filter(p=>p.needsReorder).map(p=>({
    name:p.name,sskSku:p.sskSku,stock:p.stock,daysLeft:p.daysOfSupply,orderQty:p.reorderQty,
    urgency:p.status==="stockout"?"IMMEDIATE":p.daysOfSupply<21?"HIGH":"MEDIUM",
  }));

  const report={
    syncedAt:new Date().toISOString(),
    inventorySource: sskInvRaw ? "ShipSidekick" : "Shopify (SSK fallback)",
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
  log(`Inventory source: ${report.inventorySource}`);
  log(`Total units: ${report.summary.totalUnitsAllSKUs}`);
  log(`Orders today: ${today.ordersToday} / $${today.revenueToday}`);
  log(`TW ROAS: ${tw.blendedROAS}, spend: ${tw.totalSpend}`);
}

main().catch(err=>{console.error("SYNC FAILED:",err.message);process.exit(1);});
