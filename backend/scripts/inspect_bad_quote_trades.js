require("dotenv").config();

const mongoose = require("mongoose");
const Trade = require("../models/Trade");
const {
  getEntryOptionPrice,
  getExitOptionPrice,
  getOptionLotAmount,
  getOptionQuantity
} = require("../utils/optionPricing");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000
  });

  const query = {
    createdAt: { $gte: new Date("2026-04-29T00:00:00.000Z") },
    $or: [
      { current_pnl: 25725 },
      { current_pnl: 25725.0 },
      { estimated_option_price: 148.25 },
      { estimated_option_price: 1005.75 },
      { exit_option_price: 1005.75 },
      { exitOptionLotAmount: 30172.5 },
      { currentOptionPrice: 148.25 }
    ]
  };

  const rows = await Trade.find(query)
    .sort({ createdAt: -1 })
    .limit(20)
    .select("_id createdAt symbol trade signal result quote_source quote_reliability estimated_option_price simulatedPrice currentOptionPrice current_pnl current_pnl_percent exit_option_price exitOptionLotAmount optionLotAmount currentLotAmount simulatedQuantity orderResponse");

  console.log(JSON.stringify(rows.map((trade) => ({
    _id: String(trade._id),
    createdAt: trade.createdAt,
    symbol: trade.symbol,
    trade: trade.trade,
    signal: trade.signal,
    result: trade.result,
    quote_source: trade.quote_source,
    quote_reliability: trade.quote_reliability,
    entryOptionPrice: Number.isFinite(getEntryOptionPrice(trade)) ? Number(getEntryOptionPrice(trade).toFixed(2)) : null,
    exitOptionPrice: Number.isFinite(getExitOptionPrice(trade)) ? Number(getExitOptionPrice(trade).toFixed(2)) : null,
    optionQuantity: Number.isFinite(getOptionQuantity(trade)) ? getOptionQuantity(trade) : null,
    entryLotAmount: Number.isFinite(getOptionLotAmount(getEntryOptionPrice(trade), getOptionQuantity(trade))) ? getOptionLotAmount(getEntryOptionPrice(trade), getOptionQuantity(trade)) : null,
    exitLotAmount: trade.exitOptionLotAmount ?? null,
    current_pnl: trade.current_pnl,
    current_pnl_percent: trade.current_pnl_percent
  })), null, 2));
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
