/**
 * Native technical analysis engine for online trading backend.
 * Computes live technical indicators, market regime, support/resistance,
 * option strike/targets, and directional signals directly from live Angel One candles.
 * Ensures zero downtime even when remote AI engines or third-party quote APIs are rate-limited or sleeping.
 */

function toNumber(val, fallback = 0) {
  const num = Number(val);
  return Number.isFinite(num) ? num : fallback;
}

function calculateEMA(prices, period) {
  if (!prices || prices.length === 0) return [];
  const k = 2 / (period + 1);
  const ema = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calculateRSI(closes, period = 14) {
  if (!closes || closes.length <= period) return 50;
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Number((100 - (100 / (1 + rs))).toFixed(2));
}

function calculateATR(highs, lows, closes, period = 14) {
  if (!highs || highs.length < 2) return 20;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }

  if (trs.length < period) {
    return Number((trs.reduce((a, b) => a + b, 0) / trs.length).toFixed(2));
  }

  const recent = trs.slice(-period);
  return Number((recent.reduce((a, b) => a + b, 0) / period).toFixed(2));
}

function calculateVWAP(candles) {
  if (!candles || candles.length === 0) return 0;
  let cumTypicalPriceVol = 0;
  let cumVol = 0;

  for (const c of candles) {
    const high = toNumber(c.high);
    const low = toNumber(c.low);
    const close = toNumber(c.close);
    const vol = toNumber(c.volume, 1); // default vol 1 if 0
    const typical = (high + low + close) / 3;
    cumTypicalPriceVol += typical * vol;
    cumVol += vol;
  }

  if (cumVol === 0) return toNumber(candles[candles.length - 1].close);
  return Number((cumTypicalPriceVol / cumVol).toFixed(2));
}

function roundStrike(price, symbol) {
  const norm = String(symbol || "").toLowerCase();
  const step = norm.includes("bank") ? 100 : 50;
  return Math.round(price / step) * step;
}

function analyzeCandles(symbol, candles, currentLivePrice) {
  const normSymbol = String(symbol || "").toUpperCase();
  const isBankNifty = normSymbol.includes("BANK");
  const cleanCandles = (Array.isArray(candles) ? candles : []).filter(c => c && Number.isFinite(toNumber(c.close)));

  if (cleanCandles.length < 10) {
    return null;
  }

  const closes = cleanCandles.map(c => toNumber(c.close));
  const highs = cleanCandles.map(c => toNumber(c.high));
  const lows = cleanCandles.map(c => toNumber(c.low));
  const currentPrice = toNumber(currentLivePrice || closes[closes.length - 1]);

  // Support & Resistance (Swing lows and swing highs over last 60 candles)
  const lookback = Math.min(60, cleanCandles.length);
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);
  const resistance = Number(Math.max(...recentHighs).toFixed(2));
  const support = Number(Math.min(...recentLows).toFixed(2));

  // Indicators
  const ema20Arr = calculateEMA(closes, Math.min(20, closes.length));
  const ema50Arr = calculateEMA(closes, Math.min(50, closes.length));
  const ema200Arr = calculateEMA(closes, Math.min(200, closes.length));

  const ema20 = Number(ema20Arr[ema20Arr.length - 1].toFixed(2));
  const ema50 = Number(ema50Arr[ema50Arr.length - 1].toFixed(2));
  const ema200 = Number(ema200Arr[ema200Arr.length - 1].toFixed(2));

  const rsi = calculateRSI(closes, 14);
  const atr = calculateATR(highs, lows, closes, 14);
  const vwap = calculateVWAP(cleanCandles.slice(-60));

  // Determine Regime
  let marketRegime = "RANGE";
  if (currentPrice > ema20 && ema20 > ema50) {
    marketRegime = "TREND_UP";
  } else if (currentPrice < ema20 && ema20 < ema50) {
    marketRegime = "TREND_DOWN";
  } else if (currentPrice >= resistance * 0.999) {
    marketRegime = "BREAKOUT";
  }

  // Detect Liquidity Signal
  const lastCandle = cleanCandles[cleanCandles.length - 1];
  const prevCandle = cleanCandles.length > 1 ? cleanCandles[cleanCandles.length - 2] : lastCandle;
  let liquiditySignal = "NONE";

  if (lastCandle.low < support && lastCandle.close > support) {
    liquiditySignal = "SWEEP_LOW";
  } else if (lastCandle.high > resistance && lastCandle.close < resistance) {
    liquiditySignal = "SWEEP_HIGH";
  } else if (currentPrice > resistance) {
    liquiditySignal = "BREAKOUT_UP";
  } else if (currentPrice < support) {
    liquiditySignal = "BREAKOUT_DOWN";
  }

  // Scoring
  let buyScore = 0;
  let sellScore = 0;
  const reasons = [];

  // Bullish factors
  if (currentPrice > ema20) { buyScore += 2.0; reasons.push("Price above EMA20"); }
  if (ema20 > ema50) { buyScore += 2.0; reasons.push("EMA 20 > EMA 50 alignment"); }
  if (currentPrice > vwap) { buyScore += 1.5; reasons.push("Price above VWAP"); }
  if (rsi > 50 && rsi < 75) { buyScore += 1.5; reasons.push(`Healthy RSI momentum (${rsi})`); }
  if (liquiditySignal === "SWEEP_LOW" || liquiditySignal === "BREAKOUT_UP") {
    buyScore += 1.5;
    reasons.push(`Bullish liquidity: ${liquiditySignal}`);
  }

  // Bearish factors
  if (currentPrice < ema20) { sellScore += 2.0; reasons.push("Price below EMA20"); }
  if (ema20 < ema50) { sellScore += 2.0; reasons.push("EMA 20 < EMA 50 alignment"); }
  if (currentPrice < vwap) { sellScore += 1.5; reasons.push("Price below VWAP"); }
  if (rsi < 50 && rsi > 25) { sellScore += 1.5; reasons.push(`Healthy RSI weakness (${rsi})`); }
  if (liquiditySignal === "SWEEP_HIGH" || liquiditySignal === "BREAKOUT_DOWN") {
    sellScore += 1.5;
    reasons.push(`Bearish liquidity: ${liquiditySignal}`);
  }

  const strike = roundStrike(currentPrice, normSymbol);
  const directionalEdge = Math.abs(buyScore - sellScore);

  let signal = "HOLD";
  let trade = "WAIT";
  let spotStop = null;
  let spotTarget = null;
  const failedChecks = [];

  const minScoreThreshold = 5.5;
  const minEdgeThreshold = 1.5;

  if (buyScore >= minScoreThreshold && (buyScore - sellScore) >= minEdgeThreshold && marketRegime !== "TREND_DOWN") {
    signal = "BUY CALL";
    trade = `${normSymbol} ${strike} CE`;
    spotStop = Number((currentPrice - atr * 1.5).toFixed(2));
    spotTarget = Number((currentPrice + atr * 2.5).toFixed(2));
  } else if (sellScore >= minScoreThreshold && (sellScore - buyScore) >= minEdgeThreshold && marketRegime !== "TREND_UP") {
    signal = "BUY PUT";
    trade = `${normSymbol} ${strike} PE`;
    spotStop = Number((currentPrice + atr * 1.5).toFixed(2));
    spotTarget = Number((currentPrice - atr * 2.5).toFixed(2));
  } else {
    signal = "HOLD";
    trade = "WAIT";
    if (directionalEdge < minEdgeThreshold) failedChecks.push("directional_edge_too_small");
    if (Math.max(buyScore, sellScore) < minScoreThreshold) failedChecks.push("directional_score_below_threshold");
  }

  // Option estimates (sensible 18% stop loss and 25% target)
  const lotSize = isBankNifty ? 30 : 65;
  const estimatedOptionPrice = Number(Math.max(30, atr * (isBankNifty ? 2.2 : 2.5)).toFixed(2));
  const optionStopLoss = signal !== "HOLD" ? Number((estimatedOptionPrice * 0.82).toFixed(2)) : null;
  const optionTargetPrice = signal !== "HOLD" ? Number((estimatedOptionPrice * 1.25).toFixed(2)) : null;
  const optionTargetPrice2 = signal !== "HOLD" ? Number((estimatedOptionPrice * 1.45).toFixed(2)) : null;

  const maxRiskRupees = signal !== "HOLD" ? Number(((estimatedOptionPrice - optionStopLoss) * lotSize).toFixed(2)) : 0;
  const expectedProfitT1 = signal !== "HOLD" ? Number(((optionTargetPrice - estimatedOptionPrice) * lotSize).toFixed(2)) : 0;
  const expectedProfitT2 = signal !== "HOLD" ? Number(((optionTargetPrice2 - estimatedOptionPrice) * lotSize).toFixed(2)) : 0;

  const qualityScore = Number(Math.min(95, Math.max(50, Math.max(buyScore, sellScore) * 10 + directionalEdge * 5)).toFixed(2));
  const confidence = Number(Math.min(92, Math.max(55, Math.max(buyScore, sellScore) * 9 + (marketRegime !== "RANGE" ? 15 : 0))).toFixed(2));

  return {
    symbol: normSymbol,
    price: currentPrice,
    signal,
    trade,
    confidence,
    buy_score: Number(buyScore.toFixed(1)),
    sell_score: Number(sellScore.toFixed(1)),
    buy_readiness: Number(Math.min(100, buyScore * 12).toFixed(1)),
    sell_readiness: Number(Math.min(100, sellScore * 12).toFixed(1)),
    directional_bias: buyScore > sellScore ? "BULLISH" : (sellScore > buyScore ? "BEARISH" : "NEUTRAL"),
    market_bias: buyScore > sellScore ? "BULLISH" : (sellScore > buyScore ? "BEARISH" : "NEUTRAL"),
    reason: reasons[0] || (signal === "HOLD" ? "Waiting for directional edge" : "Trend aligned"),
    reasons: reasons.slice(0, 4),
    failed_checks: failedChecks,
    risk_reward: 2.0,
    quality_score: qualityScore,
    liquidity_signal: liquiditySignal,
    market_regime: marketRegime,
    support,
    resistance,
    stop_loss: spotStop,
    target: spotTarget,
    target_2: signal === "BUY CALL" ? Number((currentPrice + atr * 3.5).toFixed(2)) : (signal === "BUY PUT" ? Number((currentPrice - atr * 3.5).toFixed(2)) : null),
    volume_ratio: 1.0,
    volume_available: false,
    higher_tf_bullish: ema20 > ema50,
    higher_tf_bearish: ema20 < ema50,
    estimated_option_price: estimatedOptionPrice,
    option_stop_loss: optionStopLoss,
    option_target_price: optionTargetPrice,
    option_target_price_2: optionTargetPrice2,
    expected_profit_t1: expectedProfitT1,
    expected_profit_t2: expectedProfitT2,
    max_risk_rupees: maxRiskRupees,
    candlestick_pattern: "NONE",
    candlestick_bias: buyScore > sellScore ? "BULLISH" : "BEARISH",
    score_breakdown: {
      dominant_score: Math.max(buyScore, sellScore),
      directional_edge: directionalEdge
    }
  };
}

module.exports = {
  analyzeCandles,
  calculateEMA,
  calculateRSI,
  calculateATR,
  calculateVWAP,
  roundStrike
};
