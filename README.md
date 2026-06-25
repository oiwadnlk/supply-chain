# Quasi Supply Chain Sync

Pulls live data from **Shopify**, **Triple Whale**, and **ShipSidekick** every morning at 6 AM ET.
Outputs `supply-chain-data.json` which powers the supply chain dashboard.

---

## What it pulls

| Source | Data |
|---|---|
| Shopify | Per-SKU inventory, daily orders, revenue, units sold |
| Triple Whale | Blended ROAS, ad spend by channel, attributed revenue |
| ShipSidekick | Warehouse inventory counts, inbound container ASNs |

## Setup (one time, ~10 minutes)

### 1. Create a private GitHub repo

Go to github.com → New repository → name it `quasi-supply-chain` → set to **Private** → Create.

### 2. Upload these files

Drag and drop all files from this folder into the repo, OR use GitHub Desktop.

### 3. Add your API keys as GitHub Secrets

In your repo go to: **Settings → Secrets and variables → Actions → New repository secret**

Add these three secrets:

| Secret name | Value |
|---|---|
| `SHOPIFY_TOKEN` | `atkn_b56c8ac7544ed1c2414464a...` |
| `TW_API_KEY` | `052eefa5-f5ee-44ee-990d-62cc...` |
| `SSK_API_KEY` | `ssk_287a7a5baf771ae92c97305...` |

> ⚠️ Never put the actual key values in any file that gets committed — only in GitHub Secrets.

### 4. Enable GitHub Actions

Go to the **Actions** tab in your repo → click **"I understand my workflows, go ahead and enable them"**

### 5. Test it manually

Go to **Actions → Quasi Supply Chain Daily Sync → Run workflow → Run workflow**

It will run in ~30 seconds and commit `supply-chain-data.json` to your repo.

### 6. It's live

From now on it runs automatically every morning at 6 AM Eastern. No server, no cost.

---

## Running locally

```bash
npm install
# Create .env with your keys (see .env.example)
npm run sync
```

## Output format

`supply-chain-data.json` contains:

```json
{
  "syncedAt": "2026-06-25T11:00:00Z",
  "summary": {
    "totalUnitsAllSKUs": 4210,
    "skusInStockout": 3,
    "ordersToday": 142,
    "revenueToday": 10790,
    "blendedROAS7d": 3.8,
    "adSpend7d": 19880
  },
  "skus": [...],
  "reorderAlerts": [...],
  "inboundContainers": [...]
}
```

## SKUs tracked

1. Bio Collagen Mask (BCM-001)
2. Salmon PDRM Mask (SPM-002)
3. Night Sealing Mask (NSM-003)
4. Neck Mask (NKM-004)
5. Chest Mask (CHM-005)
6. Multi Balm Stick (MBS-006)
7. Eye Patches (EYP-007)
