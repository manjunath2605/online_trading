const mongoose = require("mongoose");
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const Trade = require("../models/Trade");
const { getEntryOptionPrice, getOptionQuantity, getExitOptionPrice } = require("../utils/optionPricing");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const trades = await Trade.find({}).sort({ createdAt: -1 });
  console.log(`Auditing and repairing ${trades.length} trades in MongoDB...`);

  let repairedCount = 0;

  for (const t of trades) {
    let modified = false;
    const entryOpt = getEntryOptionPrice(t);
    const exitOpt = getExitOptionPrice(t);
    const qty = getOptionQuantity(t) || 1;

    // Check entry lot amount
    if (entryOpt && qty > 0) {
      const correctEntryLot = Number((entryOpt * qty).toFixed(2));
      if (!t.optionLotAmount || Math.abs(t.optionLotAmount - correctEntryLot) > 0.05) {
        console.log(`Fixing Trade ${t._id} optionLotAmount: was ${t.optionLotAmount}, setting to ${correctEntryLot}`);
        t.optionLotAmount = correctEntryLot;
        modified = true;
      }
    }

    // For closed trades, check exit lot amount and PnL
    if (t.result !== "OPEN" && exitOpt && qty > 0) {
      const correctExitLot = Number((exitOpt * qty).toFixed(2));
      if (!t.exitOptionLotAmount || Math.abs(t.exitOptionLotAmount - correctExitLot) > 0.05) {
        console.log(`Fixing Trade ${t._id} exitOptionLotAmount: was ${t.exitOptionLotAmount}, setting to ${correctExitLot}`);
        t.exitOptionLotAmount = correctExitLot;
        modified = true;
      }

      if (entryOpt) {
        const correctPnl = Number(((exitOpt - entryOpt) * qty).toFixed(2));
        if (t.current_pnl === undefined || t.current_pnl === null || Math.abs(t.current_pnl - correctPnl) > 0.05) {
          console.log(`Fixing Trade ${t._id} current_pnl: was ${t.current_pnl}, setting to ${correctPnl}`);
          t.current_pnl = correctPnl;
          modified = true;
        }

        const entryLot = t.optionLotAmount || (entryOpt * qty);
        if (entryLot > 0) {
          const correctPnlPct = Number(((correctPnl / entryLot) * 100).toFixed(2));
          if (t.current_pnl_percent === undefined || t.current_pnl_percent === null || Math.abs(t.current_pnl_percent - correctPnlPct) > 0.05) {
            t.current_pnl_percent = correctPnlPct;
            modified = true;
          }
        }

        const correctResult = correctPnl >= 0 ? "WIN" : "LOSS";
        if (t.result !== correctResult) {
          console.log(`Fixing Trade ${t._id} result: was ${t.result}, setting to ${correctResult}`);
          t.result = correctResult;
          modified = true;
        }
      }
    }

    if (modified) {
      await t.save();
      repairedCount++;
    }
  }

  console.log(`Repair completed: ${repairedCount} trades updated.`);
  await mongoose.disconnect();
})();

