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
function yesterdayET(){
  const d=new Date();
  d.setDate(d.getDate()-1);
  return d.toLocaleDateString("en-CA",{timeZone:"America/New_York"});
}
function startOfYesterdayET(){
  return yesterdayET()+"T04:00:00.000Z"; // midnight EDT start of yesterday
}
function endOfYesterdayET(){
  return todayET()+"T04:00:00.000Z"; // midnight EDT = end of yesterday
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
    const yday=yesterdayET();
    // Pull yesterday's complete data
    const res=await fetch("https://api.triplewhale.com/api/v2/summary-page/get-data",{
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":TW_API_KEY},
      body:JSON.stringify({
        shopDomain: SHOPIFY_STORE,
        period: {
          start: yday,
          end:   yday,
        },
        todayHour: 23,
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
async function getShopifyOrdersYesterday(){
  log("Fetching YESTERDAY US orders only...");
  const since = startOfYesterdayET();
  const until = endOfYesterdayET();
  log(`Yesterday: ${since} → ${until}`);

  let allOrders=[], pageInfo=null, page=0;
  while(true){
    page++;
    let url;
    if(pageInfo){
      url=`/orders.json?limit=250&fields=id,total_price,line_items,tags,shipping_address&page_info=${pageInfo}`;
    } else {
      url=`/orders.json?status=any&limit=250&fields=id,total_price,line_items,tags,shipping_address&created_at_min=${encodeURIComponent(since)}&created_at_max=${encodeURIComponent(until)}`;
    }
    const resp=await shopifyRESTWithHeaders(url);
    allOrders=[...allOrders,...(resp.data.orders||[])];
    log(`Yesterday page ${page}: ${resp.data.orders?.length||0} (total: ${allOrders.length})`);
    const link=resp.headers?.get?.("Link")||"";
    const m=link.match(/page_info=([^&>]+)[^>]*>; rel="next"/);
    if(m && resp.data.orders?.length===250){ pageInfo=m[1]; }
    else break;
    if(page>20) break;
  }

  // Filter US only (3PL fulfills US, China fulfills intl)
  const usOrders=allOrders.filter(o=>{
    const c=o.shipping_address?.country_code??o.shipping_address?.country??"";
    return c.toUpperCase()==="US"||c.toLowerCase()==="united states";
  });
  const usPct=allOrders.length>0?Math.round(usOrders.length/allOrders.length*100):0;
  log(`Yesterday: ${allOrders.length} total, ${usOrders.length} US (${usPct}%), ${allOrders.length-usOrders.length} intl`);

  let orders=0,revenue=0,units=0,preorders=0;
  const skuSalesYesterday={};
  for(const o of usOrders){
    orders++;revenue+=parseFloat(o.total_price||0);
    if((o.tags||"").toLowerCase().includes("pre-order")) preorders++;
    for(const item of o.line_items){
      units+=item.quantity;
      if(!item.sku) continue;
      if(!skuSalesYesterday[item.sku]) skuSalesYesterday[item.sku]={units:0,revenue:0};
      skuSalesYesterday[item.sku].units+=item.quantity;
      skuSalesYesterday[item.sku].revenue+=item.quantity*parseFloat(item.price||0);
    }
  }
  log(`Yesterday US: ${orders} orders / $${revenue.toFixed(2)} / ${units} units`);
  return {ordersYesterday:orders,revenueYesterday:Math.round(revenue),
    unitsYesterday:units,preOrdersPending:preorders,skuSalesYesterday,
    totalOrders:allOrders.length,usOrders:usOrders.length,usSplit:usPct};
}
async function getShopifyOrders7d(){
  log("Fetching 7d US orders (sampled + scaled)...");
  const token = await getToken();
  // Pull last 7 complete days ending at end of yesterday
  const since = new Date(daysAgoET(7)+"T04:00:00.000Z").toISOString();
  const until = endOfYesterdayET();

  // Get total US order count for scaling
  const countRes = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2026-04/orders/count.json?status=any&created_at_min=${encodeURIComponent(since)}&created_at_max=${encodeURIComponent(until)}`,
    { headers: {"X-Shopify-Access-Token": token} }
  );
  const countData = await countRes.json();
  const total7dOrders = countData.count ?? 0;
  log(`7d total order count: ${total7dOrders}`);

  // Sample 2000 orders with shipping address for US filter
  let sampleOrders=[], pageInfo=null, page=0;
  while(page < 8){
    page++;
    let url;
    if(pageInfo){
      url=`/orders.json?limit=250&fields=id,line_items,shipping_address&page_info=${pageInfo}`;
    } else {
      url=`/orders.json?status=any&limit=250&fields=id,line_items,shipping_address&created_at_min=${encodeURIComponent(since)}&created_at_max=${encodeURIComponent(until)}`;
    }
    const resp=await shopifyRESTWithHeaders(url);
    sampleOrders=[...sampleOrders,...(resp.data.orders||[])];
    const link=resp.headers?.get?.("Link")||"";
    const nextMatch=link.match(/page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if(nextMatch && resp.data.orders?.length===250){ pageInfo=nextMatch[1]; }
    else break;
  }

  // Filter to US only
  const usSample = sampleOrders.filter(o=>{
    const c=o.shipping_address?.country_code??o.shipping_address?.country??"";
    return c.toUpperCase()==="US"||c.toLowerCase()==="united states";
  });
  const usSamplePct = sampleOrders.length>0?usSample.length/sampleOrders.length:0.7;
  const estimatedTotalUS = Math.round(total7dOrders * usSamplePct);
  const scaleFactor = estimatedTotalUS > usSample.length ? estimatedTotalUS / usSample.length : 1;
  log(`7d sample: ${sampleOrders.length} total, ${usSample.length} US (${Math.round(usSamplePct*100)}%), scale: ${scaleFactor.toFixed(2)}x`);

  const skuSales7d={};
  for(const o of usSample){
    for(const item of o.line_items){
      if(!item.sku) continue;
      if(!skuSales7d[item.sku]) skuSales7d[item.sku]={units:0,revenue:0};
      skuSales7d[item.sku].units+=item.quantity;
      skuSales7d[item.sku].revenue+=item.quantity*parseFloat(item.price||0);
    }
  }

  // Scale to full 7d estimate
  for(const sku of Object.keys(skuSales7d)){
    skuSales7d[sku].units   = Math.round(skuSales7d[sku].units   * scaleFactor);
    skuSales7d[sku].revenue = Math.round(skuSales7d[sku].revenue * scaleFactor);
  }

  Object.entries(skuSales7d).sort((a,b)=>b[1].units-a[1].units).slice(0,5)
    .forEach(([sku,d])=>log(`  7d US est. "${sku}": ${d.units} units/7d = ${Math.round(d.units/7)}/day`));

  return skuSales7d;
}

// ── Calculations ──────────────────────────────────────────────────────────────
function calcProducts(inv, skuSales7d, skuSalesYesterday){
  return PRODUCTS.map(p=>{
    if(p.dropship) return {name:p.name,sskSku:"dropship",dropship:true,
      stock:"dropship",units7d:0,unitsToday:0,dailyAvg:0,daysOfSupply:null,
      reorderPoint:0,needsReorder:false,reorderQty:0,status:"dropship"};
    // SSK inventory keyed by sskSku; fallback to shopifySku
    const stock=Math.max(0,inv[p.sskSku]??inv[p.shopifySku]??0);
    const units7d=skuSales7d[p.shopifySku]?.units??0;
    const unitsToday=skuSalesYesterday[p.shopifySku]?.units??0;
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

  const [sskInv, sskInbound, yesterday, sales7d, tw] = await Promise.all([
    getSSKInventory(), getSSKInbound(),
    getShopifyOrdersYesterday(), getShopifyOrders7d(), getTripleWhale(),
  ]);

  const products=calcProducts(sskInv||{}, sales7d, yesterday.skuSalesYesterday);
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
      ordersYesterday:yesterday.ordersYesterday, revenueYesterday:yesterday.revenueYesterday,
      unitsYesterday:yesterday.unitsYesterday, preOrdersPending:yesterday.preOrdersPending,
      usSplit:yesterday.usSplit,
      blendedROAS:tw.blendedROAS,    adSpend:tw.totalSpend,
      blendedSales:tw.blendedSales,  netRevenue:tw.netRevenue,
    },
    products, reorderAlerts, inboundContainers:sskInbound,
  };

  fs.writeFileSync("./supply-chain-data.json",JSON.stringify(report,null,2));
  log("=== SYNC COMPLETE ===");
  log(`Inventory source: ${report.inventorySource}`);
  log(`Total units: ${report.summary.totalUnitsAllSKUs}`);
  log(`Orders today: ${yesterday.ordersYesterday} / $${yesterday.revenueYesterday}`);
  log(`TW: ROAS=${tw.blendedROAS}, spend=${tw.totalSpend}`);
}

main().catch(err=>{console.error("SYNC FAILED:",err.message);process.exit(1);});
