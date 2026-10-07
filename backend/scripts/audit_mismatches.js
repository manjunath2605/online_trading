const mongoose = require("mongoose");
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const Trade = require("../models/Trade");
const { getEntryOptionPrice, getOptionQuantity } = require("../utils/optionPricing");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const trades = await Trade.find({ result: { $in: ["WIN", "LOSS"] } }).sort({ createdAt: -1 }).limit(10);
  console.log(JSON.stringify(trades.map(t => {
    const entryOpt = getEntryOptionPrice(t);
    const exitOpt = t.exit_option_price;
    const qty = getOptionQuantity(t) || 1;
    const pnl = t.current_pnl;
    const lotPnl = t.lotPnl;
    const expectedPnl = (entryOpt && exitOpt && qty) ? Number(((exitOpt - entryOpt) * qty).toFixed(2)) : null;
    return {
      id: t._id,
      trade: t.trade,
      signal: t.signal,
      entrySpot: t.price,
      exitSpot: t.exit_price,
      entryOpt,
      exitOpt,
      qty,
      storedPnl: pnl,
      expectedPnl,
      mismatch: expectedPnl !== null && pnl !== null && Math.abs(expectedPnl - pnl) > 0.05,
      reason: t.exit_reason,
      createdAt: t.createdAt
    };
  }), null, 2));
  await mongoose.disconnect();
})();
