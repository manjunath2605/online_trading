require("dotenv").config();

const mongoose = require("mongoose");
const Trade = require("../models/Trade");
const { getOptionLotAmount } = require("../utils/optionPricing");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000
  });

  const filter = {
    symbol: "BANKNIFTY",
    trade: "BANKNIFTY 55600 PE",
    estimated_option_price: 148.25,
    current_pnl: 25725
  };

  const patch = {
    $set: {
      quote_source: "stale_quote",
      quote_reliability: "stale_quote",
      estimated_option_price: 1005.75,
      simulatedPrice: 1005.75,
      currentOptionPrice: 1005.75,
      optionLotAmount: getOptionLotAmount(1005.75, 30),
      currentLotAmount: getOptionLotAmount(1005.75, 30),
      current_pnl: 0,
      current_pnl_percent: 0,
      currentQuoteAvailable: false
    }
  };

  const result = await Trade.updateMany(filter, patch);
  console.log(JSON.stringify({
    matched: result.matchedCount ?? result.n,
    modified: result.modifiedCount ?? result.nModified
  }));

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
