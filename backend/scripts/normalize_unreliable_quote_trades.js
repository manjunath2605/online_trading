require("dotenv").config();

const mongoose = require("mongoose");
const Trade = require("../models/Trade");
const {
  getEntryOptionPrice,
  getOptionLotAmount,
  getOptionQuantity
} = require("../utils/optionPricing");

const MONGODB_URI = process.env.MONGODB_URI;
const DRY_RUN = process.argv.includes("--dry-run");

const normalizeFilter = {
  result: { $ne: "OPEN" },
  $or: [
    { quote_source: { $in: ["stale_quote", "rejected_no_quote"] } },
    { quote_reliability: { $in: ["stale_quote", "rejected_no_quote"] } }
  ]
};

async function main() {
  if (!MONGODB_URI) {
    throw new Error("Missing MONGODB_URI");
  }

  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000
  });

  const trades = await Trade.find(normalizeFilter).select("_id trade symbol quote_source quote_reliability estimated_option_price simulatedPrice currentOptionPrice current_pnl current_pnl_percent optionLotAmount currentLotAmount simulatedQuantity orderResponse");

  let updated = 0;
  for (const trade of trades) {
    const entryOptionPrice = getEntryOptionPrice(trade);
    const optionQuantity = getOptionQuantity(trade);
    const entryLotAmount = getOptionLotAmount(entryOptionPrice, optionQuantity);
    const patch = {
      $set: {
        quote_source: trade.quote_source || trade.quote_reliability || "rejected_no_quote",
        quote_reliability: trade.quote_reliability || trade.quote_source || "rejected_no_quote",
        current_pnl: 0,
        current_pnl_percent: 0,
        currentQuoteAvailable: false
      },
      $unset: {
        currentOptionPrice: "",
        currentLotAmount: ""
      }
    };

    if (Number.isFinite(entryOptionPrice) && entryOptionPrice > 0) {
      patch.$set.estimated_option_price = Number(entryOptionPrice.toFixed(2));
      patch.$set.simulatedPrice = Number(entryOptionPrice.toFixed(2));
    }

    if (Number.isFinite(entryLotAmount) && entryLotAmount > 0) {
      patch.$set.optionLotAmount = entryLotAmount;
    }

    if (DRY_RUN) {
      console.log("[dry-run]", JSON.stringify({
        id: String(trade._id),
        symbol: trade.symbol,
        trade: trade.trade,
        quote_source: trade.quote_source,
        quote_reliability: trade.quote_reliability,
        estimated_option_price: trade.estimated_option_price,
        simulatedPrice: trade.simulatedPrice,
        currentOptionPrice: trade.currentOptionPrice,
        current_pnl: trade.current_pnl,
        current_pnl_percent: trade.current_pnl_percent,
        canonical_entry_option_price: Number.isFinite(entryOptionPrice) ? Number(entryOptionPrice.toFixed(2)) : null,
        canonical_option_quantity: Number.isFinite(optionQuantity) ? optionQuantity : null,
        canonical_entry_lot_amount: Number.isFinite(entryLotAmount) ? entryLotAmount : null
      }));
      continue;
    }

    await Trade.updateOne({ _id: trade._id }, patch);
    updated += 1;
  }

  console.log(JSON.stringify({
    matched: trades.length,
    updated,
    dryRun: DRY_RUN
  }));
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });
