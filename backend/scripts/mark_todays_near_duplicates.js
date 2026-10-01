require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Trade = require("../models/Trade");

const MARKET_TIMEZONE = process.env.MARKET_TIMEZONE || "Asia/Kolkata";
const DUPLICATE_WINDOW_MS = Number(process.env.DUPLICATE_WINDOW_MS || 60000);

const getMarketDateKey = (value = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: MARKET_TIMEZONE
}).format(new Date(value));

const getStartOfTodayUtc = () => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MARKET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const year = parts.find((part) => part.type === "year")?.value || "1970";
  const month = parts.find((part) => part.type === "month")?.value || "01";
  const day = parts.find((part) => part.type === "day")?.value || "01";
  const localMidnight = new Date(`${year}-${month}-${day}T00:00:00`);
  return new Date(localMidnight.toISOString());
};

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("Missing MONGODB_URI");
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000
  });

  const todayKey = getMarketDateKey(new Date());
  const startOfToday = getStartOfTodayUtc();

  const trades = await Trade.find({
    createdAt: { $gte: startOfToday },
    duplicateTrade: { $ne: true }
  })
    .sort({ createdAt: 1 })
    .select("_id createdAt symbol trade signal result duplicateTrade");

  const grouped = new Map();
  for (const trade of trades) {
    const key = [
      String(trade.symbol || "").toUpperCase(),
      String(trade.trade || "").toUpperCase(),
      String(trade.signal || "").toUpperCase()
    ].join("|");
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(trade);
  }

  const duplicateIds = [];
  for (const [, rows] of grouped) {
    let cluster = [];
    for (const row of rows) {
      if (cluster.length === 0) {
        cluster.push(row);
        continue;
      }

      const previous = cluster[cluster.length - 1];
      const deltaMs = new Date(row.createdAt).getTime() - new Date(previous.createdAt).getTime();
      if (deltaMs <= DUPLICATE_WINDOW_MS) {
        cluster.push(row);
        continue;
      }

      if (cluster.length > 1) {
        duplicateIds.push(...cluster.slice(0, -1).map((entry) => entry._id));
      }
      cluster = [row];
    }

    if (cluster.length > 1) {
      duplicateIds.push(...cluster.slice(0, -1).map((entry) => entry._id));
    }
  }

  const uniqueIds = [...new Set(duplicateIds.map((id) => String(id)))];
  if (uniqueIds.length === 0) {
    console.log(JSON.stringify({ todayKey, marked: 0, duplicateWindowMs: DUPLICATE_WINDOW_MS }, null, 2));
    return;
  }

  const result = await Trade.updateMany(
    { _id: { $in: uniqueIds } },
    {
      $set: {
        duplicateTrade: true,
        duplicateReason: "today_near_duplicate_same_contract"
      }
    }
  );

  console.log(JSON.stringify({
    todayKey,
    marked: result.modifiedCount || result.nModified || 0,
    duplicateWindowMs: DUPLICATE_WINDOW_MS,
    duplicateIds: uniqueIds
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
