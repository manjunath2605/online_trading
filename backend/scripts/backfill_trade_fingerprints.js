require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Trade = require("../models/Trade");
const { getTradeExecutionFingerprint } = require("../utils/tradeFingerprint");

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
    .select("_id createdAt symbol trade signal duplicateTrade executionFingerprint");

  const grouped = new Map();
  const updates = [];
  const duplicateIds = [];

  for (const trade of trades) {
    const fingerprint = getTradeExecutionFingerprint(trade, trade.createdAt);
    if (!fingerprint) {
      continue;
    }

    updates.push({
      updateOne: {
        filter: { _id: trade._id },
        update: {
          $set: {
            executionFingerprint: fingerprint,
            duplicateTrade: trade.duplicateTrade === true
          }
        }
      }
    });

    if (!grouped.has(fingerprint)) {
      grouped.set(fingerprint, []);
    }
    grouped.get(fingerprint).push(trade);
  }

  for (const [, rows] of grouped) {
    if (rows.length <= 1) {
      continue;
    }

    const keep = rows[rows.length - 1];
    for (const row of rows.slice(0, -1)) {
      if (row.duplicateTrade !== true) {
        duplicateIds.push(String(row._id));
      }
    }

    updates.push({
      updateOne: {
        filter: { _id: keep._id },
        update: {
          $set: {
            executionFingerprint: getTradeExecutionFingerprint(keep, keep.createdAt),
            duplicateTrade: false
          }
        }
      }
    });
  }

  if (duplicateIds.length > 0) {
    updates.push({
    updateMany: {
      filter: { _id: { $in: duplicateIds } },
      update: {
        $set: {
          duplicateTrade: true,
          duplicateReason: "fingerprint_collision"
        }
      }
    }
  });
  }

  if (updates.length === 0) {
    console.log(JSON.stringify({ matched: 0, modified: 0, duplicateIds: [] }, null, 2));
    return;
  }

  const result = await Trade.bulkWrite(updates, { ordered: false });
  console.log(JSON.stringify({
    matched: trades.length,
    modified: (result.modifiedCount || 0) + (result.upsertedCount || 0),
    duplicateIds
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
