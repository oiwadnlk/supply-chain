/**
 * Quasi Supply Chain — Daily Sync Script
 * Shopify + Triple Whale + ShipSidekick
 * Uses Shopify Admin API with Client Credentials
 */

require("dotenv").config();
const fs = require("fs");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SHOPIFY_STORE    = "e1c5f3-7e.myshopify.com";
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const TW_API_KEY       = process.env.TW_API_KEY;
const SSK_API_KEY      = process.env.SSK_API_KEY;

const SKU_MAP = {
  "BCM-001": "Bio Collagen Mask",
  "SPM-002": "Salmon PDRM Mask",
  "NSM-003": "Night Sealing Mask",
  "NKM-004": "Neck Mask",
  "CHM-005": "Chest Mask",
  "MBS-006": "Multi Balm Stick",
  "EYP-007": "Eye Patches",
};

const LEAD_TIME_PKG_READY  = 9;
const LEAD_TIME_NO_PKG     = 11;
const SAFETY_STOCK_DAYS    = 21;
const TARGET_COVERAGE_DAYS = 90;

// ─── HELPERS ───────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function today() {
  return new Date().toISOString().split("T")[0];
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

// ─── SHOPIFY ACCESS TOKEN (Client Credentials) ─────────────────────────────
let _shopifyToken = null;

async function getShopifyToken() {
  if (_shopifyToken) return _shopifyToken;
  log("Getting Shopify access token via client credentials...");

  // Use the client_credentials grant for server-to-server access
  const credentials = Buffer.from(
    `${SHOPIFY_CLIENT_ID}:${SHOPIFY_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${credentials}`,
      },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        grant_type: "client_credentials",
      }),
    }
  );

  if (!res.ok) {
    // Fallback: try using client secret directly as access token
    // (some Dev Dashboard apps use the secret as the API password)
    log("Client credentials flow failed, trying direct secret auth...");
    _shopifyToken = SHOPIFY_CLIENT_SECRET;
    return _shopifyToken;
  }

  const data = await res.json();
  _shopifyToken = data.access_token;
  log("Got Shopify access token");
  return _shopifyToken;
}

// ─── SHOPIFY GRAPHQL ───────────────────────────────────────────────────────
async function shopifyGraphQL(query) {
  const token = await getShopifyToken();
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query }),
    }
  );
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// ─── SHOPIFY REST (fallback for inventory) ─────────────────────────────────
async function shopifyREST(path) {
  const token = await getShopifyToken();
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2026-04${path}`,
    {
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
    }
  );
  if (!res.ok) {
    throw new Error(`Shopify REST ${res.status}: ${path}`);
  }
  return res.json();
}

// ─── INVENTORY ─────────────────────────────────────────────────────────────
async function getShopifyInventory() {
  log("Fetching Shopify inventory...");
  const data = await shopifyREST("/products.json?limit=250&fields=title,variants");
  const inventory = {};
  for (const product of data.products) {
    for (const variant of product.variants) {
      if (!variant.sku) continue;
      inventory[variant.sku] = {
        sku: variant.sku,
        productName: product.title,
        stock: variant.inventory_quantity ?? 0,
      };
    }
  }
  log(`Got inventory for ${Object.keys(inventory).length} SKUs`);
  return inventory;
}

// ─── ORDERS 7 DAYS ─────────────────────────────────────────────────────────
async function getShopifyOrders7Days() {
  log("Fetching Shopify orders (last 7 days)...");
  const since = daysAgo(7);
  const data = await shopifyREST(
    `/orders.json?status=any&financial_status=paid&created_at_min=${since}T00:00:00Z&limit=250&fields=id,total_price,line_items,tags,created_at`
  );

  const skuSales = {};
  let totalOrders = 0;
  let totalRevenue = 0;
  let preOrderCount = 0;

  for (const order of data.orders) {
    totalOrders++;
    totalRevenue += parseFloat(order.total_price || 0);
    if ((order.tags || "").includes("pre-order")) preOrderCount++;
    for (const item of order.line_items) {
      if (!item.sku) continue;
      if (!skuSales[item.sku]) skuSales[item.sku] = { units: 0, revenue: 0 };
      skuSales[item.sku].units += item.quantity;
      skuSales[item.sku].revenue += item.quantity * parseFloat(item.price || 0);
    }
  }

  log(`Got ${totalOrders} orders, $${totalRevenue.toFixed(2)} revenue (7d)`);
  return { skuSales, totalOrders, totalRevenue, preOrderCount };
}

// ─── ORDERS TODAY ──────────────────────────────────────────────────────────
async function getShopifyOrdersToday() {
  log("Fetching Shopify orders today...");
  const data = await shopifyREST(
    `/orders.json?status=any&financial_status=paid&created_at_min=${today()}T00:00:00Z&limit=250&fields=id,total_price,line_items`
  );

  let ordersToday = 0;
  let revenueToday = 0;
  let unitsToday = 0;
  for (const order of data.orders) {
    ordersToday++;
    revenueToday += parseFloat(order.total_price || 0);
    for (const item of order.line_items) unitsToday += item.quantity;
  }
  return { ordersToday, revenueToday, unitsToday };
}

// ─── TRIPLE WHALE ──────────────────────────────────────────────────────────
async function getTripleWhaleStats() {
  log("Fetching Triple Whale stats...");
  try {
    const res = await fetch(
      "https://api.triplewhale.com/api/v2/tw-metrics/get-metrics-data",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": TW_API_KEY,
        },
        body: JSON.stringify({
          shopDomain: SHOPIFY_STORE,
          startDate: daysAgo(7),
          endDate: today(),
          metrics: ["blended-roas", "total-spend", "net-revenue", "orders", "cpa"],
        }),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      blendedROAS: data?.["blended-roas"] ?? null,
      totalSpend:  data?.["total-spend"]  ?? null,
      netRevenue:  data?.["net-revenue"]  ?? null,
    };
  } catch (err) {
    log(`Triple Whale error (non-fatal): ${err.message}`);
    return { blendedROAS: null, totalSpend: null, netRevenue: null };
  }
}

// ─── SHIPSIDEKICK ──────────────────────────────────────────────────────────
async function getShipSidekickInventory() {
  log("Fetching ShipSidekick inventory...");
  try {
    const res = await fetch("https://www.shipsidekick.com/api/v1/inventory", {
      headers: {
        "Authorization": `Bearer ${SSK_API_KEY}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const inv = {};
    const items = data?.inventory ?? data?.items ?? data ?? [];
    for (const item of Array.isArray(items) ? items : []) {
      const sku = item.sku ?? item.SKU ?? item.product_sku;
      const qty = item.quantity ?? item.available ?? item.onHand ?? 0;
      if (sku) inv[sku] = qty;
    }
    log(`ShipSidekick: ${Object.keys(inv).length} SKUs`);
    return inv;
  } catch (err) {
    log(`ShipSidekick inventory error (non-fatal): ${err.message}`);
    return null;
  }
}

async function getShipSidekickInbound() {
  log("Fetching ShipSidekick inbound POs...");
  try {
    const res = await fetch("https://www.shipsidekick.com/api/v1/purchase-orders", {
      headers: {
        "Authorization": `Bearer ${SSK_API_KEY}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const orders = data?.purchaseOrders ?? data?.orders ?? data ?? [];
    return (Array.isArray(orders) ? orders : [])
      .filter(o => ["pending","in_transit","shipped","open"].includes((o.status ?? "").toLowerCase()))
      .map(o => ({
        poNumber:     o.poNumber ?? o.po_number ?? o.id,
        status:       o.status,
        qty:          o.totalQuantity ?? o.quantity ?? 0,
        expectedDate: o.expectedDate ?? o.expected_date ?? o.eta,
      }));
  } catch (err) {
    log(`ShipSidekick ASN error (non-fatal): ${err.message}`);
    return [];
  }
}

// ─── CALCULATIONS ──────────────────────────────────────────────────────────
function calcSKUMetrics(inventory, skuSales7d, sskInventory) {
  return Object.entries(SKU_MAP).map(([sku, name]) => {
    const shopifyStock = inventory[sku]?.stock ?? 0;
    const stock = sskInventory?.[sku] ?? shopifyStock;
    const units7d = skuSales7d[sku]?.units ?? 0;
    const revenue7d = skuSales7d[sku]?.revenue ?? 0;
    const dailyAvg = Math.round((units7d / 7) * 10) / 10;
    const daysOfSupply = dailyAvg > 0 ? Math.round(stock / dailyAvg) : 999;
    const reorderPoint = Math.round(dailyAvg * LEAD_TIME_PKG_READY * 7);
    const targetUnits = Math.round(dailyAvg * (TARGET_COVERAGE_DAYS + SAFETY_STOCK_DAYS));
    const reorderQty = Math.max(0, targetUnits - stock);
    let status = "healthy";
    if (stock === 0) status = "stockout";
    else if (daysOfSupply < 14) status = "critical";
    else if (daysOfSupply < 30) status = "low";
    return {
      sku, name, stock, units7d,
      revenue7d: Math.round(revenue7d),
      dailyAvg, daysOfSupply,
      weeksOfSupply: Math.round(daysOfSupply / 7 * 10) / 10,
      reorderPoint, needsReorder: stock <= reorderPoint,
      reorderQty, status,
    };
  });
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  log("=== Quasi Supply Chain Sync Starting ===");

  if (!SHOPIFY_CLIENT_ID)     throw new Error("Missing SHOPIFY_CLIENT_ID");
  if (!SHOPIFY_CLIENT_SECRET) throw new Error("Missing SHOPIFY_CLIENT_SECRET");
  if (!TW_API_KEY)            throw new Error("Missing TW_API_KEY");
  if (!SSK_API_KEY)           throw new Error("Missing SSK_API_KEY");

  const [
    shopifyInventory,
    { skuSales, totalOrders, totalRevenue, preOrderCount },
    shopifyToday,
    twStats,
    sskInventory,
    inboundPOs,
  ] = await Promise.all([
    getShopifyInventory(),
    getShopifyOrders7Days(),
    getShopifyOrdersToday(),
    getTripleWhaleStats(),
    getShipSidekickInventory(),
    getShipSidekickInbound(),
  ]);

  const skuMetrics = calcSKUMetrics(shopifyInventory, skuSales, sskInventory);

  const report = {
    syncedAt: new Date().toISOString(),
    summary: {
      totalUnitsAllSKUs: skuMetrics.reduce((s, r) => s + r.stock, 0),
      skusInStockout:    skuMetrics.filter(r => r.status === "stockout").length,
      skusCritical:      skuMetrics.filter(r => r.status === "critical").length,
      ordersToday:       shopifyToday.ordersToday,
      revenueToday:      Math.round(shopifyToday.revenueToday),
      unitsToday:        shopifyToday.unitsToday,
      blendedROAS7d:     twStats.blendedROAS,
      adSpend7d:         twStats.totalSpend,
      revenue7d:         twStats.netRevenue,
      preOrdersPending:  preOrderCount,
    },
    skus: skuMetrics,
    reorderAlerts: skuMetrics.filter(r => r.needsReorder).map(s => ({
      sku: s.sku, name: s.name, stock: s.stock,
      daysLeft: s.daysOfSupply, orderQty: s.reorderQty,
      urgency: s.status === "stockout" ? "IMMEDIATE" : s.daysOfSupply < 21 ? "HIGH" : "MEDIUM",
    })),
    inboundContainers: inboundPOs,
  };

  fs.writeFileSync("./supply-chain-data.json", JSON.stringify(report, null, 2));
  log("Report written to supply-chain-data.json");
  log(`Total stock: ${report.summary.totalUnitsAllSKUs.toLocaleString()} units`);
  log(`Orders today: ${report.summary.ordersToday}`);
  log(`Reorder alerts: ${report.reorderAlerts.length}`);
  if (report.reorderAlerts.length > 0) {
    for (const a of report.reorderAlerts) {
      log(`  ${a.urgency} — ${a.name}: ${a.stock} units (${a.daysLeft}d), order ${a.orderQty}`);
    }
  }
}

main().catch(err => {
  console.error("SYNC FAILED:", err.message);
  process.exit(1);
});
