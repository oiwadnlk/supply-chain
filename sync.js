/**
 * Quasi Supply Chain — Daily Sync Script
 * Pulls from Shopify, Triple Whale, and ShipSidekick
 * Runs every morning at 6 AM via GitHub Actions
 *
 * SETUP: copy .env.example → .env and fill in your keys
 */

require("dotenv").config();
const fs = require("fs");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SHOPIFY_STORE   = "e1c5f3-7e.myshopify.com";
const SHOPIFY_TOKEN   = process.env.SHOPIFY_TOKEN;
const TW_API_KEY      = process.env.TW_API_KEY;
const SSK_API_KEY     = process.env.SSK_API_KEY;

const SKU_MAP = {
  "BCM-001": "Bio Collagen Mask",
  "SPM-002": "Salmon PDRM Mask",
  "NSM-003": "Night Sealing Mask",
  "NKM-004": "Neck Mask",
  "CHM-005": "Chest Mask",
  "MBS-006": "Multi Balm Stick",
  "EYP-007": "Eye Patches",
};

// Lead time settings (weeks)
const LEAD_TIME_PKG_READY = 9;
const LEAD_TIME_NO_PKG    = 11;
const SAFETY_STOCK_DAYS   = 21;
const TARGET_COVERAGE_DAYS = 90;

// ─── HELPERS ───────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function today() {
  return new Date().toISOString().split("T")[0];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} from ${url}: ${text}`);
  }
  return res.json();
}

// ─── SHOPIFY ───────────────────────────────────────────────────────────────
async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function getShopifyInventory() {
  log("Fetching Shopify inventory by SKU...");
  const query = `
    {
      products(first: 50) {
        edges {
          node {
            title
            variants(first: 20) {
              edges {
                node {
                  sku
                  inventoryQuantity
                  inventoryItem {
                    id
                    inventoryLevels(first: 5) {
                      edges {
                        node {
                          quantities(names: ["available"]) {
                            name
                            quantity
                          }
                          location {
                            name
                            id
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query);
  const inventory = {};
  for (const { node: product } of data.products.edges) {
    for (const { node: variant } of product.variants.edges) {
      if (!variant.sku) continue;
      // Sum available across all locations (ShipSidekick syncs to Shopify)
      let total = 0;
      for (const { node: level } of variant.inventoryItem.inventoryLevels.edges) {
        const avail = level.quantities.find(q => q.name === "available");
        if (avail) total += avail.quantity;
      }
      inventory[variant.sku] = {
        sku: variant.sku,
        productName: product.title,
        stock: total,
      };
    }
  }
  log(`Got inventory for ${Object.keys(inventory).length} SKUs`);
  return inventory;
}

async function getShopifyOrders7Days() {
  log("Fetching Shopify orders (last 7 days)...");
  const since = daysAgo(7);
  const query = `
    {
      orders(first: 250, query: "created_at:>='${since}' financial_status:paid") {
        edges {
          node {
            id
            totalPriceSet { shopMoney { amount } }
            lineItems(first: 20) {
              edges {
                node {
                  sku
                  quantity
                  originalUnitPriceSet { shopMoney { amount } }
                }
              }
            }
            tags
            createdAt
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query);
  const skuSales = {};
  let totalOrders = 0;
  let totalRevenue = 0;
  let preOrderCount = 0;

  for (const { node: order } of data.orders.edges) {
    totalOrders++;
    totalRevenue += parseFloat(order.totalPriceSet.shopMoney.amount);
    if (order.tags.includes("pre-order")) preOrderCount++;

    for (const { node: item } of order.lineItems.edges) {
      if (!item.sku) continue;
      if (!skuSales[item.sku]) skuSales[item.sku] = { units: 0, revenue: 0 };
      skuSales[item.sku].units += item.quantity;
      skuSales[item.sku].revenue +=
        item.quantity * parseFloat(item.originalUnitPriceSet.shopMoney.amount);
    }
  }

  log(`Got ${totalOrders} orders, $${totalRevenue.toFixed(2)} revenue (7d)`);
  return { skuSales, totalOrders, totalRevenue, preOrderCount };
}

async function getShopifyOrdersToday() {
  log("Fetching Shopify orders today...");
  const since = today();
  const query = `
    {
      orders(first: 250, query: "created_at:>='${since}' financial_status:paid") {
        edges {
          node {
            id
            totalPriceSet { shopMoney { amount } }
            lineItems(first: 20) {
              edges {
                node {
                  sku
                  quantity
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = await shopifyGraphQL(query);
  let ordersToday = 0;
  let revenueToday = 0;
  let unitsToday = 0;
  for (const { node: order } of data.orders.edges) {
    ordersToday++;
    revenueToday += parseFloat(order.totalPriceSet.shopMoney.amount);
    for (const { node: item } of order.lineItems.edges) {
      unitsToday += item.quantity;
    }
  }
  return { ordersToday, revenueToday, unitsToday };
}

// ─── TRIPLE WHALE ──────────────────────────────────────────────────────────
async function getTripleWhaleStats() {
  log("Fetching Triple Whale blended stats...");
  try {
    // Triple Whale Summary Stats endpoint
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
          metrics: [
            "blended-roas",
            "total-spend",
            "net-revenue",
            "orders",
            "cpa",
          ],
        }),
      }
    );

    if (!res.ok) throw new Error(`Triple Whale HTTP ${res.status}`);
    const data = await res.json();

    return {
      blendedROAS: data?.["blended-roas"] ?? null,
      totalSpend:  data?.["total-spend"]  ?? null,
      netRevenue:  data?.["net-revenue"]  ?? null,
      orders:      data?.["orders"]       ?? null,
      cpa:         data?.["cpa"]          ?? null,
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
    const res = await fetch(
      "https://www.shipsidekick.com/api/v1/inventory",
      {
        headers: {
          "Authorization": `Bearer ${SSK_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (!res.ok) throw new Error(`ShipSidekick HTTP ${res.status}`);
    const data = await res.json();
    // Normalize to { sku: quantity } map
    const inv = {};
    const items = data?.inventory ?? data?.items ?? data ?? [];
    for (const item of items) {
      const sku = item.sku ?? item.SKU ?? item.product_sku;
      const qty = item.quantity ?? item.available ?? item.onHand ?? 0;
      if (sku) inv[sku] = qty;
    }
    log(`ShipSidekick: ${Object.keys(inv).length} SKUs found`);
    return inv;
  } catch (err) {
    log(`ShipSidekick error (non-fatal): ${err.message}`);
    log("Falling back to Shopify inventory levels");
    return null;
  }
}

async function getShipSidekickInbound() {
  log("Fetching ShipSidekick inbound ASNs...");
  try {
    const res = await fetch(
      "https://www.shipsidekick.com/api/v1/purchase-orders",
      {
        headers: {
          "Authorization": `Bearer ${SSK_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (!res.ok) throw new Error(`ShipSidekick ASN HTTP ${res.status}`);
    const data = await res.json();
    const orders = data?.purchaseOrders ?? data?.orders ?? data ?? [];
    // Return pending/in-transit POs
    return orders.filter(o =>
      ["pending","in_transit","shipped","open"].includes(
        (o.status ?? "").toLowerCase()
      )
    ).map(o => ({
      poNumber:    o.poNumber ?? o.po_number ?? o.id,
      status:      o.status,
      qty:         o.totalQuantity ?? o.quantity ?? 0,
      expectedDate: o.expectedDate ?? o.expected_date ?? o.eta,
    }));
  } catch (err) {
    log(`ShipSidekick ASN error (non-fatal): ${err.message}`);
    return [];
  }
}

// ─── CALCULATIONS ──────────────────────────────────────────────────────────
function calcSKUMetrics(inventory, skuSales7d, sskInventory) {
  const results = [];

  for (const [sku, name] of Object.entries(SKU_MAP)) {
    const shopifyStock = inventory[sku]?.stock ?? 0;
    // Prefer ShipSidekick inventory if available (more accurate warehouse count)
    const stock = sskInventory?.[sku] ?? shopifyStock;
    const units7d = skuSales7d[sku]?.units ?? 0;
    const revenue7d = skuSales7d[sku]?.revenue ?? 0;
    const dailyAvg = Math.round((units7d / 7) * 10) / 10;
    const daysOfSupply = dailyAvg > 0 ? Math.round(stock / dailyAvg) : 999;
    const weeksOfSupply = Math.round(daysOfSupply / 7 * 10) / 10;
    const reorderPoint = Math.round(dailyAvg * LEAD_TIME_PKG_READY * 7);
    const needsReorder = stock <= reorderPoint;

    // Recommended order qty
    const targetUnits = Math.round(dailyAvg * (TARGET_COVERAGE_DAYS + SAFETY_STOCK_DAYS));
    const reorderQty = Math.max(0, targetUnits - stock);

    // Status
    let status = "healthy";
    if (stock === 0) status = "stockout";
    else if (daysOfSupply < 14) status = "critical";
    else if (daysOfSupply < 30) status = "low";

    results.push({
      sku,
      name,
      stock,
      units7d,
      revenue7d: Math.round(revenue7d),
      dailyAvg,
      daysOfSupply,
      weeksOfSupply,
      reorderPoint,
      needsReorder,
      reorderQty,
      status,
    });
  }

  return results;
}

// ─── OUTPUT ────────────────────────────────────────────────────────────────
function buildReport(skuMetrics, shopifyToday, twStats, inboundPOs) {
  const totalStock = skuMetrics.reduce((s, r) => s + r.stock, 0);
  const stockouts  = skuMetrics.filter(r => r.status === "stockout").length;
  const criticals  = skuMetrics.filter(r => r.status === "critical").length;
  const needsOrder = skuMetrics.filter(r => r.needsReorder);

  return {
    syncedAt: new Date().toISOString(),
    summary: {
      totalUnitsAllSKUs: totalStock,
      skusInStockout:    stockouts,
      skusCritical:      criticals,
      ordersToday:       shopifyToday.ordersToday,
      revenueToday:      Math.round(shopifyToday.revenueToday),
      unitsToday:        shopifyToday.unitsToday,
      blendedROAS7d:     twStats.blendedROAS,
      adSpend7d:         twStats.totalSpend,
      revenue7d:         twStats.netRevenue,
    },
    skus: skuMetrics,
    reorderAlerts: needsOrder.map(s => ({
      sku:        s.sku,
      name:       s.name,
      stock:      s.stock,
      daysLeft:   s.daysOfSupply,
      orderQty:   s.reorderQty,
      urgency:    s.status === "stockout" ? "IMMEDIATE" : s.daysOfSupply < 21 ? "HIGH" : "MEDIUM",
    })),
    inboundContainers: inboundPOs,
    leadTimes: {
      withPackaging:    `${LEAD_TIME_PKG_READY} weeks`,
      withoutPackaging: `${LEAD_TIME_NO_PKG} weeks`,
      safetyStock:      `${SAFETY_STOCK_DAYS} days`,
      targetCoverage:   `${TARGET_COVERAGE_DAYS} days`,
    },
  };
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  log("=== Quasi Supply Chain Sync Starting ===");

  // Validate keys
  if (!SHOPIFY_TOKEN) throw new Error("Missing SHOPIFY_TOKEN in .env");
  if (!TW_API_KEY)    throw new Error("Missing TW_API_KEY in .env");
  if (!SSK_API_KEY)   throw new Error("Missing SSK_API_KEY in .env");

  // Fetch all data in parallel
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

  // Calculate per-SKU metrics
  const skuMetrics = calcSKUMetrics(shopifyInventory, skuSales, sskInventory);

  // Build final report
  const report = buildReport(skuMetrics, shopifyToday, twStats, inboundPOs);

  // Write JSON output (GitHub Actions picks this up)
  const outputPath = "./supply-chain-data.json";
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  log(`Report written to ${outputPath}`);

  // Print summary to console
  log("=== SYNC COMPLETE ===");
  log(`Total stock: ${report.summary.totalUnitsAllSKUs.toLocaleString()} units`);
  log(`Orders today: ${report.summary.ordersToday} ($${report.summary.revenueToday.toLocaleString()})`);
  log(`Blended ROAS (7d): ${report.summary.blendedROAS7d ?? "N/A"}`);
  log(`SKUs needing reorder: ${report.reorderAlerts.length}`);

  if (report.reorderAlerts.length > 0) {
    log("⚠️  REORDER ALERTS:");
    for (const alert of report.reorderAlerts) {
      log(`   ${alert.urgency} — ${alert.name}: ${alert.stock} units left (${alert.daysLeft}d), order ${alert.orderQty} units`);
    }
  }

  if (inboundPOs.length > 0) {
    log("🚢 INBOUND CONTAINERS:");
    for (const po of inboundPOs) {
      log(`   PO ${po.poNumber}: ${po.qty} units, ETA ${po.expectedDate}, status: ${po.status}`);
    }
  }

  return report;
}

main().catch(err => {
  console.error("SYNC FAILED:", err.message);
  process.exit(1);
});
