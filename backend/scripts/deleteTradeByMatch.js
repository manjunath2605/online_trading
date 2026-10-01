require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Trade = require("../models/Trade");

const MARKET_TIMEZONE = process.env.MARKET_TIMEZONE || "Asia/Kolkata";

const target = {
  dateLabel: process.env.TRADE_DATE_LABEL || "2026-05-05",
  timeLabel: process.env.TRADE_TIME_LABEL || "10:03:19 am",
  symbol: process.env.TRADE_SYMBOL || "banknifty",
  trade: process.env.TRADE_NAME || "BANKNIFTY 54600 PE",
  signal: process.env.TRADE_SIGNAL || "BUY PUT"
};

const formatDate = (value) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MARKET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
};

const formatTime = (value) => new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true
}).format(new Date(value)).toLowerCase();

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("Missing MONGODB_URI");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const candidates = await Trade.find({
    createdAt: {
      $gte: new Date("2026-05-05T00:00:00.000Z"),
      $lt: new Date("2026-05-06T00:00:00.000Z")
    }
  });

  const matches = candidates.filter((trade) => {
    return formatDate(trade.createdAt) === target.dateLabel
      && formatTime(trade.createdAt) === target.timeLabel
      && String(trade.symbol || "").toLowerCase() === target.symbol.toLowerCase()
      && String(trade.trade || "").toUpperCase() === target.trade.toUpperCase()
      && String(trade.signal || "").toUpperCase() === target.signal.toUpperCase();
  });

  if (matches.length === 0) {
    console.log(JSON.stringify({ deleted: 0, matched: 0, target }, null, 2));
    return;
  }

  const tradeToDelete = matches[0];
  await Trade.deleteOne({ _id: tradeToDelete._id });

  const remainingSamePattern = await Trade.countDocuments({
    createdAt: {
      $gte: new Date("2026-05-05T00:00:00.000Z"),
      $lt: new Date("2026-05-06T00:00:00.000Z")
    },
    symbol: tradeToDelete.symbol,
    trade: tradeToDelete.trade,
    signal: tradeToDelete.signal
  });

  console.log(JSON.stringify({
    deleted: 1,
    matched: matches.length,
    deletedTradeId: String(tradeToDelete._id),
    remainingSamePattern
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
