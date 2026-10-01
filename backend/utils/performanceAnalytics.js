const { getEntryOptionPrice, getExitOptionPrice, getOptionQuantity } = require("./optionPricing");

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isValidDate = (value) => value instanceof Date && !Number.isNaN(value.getTime());

const resolveTradeDate = (trade = {}) => {
  const candidates = [trade.createdAt, trade.closedAt, trade.tradeDate];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const date = new Date(candidate);
    if (isValidDate(date)) {
      return date;
    }
  }

  const tradeId = String(trade?._id || "");
  if (/^[a-f0-9]{24}$/i.test(tradeId)) {
    const seconds = Number.parseInt(tradeId.slice(0, 8), 16);
    if (Number.isFinite(seconds)) {
      const derivedDate = new Date(seconds * 1000);
      if (isValidDate(derivedDate)) {
        return derivedDate;
      }
    }
  }

  return null;
};

const getTradeDirection = (trade = {}) => {
  return String(trade.signal || "").trim().toUpperCase() === "BUY PUT" ? -1 : 1;
};

const getTradeInvestedAmount = (trade = {}) => {
  const candidates = [
    trade.entryLotAmount,
    trade.optionLotAmount,
    trade.simulatedAmount
  ];

  for (const candidate of candidates) {
    const value = toNumber(candidate, NaN);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  const optionPrice = getEntryOptionPrice(trade);
  const optionQuantity = getOptionQuantity(trade);
  if (optionPrice > 0 && optionQuantity > 0) {
    return Number((optionPrice * optionQuantity).toFixed(2));
  }

  return 0;
};

const getTradeClosedPnl = (trade = {}) => {
  const lotPnl = toNumber(trade.lotPnl, NaN);
  if (Number.isFinite(lotPnl)) {
    return lotPnl;
  }

  const entryLotAmount = toNumber(trade.entryLotAmount, NaN);
  const exitLotAmount = toNumber(trade.exitLotAmount, NaN);
  if (Number.isFinite(entryLotAmount) && Number.isFinite(exitLotAmount)) {
    return Number((exitLotAmount - entryLotAmount).toFixed(2));
  }

  const entryOptionPrice = getEntryOptionPrice(trade);
  const exitOptionPrice = getExitOptionPrice(trade);
  const optionQuantity = getOptionQuantity(trade);
  if (entryOptionPrice > 0 && exitOptionPrice > 0 && optionQuantity > 0) {
    return Number(((exitOptionPrice - entryOptionPrice) * optionQuantity).toFixed(2));
  }

  const entrySpot = toNumber(trade.price, NaN);
  const exitSpot = toNumber(trade.exit_price, NaN);
  const invested = getTradeInvestedAmount(trade);
  if (Number.isFinite(entrySpot) && Number.isFinite(exitSpot) && entrySpot > 0 && invested > 0) {
    const direction = getTradeDirection(trade);
    return Number((((exitSpot - entrySpot) * direction) * (invested / entrySpot)).toFixed(2));
  }

  return 0;
};

const getTradeOpenPnl = (trade = {}) => {
  const currentPnl = toNumber(trade.current_pnl, NaN);
  if (Number.isFinite(currentPnl)) {
    return currentPnl;
  }

  const currentLotAmount = toNumber(trade.currentLotAmount, NaN);
  const entryLotAmount = toNumber(trade.entryLotAmount, NaN);
  if (Number.isFinite(currentLotAmount) && Number.isFinite(entryLotAmount)) {
    return Number((currentLotAmount - entryLotAmount).toFixed(2));
  }

  return 0;
};

const getStrategyTradePnl = (trade = {}) => {
  return trade.result === "OPEN" ? getTradeOpenPnl(trade) : getTradeClosedPnl(trade);
};

const getUnderlyingBaselinePnl = (trade = {}) => {
  const entrySpot = toNumber(trade.price, NaN);
  const exitSpot = toNumber(trade.exit_price, NaN);
  const invested = getTradeInvestedAmount(trade);
  if (!Number.isFinite(entrySpot) || !Number.isFinite(exitSpot) || entrySpot <= 0 || invested <= 0) {
    return null;
  }

  const direction = getTradeDirection(trade);
  return Number((((exitSpot - entrySpot) * direction) * (invested / entrySpot)).toFixed(2));
};

const calculateCurveStats = (trades, pnlSelector) => {
  const closedTrades = trades
    .filter((trade) => trade.result !== "OPEN")
    .map((trade) => {
      const tradeDate = resolveTradeDate(trade);
      return {
        trade,
        tradeDate,
        pnl: Number(pnlSelector(trade) || 0)
      };
    })
    .filter((entry) => entry.tradeDate && Number.isFinite(entry.pnl))
    .sort((a, b) => a.tradeDate.getTime() - b.tradeDate.getTime());

  let grossProfit = 0;
  let grossLoss = 0;
  let netPnl = 0;
  let wins = 0;
  let losses = 0;
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  const equityCurve = [];

  for (const entry of closedTrades) {
    const pnl = Number(entry.pnl.toFixed(2));
    netPnl = Number((netPnl + pnl).toFixed(2));
    cumulative = netPnl;

    if (pnl > 0) {
      grossProfit = Number((grossProfit + pnl).toFixed(2));
      wins += 1;
    } else if (pnl < 0) {
      grossLoss = Number((grossLoss + Math.abs(pnl)).toFixed(2));
      losses += 1;
    }

    peak = Math.max(peak, cumulative);
    const drawdown = Number((peak - cumulative).toFixed(2));
    const drawdownPct = peak > 0 ? Number(((drawdown / peak) * 100).toFixed(2)) : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdownPct);

    equityCurve.push({
      date: entry.tradeDate.toISOString(),
      pnl,
      equity: cumulative,
      drawdown,
      drawdownPercent: drawdownPct
    });
  }

  const closedCount = closedTrades.length;
  const winRate = closedCount ? Number(((wins / closedCount) * 100).toFixed(2)) : 0;
  const expectancyPerTrade = closedCount ? Number((netPnl / closedCount).toFixed(2)) : 0;
  const avgWin = wins ? Number((grossProfit / wins).toFixed(2)) : 0;
  const avgLoss = losses ? Number((grossLoss / losses).toFixed(2)) : 0;
  const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : null;
  const lossRate = closedCount ? Number(((losses / closedCount) * 100).toFixed(2)) : 0;

  return {
    trades: closedCount,
    wins,
    losses,
    winRate,
    lossRate,
    grossProfit,
    grossLoss,
    netPnl: Number(netPnl.toFixed(2)),
    expectancyPerTrade,
    avgWin,
    avgLoss,
    profitFactor,
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    maxDrawdownPercent: Number(maxDrawdownPercent.toFixed(2)),
    equityCurve
  };
};

const buildPerformanceReport = (trades = [], options = {}) => {
  const allTrades = Array.isArray(trades) ? trades : [];
  const openTrades = allTrades.filter((trade) => trade.result === "OPEN");
  const closedTrades = allTrades.filter((trade) => trade.result !== "OPEN");
  const strategy = calculateCurveStats(allTrades, getStrategyTradePnl);
  const baseline = calculateCurveStats(closedTrades, getUnderlyingBaselinePnl);
  const openUnrealizedPnl = Number(openTrades.reduce((sum, trade) => sum + getTradeOpenPnl(trade), 0).toFixed(2));

  return {
    generatedAt: new Date().toISOString(),
    source: "stored_trades_realized",
    strategyName: "current_strategy_realized",
    filters: {
      start: options.start || null,
      end: options.end || null,
      symbol: options.symbol || null
    },
    totals: {
      trades: allTrades.length,
      closedTrades: closedTrades.length,
      openTrades: openTrades.length
    },
    strategy: {
      ...strategy,
      openUnrealizedPnl,
      totalWithOpen: Number((strategy.netPnl + openUnrealizedPnl).toFixed(2))
    },
    baseline: {
      ...baseline,
      openUnrealizedPnl: 0,
      totalWithOpen: baseline.netPnl
    },
    comparison: {
      netPnlDelta: Number((strategy.netPnl - baseline.netPnl).toFixed(2)),
      expectancyDelta: Number((strategy.expectancyPerTrade - baseline.expectancyPerTrade).toFixed(2)),
      winRateDelta: Number((strategy.winRate - baseline.winRate).toFixed(2)),
      profitFactorDelta: strategy.profitFactor !== null && baseline.profitFactor !== null
        ? Number((strategy.profitFactor - baseline.profitFactor).toFixed(2))
        : null,
      maxDrawdownDelta: Number((strategy.maxDrawdown - baseline.maxDrawdown).toFixed(2))
    }
  };
};

module.exports = {
  buildPerformanceReport,
  getStrategyTradePnl,
  getTradeClosedPnl,
  getTradeOpenPnl,
  getTradeInvestedAmount,
  getUnderlyingBaselinePnl,
  resolveTradeDate
};
