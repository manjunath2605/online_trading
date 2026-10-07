const mongoose = require("mongoose");
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const Trade = require("../models/Trade");
const { getEntryOptionPrice, getOptionQuantity, getExitOptionPrice } = require("../utils/optionPricing");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const trades = await Trade.find({}).sort({ createdAt: -1 });
  console.log(`Total trades in DB: ${trades.length}`);
  
  let mismatches = 0;
  for (const t of trades) {
    const entryOpt = getEntryOptionPrice(t);
    const exitOpt = getExitOptionPrice(t);
    const qty = getOptionQuantity(t) || 1;
    const entryLot = t.optionLotAmount || (entryOpt && qty ? Number((entryOpt * qty).toFixed(2)) : null);
    const exitLot = t.exitOptionLotAmount || (exitOpt && qty ? Number((exitOpt * qty).toFixed(2)) : null);
    const pnl = t.current_pnl;

    let calculatedPnl = null;
    if (t.result !== "OPEN" && entryOpt && exitOpt && qty) {
      calculatedPnl = Number(((exitOpt - entryOpt) * qty).toFixed(2));
    } else if (t.result !== "OPEN" && exitLot !== null && entryLot !== null) {
      calculatedPnl = Number((exitLot - entryLot).toFixed(2));
    }

    const hasPnlMismatch = calculatedPnl !== null && pnl !== null && Math.abs(calculatedPnl - pnl) > 0.1;
    const hasLotMismatch = (entryLot && entryOpt && Math.abs(entryLot - entryOpt * qty) > 0.1) ||
                           (exitLot && exitOpt && Math.abs(exitLot - exitOpt * qty) > 0.1);

    if (hasPnlMismatch || hasLotMismatch) {
      mismatches++;
      console.log(`Mismatch on Trade ${t._id} (${t.trade}, result: ${t.result}):`);
      console.log(`  EntryOpt: ${entryOpt}, Qty: ${qty}, EntryLot: ${entryLot}`);
      console.log(`  ExitOpt: ${exitOpt}, ExitLot: ${exitLot}`);
      console.log(`  Stored PnL: ${pnl}, Calculated PnL: ${calculatedPnl}, diff: ${calculatedPnl !== null && pnl !== null ? Math.abs(calculatedPnl - pnl) : 'N/A'}`);
      console.log(`  Reason: ${t.exit_reason}`);
    }
  }

  console.log(`\nTotal mismatches found: ${mismatches}`);
  await mongoose.disconnect();
})();

