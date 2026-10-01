const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getTradeNetPnl = (trade) => {
  const lotPnl = toNumber(trade?.lotPnl, NaN);
  if (Number.isFinite(lotPnl)) {
    return lotPnl;
  }

  const closedPnl = toNumber(trade?.current_pnl, NaN);
  if (trade?.result === "LOSS" && Number.isFinite(closedPnl)) {
    return closedPnl;
  }

  if (trade?.result === "WIN" && Number.isFinite(closedPnl)) {
    return closedPnl;
  }

  if (Number.isFinite(toNumber(trade?.exitLotAmount, NaN)) && Number.isFinite(toNumber(trade?.entryLotAmount, NaN))) {
    return Number((toNumber(trade.exitLotAmount) - toNumber(trade.entryLotAmount)).toFixed(2));
  }

  return 0;
};

const getTradeRiskAmount = (trade) => {
  const entryPrice = toNumber(trade?.estimated_option_price, NaN);
  const stopPrice = toNumber(trade?.option_stop_loss, NaN);
  const fallbackStop = toNumber(trade?.stop_loss, NaN);
  const quantity = toNumber(trade?.simulatedQuantity, NaN);
  const fallbackQuantity = toNumber(trade?.optionLotAmount, NaN);

  if (Number.isFinite(entryPrice) && Number.isFinite(stopPrice) && Number.isFinite(quantity) && quantity > 0) {
    return Number(Math.abs(entryPrice - stopPrice) * quantity);
  }

  if (Number.isFinite(entryPrice) && Number.isFinite(fallbackStop) && Number.isFinite(quantity) && quantity > 0) {
    return Number(Math.abs(entryPrice - fallbackStop) * quantity);
  }

  if (Number.isFinite(entryPrice) && Number.isFinite(stopPrice) && Number.isFinite(fallbackQuantity) && fallbackQuantity > 0) {
    return Number(Math.abs(entryPrice - stopPrice) * fallbackQuantity);
  }

  return 0;
};

const getSessionRiskSnapshot = ({ trades = [], sessionRiskLimit = 0 } = {}) => {
  const openTrades = (Array.isArray(trades) ? trades : []).filter((trade) => trade?.result === "OPEN" && trade?.duplicateTrade !== true);
  const sessionRiskUsed = openTrades.reduce((sum, trade) => sum + getTradeRiskAmount(trade), 0);
  const sessionRiskLimitValue = toNumber(sessionRiskLimit, 0);
  const sessionRiskExceeded = sessionRiskLimitValue > 0 && sessionRiskUsed > sessionRiskLimitValue;

  return {
    sessionRiskUsed: Number(sessionRiskUsed.toFixed(2)),
    sessionRiskLimit: Number(sessionRiskLimitValue.toFixed(2)),
    sessionRiskRemaining: Number(Math.max(sessionRiskLimitValue - sessionRiskUsed, 0).toFixed(2)),
    sessionRiskExceeded,
    openTrades: openTrades.length
  };
};

const getDailyLossSnapshot = ({ trades = [], dailyLossLimit = 0 } = {}) => {
  const todayTrades = (Array.isArray(trades) ? trades : []).filter((trade) => {
    if (!trade?.createdAt) {
      return false;
    }
    const createdAt = new Date(trade.createdAt);
    return Number.isFinite(createdAt.getTime()) && createdAt.toDateString() === new Date().toDateString();
  });

  const realizedLoss = todayTrades
    .filter((trade) => trade?.result === "LOSS")
    .reduce((sum, trade) => sum + Math.min(0, getTradeNetPnl(trade)), 0);

  const openLoss = todayTrades
    .filter((trade) => trade?.result === "OPEN")
    .reduce((sum, trade) => sum + Math.min(0, toNumber(trade?.current_pnl, 0)), 0);

  const dailyPnl = Number((realizedLoss + openLoss).toFixed(2));
  const dailyLossLimitValue = toNumber(dailyLossLimit, 0);
  const dailyLossExceeded = dailyLossLimitValue > 0 && dailyPnl <= -dailyLossLimitValue;

  return {
    dailyPnl,
    dailyLossLimit: Number(dailyLossLimitValue.toFixed(2)),
    dailyLossRemaining: Number(Math.max(dailyLossLimitValue + dailyPnl, 0).toFixed(2)),
    dailyLossExceeded,
    closedLoss: Number(realizedLoss.toFixed(2)),
    openLoss: Number(openLoss.toFixed(2)),
    tradeCount: todayTrades.length
  };
};

const getRiskCapGate = ({ trades = [], sessionRiskLimit = 0, dailyLossLimit = 0 } = {}) => {
  const sessionSnapshot = getSessionRiskSnapshot({ trades, sessionRiskLimit });
  const dailySnapshot = getDailyLossSnapshot({ trades, dailyLossLimit });

  if (sessionSnapshot.sessionRiskExceeded) {
    return {
      allowed: false,
      reason: "session_risk_cap_exceeded",
      details: sessionSnapshot
    };
  }

  if (dailySnapshot.dailyLossExceeded) {
    return {
      allowed: false,
      reason: "daily_loss_cap_exceeded",
      details: dailySnapshot
    };
  }

  return {
    allowed: true,
    reason: null,
    details: {
      session: sessionSnapshot,
      daily: dailySnapshot
    }
  };
};

const buildRuleReport = ({ symbol, signalData = {}, trades = [], sessionRiskLimit = 0, dailyLossLimit = 0 } = {}) => {
  const sessionSnapshot = getSessionRiskSnapshot({ trades, sessionRiskLimit });
  const dailySnapshot = getDailyLossSnapshot({ trades, dailyLossLimit });
  const riskGate = getRiskCapGate({ trades, sessionRiskLimit, dailyLossLimit });

  return {
    symbol: String(symbol || signalData?.symbol || "").toUpperCase(),
    signal: signalData?.signal || "HOLD",
    trade: signalData?.trade || "WAIT",
    price: toNumber(signalData?.price, 0),
    support: signalData?.support ?? null,
    resistance: signalData?.resistance ?? null,
    market_regime: signalData?.market_regime || "UNKNOWN",
    stop_loss: signalData?.stop_loss ?? null,
    target: signalData?.target ?? null,
    risk_reward: toNumber(signalData?.risk_reward, 0),
    quality_score: toNumber(signalData?.quality_score, 0),
    session_risk: sessionSnapshot,
    daily_loss: dailySnapshot,
    execution_allowed: riskGate.allowed,
    execution_reason: riskGate.reason,
    risk_gate: riskGate
  };
};

module.exports = {
  getTradeNetPnl,
  getTradeRiskAmount,
  getSessionRiskSnapshot,
  getDailyLossSnapshot,
  getRiskCapGate,
  buildRuleReport
};
