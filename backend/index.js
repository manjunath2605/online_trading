require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const cron = require("node-cron");
const mongoose = require("mongoose");

const { manageTrades, allowNewTrade, getRiskControlsStatus } = require("./tradeManager");
const { getRiskCapGate, buildRuleReport } = require("./riskCaps");
const sendSignal = require("./telegram");
const {
  placeOrder,
  closeTrade,
  fetchOptionQuote,
  getBrokerOrderBook,
  getQuantityForTrade,
  startLiveMarketFeed,
  getLiveMarketSnapshot,
  subscribeToLiveMarket,
  getLiveMarketFeedStatus
} = require("./tradingEngine");
const Trade = require("./models/Trade");
const {
  getEntryOptionPrice,
  getExitOptionPrice,
  getOptionQuantity,
  getOptionLotAmount
} = require("./utils/optionPricing");
const { getTradeExecutionFingerprint } = require("./utils/tradeFingerprint");
const {
  buildPerformanceReport,
  resolveTradeDate
} = require("./utils/performanceAnalytics");

const app = express();
const defaultAllowedOrigins = [
  "https://online-trading-rho.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];
const allowedOrigins = (process.env.CORS_ORIGIN || defaultAllowedOrigins.join(",")).split(",").map((value) => value.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes(origin.replace(/\/+$/, ""))) {
      callback(null, true);
      return;
    }
    const normalizedOrigin = origin.replace(/\/+$/, "");
    const isLocalDevOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?$/.test(normalizedOrigin);
    if (isLocalDevOrigin) {
      callback(null, true);
      return;
    }
    callback(new Error("CORS blocked"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"]
}));
app.use(express.json());

let lastSignals = {};
let tradesToday = 0;
let latestSignalResults = [];
let manageTradesRunning = false;
let mongoConnectionWarningLogged = false;

const MONGODB_URI = process.env.MONGODB_URI;
const PAPER_MODE = process.env.PAPER_MODE === "true";
const ALLOW_PAPER_TRADING_WHEN_MARKET_CLOSED = process.env.ALLOW_PAPER_TRADING_WHEN_MARKET_CLOSED !== "false";
const PAPER_EXECUTE_ALL_SIGNALS = process.env.PAPER_EXECUTE_ALL_SIGNALS === "true";
const TRADING_START_DATE = process.env.TRADING_START_DATE || "2026-04-09";
// Hard cap on concurrently OPEN trades.
const MAX_TRADES = Math.max(Number(process.env.MAX_TRADES || 3), 1);
const MAX_DAILY_TRADES = Math.max(Number(process.env.MAX_DAILY_TRADES || 3), 1);
const MAX_SESSION_RISK_AMOUNT = Math.max(Number(process.env.MAX_SESSION_RISK_AMOUNT || 2000), 0);
const MAX_DAILY_LOSS_AMOUNT = Math.max(Number(process.env.MAX_DAILY_LOSS_AMOUNT || 1500), 0);
const PORT = Number(process.env.PORT || 4000);
const MIN_CONFIDENCE = Math.max(Number(process.env.MIN_CONFIDENCE || 0), 65);
const MIN_RISK_REWARD = Math.max(Number(process.env.MIN_RISK_REWARD || 0), 1.4);
const MIN_QUALITY_SCORE = Math.max(Number(process.env.MIN_QUALITY_SCORE || 0), 60);
const MIN_VOLUME_RATIO = Math.max(Number(process.env.MIN_VOLUME_RATIO || 0), 1.0);
const REQUIRE_HIGHER_TF_CONFIRMATION = process.env.REQUIRE_HIGHER_TF_CONFIRMATION !== "false";
const BLOCK_RANGE_REGIME = process.env.BLOCK_RANGE_REGIME !== "false";
const REQUIRE_LIQUIDITY_CONFIRMATION = process.env.REQUIRE_LIQUIDITY_CONFIRMATION !== "false";
const AI_ENGINE_TIMEOUT_MS = Number(process.env.AI_ENGINE_TIMEOUT_MS || 8000);
const MAX_SIGNAL_SPOT_DRIFT_PCT = Math.max(Number(process.env.MAX_SIGNAL_SPOT_DRIFT_PCT || 0.35), 0);
const MAX_LIVE_PRICE_STALENESS_MS = Math.max(Number(process.env.MAX_LIVE_PRICE_STALENESS_MS || 15000), 1000);
const PERFORMANCE_LOOKBACK_TRADES = Math.max(Number(process.env.PERFORMANCE_LOOKBACK_TRADES || 8), 3);
const PERFORMANCE_GUARD_MIN_WIN_RATE = Math.max(Number(process.env.PERFORMANCE_GUARD_MIN_WIN_RATE || 35), 0);
const PERFORMANCE_GUARD_MAX_LOSSES = Math.max(Number(process.env.PERFORMANCE_GUARD_MAX_LOSSES || 5), 1);
const PERFORMANCE_GUARD_MAX_NET_LOSS = Number(process.env.PERFORMANCE_GUARD_MAX_NET_LOSS || -2500);

const resolveAiEngineUrl = () => {
  const configuredUrl = process.env.AI_ENGINE_URL || process.env.AI_ENGINE_HOST || process.env.AI_ENGINE_BASE_URL;
  const value = (configuredUrl || "http://127.0.0.1:5000").replace(/\/$/, "");

  if (!configuredUrl) {
    console.warn("AI_ENGINE_URL is not set. Falling back to http://127.0.0.1:5000. In production, set AI_ENGINE_URL to the live AI-engine host.");
  }

  return value;
};

const AI_ENGINE_URL = resolveAiEngineUrl();
const SIGNAL_SLOTS = [
  { key: "nifty", symbol: "nifty" },
  { key: "banknifty", symbol: "banknifty" }
];
const MAX_OPEN_TRADES_PER_SYMBOL = {
  nifty: 2,
  banknifty: 1
};

const MARKET_TIMEZONE = process.env.MARKET_TIMEZONE || "Asia/Kolkata";
const MARKET_OPEN_TIME = process.env.MARKET_OPEN_TIME || "09:15";
const MARKET_CLOSE_TIME = process.env.MARKET_CLOSE_TIME || "15:30";

const formatError = (error) => {
  if (!error) {
    return "Unknown error";
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error?.message === "string" && error.message) {
    return error.message;
  }

  if (typeof error?.type === "string" && error.type) {
    return `Event: ${error.type}`;
  }

  try {
    return JSON.stringify(error);
  } catch (jsonError) {
    return String(error);
  }
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeSymbol = (symbol) => {
  const value = String(symbol || "").trim().toLowerCase();

  if (value === "nifty" || value === "nifty 50") {
    return "nifty";
  }

  if (value === "banknifty" || value === "bank nifty") {
    return "banknifty";
  }

  return value;
};

const getTradeDirection = (signal) => {
  if (String(signal || "").trim().toUpperCase() === "BUY PUT") {
    return -1;
  }

  return 1;
};

const inferOptionUnderlying = (trade) => {
  const tradeName = String(trade?.trade || "").trim().toUpperCase();
  if (tradeName.startsWith("NIFTY ")) {
    return "NIFTY";
  }

  if (tradeName.startsWith("BANKNIFTY ")) {
    return "BANKNIFTY";
  }

  const symbolName = String(trade?.symbol || "").trim().toUpperCase();
  if (symbolName === "NIFTY" || symbolName === "NIFTY 50") {
    return "NIFTY";
  }

  if (symbolName === "BANKNIFTY" || symbolName === "BANK NIFTY") {
    return "BANKNIFTY";
  }

  return null;
};

const inferNormalizedTradeSymbol = (trade) => {
  const underlying = inferOptionUnderlying(trade);

  if (underlying === "NIFTY") {
    return "nifty";
  }

  if (underlying === "BANKNIFTY") {
    return "banknifty";
  }

  return normalizeSymbol(trade?.symbol);
};

const parseOptionContract = (trade) => {
  const normalized = String(trade || "").trim().toUpperCase();
  const directMatch = /^([A-Z]+)\s+(\d+)\s+(CE|PE)$/.exec(normalized);
  if (directMatch) {
    return {
      underlying: directMatch[1].toUpperCase(),
      strike: Number(directMatch[2]),
      optionType: directMatch[3].toUpperCase()
    };
  }

  const compactMatch = /^([A-Z]+)(\d+)(CE|PE)$/.exec(normalized);
  if (compactMatch) {
    return {
      underlying: compactMatch[1].toUpperCase(),
      strike: Number(compactMatch[2]),
      optionType: compactMatch[3].toUpperCase()
    };
  }

  const callPutMatch = /^([A-Z]+)\s+(\d+)\s+(CALL|PUT)$/.exec(normalized);
  if (callPutMatch) {
    return {
      underlying: callPutMatch[1].toUpperCase(),
      strike: Number(callPutMatch[2]),
      optionType: callPutMatch[3] === "CALL" ? "CE" : "PE"
    };
  }

  return null;
};

const getTradeStrikeStep = (symbol) => {
  const normalized = normalizeSymbol(symbol);
  if (normalized === "nifty") {
    return 50;
  }

  if (normalized === "banknifty") {
    return 100;
  }

  return 50;
};

const roundTradeStrike = (price, symbol) => {
  const step = getTradeStrikeStep(symbol);
  const numericPrice = toNumber(price, 0);
  if (!numericPrice) {
    return null;
  }

  return Math.round(numericPrice / step) * step;
};

const inferOptionType = (data) => {
  const normalizedSignal = String(data?.signal || "").trim().toUpperCase();
  const normalizedTrade = String(data?.trade || "").trim().toUpperCase();

  if (normalizedTrade.endsWith("CE") || normalizedSignal === "BUY CALL") {
    return "CE";
  }

  if (normalizedTrade.endsWith("PE") || normalizedSignal === "BUY PUT") {
    return "PE";
  }

  return null;
};

const normalizeTradeContract = (data) => {
  const parsed = parseOptionContract(data?.trade);
  if (parsed) {
    return {
      contract: parsed,
      trade: `${parsed.underlying} ${parsed.strike} ${parsed.optionType}`,
      source: "parsed_trade"
    };
  }

  const underlying = inferOptionUnderlying(data) || normalizeSymbol(data?.symbol).toUpperCase();
  const optionType = inferOptionType(data);
  const strike = roundTradeStrike(data?.price, underlying);

  if (!underlying || !optionType || !strike) {
    return null;
  }

  return {
    contract: {
      underlying,
      strike,
      optionType
    },
    trade: `${underlying} ${strike} ${optionType}`,
    source: "derived_from_symbol_price_signal"
  };
};

const getSymbolTradeBounds = (symbol) => {
  const normalized = normalizeSymbol(symbol);

  if (normalized === "nifty") {
    return {
      minPrice: 15000,
      maxPrice: 35000,
      step: 50,
      maxStrikeDistance: 2500
    };
  }

  if (normalized === "banknifty") {
    return {
      minPrice: 30000,
      maxPrice: 70000,
      step: 100,
      maxStrikeDistance: 5000
    };
  }

  return null;
};

const validateTradePayload = (data) => {
  const normalizedSymbol = normalizeSymbol(data?.symbol);
  const normalizedSignal = String(data?.signal || "").trim().toUpperCase();
  const normalizedTrade = String(data?.trade || "").trim().toUpperCase();
  const bounds = getSymbolTradeBounds(normalizedSymbol);

  if (!bounds) {
    return { allowed: false, reason: "unsupported_symbol" };
  }

  if (normalizedSignal === "HOLD" || normalizedTrade === "WAIT") {
    return {
      allowed: true,
      skipped: true,
      reason: "hold_signal"
    };
  }

  const spotPrice = toNumber(data?.price, 0);
  if (!spotPrice || spotPrice < bounds.minPrice || spotPrice > bounds.maxPrice) {
    return {
      allowed: false,
      reason: "spot_price_out_of_range",
      bounds,
      spotPrice
    };
  }

  const normalizedContract = normalizeTradeContract(data);
  const contract = normalizedContract?.contract || null;
  if (!contract) {
    return {
      allowed: false,
      reason: "invalid_option_contract",
      details: {
        trade: data?.trade || null,
        symbol: data?.symbol || null,
        signal: data?.signal || null,
        price: data?.price || null
      }
    };
  }

  if (!data?.trade || normalizedContract?.source === "derived_from_symbol_price_signal") {
    data.trade = normalizedContract.trade;
    data.contract_source = normalizedContract.source;
  }

  if (contract.underlying !== normalizedSymbol.toUpperCase()) {
    return {
      allowed: false,
      reason: "trade_underlying_mismatch",
      expected: normalizedSymbol.toUpperCase(),
      actual: contract.underlying
    };
  }

  if (contract.strike % bounds.step !== 0) {
    return {
      allowed: false,
      reason: "strike_step_mismatch",
      step: bounds.step,
      strike: contract.strike
    };
  }

  if (Math.abs(contract.strike - spotPrice) > bounds.maxStrikeDistance) {
    return {
      allowed: false,
      reason: "strike_spot_mismatch",
      strike: contract.strike,
      spotPrice,
      maxStrikeDistance: bounds.maxStrikeDistance
    };
  }

  return { allowed: true };
};

const ENABLED_SYMBOLS = String(process.env.ENABLED_SYMBOLS || "nifty,banknifty")
  .split(",")
  .map((item) => normalizeSymbol(item))
  .filter(Boolean);
const ENABLED_SIGNALS = String(process.env.ENABLED_SIGNALS || "BUY CALL,BUY PUT")
  .split(",")
  .map((item) => String(item || "").trim().toUpperCase())
  .filter(Boolean);

const getMarketTimeString = () => {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: MARKET_TIMEZONE
  });

  return formatter.format(new Date());
};

const isMarketOpen = () => {
  const now = getMarketTimeString();
  return now >= `${MARKET_OPEN_TIME}:00` && now <= `${MARKET_CLOSE_TIME}:00`;
};

const canTradeNow = () => {
  if (getMarketDateKey() < TRADING_START_DATE) {
    return false;
  }

  return isMarketOpen();
};

const getMarketDateKey = (value = new Date()) => {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MARKET_TIMEZONE
  }).format(new Date(value));
};

const getTradeResolvedDate = (trade) => {
  return resolveTradeDate(trade);
};

const isTodayTrade = (trade, dayKey = getMarketDateKey()) => getMarketDateKey(trade?.createdAt) === dayKey;

const getSignalFingerprint = (data) => {
  const roundedPrice = toNumber(data?.price).toFixed(2);
  return [
    data?.signal || "HOLD",
    data?.trade || "WAIT",
    roundedPrice,
    toNumber(data?.risk_reward).toFixed(2),
    toNumber(data?.quality_score).toFixed(2)
  ].join("|");
};

const getRiskGateForCurrentSession = async () => {
  const trades = await getTrackedTrades();
  return getRiskCapGate({
    trades,
    sessionRiskLimit: MAX_SESSION_RISK_AMOUNT,
    dailyLossLimit: MAX_DAILY_LOSS_AMOUNT
  });
};

const connectDatabase = async () => {
  if (!MONGODB_URI) {
    throw new Error("Missing MONGODB_URI in backend/.env");
  }

  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000
  });

  console.log("MongoDB connected");
};

const isMongoConnected = () => mongoose.connection.readyState === 1;

const fetchSignalAnalysis = async (symbol) => {
  const { data } = await axios.get(`${AI_ENGINE_URL}/analyze/${symbol}`, {
    timeout: AI_ENGINE_TIMEOUT_MS
  });
  return data;
};

const appendFailedCheck = (data, reason) => {
  if (!reason) {
    return;
  }

  if (!Array.isArray(data.failed_checks)) {
    data.failed_checks = [];
  }

  if (!data.failed_checks.includes(reason)) {
    data.failed_checks.push(reason);
  }
};

const getSignalLivePriceGuard = (data) => {
  const snapshot = getLiveMarketSnapshot(normalizeSymbol(data?.symbol));
  const signalPrice = toNumber(data?.price, 0);
  const livePrice = toNumber(snapshot?.latestPrice, 0);
  const lastUpdatedAt = snapshot?.lastUpdated ? new Date(snapshot.lastUpdated).getTime() : NaN;

  if (!livePrice) {
    return {
      allowed: false,
      reason: "live_spot_price_unavailable"
    };
  }

  if (!Number.isFinite(lastUpdatedAt) || (Date.now() - lastUpdatedAt) > MAX_LIVE_PRICE_STALENESS_MS) {
    return {
      allowed: false,
      reason: "live_spot_price_stale",
      livePrice,
      lastUpdated: snapshot?.lastUpdated || null
    };
  }

  if (!signalPrice) {
    return {
      allowed: false,
      reason: "signal_price_unavailable",
      livePrice
    };
  }

  const driftPct = Number((Math.abs(livePrice - signalPrice) / signalPrice * 100).toFixed(2));

  if (driftPct > MAX_SIGNAL_SPOT_DRIFT_PCT) {
    return {
      allowed: false,
      reason: "live_spot_drift_too_high",
      signalPrice,
      livePrice,
      driftPct
    };
  }

  return {
    allowed: true,
    signalPrice,
    livePrice,
    driftPct,
    lastUpdated: snapshot?.lastUpdated || null
  };
};

const getClosedTradeNetPnl = (trade) => {
  if (Number.isFinite(toNumber(trade?.lotPnl, NaN))) {
    return toNumber(trade.lotPnl);
  }

  const entryLotAmount = toNumber(trade?.entryLotAmount, NaN);
  const exitLotAmount = toNumber(trade?.exitLotAmount || trade?.exitOptionLotAmount || trade?.exitOrderResponse?.exitAmount, NaN);
  if (Number.isFinite(entryLotAmount) && Number.isFinite(exitLotAmount)) {
    return Number((exitLotAmount - entryLotAmount).toFixed(2));
  }

  const entryOptionPrice = getEntryOptionPrice(trade);
  const exitOptionPrice = getExitOptionPrice(trade);
  const optionQuantity = getOptionQuantity(trade);

  if (entryOptionPrice && exitOptionPrice && optionQuantity) {
    return Number(((exitOptionPrice - entryOptionPrice) * optionQuantity).toFixed(2));
  }

  const entrySpotPrice = toNumber(trade?.price, 0);
  const exitSpotPrice = toNumber(trade?.exit_price, 0);
  const direction = getTradeDirection(trade?.signal);

  if (entrySpotPrice && exitSpotPrice) {
    return Number((((exitSpotPrice - entrySpotPrice) * direction)).toFixed(2));
  }

  return 0;
};

const formatTelegramValue = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "N/A";
};

const buildTelegramEntryMessage = (trade, data = {}) => {
  const quoteSource = trade?.quote_source || data?.quote_source || "rejected_no_quote";
  const entryOptionPrice = getEntryOptionPrice(trade);
  const entryLotAmount = toNumber(trade?.optionLotAmount || trade?.currentLotAmount, 0);

  return [
    "New trade",
    `${trade?.symbol || data?.symbol || "-"}`,
    `${trade?.trade || data?.trade || "-"}`,
    `Signal: ${trade?.signal || data?.signal || "-"}`,
    `Entry spot: ${formatTelegramValue(trade?.price || data?.price)}`,
    `Entry option: ${formatTelegramValue(entryOptionPrice)}`,
    `Entry lot: Rs. ${formatTelegramValue(entryLotAmount)}`,
    `SL: ${formatTelegramValue(trade?.stop_loss || data?.stop_loss)}`,
    `Target: ${formatTelegramValue(trade?.target || data?.target)}`,
    `Quote source: ${quoteSource}`
  ].join("\n");
};

const getRecentPerformanceGuard = async () => {
  const closedTrades = await Trade.find({
    result: { $in: ["WIN", "LOSS"] },
    duplicateTrade: { $ne: true }
  })
    .sort({ closedAt: -1, createdAt: -1 });

  const todaysClosedTrades = closedTrades.filter((trade) => isTodayTrade(trade));
  const recentClosedTrades = todaysClosedTrades.slice(0, PERFORMANCE_LOOKBACK_TRADES);

  if (recentClosedTrades.length < PERFORMANCE_LOOKBACK_TRADES) {
    return {
      allowed: true,
      sampleSize: recentClosedTrades.length,
      requiredSampleSize: PERFORMANCE_LOOKBACK_TRADES
    };
  }

  const wins = recentClosedTrades.filter((trade) => trade.result === "WIN").length;
  const losses = recentClosedTrades.filter((trade) => trade.result === "LOSS").length;
  const winRate = Number(((wins / recentClosedTrades.length) * 100).toFixed(2));
  const netPnl = Number(recentClosedTrades.reduce((sum, trade) => sum + getClosedTradeNetPnl(trade), 0).toFixed(2));

  if (losses >= PERFORMANCE_GUARD_MAX_LOSSES && winRate < PERFORMANCE_GUARD_MIN_WIN_RATE) {
    return {
      allowed: false,
      reason: "recent_win_rate_too_low",
      sampleSize: recentClosedTrades.length,
      wins,
      losses,
      winRate,
      netPnl
    };
  }

  if (netPnl <= PERFORMANCE_GUARD_MAX_NET_LOSS) {
    return {
      allowed: false,
      reason: "recent_net_pnl_too_low",
      sampleSize: recentClosedTrades.length,
      wins,
      losses,
      winRate,
      netPnl
    };
  }

  return {
    allowed: true,
    sampleSize: recentClosedTrades.length,
    wins,
    losses,
    winRate,
    netPnl
  };
};

const getAdaptiveEntryThresholds = (performanceGuard) => {
  const thresholds = {
    minConfidence: MIN_CONFIDENCE,
    minRiskReward: MIN_RISK_REWARD,
    minQualityScore: MIN_QUALITY_SCORE,
    minVolumeRatio: MIN_VOLUME_RATIO
  };

  if (!performanceGuard || performanceGuard.sampleSize < PERFORMANCE_LOOKBACK_TRADES) {
    return thresholds;
  }

  if (toNumber(performanceGuard.winRate, 100) < 50 || toNumber(performanceGuard.netPnl, 0) < 0) {
    thresholds.minConfidence += 5;
    thresholds.minRiskReward += 0.2;
    thresholds.minQualityScore += 5;
    thresholds.minVolumeRatio += 0.1;
  }

  if (toNumber(performanceGuard.winRate, 100) < 40 || toNumber(performanceGuard.netPnl, 0) < PERFORMANCE_GUARD_MAX_NET_LOSS / 2) {
    thresholds.minConfidence += 5;
    thresholds.minRiskReward += 0.2;
    thresholds.minQualityScore += 5;
  }

  return thresholds;
};

const getAdaptiveEntryGate = (data, performanceGuard) => {
  const thresholds = getAdaptiveEntryThresholds(performanceGuard);

  if (toNumber(data.confidence) < thresholds.minConfidence) {
    return {
      allowed: false,
      reason: "adaptive_confidence_below_threshold",
      thresholds
    };
  }

  if (toNumber(data.risk_reward) < thresholds.minRiskReward) {
    return {
      allowed: false,
      reason: "adaptive_risk_reward_below_threshold",
      thresholds
    };
  }

  if (toNumber(data.quality_score) < thresholds.minQualityScore) {
    return {
      allowed: false,
      reason: "adaptive_quality_score_below_threshold",
      thresholds
    };
  }

  if (toNumber(data.volume_ratio, 0) < thresholds.minVolumeRatio) {
    return {
      allowed: false,
      reason: "adaptive_volume_ratio_below_threshold",
      thresholds
    };
  }

  return {
    allowed: true,
    thresholds
  };
};

const buildExecutionCheck = (stage, decision, status = null) => {
  const details = { ...(decision || {}) };
  delete details.allowed;
  delete details.reason;

  return {
    stage,
    status: status || (decision?.allowed ? "PASSED" : "REJECTED"),
    allowed: Boolean(decision?.allowed),
    reason: decision?.reason || null,
    details
  };
};

const appendExecutionCheck = (data, check) => {
  if (!Array.isArray(data.execution_checks)) {
    data.execution_checks = [];
  }

  data.execution_checks.push(check);
  return check;
};

const logExecutionEvent = (data, check) => {
  if (check.status === "PASSED") {
    return;
  }

  console.info(JSON.stringify({
    event: "trade_execution_decision",
    symbol: data?.symbol || null,
    signal: data?.signal || null,
    trade: data?.trade || null,
    stage: check.stage,
    status: check.status,
    reason: check.reason,
    details: check.details,
    price: data?.price || null,
    confidence: data?.confidence || null,
    risk_reward: data?.risk_reward || null,
    quality_score: data?.quality_score || null
  }));
};

const recordExecutionCheck = (data, stage, decision, status = null, extraDetails = {}) => {
  const check = buildExecutionCheck(stage, decision, status);
  check.details = {
    ...check.details,
    ...extraDetails
  };

  appendExecutionCheck(data, check);

  if (check.status !== "PASSED") {
    data.execution_status = check.status;
    data.execution_reason = check.reason;
    data.execution_rejection = {
      stage: check.stage,
      reason: check.reason,
      details: check.details
    };
  }

  logExecutionEvent(data, check);
  return check;
};

const markExecutionExecuted = (data, stage = "trade_created", extraDetails = {}) => {
  const check = {
    stage,
    status: "EXECUTED",
    allowed: true,
    reason: null,
    details: extraDetails
  };

  appendExecutionCheck(data, check);
  data.execution_status = "EXECUTED";
  data.execution_reason = null;
  data.execution_rejection = null;

  console.info(JSON.stringify({
    event: "trade_execution_decision",
    symbol: data?.symbol || null,
    signal: data?.signal || null,
    trade: data?.trade || null,
    stage,
    status: "EXECUTED",
    details: extraDetails,
    price: data?.price || null
  }));
};

const isBullishMarketRegime = (data) => {
  const regime = String(data?.market_regime || "").trim().toUpperCase();
  const liquiditySignal = String(data?.liquidity_signal || "").trim().toUpperCase();

  if (regime === "TREND_UP") {
    return true;
  }

  return regime === "BREAKOUT" && ["SWEEP_LOW", "BREAKOUT_UP"].includes(liquiditySignal);
};

const isBearishMarketRegime = (data) => {
  const regime = String(data?.market_regime || "").trim().toUpperCase();
  const liquiditySignal = String(data?.liquidity_signal || "").trim().toUpperCase();

  if (regime === "TREND_DOWN") {
    return true;
  }

  return regime === "BREAKOUT" && ["SWEEP_HIGH", "BREAKOUT_DOWN"].includes(liquiditySignal);
};

const hasLiveQuoteSource = (data) => {
  const quoteSource = String(data?.quote_source || data?.quote_reliability || "").trim().toLowerCase();

  if (!quoteSource) {
    return false;
  }

  if (["stale_quote", "rejected_no_quote", "no_live_quote", "no_quote"].includes(quoteSource)) {
    return false;
  }

  if (PAPER_MODE) {
    return ["live_quote", "cached_live_quote", "estimated_quote", "paper_quote"].includes(quoteSource);
  }

  return quoteSource === "live_quote";
};

const getTrendConfirmationGate = (data) => {
  const normalizedSignal = String(data?.signal || "").trim().toUpperCase();
  const normalizedTrade = String(data?.trade || "").trim().toUpperCase();

  if (normalizedSignal === "BUY CALL" || normalizedTrade.endsWith("CE")) {
    if (data?.higher_tf_bullish !== true) {
      return { allowed: false, reason: "bullish_trend_confirmation_missing", direction: "BUY CALL" };
    }

    if (!isBullishMarketRegime(data)) {
      return { allowed: false, reason: "market_regime_not_trend_up", direction: "BUY CALL" };
    }
  }

  if (normalizedSignal === "BUY PUT" || normalizedTrade.endsWith("PE")) {
    if (data?.higher_tf_bearish !== true) {
      return { allowed: false, reason: "bearish_trend_confirmation_missing", direction: "BUY PUT" };
    }

    if (!isBearishMarketRegime(data)) {
      return { allowed: false, reason: "market_regime_not_trend_down", direction: "BUY PUT" };
    }
  }

  return { allowed: true, reason: null };
};

const getTradeEntryGate = (data) => {
  const normalizedSymbol = normalizeSymbol(data?.symbol);
  const normalizedSignal = String(data?.signal || "").trim().toUpperCase();

  if (!canTradeNow()) {
    return { allowed: false, reason: "market_closed" };
  }

  if (data.signal === "HOLD" || data.trade === "WAIT") {
    return { allowed: false, reason: "hold_signal" };
  }

  if (ENABLED_SYMBOLS.length > 0 && !ENABLED_SYMBOLS.includes(normalizedSymbol)) {
    return { allowed: false, reason: "symbol_disabled_by_live_tuning" };
  }

  if (ENABLED_SIGNALS.length > 0 && !ENABLED_SIGNALS.includes(normalizedSignal)) {
    return { allowed: false, reason: "signal_disabled_by_live_tuning" };
  }

  if (toNumber(data.confidence) < MIN_CONFIDENCE) {
    return { allowed: false, reason: "confidence_below_threshold" };
  }

  if (toNumber(data.risk_reward) < MIN_RISK_REWARD) {
    return { allowed: false, reason: "risk_reward_below_threshold" };
  }

  if (toNumber(data.quality_score) < MIN_QUALITY_SCORE) {
    return { allowed: false, reason: "quality_score_below_threshold" };
  }

  if (toNumber(data.volume_ratio, 0) < MIN_VOLUME_RATIO) {
    return { allowed: false, reason: "volume_ratio_below_threshold" };
  }

  if (!PAPER_MODE && !hasLiveQuoteSource(data)) {
    return { allowed: false, reason: "quote_not_live_or_stale" };
  }

  const trendGate = getTrendConfirmationGate(data);
  if (!trendGate.allowed) {
    return trendGate;
  }

  if (REQUIRE_HIGHER_TF_CONFIRMATION) {
    if (normalizedSignal === "BUY CALL" && data.higher_tf_bullish !== true) {
      return { allowed: false, reason: "higher_tf_bullish_confirmation_missing" };
    }

    if (normalizedSignal === "BUY PUT" && data.higher_tf_bearish !== true) {
      return { allowed: false, reason: "higher_tf_bearish_confirmation_missing" };
    }
  }

  if (BLOCK_RANGE_REGIME) {
    if (normalizedSignal === "BUY CALL" && !isBullishMarketRegime(data)) {
      return { allowed: false, reason: "market_regime_not_trend_up" };
    }

    if (normalizedSignal === "BUY PUT" && !isBearishMarketRegime(data)) {
      return { allowed: false, reason: "market_regime_not_trend_down" };
    }
  }

  if (REQUIRE_LIQUIDITY_CONFIRMATION) {
    const liquiditySignal = String(data.liquidity_signal || "").trim().toUpperCase();

    if (normalizedSignal === "BUY CALL" && !["SWEEP_LOW", "BREAKOUT_UP"].includes(liquiditySignal)) {
      return { allowed: false, reason: "liquidity_bullish_confirmation_missing" };
    }

    if (normalizedSignal === "BUY PUT" && !["SWEEP_HIGH", "BREAKOUT_DOWN"].includes(liquiditySignal)) {
      return { allowed: false, reason: "liquidity_bearish_confirmation_missing" };
    }
  }

  if (!allowNewTrade()) {
    return { allowed: false, reason: "risk_controls_locked" };
  }

  if (Array.isArray(data.failed_checks) && data.failed_checks.length > 0) {
    return { allowed: false, reason: data.failed_checks.join(",") };
  }

  return { allowed: true };
};

const findRecentDuplicateTrade = async (data, windowMs = Number(process.env.DUPLICATE_WINDOW_MS || 60000)) => {
  const now = Date.now();
  const windowStart = new Date(now - windowMs);
  const windowEnd = new Date(now);

  return Trade.findOne({
    symbol: data?.symbol,
    trade: data?.trade,
    signal: data?.signal,
    createdAt: { $gte: windowStart, $lte: windowEnd },
    duplicateTrade: { $ne: true }
  }).sort({ createdAt: -1 });
};

const enrichTrade = async (trade, { fetchLiveQuote = false } = {}) => {
  const plainTrade = typeof trade.toObject === "function" ? trade.toObject() : { ...trade };
  const normalizedTradeSymbol = inferNormalizedTradeSymbol(plainTrade);
  const livePrice = getLiveMarketSnapshot(normalizedTradeSymbol)?.latestPrice;
  const tradeDirection = getTradeDirection(plainTrade.signal);

  const inferredUnderlying = inferOptionUnderlying(plainTrade);
  const configuredQuantity = inferredUnderlying ? getQuantityForTrade(inferredUnderlying) : 0;
  let liveOptionQuote = null;

  if (fetchLiveQuote && plainTrade.result === "OPEN" && plainTrade.trade && plainTrade.trade !== "WAIT") {
    try {
      liveOptionQuote = await fetchOptionQuote(plainTrade.trade, {
        forceRefresh: false,
        allowCachedQuote: true
      });
    } catch (error) {
      liveOptionQuote = null;
    }
  }

  const storedQuantity = toNumber(getOptionQuantity(plainTrade) || liveOptionQuote?.quantity, 0);
  const optionQuantity = storedQuantity > 1 ? storedQuantity : configuredQuantity;
  const entryOptionPrice = getEntryOptionPrice(plainTrade);
  const liveCurrentOptionPrice = Number.isFinite(toNumber(liveOptionQuote?.optionPrice, NaN))
    ? toNumber(liveOptionQuote?.optionPrice, NaN)
    : NaN;
  const storedCurrentOptionPrice = toNumber(plainTrade.currentOptionPrice, NaN);
  const currentOptionPrice = Number.isFinite(liveCurrentOptionPrice)
    ? liveCurrentOptionPrice
    : (Number.isFinite(storedCurrentOptionPrice) ? storedCurrentOptionPrice : null);
  const exitOptionPrice = getExitOptionPrice(plainTrade);
  const underlyingEntryPrice = toNumber(plainTrade.price, 0);
  const underlyingCurrentPrice = toNumber(livePrice, 0);
  const underlyingPnl = underlyingEntryPrice && underlyingCurrentPrice
    ? Number(((underlyingCurrentPrice - underlyingEntryPrice) * tradeDirection).toFixed(2))
    : null;
  const entryLotAmount = Number.isFinite(entryOptionPrice) && entryOptionPrice > 0 && optionQuantity
    ? getOptionLotAmount(entryOptionPrice, optionQuantity)
    : (toNumber(plainTrade.optionLotAmount) || null);
  const currentLotAmount = Number.isFinite(currentOptionPrice) && optionQuantity
    ? getOptionLotAmount(currentOptionPrice, optionQuantity)
    : (Number.isFinite(toNumber(plainTrade.currentLotAmount, NaN)) ? toNumber(plainTrade.currentLotAmount, NaN) : null);
  const exitLotAmount = Number.isFinite(exitOptionPrice) && exitOptionPrice > 0 && optionQuantity
    ? getOptionLotAmount(exitOptionPrice, optionQuantity)
    : (toNumber(plainTrade.exitOptionLotAmount || plainTrade.exitOrderResponse?.exitAmount) || null);
  const liveOptionPnl = Number.isFinite(liveCurrentOptionPrice) && Number.isFinite(entryOptionPrice) && entryOptionPrice > 0 && optionQuantity
    ? Number(((currentOptionPrice - entryOptionPrice) * optionQuantity).toFixed(2))
    : null;
  const shouldUseUnderlyingFallback = !inferredUnderlying;
  const storedCurrentPnl = toNumber(plainTrade.current_pnl, NaN);
  const currentPnl = liveOptionPnl
    ?? (Number.isFinite(storedCurrentPnl) ? storedCurrentPnl : (shouldUseUnderlyingFallback ? underlyingPnl : null));
  const closedLotPnl = entryLotAmount !== null && exitLotAmount !== null
    ? Number((exitLotAmount - entryLotAmount).toFixed(2))
    : null;
  const lotPnl = plainTrade.result === "OPEN" ? currentPnl : closedLotPnl;
  const storedCurrentPnlPercent = toNumber(plainTrade.current_pnl_percent, NaN);
  const currentPnlPercent = liveOptionPnl !== null && entryLotAmount
    ? Number(((liveOptionPnl / entryLotAmount) * 100).toFixed(2))
    : (Number.isFinite(storedCurrentPnlPercent)
      ? storedCurrentPnlPercent
      : (shouldUseUnderlyingFallback && currentPnl !== null && underlyingEntryPrice
        ? Number(((currentPnl / underlyingEntryPrice) * 100).toFixed(2))
        : null));
  const quoteSource = String(plainTrade.quote_source || "").trim().toLowerCase();
  const quoteReliability = ["live_quote", "cached_live_quote"].includes(quoteSource)
    ? "live_quote"
    : (String(plainTrade.executionMode || "").toLowerCase() === "paper" && quoteSource === "estimated_quote"
      ? "paper_quote"
      : (quoteSource || null));
  const quoteIsUnreliable = ["stale_quote", "rejected_no_quote"].includes(quoteReliability);
  const suppressUnreliableQuoteMetrics = plainTrade.result === "OPEN" && quoteIsUnreliable;
  const effectiveCurrentPnl = suppressUnreliableQuoteMetrics ? 0 : currentPnl;
  const effectiveCurrentPnlPercent = suppressUnreliableQuoteMetrics ? 0 : currentPnlPercent;
  const effectiveLotPnl = suppressUnreliableQuoteMetrics ? 0 : lotPnl;

  return {
    ...plainTrade,
    tradeDate: getTradeResolvedDate(plainTrade),
    derivedSymbol: normalizedTradeSymbol,
    livePrice: Number.isFinite(Number(livePrice)) ? Number(livePrice) : null,
    optionQuantity: optionQuantity || null,
    quote_source: liveOptionQuote?.quoteSource || plainTrade.quote_source || null,
    quote_reliability: liveOptionQuote?.quoteSource || quoteReliability,
    currentOptionPrice: Number.isFinite(currentOptionPrice) ? currentOptionPrice : null,
    exitOptionPrice: exitOptionPrice || null,
    entryLotAmount,
    currentLotAmount,
    exitLotAmount,
    lotPnl: effectiveLotPnl,
    current_pnl: effectiveCurrentPnl,
    current_pnl_percent: effectiveCurrentPnlPercent,
    currentQuoteAvailable: fetchLiveQuote ? Boolean(liveOptionQuote?.optionPrice && Number(liveOptionQuote.optionPrice) > 0) : Boolean(plainTrade.currentQuoteAvailable),
    currentPnlSource: liveOptionPnl !== null ? "option" : (Number.isFinite(storedCurrentPnl) ? "stored" : (shouldUseUnderlyingFallback && underlyingPnl !== null ? "underlying" : null)),
    currentQuoteUpdatedAt: liveOptionQuote?.quoteUpdatedAt || (liveOptionQuote?.optionPrice ? new Date() : (plainTrade.currentQuoteUpdatedAt || null)),
    activeStopLoss: toNumber(plainTrade.trailingStop || plainTrade.option_stop_loss || plainTrade.stop_loss) || null,
    activeTarget: toNumber(plainTrade.option_target_price || plainTrade.target) || null
  };
};

const closeTradeManually = async (trade) => {
  const livePrice = getLiveMarketSnapshot(normalizeSymbol(trade.symbol))?.latestPrice;
  const exitPrice = toNumber(livePrice, NaN);

  if (!Number.isFinite(exitPrice) || !exitPrice) {
    throw new Error("Live market price is not available for manual exit");
  }

  const optionQuote = await fetchOptionQuote(trade.trade, { forceRefresh: true });
  const optionExitPrice = toNumber(optionQuote?.optionPrice, NaN);
  const optionQuantity = toNumber(getOptionQuantity(trade) || optionQuote?.quantity, 0);
  const entryOptionPrice = getEntryOptionPrice(trade);

  if (!Number.isFinite(optionExitPrice) || !optionExitPrice || !entryOptionPrice || !optionQuantity) {
    throw new Error("Option premium is not available for manual exit");
  }

  const pnl = Number(((optionExitPrice - entryOptionPrice) * optionQuantity).toFixed(2));

  trade.result = pnl >= 0 ? "WIN" : "LOSS";
  trade.exit_price = exitPrice;
  trade.exit_option_price = optionExitPrice;
  trade.exit_reason = "MANUAL_EXIT";
  trade.closedAt = new Date();
  trade.exitOrderResponse = await closeTrade(trade.trade, {
    exitPrice,
    currentOptionPrice: optionExitPrice,
    stopLossOrderId: trade.stopLossOrderId
  });
  trade.exitOptionLotAmount = toNumber(trade.exitOrderResponse?.exitAmount, 0) || undefined;
  await trade.save();
  await sendSignal([
    "Trade exited",
    `${trade.symbol || "-"}`,
    `${trade.trade || "-"}`,
    `Signal: ${trade.signal || "-"}`,
    `Entry option: ${formatTelegramValue(entryOptionPrice)}`,
    `Exit option: ${formatTelegramValue(optionExitPrice)}`,
    `Reason: MANUAL_EXIT`,
    `Quote source: ${trade.quote_source || "rejected_no_quote"}`
  ].join("\n"));

  return trade;
};

const computeStats = (trades) => {
  const closedTrades = trades.filter((trade) => trade.result !== "OPEN");
  const wins = closedTrades.filter((trade) => trade.result === "WIN");
  const losses = closedTrades.filter((trade) => trade.result === "LOSS");
  const closedProfit = closedTrades.reduce((sum, trade) => {
    if (Number.isFinite(toNumber(trade.lotPnl, NaN))) {
      return sum + toNumber(trade.lotPnl);
    }

    const entryLotAmount = toNumber(trade.entryLotAmount, NaN);
    const exitLotAmount = toNumber(trade.exitLotAmount, NaN);
    if (Number.isFinite(entryLotAmount) && Number.isFinite(exitLotAmount)) {
      return sum + (exitLotAmount - entryLotAmount);
    }

    if (!Number.isFinite(toNumber(trade.exit_price)) || !Number.isFinite(toNumber(trade.price))) {
      return sum;
    }

    const direction = trade.signal === "BUY PUT" ? -1 : 1;
    return sum + ((toNumber(trade.exit_price) - toNumber(trade.price)) * direction);
  }, 0);
  const openProfit = trades
    .filter((trade) => trade.result === "OPEN")
    .reduce((sum, trade) => sum + toNumber(trade.current_pnl), 0);

  return {
    total: trades.length,
    open: trades.filter((trade) => trade.result === "OPEN").length,
    wins: wins.length,
    losses: losses.length,
    winRate: closedTrades.length ? Number(((wins.length / closedTrades.length) * 100).toFixed(2)) : 0,
    profit: Number(closedProfit.toFixed(2)),
    openProfit: Number(openProfit.toFixed(2)),
    totalProfitWithOpen: Number((closedProfit + openProfit).toFixed(2)),
    averageRiskReward: trades.length
      ? Number((trades.reduce((sum, trade) => sum + toNumber(trade.risk_reward), 0) / trades.length).toFixed(2))
      : 0
  };
};

const filterTradesForBacktest = (trades, { start, end, symbol } = {}) => {
  const startDate = start ? new Date(`${start}T00:00:00.000Z`) : null;
  const endDate = end ? new Date(`${end}T23:59:59.999Z`) : null;
  const normalizedSymbol = String(symbol || "").trim().toLowerCase();

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

    if (normalizedSymbol && normalizeSymbol(trade.symbol) !== normalizedSymbol) {
      return false;
    }

    return trade.duplicateTrade !== true;
  });
};

const getTrackedTrades = async () => {
  return Trade.find({
    createdAt: {
      $gte: new Date(`${TRADING_START_DATE}T00:00:00.000Z`)
    },
    duplicateTrade: { $ne: true }
  }).sort({ createdAt: -1 });
};

const getOpenTradeCount = async () => {
  return Trade.countDocuments({ result: "OPEN", duplicateTrade: { $ne: true } });
};

const getTodayTradeCount = async () => {
  const trades = await getTrackedTrades();
  return trades.filter((trade) => isTodayTrade(trade)).length;
};

const getTodayTrades = async () => {
  const trades = await getTrackedTrades();
  return trades.filter((trade) => isTodayTrade(trade));
};

const getFallbackSignal = (symbol, reason) => ({
  symbol: String(symbol || "").toUpperCase(),
  signal: "HOLD",
  trade: "WAIT",
  confidence: 0,
  buy_score: 0,
  sell_score: 0,
  buy_readiness: 0,
  sell_readiness: 0,
  reason,
  reasons: [reason],
  failed_checks: [reason],
  risk_reward: 0,
  quality_score: 0,
  support: null,
  resistance: null,
  market_regime: "UNKNOWN"
});

const buildTradeFromSignal = async (data, { force = false } = {}) => {
  const openTradeCount = await getOpenTradeCount();
  if (openTradeCount >= MAX_TRADES) {
    const error = new Error("max_open_trades_reached");
    error.details = {
      reason: "max_open_trades_reached",
      maxOpenTrades: MAX_TRADES,
      openTrades: openTradeCount
    };
    throw error;
  }

  const dailyTradeCount = await getTodayTradeCount();
  if (dailyTradeCount >= MAX_DAILY_TRADES) {
    const error = new Error("max_daily_trades_reached");
    error.details = {
      reason: "max_daily_trades_reached",
      maxDailyTrades: MAX_DAILY_TRADES,
      dailyTrades: dailyTradeCount
    };
    throw error;
  }

  const riskCapGate = await getRiskGateForCurrentSession();
  if (!riskCapGate.allowed) {
    const error = new Error(riskCapGate.reason || "risk_cap_exceeded");
    error.details = riskCapGate.details || riskCapGate;
    throw error;
  }

  if (!canTradeNow()) {
    const error = new Error("trading_paused_until_tomorrow");
    error.details = { reason: "trading_paused_until_tomorrow", tradingStartDate: TRADING_START_DATE };
    throw error;
  }

  const payloadValidation = validateTradePayload(data);
  if (!payloadValidation.allowed) {
    const error = new Error(payloadValidation.reason);
    error.details = payloadValidation;
    throw error;
  }

  const forcePaperExecution = force && PAPER_MODE && PAPER_EXECUTE_ALL_SIGNALS;
  const gate = getTradeEntryGate(data);
  const performanceGuard = await getRecentPerformanceGuard();
  const adaptiveGate = gate.allowed ? getAdaptiveEntryGate(data, performanceGuard) : { allowed: true };
  const livePriceGuard = gate.allowed && adaptiveGate.allowed
    ? getSignalLivePriceGuard(data)
    : { allowed: true };
  const executionGate = (!gate.allowed
    ? gate
    : (!adaptiveGate.allowed
      ? adaptiveGate
      : (!livePriceGuard.allowed ? livePriceGuard : performanceGuard)));

  if (!executionGate.allowed) {
    const error = new Error(executionGate.reason || "execution_blocked");
    error.details = executionGate;
    throw error;
  }

  if (livePriceGuard.signalPrice) {
    data.signal_spot_price = livePriceGuard.signalPrice;
  }

  if (livePriceGuard.livePrice) {
    data.live_spot_price = livePriceGuard.livePrice;
  }

  if (Number.isFinite(livePriceGuard.driftPct)) {
    data.live_spot_drift_pct = livePriceGuard.driftPct;
  }

  if (livePriceGuard.lastUpdated) {
    data.live_spot_last_updated = livePriceGuard.lastUpdated;
  }

  const orderResponse = await placeOrder(data.trade, {
    estimatedOptionPrice: data.estimated_option_price,
    currentOptionPrice: data.estimated_option_price,
    entrySpotPrice: data.price,
    price: data.price,
    stop_loss: data.stop_loss,
    target: data.target,
    option_stop_loss: data.option_stop_loss,
    option_target_price: data.option_target_price,
    liquidity_signal: data.liquidity_signal,
    volume_ratio: data.volume_ratio
  });

  if (!orderResponse || !Number.isFinite(Number(orderResponse.simulatedPrice)) || Number(orderResponse.simulatedPrice) <= 0) {
    const error = new Error("option_quote_unavailable");
    error.details = { reason: "option_quote_unavailable" };
    throw error;
  }

  const createdAt = new Date();
  const executionFingerprint = getTradeExecutionFingerprint(data, createdAt);

  try {
    return await Trade.create({
    ...data,
    estimated_option_price: orderResponse?.simulatedPrice || data.estimated_option_price,
    quote_source: orderResponse?.quoteSource || data.quote_source || null,
    optionTradingsymbol: orderResponse?.optionTradingsymbol,
    optionSymbolToken: orderResponse?.optionSymbolToken,
    optionLotAmount: orderResponse?.simulatedAmount || orderResponse?.lotAmount,
    currentOptionPrice: orderResponse?.simulatedPrice || data.estimated_option_price,
    currentLotAmount: orderResponse?.simulatedAmount || orderResponse?.lotAmount,
    current_pnl: 0,
    current_pnl_percent: 0,
    currentQuoteAvailable: true,
    currentQuoteUpdatedAt: new Date(),
    option_stop_loss: orderResponse?.optionStopLoss || data.option_stop_loss || null,
    stopLossOrderId: orderResponse?.stopLossOrderId || null,
    stopLossOrderStatus: orderResponse?.stopLossOrderResponse?.orderstatus || orderResponse?.stopLossOrderResponse?.status || null,
    stopLossOrderResponse: orderResponse?.stopLossOrderResponse || null,
    option_target_price: data.option_target_price || null,
    result: "OPEN",
    approvalStatus: "NOT_REQUIRED",
    approvedAt: new Date(),
    executionMode: orderResponse?.mode || "unknown",
    simulatedPrice: orderResponse?.simulatedPrice,
    simulatedQuantity: orderResponse?.quantity,
    simulatedAmount: orderResponse?.simulatedAmount,
      orderResponse,
      executionFingerprint,
      createdAt
    });
  } catch (error) {
    if (error?.code === 11000) {
      console.warn("Skipped duplicate trade creation:", executionFingerprint || formatError(error));
      return null;
    }
    throw error;
  }
};

const shouldForcePaperExecution = (data) => (
  PAPER_MODE
  && PAPER_EXECUTE_ALL_SIGNALS
  && String(data?.signal || "").trim().toUpperCase() !== "HOLD"
  && String(data?.trade || "").trim().toUpperCase() !== "WAIT"
);

if (PAPER_MODE && !PAPER_EXECUTE_ALL_SIGNALS) {
  console.info("Paper mode is on, but auto-execution of all signals is disabled by config.");
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", formatError(reason));
});

startLiveMarketFeed().catch((error) => {
  console.error("Live market feed failed to start:", formatError(error));
});

app.get("/signal", async (req, res) => {
  try {
    const results = [];
    let aiEngineUnavailable = false;
    const performanceGuard = await getRecentPerformanceGuard();
    const riskCapGate = await getRiskGateForCurrentSession();
    let openTradeCount = await getOpenTradeCount();
    let dailyTradeCount = await getTodayTradeCount();
    const seenSymbols = new Set();

    for (const slot of SIGNAL_SLOTS) {
      const symbol = slot.symbol;
      const normalizedSymbol = normalizeSymbol(symbol);
      if (seenSymbols.has(normalizedSymbol)) {
        continue;
      }
      seenSymbols.add(normalizedSymbol);
      let data;

      try {
        data = await fetchSignalAnalysis(symbol);
      } catch (error) {
        aiEngineUnavailable = true;
        console.error(`Signal fetch failed for ${symbol}:`, formatError(error));
        data = getFallbackSignal(symbol, `AI engine unavailable: ${formatError(error)}`);
      }

      data.execution_status = "PENDING";
      data.execution_checks = [];

      const payloadValidation = validateTradePayload(data);
      recordExecutionCheck(data, "payload_validation", payloadValidation);
      if (!payloadValidation.allowed) {
        data.execution_allowed = false;
        appendFailedCheck(data, payloadValidation.reason);
        data.validation = payloadValidation;
        results.push(data);
        lastSignals[slot.key] = getSignalFingerprint(data);
        continue;
      }

      if (!riskCapGate.allowed) {
        recordExecutionCheck(data, "risk_cap_gate", riskCapGate, "BLOCKED");
        data.execution_allowed = false;
        appendFailedCheck(data, riskCapGate.reason);
        data.validation = { allowed: false, reason: riskCapGate.reason, details: riskCapGate.details || riskCapGate };
        results.push(data);
        lastSignals[slot.key] = getSignalFingerprint(data);
        continue;
      }

      const forcePaperExecution = shouldForcePaperExecution(data);
      const gate = forcePaperExecution ? { allowed: true, reason: null } : getTradeEntryGate(data);
      recordExecutionCheck(data, "trade_entry_gate", gate);
      if (!gate.allowed && !forcePaperExecution) {
        data.execution_allowed = false;
        appendFailedCheck(data, gate.reason);
        data.paper_execution_forced = forcePaperExecution;
        data.validation = payloadValidation;
        results.push(data);
        lastSignals[slot.key] = getSignalFingerprint(data);
        continue;
      }

      const adaptiveGate = gate.allowed && !forcePaperExecution ? getAdaptiveEntryGate(data, performanceGuard) : { allowed: true };
      if (!forcePaperExecution) {
        recordExecutionCheck(data, "adaptive_entry_gate", adaptiveGate);
      }
      if (!adaptiveGate.allowed && !forcePaperExecution) {
        data.execution_allowed = false;
        appendFailedCheck(data, adaptiveGate.reason);
        data.paper_execution_forced = forcePaperExecution;
        data.validation = payloadValidation;
        results.push(data);
        lastSignals[slot.key] = getSignalFingerprint(data);
        continue;
      }

      const livePriceGuard = gate.allowed && adaptiveGate.allowed && !forcePaperExecution
        ? getSignalLivePriceGuard(data)
        : { allowed: true };
      if (!forcePaperExecution) {
        recordExecutionCheck(data, "live_price_gate", livePriceGuard);
      }
      if (!livePriceGuard.allowed && !forcePaperExecution) {
        data.execution_allowed = false;
        appendFailedCheck(data, livePriceGuard.reason);
        data.paper_execution_forced = forcePaperExecution;
        data.validation = payloadValidation;
        results.push(data);
        lastSignals[slot.key] = getSignalFingerprint(data);
        continue;
      }

      if (!performanceGuard.allowed && !forcePaperExecution) {
        recordExecutionCheck(data, "performance_guard", performanceGuard);
        data.execution_allowed = false;
        appendFailedCheck(data, performanceGuard.reason);
        data.paper_execution_forced = forcePaperExecution;
        data.validation = payloadValidation;
        results.push(data);
        lastSignals[slot.key] = getSignalFingerprint(data);
        continue;
      }

      data.execution_allowed = true;
      data.execution_reason = null;
      data.paper_execution_forced = forcePaperExecution;
      if (forcePaperExecution) {
        data.failed_checks = [];
      }

      if (livePriceGuard.signalPrice) {
        data.signal_spot_price = livePriceGuard.signalPrice;
      }

      if (livePriceGuard.livePrice) {
        data.live_spot_price = livePriceGuard.livePrice;
      }

      if (Number.isFinite(livePriceGuard.driftPct)) {
        data.live_spot_drift_pct = livePriceGuard.driftPct;
      }

      if (livePriceGuard.lastUpdated) {
        data.live_spot_last_updated = livePriceGuard.lastUpdated;
      }

      if (!performanceGuard.allowed) {
        data.performance_guard = performanceGuard;
      }

      data.adaptive_thresholds = getAdaptiveEntryThresholds(performanceGuard);

      results.push(data);
      const fingerprint = getSignalFingerprint(data);

      if (lastSignals[slot.key] === fingerprint) {
        recordExecutionCheck(
          data,
          "duplicate_signal",
          { allowed: false, reason: "duplicate_signal_fingerprint" },
          "SKIPPED",
          { fingerprint }
        );
        data.execution_allowed = false;
        lastSignals[slot.key] = fingerprint;
        continue;
      }

      if (openTradeCount >= MAX_TRADES) {
        recordExecutionCheck(
          data,
          "capacity_gate",
          { allowed: false, reason: "max_open_trades_reached", maxOpenTrades: MAX_TRADES, openTrades: openTradeCount },
          "SKIPPED"
        );
        data.execution_allowed = false;
        return res.json({
          results,
          skipped: `Max open trades reached (${MAX_TRADES})`
        });
      }

      if (dailyTradeCount >= MAX_DAILY_TRADES) {
        recordExecutionCheck(
          data,
          "capacity_gate",
          {
            allowed: false,
            reason: "max_daily_trades_reached",
            maxDailyTrades: MAX_DAILY_TRADES,
            dailyTrades: dailyTradeCount
          },
          "SKIPPED"
        );
        data.execution_allowed = false;
        lastSignals[slot.key] = fingerprint;
        continue;
      }

      const symbolOpenTradeCount = await Trade.countDocuments({
        symbol: data.symbol,
        result: "OPEN"
      });

      if (symbolOpenTradeCount >= (MAX_OPEN_TRADES_PER_SYMBOL[normalizeSymbol(data.symbol)] || 1)) {
        recordExecutionCheck(
          data,
          "capacity_gate",
          {
            allowed: false,
            reason: "symbol_open_trade_cap_reached",
            symbol: normalizeSymbol(data.symbol),
            openTrades: symbolOpenTradeCount,
            maxOpenTrades: MAX_OPEN_TRADES_PER_SYMBOL[normalizeSymbol(data.symbol)] || 1
          },
          "SKIPPED"
        );
        data.execution_allowed = false;
        lastSignals[slot.key] = fingerprint;
        continue;
      }

      let tradeRecord;
      try {
        const recentDuplicate = await findRecentDuplicateTrade(data);
        if (recentDuplicate) {
          recordExecutionCheck(
            data,
            "duplicate_signal",
            {
              allowed: false,
              reason: "recent_duplicate_trade_detected",
              duplicateTradeId: String(recentDuplicate._id),
              duplicateCreatedAt: recentDuplicate.createdAt
            },
            "SKIPPED"
          );
          data.execution_allowed = false;
          lastSignals[slot.key] = fingerprint;
          continue;
        }

        tradeRecord = await buildTradeFromSignal(data, { force: forcePaperExecution });
      } catch (error) {
        if (error?.details?.reason === "option_quote_unavailable") {
          data.quote_source = "rejected_no_quote";
        }
        recordExecutionCheck(
          data,
          "order_creation",
          {
            allowed: false,
            reason: formatError(error),
            details: error?.details || null
          },
          "REJECTED"
        );
        data.execution_allowed = false;
        lastSignals[slot.key] = fingerprint;
        continue;
      }

      if (!tradeRecord) {
        lastSignals[slot.key] = fingerprint;
        continue;
      }

      const formatLevel = (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed.toFixed(2) : "N/A";
      };

      await sendSignal(buildTelegramEntryMessage(tradeRecord, data));
      markExecutionExecuted(data, "trade_created", {
        tradeId: tradeRecord?._id ? String(tradeRecord._id) : null,
        executionMode: tradeRecord?.executionMode || null
      });
      openTradeCount += 1;
      dailyTradeCount += 1;
      tradesToday = openTradeCount;
      lastSignals[slot.key] = fingerprint;
    }

    latestSignalResults = results;
    return res.status(aiEngineUnavailable ? 503 : 200).json(results);
  } catch (error) {
    console.error("Signal error:", formatError(error));
    if (latestSignalResults.length > 0) {
      return res.status(200).json(latestSignalResults);
    }

    return res.status(500).json({
      error: "Signal fetch failed",
      details: formatError(error)
    });
  }
});

app.get("/signals/latest", async (req, res) => {
  try {
    if (latestSignalResults.length === 0 || req.query.refresh === "true") {
      const { data } = await axios.get(`http://localhost:${PORT}/signal`, {
        timeout: AI_ENGINE_TIMEOUT_MS + 2000,
        validateStatus: () => true
      });
      latestSignalResults = Array.isArray(data) ? data : data?.results || [];
    }

    return res.json(latestSignalResults);
  } catch (error) {
    console.error("Latest signal fetch error:", formatError(error));
    if (latestSignalResults.length > 0) {
      return res.json(latestSignalResults);
    }
    return res.status(500).json({
      error: "Latest signal fetch failed",
      details: formatError(error)
    });
  }
});

app.get("/trades", async (req, res) => {
  const trades = await getTrackedTrades();
  return res.json(await Promise.all(trades.map((trade) => enrichTrade(trade, {
    fetchLiveQuote: trade.result === "OPEN"
  }))));
});

app.post("/trades/reset-today", async (req, res) => {
  try {
    const todayTrades = await getTodayTrades();
    const tradeIds = todayTrades.map((trade) => trade._id);
    if (tradeIds.length === 0) {
      return res.json({
        deleted: 0,
        message: "No trades found for today"
      });
    }

    const deletionResult = await Trade.deleteMany({ _id: { $in: tradeIds } });
    tradesToday = 0;
    latestSignalResults = [];

    return res.json({
      deleted: deletionResult.deletedCount || 0,
      message: "Today's trades cleared"
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to clear today's trades",
      details: formatError(error)
    });
  }
});

app.get("/stats", async (req, res) => {
  const trades = await getTrackedTrades();
  const enrichedTrades = await Promise.all(trades.map((trade) => enrichTrade(trade, {
    fetchLiveQuote: trade.result === "OPEN"
  })));
  return res.json({
    ...computeStats(enrichedTrades),
    performanceReport: buildPerformanceReport(enrichedTrades),
    ...getRiskControlsStatus(),
    enabledSymbols: ENABLED_SYMBOLS,
    enabledSignals: ENABLED_SIGNALS
  });
});

app.get("/analytics/performance", async (req, res) => {
  const trades = await getTrackedTrades();
  const enrichedTrades = await Promise.all(trades.map((trade) => enrichTrade(trade, {
    fetchLiveQuote: trade.result === "OPEN"
  })));
  const filteredTrades = filterTradesForBacktest(enrichedTrades, req.query);
  return res.json(buildPerformanceReport(filteredTrades, req.query));
});

app.get("/backtest/report", async (req, res) => {
  const trades = await getTrackedTrades();
  const enrichedTrades = await Promise.all(trades.map((trade) => enrichTrade(trade, {
    fetchLiveQuote: trade.result === "OPEN"
  })));
  const filteredTrades = filterTradesForBacktest(enrichedTrades, req.query);
  return res.json({
    mode: "backtest",
    ...buildPerformanceReport(filteredTrades, req.query)
  });
});

app.get("/rule-report", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.query.symbol || "nifty");
    const trades = await getTrackedTrades();
    const signalData = await fetchSignalAnalysis(symbol);
    return res.json(buildRuleReport({
      symbol,
      signalData,
      trades,
      sessionRiskLimit: MAX_SESSION_RISK_AMOUNT,
      dailyLossLimit: MAX_DAILY_LOSS_AMOUNT
    }));
  } catch (error) {
    return res.status(500).json({
      error: "Failed to build rule report",
      details: formatError(error)
    });
  }
});

app.get("/rule-report/:symbol", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const trades = await getTrackedTrades();
    const signalData = await fetchSignalAnalysis(symbol);
    return res.json(buildRuleReport({
      symbol,
      signalData,
      trades,
      sessionRiskLimit: MAX_SESSION_RISK_AMOUNT,
      dailyLossLimit: MAX_DAILY_LOSS_AMOUNT
    }));
  } catch (error) {
    return res.status(500).json({
      error: "Failed to build rule report",
      details: formatError(error)
    });
  }
});

app.get("/market/status", (req, res) => {
  return res.json({
    open: isMarketOpen(),
    marketTime: getMarketTimeString(),
    marketOpen: MARKET_OPEN_TIME,
    marketClose: MARKET_CLOSE_TIME,
    timezone: MARKET_TIMEZONE,
    tradingStartDate: TRADING_START_DATE,
    maxDailyTrades: MAX_DAILY_TRADES,
    maxSessionRiskAmount: MAX_SESSION_RISK_AMOUNT,
    maxDailyLossAmount: MAX_DAILY_LOSS_AMOUNT,
    tradingAllowed: canTradeNow()
  });
});

app.get("/market/feed-status", (req, res) => {
  return getRecentPerformanceGuard().then((performanceGuard) => res.json({
    ...getLiveMarketFeedStatus(),
    marketOpen: isMarketOpen(),
    tradingAllowed: canTradeNow(),
    riskControls: getRiskControlsStatus(),
    performanceGuard,
    entryFilters: {
      minConfidence: MIN_CONFIDENCE,
      minRiskReward: MIN_RISK_REWARD,
      minQualityScore: MIN_QUALITY_SCORE,
      minVolumeRatio: MIN_VOLUME_RATIO,
      requireHigherTfConfirmation: REQUIRE_HIGHER_TF_CONFIRMATION,
      blockRangeRegime: BLOCK_RANGE_REGIME,
      requireLiquidityConfirmation: REQUIRE_LIQUIDITY_CONFIRMATION,
      maxSignalSpotDriftPct: MAX_SIGNAL_SPOT_DRIFT_PCT,
      maxLivePriceStalenessMs: MAX_LIVE_PRICE_STALENESS_MS,
      tradingStartDate: TRADING_START_DATE,
      performanceLookbackTrades: PERFORMANCE_LOOKBACK_TRADES,
      performanceGuardMinWinRate: PERFORMANCE_GUARD_MIN_WIN_RATE,
      performanceGuardMaxLosses: PERFORMANCE_GUARD_MAX_LOSSES,
      performanceGuardMaxNetLoss: PERFORMANCE_GUARD_MAX_NET_LOSS,
      adaptiveThresholds: getAdaptiveEntryThresholds(performanceGuard),
      enabledSymbols: ENABLED_SYMBOLS,
      enabledSignals: ENABLED_SIGNALS
    }
  })).catch((error) => res.status(500).json({
    error: "Failed to load feed status",
    details: formatError(error)
  }));
});

app.get("/market/live/:symbol", async (req, res) => {
  try {
    return res.json(getLiveMarketSnapshot(req.params.symbol));
  } catch (error) {
    return res.status(500).json({
      error: "Failed to load market snapshot",
      details: formatError(error)
    });
  }
});

app.get("/market/stream/:symbol", async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  const sendSnapshot = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  sendSnapshot(getLiveMarketSnapshot(req.params.symbol));

  const unsubscribe = subscribeToLiveMarket(req.params.symbol, sendSnapshot);

  req.on("close", () => {
    unsubscribe();
    res.end();
  });
});

app.get("/market/candles/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const snapshot = getLiveMarketSnapshot(symbol);

    if (snapshot && Array.isArray(snapshot.candles) && snapshot.candles.length > 0) {
      return res.json(snapshot);
    }

    const { data } = await axios.get(`${AI_ENGINE_URL}/candles/${symbol}`, {
      timeout: AI_ENGINE_TIMEOUT_MS
    });

    return res.json({
      ...data,
      source: "ai-engine"
    });
  } catch (error) {
    console.error("Failed to fetch candles:", formatError(error));
    return res.status(500).json({
      error: "Failed to fetch candles",
      details: formatError(error)
    });
  }
});

app.post("/trades/:id/approve", async (req, res) => {
  const trade = await Trade.findByIdAndUpdate(
    req.params.id,
    {
      approvalStatus: "APPROVED",
      approvedAt: new Date()
    },
    { new: true }
  );

  return res.json(await enrichTrade(trade));
});

app.post("/trades/:id/reject", async (req, res) => {
  const trade = await Trade.findByIdAndUpdate(
    req.params.id,
    {
      approvalStatus: "REJECTED",
      rejectedAt: new Date()
    },
    { new: true }
  );

  return res.json(await enrichTrade(trade));
});

app.post("/trades/:id/sell", async (req, res) => {
  try {
    const trade = await Trade.findById(req.params.id);

    if (!trade) {
      return res.status(404).json({
        error: "Trade not found"
      });
    }

    if (trade.result !== "OPEN") {
      return res.status(409).json({
        error: "Trade is already closed"
      });
    }

    if (trade.approvalStatus === "PENDING") {
      return res.status(409).json({
        error: "Pending trade cannot be sold before approval"
      });
    }

    await closeTradeManually(trade);
    return res.json(await enrichTrade(trade));
  } catch (error) {
    return res.status(500).json({
      error: "Manual sell failed",
      details: formatError(error)
    });
  }
});

app.post("/signals/:symbol/buy", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const openTradeCount = await getOpenTradeCount();
    if (openTradeCount >= MAX_TRADES) {
      return res.status(429).json({
        error: `Max open trades reached (${MAX_TRADES})`
      });
    }

    const dailyTradeCount = await getTodayTradeCount();
    if (dailyTradeCount >= MAX_DAILY_TRADES) {
      return res.status(429).json({
        error: `Max daily trades reached (${MAX_DAILY_TRADES})`
      });
    }

    const signalResponse = await axios.get(`${AI_ENGINE_URL}/analyze/${symbol}`, {
      timeout: AI_ENGINE_TIMEOUT_MS
    });
    const data = signalResponse.data;

    if (!data || String(data.signal || "").trim().toUpperCase() === "HOLD" || String(data.trade || "").trim().toUpperCase() === "WAIT") {
      return res.status(409).json({
        error: "No actionable signal",
        details: data?.reason || "Signal is HOLD"
      });
    }

    const riskCapGate = await getRiskGateForCurrentSession();
    if (!riskCapGate.allowed) {
      return res.status(409).json({
        error: "Entry rejected",
        details: riskCapGate
      });
    }

    const entryGate = getTradeEntryGate(data);
    if (!entryGate.allowed) {
      return res.status(409).json({
        error: "Entry rejected",
        details: entryGate.reason || "entry_blocked"
      });
    }

    const tradeRecord = await buildTradeFromSignal({
      ...data,
      symbol: data.symbol || symbol
    }, {
      force: PAPER_MODE
    });

    lastSignals[symbol] = getSignalFingerprint(data);
    await sendSignal(buildTelegramEntryMessage(tradeRecord, data));
    return res.status(201).json(await enrichTrade(tradeRecord));
  } catch (error) {
    console.error("Manual buy failed:", JSON.stringify({
      symbol: req.params.symbol,
      details: formatError(error),
      errorDetails: error?.details || null
    }));
    return res.status(500).json({
      error: "Manual buy failed",
      details: formatError(error)
    });
  }
});

cron.schedule("*/1 * * * *", async () => {
  try {
    if (!canTradeNow()) {
      return;
    }

    await axios.get(`http://localhost:${PORT}/signal`);
  } catch (error) {
    console.error("Scheduled signal error:", formatError(error));
  }
}, {
  timezone: MARKET_TIMEZONE,
  noOverlap: true
});

cron.schedule("*/1 * * * * *", async () => {
  if (manageTradesRunning) {
    return;
  }

  if (!isMongoConnected()) {
    if (!mongoConnectionWarningLogged) {
      mongoConnectionWarningLogged = true;
      console.warn("Skipping trade manager until MongoDB is connected");
    }
    return;
  }

  manageTradesRunning = true;
  try {
    await manageTrades(
      (symbol) => getLiveMarketSnapshot(symbol)?.latestPrice,
      async (trade, options = {}) => {
        try {
          const optionQuote = await fetchOptionQuote(trade.trade, options);
          if (!optionQuote || String(optionQuote.quoteSource || "").trim().toLowerCase() !== "live_quote") {
            return null;
          }

          return optionQuote.optionPrice || null;
        } catch (error) {
          return null;
        }
      },
      closeTrade,
      Trade,
      getBrokerOrderBook
    );
  } catch (error) {
    console.error("Trade manager error:", formatError(error));
  } finally {
    manageTradesRunning = false;
  }
}, {
  timezone: MARKET_TIMEZONE
});

cron.schedule("0 0 * * *", () => {
  tradesToday = 0;
}, {
  timezone: MARKET_TIMEZONE
});

connectDatabase()
  .then(() => {
    app.listen(PORT, () => console.log(`Backend running on ${PORT}`));
  })
  .catch((error) => {
    console.error("MongoDB connection failed:", formatError(error));
    process.exit(1);
  });
