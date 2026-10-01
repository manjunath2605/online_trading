require("dotenv").config();

const mongoose = require("mongoose");
const Trade = require("../models/Trade");
const {
  getEntryOptionPrice,
  getExitOptionLotAmount,
  getExitOptionPrice,
  getOptionLotAmount,
  getOptionQuantity
} = require("../utils/optionPricing");

const MONGODB_URI = process.env.MONGODB_URI;
const DRY_RUN = process.argv.includes("--dry-run");
const TOLERANCE = 0.01;

const isFinitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const round2 = (value) => Number(Number(value).toFixed(2));
const differs = (left, right) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) > TOLERANCE;

async function main() {
  if (!MONGODB_URI) {
    throw new Error("Missing MONGODB_URI");
  }

  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000
  });

  const trades = await Trade.find({
    $or: [
      { estimated_option_price: { $exists: true } },
      { simulatedPrice: { $exists: true } },
      { currentOptionPrice: { $exists: true } },
      { optionLotAmount: { $exists: true } },
      { currentLotAmount: { $exists: true } },
      { exit_option_price: { $exists: true } },
      { exitOptionLotAmount: { $exists: true } },
      { current_pnl: { $exists: true } }
    ]
  }).select("_id symbol trade signal result quote_source quote_reliability estimated_option_price simulatedPrice currentOptionPrice optionLotAmount currentLotAmount exit_option_price exitOptionLotAmount current_pnl current_pnl_percent currentQuoteAvailable simulatedQuantity orderResponse exitOrderResponse");

  let matched = 0;
  let updated = 0;
  const samples = [];

  for (const trade of trades) {
    matched += 1;

    const quantity = getOptionQuantity(trade);
    if (!isFinitePositive(quantity)) {
      continue;
    }

    const storedEntryPrice = getEntryOptionPrice(trade);
    const storedExitPrice = getExitOptionPrice(trade);
    const entryLotAmount = Number.isFinite(Number(trade.optionLotAmount)) ? Number(trade.optionLotAmount) : NaN;
    const currentLotAmount = Number.isFinite(Number(trade.currentLotAmount)) ? Number(trade.currentLotAmount) : NaN;
    const exitLotAmount = Number.isFinite(Number(getExitOptionLotAmount(trade, quantity))) ? Number(getExitOptionLotAmount(trade, quantity)) : NaN;
    const entryFromLot = isFinitePositive(entryLotAmount) ? entryLotAmount / quantity : NaN;
    const currentFromLot = isFinitePositive(currentLotAmount) ? currentLotAmount / quantity : NaN;
    const exitFromLot = isFinitePositive(exitLotAmount) ? exitLotAmount / quantity : NaN;

    const canonicalEntryPrice = Number.isFinite(entryFromLot)
      ? round2(entryFromLot)
      : (Number.isFinite(storedEntryPrice) ? round2(storedEntryPrice) : NaN);

    const canonicalCurrentPrice = trade.result === "OPEN"
      ? (Number.isFinite(currentFromLot)
        ? round2(currentFromLot)
        : (Number.isFinite(Number(trade.currentOptionPrice)) ? round2(trade.currentOptionPrice) : canonicalEntryPrice))
      : (Number.isFinite(storedExitPrice)
        ? round2(storedExitPrice)
        : (Number.isFinite(exitFromLot)
          ? round2(exitFromLot)
          : canonicalEntryPrice));

    const canonicalExitPrice = trade.result === "OPEN"
      ? (Number.isFinite(storedExitPrice) ? round2(storedExitPrice) : NaN)
      : (Number.isFinite(storedExitPrice)
        ? round2(storedExitPrice)
        : (Number.isFinite(exitFromLot)
          ? round2(exitFromLot)
          : NaN));

    const canonicalEntryLotAmount = isFinitePositive(canonicalEntryPrice)
      ? round2(canonicalEntryPrice * quantity)
      : (isFinitePositive(entryLotAmount) ? round2(entryLotAmount) : NaN);

    const canonicalCurrentLotAmount = trade.result === "OPEN"
      ? (isFinitePositive(canonicalCurrentPrice) ? round2(canonicalCurrentPrice * quantity) : NaN)
      : (isFinitePositive(exitLotAmount) ? round2(exitLotAmount) : (isFinitePositive(canonicalExitPrice) ? round2(canonicalExitPrice * quantity) : NaN));

    const canonicalExitLotAmount = !trade.result || trade.result === "OPEN"
      ? (isFinitePositive(exitLotAmount) ? round2(exitLotAmount) : NaN)
      : (isFinitePositive(exitLotAmount) ? round2(exitLotAmount) : (isFinitePositive(canonicalExitPrice) ? round2(canonicalExitPrice * quantity) : NaN));

    const canonicalPnl = trade.result === "OPEN"
      ? (isFinitePositive(canonicalCurrentPrice) && isFinitePositive(canonicalEntryPrice)
        ? round2((canonicalCurrentPrice - canonicalEntryPrice) * quantity)
        : null)
      : (isFinitePositive(canonicalExitPrice) && isFinitePositive(canonicalEntryPrice)
        ? round2((canonicalExitPrice - canonicalEntryPrice) * quantity)
        : null);

    const canonicalPnlPercent = canonicalPnl !== null && isFinitePositive(canonicalEntryLotAmount)
      ? round2((canonicalPnl / canonicalEntryLotAmount) * 100)
      : null;

    const patch = { $set: {}, $unset: {} };
    let changed = false;

    if (isFinitePositive(canonicalEntryPrice) && differs(storedEntryPrice, canonicalEntryPrice)) {
      patch.$set.estimated_option_price = canonicalEntryPrice;
      patch.$set.simulatedPrice = canonicalEntryPrice;
      changed = true;
    }

    if (isFinitePositive(canonicalEntryLotAmount) && differs(entryLotAmount, canonicalEntryLotAmount)) {
      patch.$set.optionLotAmount = canonicalEntryLotAmount;
      changed = true;
    }

    if (trade.result === "OPEN") {
      if (isFinitePositive(canonicalCurrentPrice) && differs(Number(trade.currentOptionPrice), canonicalCurrentPrice)) {
        patch.$set.currentOptionPrice = canonicalCurrentPrice;
        changed = true;
      }

      if (isFinitePositive(canonicalCurrentLotAmount) && differs(currentLotAmount, canonicalCurrentLotAmount)) {
        patch.$set.currentLotAmount = canonicalCurrentLotAmount;
        changed = true;
      }
    } else {
      if (isFinitePositive(canonicalCurrentPrice) && differs(Number(trade.currentOptionPrice), canonicalCurrentPrice)) {
        patch.$set.currentOptionPrice = canonicalCurrentPrice;
        changed = true;
      }

      if (isFinitePositive(canonicalCurrentLotAmount) && differs(currentLotAmount, canonicalCurrentLotAmount)) {
        patch.$set.currentLotAmount = canonicalCurrentLotAmount;
        changed = true;
      }

      if (isFinitePositive(canonicalExitPrice) && differs(storedExitPrice, canonicalExitPrice)) {
        patch.$set.exit_option_price = canonicalExitPrice;
        changed = true;
      }

      if (isFinitePositive(canonicalExitLotAmount) && differs(exitLotAmount, canonicalExitLotAmount)) {
        patch.$set.exitOptionLotAmount = canonicalExitLotAmount;
        changed = true;
      }
    }

    if (canonicalPnl !== null && differs(Number(trade.current_pnl), canonicalPnl)) {
      patch.$set.current_pnl = canonicalPnl;
      changed = true;
    }

    if (canonicalPnlPercent !== null && differs(Number(trade.current_pnl_percent), canonicalPnlPercent)) {
      patch.$set.current_pnl_percent = canonicalPnlPercent;
      changed = true;
    }

    if (trade.result === "OPEN" && isFinitePositive(canonicalCurrentPrice) && trade.currentQuoteAvailable !== true) {
      patch.$set.currentQuoteAvailable = true;
      changed = true;
    }

    if (!changed) {
      continue;
    }

    updated += 1;

    if (samples.length < 20) {
      samples.push({
        id: String(trade._id),
        symbol: trade.symbol,
        trade: trade.trade,
        result: trade.result,
        quantity,
        storedEntryPrice: Number.isFinite(storedEntryPrice) ? round2(storedEntryPrice) : null,
        canonicalEntryPrice: isFinitePositive(canonicalEntryPrice) ? canonicalEntryPrice : null,
        storedCurrentPrice: Number.isFinite(Number(trade.currentOptionPrice)) ? round2(trade.currentOptionPrice) : null,
        canonicalCurrentPrice: isFinitePositive(canonicalCurrentPrice) ? canonicalCurrentPrice : null,
        storedExitPrice: Number.isFinite(storedExitPrice) ? round2(storedExitPrice) : null,
        canonicalExitPrice: isFinitePositive(canonicalExitPrice) ? canonicalExitPrice : null
      });
    }

    if (DRY_RUN) {
      console.log("[dry-run]", JSON.stringify({
        id: String(trade._id),
        symbol: trade.symbol,
        trade: trade.trade,
        result: trade.result,
        quantity,
        patch
      }));
      continue;
    }

    const setPatch = Object.keys(patch.$set).length > 0 ? patch.$set : undefined;
    const unsetPatch = Object.keys(patch.$unset).length > 0 ? patch.$unset : undefined;
    const update = {};
    if (setPatch) {
      update.$set = setPatch;
    }
    if (unsetPatch) {
      update.$unset = unsetPatch;
    }

    if (Object.keys(update).length > 0) {
      await Trade.updateOne({ _id: trade._id }, update);
    }
  }

  console.log(JSON.stringify({
    matched,
    updated,
    dryRun: DRY_RUN,
    samples
  }, null, 2));
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
