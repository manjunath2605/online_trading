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
  const maxRiskRupees = toNumber(trade?.max_risk_rupees, NaN);
  const entryPrice = toNumber(trade?.estimated_option_price, NaN);
  const stopPrice = toNumber(trade?.option_stop_loss, NaN);
  const quantity = toNumber(
    trade?.simulatedQuantity || trade?.optionQuantity || trade?.orderResponse?.quantity || trade?.quantity,
    toNumber(trade?.optionLotAmount, NaN)
  );

  if (Number.isFinite(entryPrice) && Number.isFinite(stopPrice) && Number.isFinite(quantity) && quantity > 0) {
    // Both entryPrice and stopPrice must be in the option domain (stopPrice < entryPrice * 2)
    if (stopPrice > 0 && stopPrice < entryPrice * 2) {
      const riskPerUnit = Math.abs(entryPrice - stopPrice);
      const calculatedRisk = Number((riskPerUnit * quantity).toFixed(2));
      if (Number.isFinite(maxRiskRupees) && maxRiskRupees > 0) {
        return Math.min(calculatedRisk, maxRiskRupees);
      }
      return calculatedRisk;
    }
  }

  if (Number.isFinite(maxRiskRupees) && maxRiskRupees > 0) {
    return maxRiskRupees;
  }

  // Fallback: Default to max 20% risk of total option position value
  if (Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(quantity) && quantity > 0) {
    return Number((entryPrice * quantity * 0.20).toFixed(2));
  }

  return 0;
};

const getSessionRiskSnapshot = ({ trades = [], sessionRiskLimit = 0 } = {}) => {
  const openTrades = (Array.isArray(trades) ? trades : []).filter((trade) => trade?.result === "OPEN" && trade?.duplicateTrade !== true);
  const sessionRiskUsed = openTrades.reduce((sum, trade) => sum + getTradeRiskAmount(trade), 0);
  const rawLimit = toNumber(sessionRiskLimit, 0);
  const sessionRiskLimitValue = rawLimit > 0 ? rawLimit : 35000;
  const sessionRiskExceeded = sessionRiskUsed > sessionRiskLimitValue;

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
  const rawDailyLimit = toNumber(dailyLossLimit, 0);
  const dailyLossLimitValue = rawDailyLimit > 0 ? rawDailyLimit : 15000;
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
