require("dotenv").config();

const mongoose = require("mongoose");
const Trade = require("../models/Trade");

const WINDOW_MS = Number(process.env.DUPLICATE_WINDOW_MS || 2000);
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("Missing MONGODB_URI");
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000
  });

  const trades = await Trade.find({})
    .sort({ createdAt: 1 })
    .select("_id createdAt symbol trade signal result estimated_option_price simulatedPrice currentOptionPrice current_pnl quote_source duplicateTrade");

  const updates = [];
  let groups = 0;

  let cluster = [];
  const flush = async () => {
    if (cluster.length <= 1) {
      cluster = [];
      return;
    }

    groups += 1;
    const keep = cluster[cluster.length - 1];
    const duplicates = cluster.slice(0, -1);

    for (const trade of duplicates) {
      updates.push({
        id: String(trade._id),
        keep: String(keep._id),
        createdAt: trade.createdAt,
        keepCreatedAt: keep.createdAt,
        symbol: trade.symbol,
        trade: trade.trade,
        signal: trade.signal,
        result: trade.result
      });

      if (!DRY_RUN) {
        await Trade.updateOne(
          { _id: trade._id },
          {
            $set: {
              duplicateTrade: true,
              duplicateOfTradeId: String(keep._id),
              duplicateReason: "near_duplicate_trade_window"
            }
          }
        );
      }
    }

    cluster = [];
  };

  for (const trade of trades) {
    if (cluster.length === 0) {
      cluster.push(trade);
      continue;
    }

    const prev = cluster[cluster.length - 1];
    const sameContract = String(prev.symbol || "").toUpperCase() === String(trade.symbol || "").toUpperCase()
      && String(prev.trade || "").toUpperCase() === String(trade.trade || "").toUpperCase()
      && String(prev.signal || "").toUpperCase() === String(trade.signal || "").toUpperCase();
    const delta = new Date(trade.createdAt).getTime() - new Date(prev.createdAt).getTime();

    if (sameContract && delta >= 0 && delta <= WINDOW_MS) {
      cluster.push(trade);
      continue;
    }

    await flush();
    cluster.push(trade);
  }

  await flush();

  console.log(JSON.stringify({
    dryRun: DRY_RUN,
    groups,
    marked: updates.length,
    samples: updates.slice(0, 20)
  }, null, 2));

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
