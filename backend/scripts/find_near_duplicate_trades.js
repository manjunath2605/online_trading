require("dotenv").config();

const mongoose = require("mongoose");
const Trade = require("../models/Trade");

const WINDOW_MS = Number(process.env.DUPLICATE_WINDOW_MS || 2000);

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
    .select("_id createdAt symbol trade signal result estimated_option_price simulatedPrice currentOptionPrice current_pnl quote_source");

  const groups = [];
  for (let i = 1; i < trades.length; i += 1) {
    const prev = trades[i - 1];
    const curr = trades[i];
    const sameContract = String(prev.symbol || "").toUpperCase() === String(curr.symbol || "").toUpperCase()
      && String(prev.trade || "").toUpperCase() === String(curr.trade || "").toUpperCase()
      && String(prev.signal || "").toUpperCase() === String(curr.signal || "").toUpperCase();
    const delta = new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime();

    if (sameContract && delta >= 0 && delta <= WINDOW_MS) {
      groups.push({
        prev: {
          id: String(prev._id),
          createdAt: prev.createdAt,
          result: prev.result,
          estimated_option_price: prev.estimated_option_price,
          currentOptionPrice: prev.currentOptionPrice,
          current_pnl: prev.current_pnl,
          quote_source: prev.quote_source
        },
        curr: {
          id: String(curr._id),
          createdAt: curr.createdAt,
          result: curr.result,
          estimated_option_price: curr.estimated_option_price,
          currentOptionPrice: curr.currentOptionPrice,
          current_pnl: curr.current_pnl,
          quote_source: curr.quote_source
        },
        deltaMs: delta
      });
    }
  }

  console.log(JSON.stringify(groups, null, 2));
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
