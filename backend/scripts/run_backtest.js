require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Trade = require("../models/Trade");
const { buildPerformanceReport, resolveTradeDate } = require("../utils/performanceAnalytics");

const parseArgs = (argv) => {
  return argv.slice(2).reduce((acc, arg) => {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) {
      return acc;
    }

    acc[match[1]] = match[2];
    return acc;
  }, {});
};

const filterTrades = (trades, options = {}) => {
  const startDate = options.start ? new Date(`${options.start}T00:00:00.000Z`) : null;
  const endDate = options.end ? new Date(`${options.end}T23:59:59.999Z`) : null;
  const symbol = String(options.symbol || "").trim().toLowerCase();

  return trades.filter((trade) => {
    const tradeDate = resolveTradeDate(trade);
    if (!tradeDate) {
      return false;
    }

    if (startDate && tradeDate < startDate) {
      return false;
    }

    if (endDate && tradeDate > endDate) {
      return false;
    }

    if (symbol && String(trade.symbol || "").trim().toLowerCase() !== symbol) {
      return false;
    }

    return trade.duplicateTrade !== true;
  });
};

async function main() {
  const args = parseArgs(process.argv);

  if (!process.env.MONGODB_URI) {
    throw new Error("Missing MONGODB_URI");
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000
  });

  const trades = await Trade.find({})
    .sort({ createdAt: 1 })
    .select("_id createdAt closedAt symbol trade signal result duplicateTrade price exit_price entryLotAmount exitLotAmount optionLotAmount simulatedAmount lotPnl current_pnl currentLotAmount optionQuantity currentQuoteAvailable");

  const filteredTrades = filterTrades(trades, args);
  const report = buildPerformanceReport(filteredTrades, args);

  console.log(JSON.stringify({
    mode: "backtest",
    filters: args,
    report
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
