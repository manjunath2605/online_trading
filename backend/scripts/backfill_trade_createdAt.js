require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Trade = require("../models/Trade");

const isValidDate = (value) => value instanceof Date && !Number.isNaN(value.getTime());

const getObjectIdDate = (id) => {
  try {
    if (id && typeof id.getTimestamp === "function") {
      return id.getTimestamp();
    }
  } catch (error) {
    return null;
  }

  const raw = String(id || "").trim();
  if (!/^[0-9a-fA-F]{24}$/.test(raw)) {
    return null;
  }

  const seconds = Number.parseInt(raw.slice(0, 8), 16);
  if (!Number.isFinite(seconds)) {
    return null;
  }

  return new Date(seconds * 1000);
};

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("Missing MONGODB_URI");
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000
  });

  const trades = await Trade.find({
    $or: [
      { createdAt: { $exists: false } },
      { createdAt: null },
      { createdAt: "" },
      { createdAt: { $type: "string" } }
    ]
  })
    .sort({ _id: 1 })
    .select("_id createdAt closedAt symbol trade signal");

  const operations = [];
  const skipped = [];

  for (const trade of trades) {
    const createdAt = getObjectIdDate(trade._id);
    if (!isValidDate(createdAt)) {
      skipped.push(String(trade._id));
      continue;
    }

    operations.push({
      updateOne: {
        filter: { _id: trade._id },
        update: {
          $set: {
            createdAt
          }
        }
      }
    });
  }

  if (operations.length === 0) {
    console.log(JSON.stringify({
      matched: trades.length,
      modified: 0,
      skipped
    }, null, 2));
    return;
  }

  const result = await Trade.bulkWrite(operations, { ordered: false });
  console.log(JSON.stringify({
    matched: trades.length,
    modified: result.modifiedCount || 0,
    skipped
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
