require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Trade = require("../models/Trade");

const TRADING_START_DATE = process.env.TRADING_START_DATE || "2026-04-09";
const MARKET_TIMEZONE = process.env.MARKET_TIMEZONE || "Asia/Kolkata";

const getMarketDateKey = (value = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: MARKET_TIMEZONE
}).format(new Date(value));

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("Missing MONGODB_URI");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const trades = await Trade.find({
    createdAt: {
      $gte: new Date(`${TRADING_START_DATE}T00:00:00.000Z`)
    }
  });

  const todayKey = getMarketDateKey();
  const todayTrades = trades.filter((trade) => getMarketDateKey(trade.createdAt) === todayKey);
  const tradeIds = todayTrades.map((trade) => trade._id);

  if (tradeIds.length === 0) {
    console.log(JSON.stringify({ todayKey, deleted: 0 }, null, 2));
    return;
  }

  const result = await Trade.deleteMany({ _id: { $in: tradeIds } });
  console.log(JSON.stringify({ todayKey, deleted: result.deletedCount || 0 }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
