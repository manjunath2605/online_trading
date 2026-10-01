require("dotenv").config();

const mongoose = require("mongoose");
const Trade = require("../models/Trade");

const tradeName = process.argv[2] || "BANKNIFTY 54100 PE";

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("Missing MONGODB_URI");
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000
  });

  const rows = await Trade.find({
    trade: tradeName
  })
    .sort({ createdAt: -1 })
    .select("_id createdAt symbol trade result approvalStatus executionMode estimated_option_price simulatedPrice currentOptionPrice optionLotAmount currentLotAmount exit_option_price exitOptionLotAmount current_pnl current_pnl_percent quote_source quote_reliability orderResponse exitOrderResponse currentQuoteAvailable");

  console.log(JSON.stringify(rows, null, 2));
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
