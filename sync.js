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
  { name:"Multi Balm Stick",   sskSku:null, shopifySku:null,   dropship:true },
  { name:"Eye Patches",        sskSku:null, shopifySku:null,   dropship:true },
];

const LEAD_TIME_WEEKS      = 9;
const SAFETY_STOCK_DAYS    = 21;
const TARGET_COVERAGE_DAYS = 90;

function log(msg){ console.log(`[${new Date().toISOString()}] ${msg}`); }
function todayET(){ return new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"}); }
function startOfTodayET(){
  // Get midnight ET as UTC
  // EDT = UTC-4, EST = UTC-5
  // June = EDT so midnight ET = 04:00 UTC
  const etDate = todayET(); // "2026-06-25"
  return etDate + "T04:00:00.000Z"; // midnight EDT
}
function daysAgoET(n){ const d=new Date(); d.setDate(d.getDate()-n); return d.toLocaleDateString("en-CA",{timeZone:"America/New_York"}); }

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
  const d=await res.json(); _token=d.access_token; return _token;
}
async function shopifyREST(path){
  const token=await getToken();
  const res=await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04${path}`,{
    headers:{"X-Shopify-Access-Token":token,"Content-Type":"application/json"},
  });
  if(!res.ok) throw new Error(`Shopify ${res.status}: ${path}`);
  return res.json();
}
async function shopifyRESTWithHeaders(path){
  const token=await getToken();
  const res=await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04${path}`,{
    headers:{"X-Shopify-Access-Token":token,"Content-Type":"application/json"},
  });
  if(!res.ok) throw new Error(`Shopify ${res.status}: ${path}`);
  const data=await res.json();
  return {data, headers:res.headers};
}

// ── ShipSidekick — /api/v1/inventory/levels (confirmed working) ───────────────
async function getSSKInventory(){
  log("Fetching ShipSidekick inventory levels...");
  try{
    // Paginate through all inventory levels
    let allItems=[], cursor=null, page=0;
    while(true){
      page++;
      const url="https://www.shipsidekick.com/api/v1/inventory/levels"+(cursor?`?cursor=${cursor}`:"");
      const res=await fetch(url,{
        headers:{"Authorization":`Bearer ${SSK_API_KEY}`,"Content-Type":"application/json","Accept":"application/json"},
      });
      if(!res.ok){log(`SSK page ${page} failed: ${res.status}`);break;}
      const data=await res.json();
      const items=data?.data??[];
      allItems=[...allItems,...items];
      log(`SSK page ${page}: ${items.length} items (total: ${allItems.length})`);
      // Check for next page cursor
      cursor=data?.nextCursor??data?.cursor??data?.meta?.nextCursor??null;
      if(!cursor||items.length===0) break;
      if(page>20) break; // safety limit
    }

    log(`SSK total inventory levels: ${allItems.length}`);


    // Map SKU → availableQuantity
    // Structure: { availableQuantity, productVariant: { sku, skuAliases } }
    const inv={};
    for(const item of allItems){
      const variant=item.productVariant;
      if(!variant) continue;
      // Use availableQuantity; if 0 or negative fall back to onHand - committed
      const avail    = item.availableQuantity ?? 0;
      const onHand   = item.onHandQuantity ?? item.incomingQuantity ?? 0;
      const committed= item.committedQuantity ?? 0;
      const qty = avail > 0 ? avail : Math.max(0, onHand - committed);
      // Keep the HIGHEST available quantity per SKU (multiple warehouse entries may exist)
      if(variant.sku) inv[variant.sku] = Math.max(inv[variant.sku]??0, qty);
      for(const alias of (variant.skuAliases??[])){
        if(alias) inv[alias] = Math.max(inv[alias]??0, qty);
      }
    }

    log(`SSK mapped ${Object.keys(inv).length} SKUs`);
    // Log our specific SKUs
    for(const p of PRODUCTS.filter(p=>!p.dropship)){
      log(`  ${p.name} (${p.sskSku}): ${inv[p.sskSku]??'NOT FOUND'}`);
    }
    return inv;
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
    const orders=Array.isArray(data)?data:(data?.data??data?.purchaseOrders??data?.orders??[]);
    return orders.filter(o=>["pending","in_transit","shipped","open"].includes((o.status??"").toLowerCase()))
      .map(o=>({poNumber:o.poNumber??o.po_number??o.id,status:o.status,
        qty:o.totalQuantity??o.quantity??0,expectedDate:o.expectedDate??o.expected_date??o.eta}));
  }catch(e){ return []; }
}

// ── Triple Whale — correct endpoint with period ────────────────────────────────
async function getTripleWhale(){
  log("Fetching Triple Whale...");
  try{
    const today=todayET();
    // Official endpoint: /api/v2/summary-page/get-data with period object
    // todayHour = current hour in ET (0-23), required by TW API
    const todayHour = new Date().toLocaleString("en-US",{timeZone:"America/New_York",hour:"numeric",hour12:false});
    const res=await fetch("https://api.triplewhale.com/api/v2/summary-page/get-data",{
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":TW_API_KEY},
      body:JSON.stringify({
        shopDomain: SHOPIFY_STORE,
        period: {
          start: today,
          end:   today,
        },
        todayHour: parseInt(todayHour)||12,
      }),
    });
    log(`TW status: ${res.status}`);
    if(!res.ok){
      const t=await res.text();
      log(`TW error: ${t.substring(0,300)}`);
      return {blendedROAS:null,totalSpend:null,blendedSales:null,netRevenue:null};
    }
    const raw=await res.text();
    log(`TW response (first 800): ${raw.substring(0,800)}`);
    const data=JSON.parse(raw);

    // Navigate the response structure
    // TW returns { metrics: [ {id, metricId, values: {current, previous}}, ... ] }
    const metricsArr = Array.isArray(data?.metrics) ? data.metrics : [];
    log(`TW metrics count: ${metricsArr.length}`);
    // Log first few metric IDs so we can see what's available
    // metrics array parsed successfully

    const findMetric = (...ids) => {
      for(const m of metricsArr){
        if(ids.includes(m.id)||ids.includes(m.metricId)) return m?.values?.current??null;
      }
      return null;
    };
    const roas  = findMetric("blendedRoas","blended-roas","roas","ROAS","blendedROAS");
    const spend = findMetric("blendedAds","blendedAdSpend","totalSpend","total-spend","blendedSpend","spend","adSpend","ads");
    const sales = findMetric("blendedSales","blended-sales","totalSales","sales","total-sales");
    const rev   = findMetric("netSales","net-revenue","netRevenue","orderRevenue");

    log(`TW extracted: ROAS=${roas}, spend=${spend}, sales=${sales}, rev=${rev}`);
    return {blendedROAS:roas, totalSpend:spend, blendedSales:sales, netRevenue:rev};
  }catch(e){
    log(`TW error: ${e.message}`);
    return {blendedROAS:null,totalSpend:null,blendedSales:null,netRevenue:null};
  }
}

// ── Shopify orders today ──────────────────────────────────────────────────────
async function getShopifyOrdersToday(){
  log("Fetching today's orders...");
  const since=startOfTodayET();
  log(`Fetching orders since ${since}`);
  // Paginate through ALL orders today using cursor-based pagination
  let allOrders=[], pageInfo=null, page=0;
  while(true){
    page++;
    let url;
    if(pageInfo){
      url = `/orders.json?limit=250&fields=id,total_price,line_items,tags&page_info=${pageInfo}`;
    } else {
      url = `/orders.json?status=any&limit=250&fields=id,total_price,line_items,tags&created_at_min=${encodeURIComponent(since)}`;
    }
    const resp = await shopifyRESTWithHeaders(url);
    allOrders=[...allOrders,...(resp.data.orders||[])];
    log(`Orders page ${page}: ${resp.data.orders?.length||0} (total: ${allOrders.length})`);
    // Extract next page cursor from Link header
    const link = resp.headers?.get?.("Link")||resp.headers?.Link||"";
    const nextMatch = link.match(/page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if(nextMatch && resp.data.orders?.length===250){
      pageInfo = nextMatch[1];
    } else {
      break;
    }
    if(page>20) break; // safety
  }
  const data = {orders: allOrders};
  let orders=0,revenue=0,units=0,preorders=0;
  const skuSalesToday={};
  for(const o of data.orders){
    orders++;revenue+=parseFloat(o.total_price||0);
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
  log("Fetching 7d sales via GraphQL...");
  const token = await getToken();
  const since = new Date(daysAgoET(7)+"T04:00:00.000Z").toISOString();

  // Use GraphQL to get total quantity sold per variant — aggregated, no pagination
  // Query line items grouped by variant SKU for last 7 days
  const skuSales7d = {};

  // Track units sold per SKU using GraphQL productVariant sales data
  // Shopify GraphQL doesn't have a direct sales aggregate, but we can use
  // the REST /admin/api/reports endpoint or query variants with fulfillmentOrders
  // Best available: use the existing sample but scale it up by ratio

  // Get total order count for 7d to scale the sample
  const countRes = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2026-04/orders/count.json?status=any&created_at_min=${encodeURIComponent(since)}`,
    { headers: {"X-Shopify-Access-Token": token} }
  );
  const countData = await countRes.json();
  const total7dOrders = countData.count ?? 0;
  log(`7d total order count: ${total7dOrders}`);

  // Sample 2000 most recent orders and scale up
  let sampleOrders=[], pageInfo=null, page=0;
  const SAMPLE_SIZE = 8; // 8 pages = 2000 orders
  while(page < SAMPLE_SIZE){
    page++;
    let url;
    if(pageInfo){
      url=`/orders.json?limit=250&fields=id,line_items&page_info=${pageInfo}`;
    } else {
      url=`/orders.json?status=any&limit=250&fields=id,line_items&created_at_min=${encodeURIComponent(since)}`;
    }
    const resp=await shopifyRESTWithHeaders(url);
    sampleOrders=[...sampleOrders,...(resp.data.orders||[])];
    const link=resp.headers?.get?.("Link")||"";
    const nextMatch=link.match(/page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if(nextMatch && resp.data.orders?.length===250){ pageInfo=nextMatch[1]; }
    else { break; }
  }

  const sampleCount = sampleOrders.length;
  // Scale factor: if we have 10,000 orders and sampled 2,000, scale by 5x
  const scaleFactor = total7dOrders > sampleCount ? total7dOrders / sampleCount : 1;
  log(`7d sample: ${sampleCount} orders, scale factor: ${scaleFactor.toFixed(2)}x`);

  for(const o of sampleOrders){
    for(const item of o.line_items){
      if(!item.sku) continue;
      if(!skuSales7d[item.sku]) skuSales7d[item.sku]={units:0,revenue:0};
      skuSales7d[item.sku].units+=item.quantity;
      skuSales7d[item.sku].revenue+=item.quantity*parseFloat(item.price||0);
    }
  }

  // Scale up to estimated true 7d total
  for(const sku of Object.keys(skuSales7d)){
    skuSales7d[sku].units   = Math.round(skuSales7d[sku].units   * scaleFactor);
    skuSales7d[sku].revenue = Math.round(skuSales7d[sku].revenue * scaleFactor);
  }

  Object.entries(skuSales7d)
    .sort((a,b)=>b[1].units-a[1].units).slice(0,5)
    .forEach(([sku,d])=>log(`  7d est. "${sku}": ${d.units} units (scaled ${scaleFactor.toFixed(1)}x)`));

  return skuSales7d;
}

// ── Calculations ──────────────────────────────────────────────────────────────
function calcProducts(inv, skuSales7d, skuSalesToday){
  return PRODUCTS.map(p=>{
    if(p.dropship) return {name:p.name,sskSku:"dropship",dropship:true,
      stock:"dropship",units7d:0,unitsToday:0,dailyAvg:0,daysOfSupply:null,
      reorderPoint:0,needsReorder:false,reorderQty:0,status:"dropship"};
    // SSK inventory keyed by sskSku; fallback to shopifySku
    const stock=Math.max(0,inv[p.sskSku]??inv[p.shopifySku]??0);
    const units7d=skuSales7d[p.shopifySku]?.units??0;
    const unitsToday=skuSalesToday[p.shopifySku]?.units??0;
    const revenue7d=skuSales7d[p.shopifySku]?.revenue??0;
    const dailyAvg=Math.round((units7d/7)*10)/10;
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

  const [sskInv, sskInbound, today, sales7d, tw] = await Promise.all([
    getSSKInventory(), getSSKInbound(),
    getShopifyOrdersToday(), getShopifyOrders7d(), getTripleWhale(),
  ]);

  const products=calcProducts(sskInv||{}, sales7d, today.skuSalesToday);
  const tracked=products.filter(p=>!p.dropship);
  const reorderAlerts=tracked.filter(p=>p.needsReorder).map(p=>({
    name:p.name,sskSku:p.sskSku,stock:p.stock,daysLeft:p.daysOfSupply,orderQty:p.reorderQty,
    urgency:p.status==="stockout"?"IMMEDIATE":p.daysOfSupply<21?"HIGH":"MEDIUM",
  }));

  const report={
    syncedAt:new Date().toISOString(),
    inventorySource: sskInv?"ShipSidekick (Doral Warehouse)":"Shopify (SSK fallback)",
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
  log(`TW: ROAS=${tw.blendedROAS}, spend=${tw.totalSpend}`);
}

main().catch(err=>{console.error("SYNC FAILED:",err.message);process.exit(1);});
