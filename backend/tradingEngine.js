require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const axios = require("axios");
const crypto = require("crypto");
const os = require("os");
const { EventEmitter } = require("events");
const { SmartAPI, WebSocketV2 } = require("smartapi-javascript");
const { ACTION, MODE, EXCHANGES } = require("smartapi-javascript/config/constant");

const PAPER_MODE = process.env.PAPER_MODE === "true";
const ENABLE_REAL_TRADING = process.env.ENABLE_REAL_TRADING === "true";
const ALLOW_SIMULATED_FALLBACK = process.env.ALLOW_SIMULATED_FALLBACK !== "false";
const API_BASE = (process.env.ANGEL_API_BASE || "https://apiconnect.angelone.in").replace(/\/$/, "");
const SOURCE_ID = process.env.ANGEL_SOURCE_ID || "WEB";
const USER_TYPE = process.env.ANGEL_USER_TYPE || "USER";
const EXCHANGE = process.env.ANGEL_EXCHANGE || "NFO";
const PRODUCT_TYPE = process.env.ANGEL_PRODUCT_TYPE || "CARRYFORWARD";
const ORDER_TYPE = process.env.ANGEL_ORDER_TYPE || "MARKET";
const VARIETY = process.env.ANGEL_VARIETY || "NORMAL";
const DURATION = process.env.ANGEL_DURATION || "DAY";
const PRICE = process.env.ANGEL_PRICE || "0";
const SQUARE_OFF = process.env.ANGEL_SQUARE_OFF || "0";
const STOP_LOSS = process.env.ANGEL_STOP_LOSS || "0";
const LIVE_PRICE_SCALE = Number(process.env.ANGEL_PRICE_SCALE || 100);
const MAX_LIVE_CANDLES = Number(process.env.ANGEL_MAX_LIVE_CANDLES || 240);
const LIVE_POLL_INTERVAL_MS = Number(process.env.ANGEL_LIVE_POLL_INTERVAL_MS || 1000);
const LIVE_CANDLE_INTERVAL_SECONDS = Number(process.env.ANGEL_LIVE_CANDLE_INTERVAL_SECONDS || 1);
const HISTORY_BACKFILL_CANDLES = Number(process.env.ANGEL_HISTORY_BACKFILL_CANDLES || 180);
const MIN_HISTORY_READY_CANDLES = Number(process.env.ANGEL_MIN_HISTORY_READY_CANDLES || 120);
const HISTORY_BACKFILL_RETRY_MS = Number(process.env.ANGEL_HISTORY_BACKFILL_RETRY_MS || 30000);
const resolveAiEngineUrl = () => {
  const configuredUrl = process.env.AI_ENGINE_URL || process.env.AI_ENGINE_HOST || process.env.AI_ENGINE_BASE_URL;
  const value = (configuredUrl || "http://127.0.0.1:5000").replace(/\/$/, "");

  if (!configuredUrl) {
    console.warn("AI_ENGINE_URL is not set. Falling back to http://127.0.0.1:5000. In production, set AI_ENGINE_URL to the live AI-engine host.");
  }

  return value;
};

const AI_ENGINE_URL = resolveAiEngineUrl();
const LOTS_PER_TRADE = Number(process.env.ANGEL_LOTS_PER_TRADE || 1);
const OPTION_QUOTE_CACHE_TTL_MS = Math.max(Number(process.env.ANGEL_OPTION_QUOTE_CACHE_TTL_MS || 5000), 1000);
const MARKET_POLL_BACKOFF_MS = Math.max(Number(process.env.ANGEL_MARKET_POLL_BACKOFF_MS || 15000), LIVE_POLL_INTERVAL_MS);
const MARKET_TIMEZONE = process.env.MARKET_TIMEZONE || "Asia/Kolkata";
const MARKET_OPEN_TIME = process.env.MARKET_OPEN_TIME || "09:15";
const MARKET_CLOSE_TIME = process.env.MARKET_CLOSE_TIME || "15:30";
const DEFAULT_LOT_SIZES = {
  NIFTY: Number(process.env.ANGEL_NIFTY_LOT_SIZE || 65),
  BANKNIFTY: Number(process.env.ANGEL_BANKNIFTY_LOT_SIZE || 30)
};

const liveFeedEmitter = new EventEmitter();
const optionContractCache = new Map();
const optionQuoteCache = new Map();
let liveFeedStarted = false;
let liveFeedStartPromise = null;
let marketSocket = null;
let marketPollTimer = null;
let marketPollRunning = false;
let smartApiSession = null;
let historicalBackfillTimer = null;
let historicalBackfillPromise = null;
let nextMarketPollAt = 0;

const liveFeedStatus = {
  started: false,
  transport: "none",
  websocketConnected: false,
  websocketTicks: 0,
  lastTickAt: null,
  pollCount: 0,
  lastPollAt: null,
  lastError: null
};

const liveMarketState = {
  nifty: {
    symbol: "NIFTY",
    ticker: "^NSEI",
    source: "angel-live",
    connected: false,
    latestPrice: null,
    lastUpdated: null,
    candles: []
  },
  banknifty: {
    symbol: "BANKNIFTY",
    ticker: "^NSEBANK",
    source: "angel-live",
    connected: false,
    latestPrice: null,
    lastUpdated: null,
    candles: []
  }
};

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

  if (typeof error?.toString === "function" && error.toString !== Object.prototype.toString) {
    return error.toString();
  }

  try {
    return JSON.stringify(error);
  } catch (jsonError) {
    return String(error);
  }
};

const isTransientAngelError = (error) => {
  const message = formatError(error).toLowerCase();
  return message.includes("invalid token")
    || message.includes("timeout")
    || message.includes("econnreset")
    || message.includes("unable to fetch market data")
    || message.includes("socket hang up");
};

const withTimeout = (promise, timeoutMs, label = "operation") => {
  let timer = null;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
    timeoutPromise
  ]);
};

const getMarketTimeString = () => new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: MARKET_TIMEZONE
}).format(new Date());

const isMarketOpen = () => {
  const now = getMarketTimeString();
  return now >= `${MARKET_OPEN_TIME}:00` && now <= `${MARKET_CLOSE_TIME}:00`;
};

const getOptionQuoteCacheKey = (contract) => `${String(contract?.exchange || EXCHANGE).toUpperCase()}|${String(contract?.symboltoken || "")}`;

const getCachedOptionQuote = (contract) => {
  const cacheEntry = optionQuoteCache.get(getOptionQuoteCacheKey(contract));
  if (!cacheEntry) {
    return null;
  }

  if ((Date.now() - cacheEntry.savedAt) > OPTION_QUOTE_CACHE_TTL_MS) {
    optionQuoteCache.delete(getOptionQuoteCacheKey(contract));
    return null;
  }

  return cacheEntry.value;
};

const setCachedOptionQuote = (contract, value) => {
  optionQuoteCache.set(getOptionQuoteCacheKey(contract), {
    savedAt: Date.now(),
    value
  });
};

const getLocalIp = () => {
  const interfaces = os.networkInterfaces();

  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return "127.0.0.1";
};

const createTotp = (secret, step = 30, digits = 6) => {
  const normalized = secret.replace(/\s+/g, "").toUpperCase();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";

  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index === -1) {
      throw new Error("ANGEL_TOTP_SECRET is not valid base32");
    }
    bits += index.toString(2).padStart(5, "0");
  }

  const bytes = bits.match(/.{1,8}/g)?.map((chunk) => parseInt(chunk.padEnd(8, "0"), 2)) || [];
  const key = Buffer.from(bytes);
  const counter = Math.floor(Date.now() / 1000 / step);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) % (10 ** digits);

  return String(code).padStart(digits, "0");
};

const buildHeaders = (jwtToken) => {
  const apiKey = process.env.ANGEL_API_KEY;

  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-UserType": USER_TYPE,
    "X-SourceID": SOURCE_ID,
    "X-ClientLocalIP": process.env.ANGEL_CLIENT_LOCAL_IP || getLocalIp(),
    "X-ClientPublicIP": process.env.ANGEL_CLIENT_PUBLIC_IP || getLocalIp(),
    "X-MACAddress": process.env.ANGEL_MAC_ADDRESS || "00:00:00:00:00:00",
    "X-PrivateKey": apiKey,
    "X-Api-Key": apiKey,
    ...(jwtToken ? { Authorization: `Bearer ${jwtToken}` } : {})
  };
};

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
};

const parseTrade = (trade) => {
  const normalized = String(trade || "").trim().toUpperCase();
  const directMatch = /^([A-Z]+)\s+(\d+)\s+(CE|PE)$/.exec(normalized);
  if (directMatch) {
    return {
      underlying: directMatch[1].toUpperCase(),
      strike: directMatch[2],
      optionType: directMatch[3].toUpperCase()
    };
  }

  const compactMatch = /^([A-Z]+)(\d+)(CE|PE)$/.exec(normalized);
  if (compactMatch) {
    return {
      underlying: compactMatch[1].toUpperCase(),
      strike: compactMatch[2],
      optionType: compactMatch[3].toUpperCase()
    };
  }

  const callPutMatch = /^([A-Z]+)\s+(\d+)\s+(CALL|PUT)$/.exec(normalized);
  if (callPutMatch) {
    return {
      underlying: callPutMatch[1].toUpperCase(),
      strike: callPutMatch[2],
      optionType: callPutMatch[3] === "CALL" ? "CE" : "PE"
    };
  }

  throw new Error(`Unsupported trade format: ${trade}`);
};

const getQuantityForTrade = (underlying) => {
  const explicitQuantityMap = {
    NIFTY: Number(process.env.ANGEL_NIFTY_QTY || 0),
    BANKNIFTY: Number(process.env.ANGEL_BANKNIFTY_QTY || 0)
  };

  const explicitQuantity = explicitQuantityMap[underlying];
  const lotSize = DEFAULT_LOT_SIZES[underlying];
  if (!Number.isFinite(lotSize) || lotSize <= 0) {
    throw new Error(`Missing valid lot size for ${underlying}. Set ANGEL_${underlying}_LOT_SIZE or ANGEL_${underlying}_QTY.`);
  }

  if (
    Number.isFinite(explicitQuantity) &&
    explicitQuantity > 0 &&
    explicitQuantity >= lotSize &&
    explicitQuantity % lotSize === 0
  ) {
    return explicitQuantity;
  }

  if (!Number.isFinite(LOTS_PER_TRADE) || LOTS_PER_TRADE <= 0) {
    throw new Error("ANGEL_LOTS_PER_TRADE must be a positive number.");
  }

  return lotSize * LOTS_PER_TRADE;
};

const buildTradingSymbol = ({ underlying, strike, optionType }) => {
  const expiry = requireEnv("ANGEL_OPTION_EXPIRY");
  return `${underlying}${expiry}${strike}${optionType}`;
};

const parseOptionExpiryFromTradingSymbol = (tradingsymbol, underlying, strike, optionType) => {
  const pattern = new RegExp(`^${underlying}(\\d{2}[A-Z]{3}\\d{2})${strike}${optionType}$`, "i");
  const match = pattern.exec(String(tradingsymbol || "").trim().toUpperCase());

  if (!match) {
    return null;
  }

  const token = match[1].toUpperCase();
  const parsed = new Date(`${token.slice(0, 2)} ${token.slice(2, 5)} 20${token.slice(5, 7)} 15:30:00 GMT+0530`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const resolveOptionContractWithoutExpiry = async (parsed, session) => {
  const cacheKey = `${parsed.underlying}|${parsed.strike}|${parsed.optionType}`;
  const cached = optionContractCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const response = await axios.post(
    `${API_BASE}/rest/secure/angelbroking/order/v1/searchScrip`,
    {
      exchange: EXCHANGE,
      searchscrip: parsed.underlying
    },
    { headers: buildHeaders(session.jwtToken) }
  );

  const candidates = (response.data?.data || []).filter((item) => {
    const tradingsymbol = String(item?.tradingsymbol || "").toUpperCase();
    return tradingsymbol.startsWith(parsed.underlying)
      && tradingsymbol.endsWith(`${parsed.strike}${parsed.optionType}`);
  }).map((item) => ({
    ...item,
    expiryDate: parseOptionExpiryFromTradingSymbol(item.tradingsymbol, parsed.underlying, parsed.strike, parsed.optionType)
  })).filter((item) => item.expiryDate !== null);

  if (candidates.length === 0) {
    throw new Error(`Unable to resolve option contract for ${parsed.underlying} ${parsed.strike} ${parsed.optionType} without ANGEL_OPTION_EXPIRY`);
  }

  const now = new Date();
  const futureCandidates = candidates
    .filter((item) => item.expiryDate >= now)
    .sort((left, right) => left.expiryDate - right.expiryDate);
  const selected = futureCandidates[0] || candidates.sort((left, right) => left.expiryDate - right.expiryDate)[0];

  const resolved = {
    parsed,
    tradingsymbol: String(selected.tradingsymbol),
    symboltoken: String(selected.symboltoken),
    exchange: EXCHANGE,
    quantity: getQuantityForTrade(parsed.underlying)
  };
  optionContractCache.set(cacheKey, {
    value: resolved,
    expiresAt: Date.now() + (5 * 60 * 1000)
  });
  return resolved;
};

const resolveOptionContract = async (trade, sessionOverride = null) => {
  const parsed = parseTrade(trade);
  const session = sessionOverride || smartApiSession || await sdkLogin();
  smartApiSession = session;

  if (!process.env.ANGEL_OPTION_EXPIRY) {
    return resolveOptionContractWithoutExpiry(parsed, session);
  }

  const tradingsymbol = buildTradingSymbol(parsed);
  const scrip = await searchScrip(session.jwtToken, tradingsymbol);

  return {
    parsed,
    tradingsymbol,
    symboltoken: String(scrip.symboltoken),
    exchange: EXCHANGE,
    quantity: getQuantityForTrade(parsed.underlying)
  };
};

const fetchOptionQuote = async (trade, { forceRefresh = false, allowCachedQuote = false } = {}) => {
  let lastError = null;
  const timeoutMs = Math.max(Number(process.env.ANGEL_OPTION_QUOTE_TIMEOUT_MS || 7000), 1000);
  const contract = await resolveOptionContract(trade);
  const cachedQuote = forceRefresh ? null : getCachedOptionQuote(contract);

  if (cachedQuote) {
    return {
      ...cachedQuote,
      quoteSource: allowCachedQuote ? "cached_live_quote" : "stale_quote"
    };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await withTimeout(
        smartApiSession.smartApi.marketData({
          mode: "LTP",
          exchangeTokens: {
            [EXCHANGE]: [contract.symboltoken]
          }
        }),
        timeoutMs,
        "Angel option quote fetch"
      );

      if (!response?.status) {
        throw new Error(`Angel option quote failed: ${JSON.stringify(response)}`);
      }

      const quote = response?.data?.fetched?.[0];
      const optionPrice = Number(quote?.ltp);
      if (!Number.isFinite(optionPrice) || optionPrice <= 0) {
        throw new Error(`Option quote missing for ${contract.tradingsymbol} (symboltoken ${contract.symboltoken})`);
      }

      const quoteResult = {
        ...contract,
        optionPrice,
        lotAmount: Number((optionPrice * contract.quantity).toFixed(2)),
        quoteSource: "live_quote",
        quoteUpdatedAt: new Date()
      };
      setCachedOptionQuote(contract, quoteResult);
      return quoteResult;
    } catch (error) {
      lastError = error;
      if (attempt === 0 && isTransientAngelError(error)) {
      const fallbackQuote = forceRefresh ? null : getCachedOptionQuote(contract);
      if (fallbackQuote) {
        return fallbackQuote;
      }

      smartApiSession = await sdkLogin();
      continue;
      }
      break;
    }
  }

  const fallbackQuote = forceRefresh ? null : getCachedOptionQuote(contract);
  if (fallbackQuote) {
    return {
      ...fallbackQuote,
      quoteSource: allowCachedQuote ? "cached_live_quote" : "stale_quote"
    };
  }

  throw lastError || new Error(`Option quote fetch failed for ${trade}`);
};

const buildSimulatedOrder = (trade, context = {}) => {
  const parsed = parseTrade(trade);
  const quantity = getQuantityForTrade(parsed.underlying);
  const simulatedPrice = Number(context.currentOptionPrice || context.estimatedOptionPrice || 0);
  if (!Number.isFinite(simulatedPrice) || simulatedPrice <= 0) {
    return null;
  }
  const simulatedAmount = Number((simulatedPrice * quantity).toFixed(2));

  return {
    mode: PAPER_MODE ? "paper" : "simulated",
    trade,
    quantity,
    simulatedPrice,
    simulatedAmount,
    quoteSource: context.quoteSource || (PAPER_MODE ? "estimated_quote" : "rejected_no_quote"),
    liveOrderPlaced: false
  };
};

const buildSimulatedExit = (trade, context = {}) => {
  const parsed = parseTrade(trade);
  const quantity = getQuantityForTrade(parsed.underlying);
  const exitPrice = Number(context.currentOptionPrice || 0);
  const exitAmount = exitPrice > 0 ? Number((exitPrice * quantity).toFixed(2)) : null;

  return {
    mode: PAPER_MODE ? "paper" : "simulated",
    trade,
    quantity,
    exitPrice,
    exitAmount,
    liveOrderPlaced: false
  };
};

const createSmartApiClient = () => new SmartAPI({
  api_key: requireEnv("ANGEL_API_KEY")
});

const sdkLogin = async () => {
  const smartApi = createSmartApiClient();
  const clientCode = requireEnv("ANGEL_CLIENT_ID");
  const password = requireEnv("ANGEL_PASSWORD");
  const totp = createTotp(requireEnv("ANGEL_TOTP_SECRET"));

  const loginResponse = await smartApi.generateSession(clientCode, password, totp);

  if (!loginResponse?.status) {
    throw new Error(`Angel SDK login failed: ${JSON.stringify(loginResponse)}`);
  }

  if (loginResponse?.data?.jwtToken) {
    smartApi.setAccessToken(loginResponse.data.jwtToken);
  }

  if (loginResponse?.data?.refreshToken) {
    smartApi.setPublicToken(loginResponse.data.refreshToken);
  }

  smartApi.setClientCode(clientCode);

  return {
    smartApi,
    clientCode,
    jwtToken: loginResponse?.data?.jwtToken,
    feedToken: loginResponse?.data?.feedToken
  };
};

const getInstrumentConfigs = () => ([
  getLiveInstrumentConfig("nifty"),
  getLiveInstrumentConfig("banknifty")
]);

const normalizeFeedToken = (value) => String(value || "")
  .replace(/\u0000/g, "")
  .replace(/^"+|"+$/g, "")
  .trim();

const login = async () => {
  const clientcode = requireEnv("ANGEL_CLIENT_ID");
  const password = requireEnv("ANGEL_PASSWORD");
  const totpSecret = requireEnv("ANGEL_TOTP_SECRET");
  const totp = createTotp(totpSecret);

  const response = await axios.post(
    `${API_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`,
    { clientcode, password, totp },
    { headers: buildHeaders() }
  );

  const jwtToken = response.data?.data?.jwtToken;
  if (!jwtToken) {
    throw new Error(`Angel login failed: ${JSON.stringify(response.data)}`);
  }

  return { jwtToken };
};

const searchScrip = async (jwtToken, tradingSymbol) => {
  const response = await axios.post(
    `${API_BASE}/rest/secure/angelbroking/order/v1/searchScrip`,
    {
      exchange: EXCHANGE,
      searchscrip: tradingSymbol
    },
    { headers: buildHeaders(jwtToken) }
  );

  const results = response.data?.data || [];
  const exactMatch = results.find((item) => item.tradingsymbol === tradingSymbol);

  if (!exactMatch?.symboltoken) {
    throw new Error(`Unable to resolve symbol token for ${tradingSymbol}`);
  }

  return exactMatch;
};

const placeAngelOrder = async (jwtToken, orderParams) => {
  const response = await axios.post(
    `${API_BASE}/rest/secure/angelbroking/order/v1/placeOrder`,
    orderParams,
    { headers: buildHeaders(jwtToken) }
  );

  if (response.data?.status === false) {
    throw new Error(`Angel order rejected: ${JSON.stringify(response.data)}`);
  }

  return response.data;
};

const fetchAngelOrderBook = async (jwtToken) => {
  const response = await axios.get(
    `${API_BASE}/rest/secure/angelbroking/order/v1/getOrderBook`,
    { headers: buildHeaders(jwtToken) }
  );

  return response.data?.data || response.data || [];
};

const cancelAngelOrder = async (jwtToken, orderid, variety = VARIETY) => {
  if (!orderid) {
    return null;
  }

  const response = await axios.post(
    `${API_BASE}/rest/secure/angelbroking/order/v1/cancelOrder`,
    {
      variety,
      orderid: String(orderid)
    },
    { headers: buildHeaders(jwtToken) }
  );

  if (response.data?.status === false) {
    throw new Error(`Angel cancel rejected: ${JSON.stringify(response.data)}`);
  }

  return response.data;
};

const buildOrderParams = async (jwtToken, trade, transactiontype = "BUY") => {
  const parsed = parseTrade(trade);
  const tradingsymbol = buildTradingSymbol(parsed);
  const scrip = await searchScrip(jwtToken, tradingsymbol);

  return {
    variety: VARIETY,
    tradingsymbol,
    symboltoken: String(scrip.symboltoken),
    transactiontype,
    exchange: EXCHANGE,
    ordertype: ORDER_TYPE,
    producttype: PRODUCT_TYPE,
    duration: DURATION,
    price: PRICE,
    squareoff: SQUARE_OFF,
    stoploss: STOP_LOSS,
    quantity: String(getQuantityForTrade(parsed.underlying))
  };
};

const numeric = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const deriveOptionStopLoss = (context = {}) => {
  const entryOptionPrice = numeric(context.currentOptionPrice || context.estimatedOptionPrice, 0);
  if (!entryOptionPrice) {
    return numeric(context.option_stop_loss, 0);
  }

  const rawStop = numeric(context.option_stop_loss, 0);
  // Sensible max 18% stop loss on option price
  const defaultStop = Number((entryOptionPrice * 0.82).toFixed(2));
  if (!rawStop || rawStop <= 0 || rawStop < entryOptionPrice * 0.75 || rawStop >= entryOptionPrice) {
    return defaultStop;
  }

  return rawStop;
};

const buildStopLossTriggerPrice = (trade, context = {}) => {
  return Number(deriveOptionStopLoss(context).toFixed(2));
};

const buildStopLossOrderParams = async (jwtToken, trade, context = {}) => {
  const parsed = parseTrade(trade);
  const tradingsymbol = buildTradingSymbol(parsed);
  const scrip = await searchScrip(jwtToken, tradingsymbol);
  const triggerprice = buildStopLossTriggerPrice(trade, context);

  if (!triggerprice) {
    throw new Error(`Unable to derive stop-loss trigger price for ${trade}`);
  }

  return {
    variety: "STOPLOSS",
    tradingsymbol,
    symboltoken: String(scrip.symboltoken),
    transactiontype: "SELL",
    exchange: EXCHANGE,
    ordertype: "STOPLOSS_MARKET",
    producttype: PRODUCT_TYPE,
    duration: DURATION,
    price: "0",
    triggerprice: String(triggerprice.toFixed(2)),
    quantity: String(getQuantityForTrade(parsed.underlying))
  };
};

const realBrokerOrder = async (trade, transactiontype, context = {}) => {
  const { jwtToken } = await login();
  const orderParams = await buildOrderParams(jwtToken, trade, transactiontype);
  const orderResponse = await placeAngelOrder(jwtToken, orderParams);
  const entryOptionPrice = Number(context.currentOptionPrice || context.estimatedOptionPrice || 0);
  const lotAmount = Number.isFinite(entryOptionPrice) && entryOptionPrice > 0
    ? Number((entryOptionPrice * Number(orderParams.quantity)).toFixed(2))
    : null;
  let stopLossOrderResponse = null;
  let stopLossOrderParams = null;

  if (transactiontype === "BUY") {
    try {
      stopLossOrderParams = await buildStopLossOrderParams(jwtToken, trade, context);
      stopLossOrderResponse = await placeAngelOrder(jwtToken, stopLossOrderParams);
    } catch (error) {
      console.error("Failed to place broker stop-loss order:", formatError(error));
    }
  }

  return {
    mode: "live",
    trade,
    transactiontype,
    quantity: Number(orderParams.quantity),
    tradingsymbol: orderParams.tradingsymbol,
    liveOrderPlaced: true,
    brokerResponse: orderResponse,
    simulatedPrice: Number.isFinite(entryOptionPrice) && entryOptionPrice > 0 ? Number(entryOptionPrice.toFixed(2)) : null,
    currentOptionPrice: Number.isFinite(entryOptionPrice) && entryOptionPrice > 0 ? Number(entryOptionPrice.toFixed(2)) : null,
    simulatedAmount: lotAmount,
    lotAmount,
    optionStopLoss: stopLossOrderParams ? Number(stopLossOrderParams.triggerprice) : null,
    stopLossOrderResponse,
    stopLossOrderId: stopLossOrderResponse?.orderid || stopLossOrderResponse?.data?.orderid || null
  };
};

const realTrade = async (trade, context = {}) => realBrokerOrder(trade, "BUY", context);
const realExitTrade = async (trade, context = {}) => realBrokerOrder(trade, "SELL", context);

const getLiveInstrumentConfig = (symbol) => {
  const normalized = String(symbol || "").trim().toLowerCase();

  if (normalized === "nifty" || normalized === "nifty 50" || normalized === "^nsei") {
    return {
      stateKey: "nifty",
      symbol: "NIFTY",
      ticker: "^NSEI",
      token: requireEnv("ANGEL_NIFTY_SPOT_TOKEN"),
      exchangeType: EXCHANGES.nse_cm
    };
  }

  if (normalized === "banknifty" || normalized === "bank nifty" || normalized === "^nsebank") {
    return {
      stateKey: "banknifty",
      symbol: "BANKNIFTY",
      ticker: "^NSEBANK",
      token: requireEnv("ANGEL_BANKNIFTY_SPOT_TOKEN"),
      exchangeType: EXCHANGES.nse_cm
    };
  }

  throw new Error(`Unsupported live symbol: ${symbol}`);
};

const normalizeTickPrice = (rawPrice) => Number(rawPrice) / LIVE_PRICE_SCALE;

const getBucketIso = (timestamp) => {
  const date = new Date(timestamp);
  date.setMilliseconds(0);
  const seconds = date.getSeconds();
  date.setSeconds(seconds - (seconds % LIVE_CANDLE_INTERVAL_SECONDS));
  return date.toISOString();
};

const emitLiveState = (stateKey) => {
  liveFeedEmitter.emit(`tick:${stateKey}`, getLiveMarketSnapshot(stateKey));
};

const isReasonablePriceForState = (stateKey, price) => {
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice)) {
    return false;
  }

  if (stateKey === "nifty") {
    return numericPrice >= 15000 && numericPrice <= 35000;
  }

  if (stateKey === "banknifty") {
    return numericPrice >= 30000 && numericPrice <= 70000;
  }

  return true;
};

const mergeHistoricalCandles = (stateKey, candles = []) => {
  const state = liveMarketState[stateKey];
  if (!state || !Array.isArray(candles) || candles.length === 0) {
    return;
  }

  const merged = new Map();

  [...state.candles, ...candles].forEach((candle) => {
    if (!candle?.time) {
      return;
    }

    const normalized = {
      time: candle.time,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume || 0)
    };

    if (
      [normalized.open, normalized.high, normalized.low, normalized.close].every(Number.isFinite) &&
      [normalized.open, normalized.high, normalized.low, normalized.close].every((price) => isReasonablePriceForState(stateKey, price))
    ) {
      merged.set(normalized.time, normalized);
    }
  });

  state.candles = [...merged.values()]
    .sort((left, right) => new Date(left.time) - new Date(right.time))
    .slice(-MAX_LIVE_CANDLES);

  if (state.latestPrice === null && state.candles.length > 0) {
    const lastCandle = state.candles[state.candles.length - 1];
    state.latestPrice = lastCandle.close;
    state.lastUpdated = lastCandle.time;
  }

  emitLiveState(stateKey);
};

const backfillHistoricalCandles = async () => {
  if (historicalBackfillPromise) {
    return historicalBackfillPromise;
  }

  historicalBackfillPromise = Promise.all(
    ["nifty", "banknifty"].map(async (symbol) => {
      try {
        const { data } = await axios.get(`${AI_ENGINE_URL}/candles/${symbol}`, {
          params: {
            prefer_backend: "false",
            limit: HISTORY_BACKFILL_CANDLES
          }
        });

        mergeHistoricalCandles(symbol, data?.candles || []);
      } catch (error) {
        liveFeedStatus.lastError = error.message;
      }
    })
  ).finally(() => {
    historicalBackfillPromise = null;
  });

  return historicalBackfillPromise;
};

const hasEnoughHistoricalCandles = () => Object.values(liveMarketState).every(
  (state) => Array.isArray(state.candles) && state.candles.length >= MIN_HISTORY_READY_CANDLES
);

const startHistoricalBackfillRetry = () => {
  if (historicalBackfillTimer) {
    return;
  }

  const runBackfill = async () => {
    if (hasEnoughHistoricalCandles()) {
      clearInterval(historicalBackfillTimer);
      historicalBackfillTimer = null;
      return;
    }

    await backfillHistoricalCandles();
  };

  historicalBackfillTimer = setInterval(() => {
    runBackfill().catch(() => {});
  }, HISTORY_BACKFILL_RETRY_MS);

  runBackfill().catch(() => {});
};

const updateLiveCandle = (stateKey, tick) => {
  const state = liveMarketState[stateKey];
  if (!state) {
    return;
  }

  const timestamp = Number(tick.exchange_timestamp || Date.now());
  const price = normalizeTickPrice(tick.last_traded_price);
  if (!isReasonablePriceForState(stateKey, price)) {
    return;
  }
  const bucket = getBucketIso(timestamp);
  const lastCandle = state.candles[state.candles.length - 1];

  state.connected = true;
  state.source = "angel-live";
  state.latestPrice = price;
  state.lastUpdated = new Date(timestamp).toISOString();
  liveFeedStatus.websocketTicks += 1;
  liveFeedStatus.lastTickAt = state.lastUpdated;
  liveFeedStatus.lastError = null;
  liveFeedStatus.transport = "websocket";

  if (!lastCandle || lastCandle.time !== bucket) {
    state.candles.push({
      time: bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: Number(tick.vol_traded || 0)
    });

    if (state.candles.length > MAX_LIVE_CANDLES) {
      state.candles = state.candles.slice(-MAX_LIVE_CANDLES);
    }
  } else {
    lastCandle.high = Math.max(lastCandle.high, price);
    lastCandle.low = Math.min(lastCandle.low, price);
    lastCandle.close = price;
    lastCandle.volume = Number(tick.vol_traded || lastCandle.volume || 0);
  }

  emitLiveState(stateKey);
};

const updateLiveQuote = (stateKey, quote, source) => {
  const state = liveMarketState[stateKey];
  if (!state) {
    return;
  }

  const price = Number(quote?.ltp);
  if (!Number.isFinite(price)) {
    return;
  }
  if (!isReasonablePriceForState(stateKey, price)) {
    return;
  }

  const timestamp = Date.now();
  const bucket = getBucketIso(timestamp);
  const lastCandle = state.candles[state.candles.length - 1];
  const volume = Number.isFinite(Number(quote?.tradeVolume)) ? Number(quote.tradeVolume) : 0;

  state.connected = true;
  state.source = source;
  state.latestPrice = price;
  state.lastUpdated = new Date(timestamp).toISOString();

  if (!lastCandle || lastCandle.time !== bucket) {
    const candleOpen = lastCandle ? Number(lastCandle.close) : price;
    state.candles.push({
      time: bucket,
      open: candleOpen,
      high: Math.max(price, candleOpen),
      low: Math.min(price, candleOpen),
      close: price,
      volume
    });

    if (state.candles.length > MAX_LIVE_CANDLES) {
      state.candles = state.candles.slice(-MAX_LIVE_CANDLES);
    }
  } else {
    lastCandle.high = Math.max(lastCandle.high, price);
    lastCandle.low = Math.min(lastCandle.low, price);
    lastCandle.close = price;
    lastCandle.volume = Math.max(lastCandle.volume || 0, volume);
  }

  emitLiveState(stateKey);
};

const startMarketDataPolling = () => {
  if (marketPollTimer) {
    return;
  }

  const pollQuotes = async () => {
    if (marketPollRunning) {
      return;
    }

    marketPollRunning = true;

    try {
      if (Date.now() < nextMarketPollAt) {
        return;
      }

      if (!isMarketOpen()) {
        nextMarketPollAt = Date.now() + (60 * 60 * 1000);
        return;
      }

      if (!smartApiSession) {
        smartApiSession = await sdkLogin();
      }

      const response = await smartApiSession.smartApi.marketData({
        mode: "FULL",
        exchangeTokens: {
          NSE: getInstrumentConfigs().map((item) => String(item.token))
        }
      });

      if (!response?.status) {
        throw new Error(`Angel marketData failed: ${JSON.stringify(response)}`);
      }

      const fetchedQuotes = response?.data?.fetched || [];
      liveFeedStatus.pollCount += 1;
      liveFeedStatus.lastPollAt = new Date().toISOString();
      liveFeedStatus.lastError = null;

      fetchedQuotes.forEach((quote) => {
        const token = String(quote?.symbolToken || "");
        if (token === String(requireEnv("ANGEL_NIFTY_SPOT_TOKEN"))) {
          updateLiveQuote("nifty", quote, "angel-quote");
        }
        if (token === String(requireEnv("ANGEL_BANKNIFTY_SPOT_TOKEN"))) {
          updateLiveQuote("banknifty", quote, "angel-quote");
        }
      });
      nextMarketPollAt = Date.now() + LIVE_POLL_INTERVAL_MS;
    } catch (error) {
      liveFeedStatus.lastError = formatError(error);
      if (String(liveFeedStatus.lastError || "").toLowerCase().includes("exceeding access rate")) {
        nextMarketPollAt = Date.now() + MARKET_POLL_BACKOFF_MS;
      } else {
        nextMarketPollAt = Date.now() + Math.max(LIVE_POLL_INTERVAL_MS, 5000);
      }
    } finally {
      marketPollRunning = false;
    }
  };

  marketPollTimer = setInterval(pollQuotes, LIVE_POLL_INTERVAL_MS);
  pollQuotes().catch(() => {});
};

const handleLiveFeedError = (error, context = "Live market feed error") => {
  const message = formatError(error);
  liveFeedStatus.websocketConnected = false;
  liveFeedStatus.lastError = message;
  console.error(`${context}:`, message);
};

const subscribeLiveTicks = async () => {
  const session = await sdkLogin();
  const { clientCode, jwtToken, feedToken } = session;
  smartApiSession = session;

  if (!feedToken) {
    throw new Error("Angel live feed token missing from login response");
  }

  liveFeedStatus.started = true;
  liveFeedStatus.transport = "startup";
  liveFeedStatus.lastError = null;

  marketSocket = new WebSocketV2({
    jwttoken: jwtToken,
    apikey: requireEnv("ANGEL_API_KEY"),
    clientcode: clientCode,
    feedtype: feedToken
  });

  // SmartAPI's reconnect loop can race the socket open/close states and trigger
  // "WebSocket is not open: readyState 0 (CONNECTING)" when the reconnect timer
  // fires before the new socket is fully initialized. Falling back to polling keeps
  // the backend stable even if the live feed is flaky or temporarily unavailable.
  marketSocket.customError();

  if (typeof marketSocket.on === "function") {
    marketSocket.on("connect", () => {
      liveFeedStatus.websocketConnected = true;
      liveFeedStatus.lastError = null;
    });

    ["error", "close", "disconnect", "reconnect", "reconnecting"].forEach((eventName) => {
      marketSocket.on(eventName, (event) => {
        handleLiveFeedError(event, `Live market feed ${eventName}`);
      });
    });
  }

  marketSocket.on("tick", (tick) => {
    try {
      const token = normalizeFeedToken(tick?.token);

      if (token === normalizeFeedToken(requireEnv("ANGEL_NIFTY_SPOT_TOKEN"))) {
        updateLiveCandle("nifty", tick);
      }

      if (token === normalizeFeedToken(requireEnv("ANGEL_BANKNIFTY_SPOT_TOKEN"))) {
        updateLiveCandle("banknifty", tick);
      }
    } catch (error) {
      handleLiveFeedError(error, "Live market tick handler error");
    }
  });

  await Promise.resolve(marketSocket.connect()).catch((error) => {
    handleLiveFeedError(error, "Live market feed connect error");
    throw error;
  });
  liveFeedStatus.websocketConnected = true;

  const subscriptions = getInstrumentConfigs();

  await Promise.all(subscriptions.map((item) => Promise.resolve(marketSocket.fetchData({
      correlationID: `live-${item.stateKey}`,
      action: ACTION.Subscribe,
      mode: MODE.LTP,
      exchangeType: item.exchangeType,
      tokens: [String(item.token)]
    })).catch((error) => {
      handleLiveFeedError(error, `Live market subscribe error (${item.stateKey})`);
      throw error;
    })));

  startMarketDataPolling();
};

const updateLiveMarketSpotPrice = (symbol, price, source = "feed") => {
  const config = getLiveInstrumentConfig(symbol);
  if (!config) {
    return;
  }
  const stateKey = config.stateKey;
  const state = liveMarketState[stateKey];
  if (!state) {
    return;
  }

  const numPrice = Number(price);
  if (!Number.isFinite(numPrice) || numPrice <= 0) {
    return;
  }
  if (!isReasonablePriceForState(stateKey, numPrice)) {
    return;
  }

  state.latestPrice = numPrice;
  state.lastUpdated = new Date().toISOString();
  if (state.source !== "angel-live") {
    state.source = source;
  }
  state.connected = true;
  emitLiveState(stateKey);
};

const startLiveMarketFeed = async () => {
  if (liveFeedStarted) {
    return;
  }

  if (liveFeedStartPromise) {
    return liveFeedStartPromise;
  }

  startHistoricalBackfillRetry();
  backfillHistoricalCandles().catch(() => {});
  startMarketDataPolling();

  liveFeedStartPromise = subscribeLiveTicks()
    .then(() => {
      liveFeedStarted = true;
      liveFeedStatus.started = true;
      return backfillHistoricalCandles();
    })
    .catch((error) => {
      liveFeedStarted = false;
      liveFeedStartPromise = null;
      liveFeedStatus.started = false;
      liveFeedStatus.lastError = formatError(error);
      console.warn("Live market WebSocket connect failed, retrying in 30s; using polling/AI engine feeds:", liveFeedStatus.lastError);
      setTimeout(() => {
        if (!liveFeedStarted) {
          startLiveMarketFeed().catch(() => {});
        }
      }, 30000);
      return null;
    });

  return liveFeedStartPromise;
};

const getLiveMarketSnapshot = (symbol) => {
  const config = getLiveInstrumentConfig(symbol);
  const stateKey = config ? config.stateKey : normalizeSymbol(symbol);
  const state = liveMarketState[stateKey];

  if (!state) {
    return {
      symbol: String(symbol || "").toUpperCase(),
      ticker: "",
      source: "unknown",
      connected: false,
      latestPrice: null,
      lastUpdated: null,
      candles: []
    };
  }

  let latestPrice = state.latestPrice;
  let lastUpdated = state.lastUpdated;

  if ((!latestPrice || !Number.isFinite(Number(latestPrice))) && Array.isArray(state.candles) && state.candles.length > 0) {
    const lastCandle = state.candles[state.candles.length - 1];
    latestPrice = Number(lastCandle.close);
    lastUpdated = lastCandle.time;
    state.latestPrice = latestPrice;
    state.lastUpdated = lastUpdated;
  }

  return {
    symbol: state.symbol,
    ticker: state.ticker,
    source: state.source,
    connected: state.connected,
    latestPrice,
    lastUpdated,
    candles: [...state.candles]
  };
};

const getLiveMarketFeedStatus = () => ({
  ...liveFeedStatus,
  symbols: Object.fromEntries(
    Object.entries(liveMarketState).map(([key, value]) => [
      key,
      {
        connected: value.connected,
        source: value.source,
        latestPrice: value.latestPrice,
        lastUpdated: value.lastUpdated,
        candleCount: value.candles.length
      }
    ])
  )
});

const subscribeToLiveMarket = (symbol, callback) => {
  const stateKey = getLiveInstrumentConfig(symbol).stateKey;
  const eventName = `tick:${stateKey}`;

  liveFeedEmitter.on(eventName, callback);
  return () => liveFeedEmitter.off(eventName, callback);
};

const placeOrder = async (trade, context = {}) => {
  if (!trade || trade === "WAIT") {
    return null;
  }

  const quoteContext = { ...context };

  try {
    const optionQuote = await fetchOptionQuote(trade, { forceRefresh: true });
    if (optionQuote) {
      if (String(optionQuote.quoteSource || "").toLowerCase() !== "live_quote") {
        throw Object.assign(new Error("live_option_quote_unavailable"), {
          details: {
            reason: "live_option_quote_unavailable",
            quoteSource: optionQuote.quoteSource || null
          }
        });
      }

      quoteContext.optionTradingsymbol = optionQuote.tradingsymbol;
      quoteContext.optionSymbolToken = optionQuote.symboltoken;
      quoteContext.lotAmount = optionQuote.lotAmount;
      quoteContext.quantity = optionQuote.quantity;
      quoteContext.quoteSource = optionQuote.quoteSource || "live_quote";
      quoteContext.currentOptionPrice = optionQuote.optionPrice;
      quoteContext.estimatedOptionPrice = optionQuote.optionPrice;
    }
  } catch (error) {
    console.error("Option quote fetch failed:", formatError(error));
    if (!PAPER_MODE && ENABLE_REAL_TRADING) {
      throw error;
    }
    const fallbackPrice = Number(quoteContext.estimatedOptionPrice || quoteContext.currentOptionPrice || 0);
    if (!Number.isFinite(fallbackPrice) || fallbackPrice <= 0) {
      throw error;
    }
    quoteContext.currentOptionPrice = fallbackPrice;
    quoteContext.estimatedOptionPrice = fallbackPrice;
    quoteContext.quoteSource = "estimated_quote";
  }

  if (PAPER_MODE || !ENABLE_REAL_TRADING) {
    return buildSimulatedOrder(trade, quoteContext);
  }

  try {
    return await realTrade(trade, quoteContext);
  } catch (error) {
    console.error("Real trade failed:", formatError(error));
    if (!ALLOW_SIMULATED_FALLBACK) {
      throw error;
    }

    const fallbackPrice = Number(quoteContext.currentOptionPrice || quoteContext.estimatedOptionPrice || 0);
    if (!Number.isFinite(fallbackPrice) || fallbackPrice <= 0) {
      throw error;
    }

    quoteContext.currentOptionPrice = fallbackPrice;
    quoteContext.estimatedOptionPrice = fallbackPrice;
    return buildSimulatedOrder(trade, quoteContext);
  }
};

const closeTrade = async (trade, context = {}) => {
  if (!trade || trade === "WAIT") {
    return null;
  }

  const quoteContext = { ...context };
  const stopLossOrderId = context.stopLossOrderId || context.stopLossOrderResponse?.orderid || context.stopLossOrderResponse?.data?.orderid || null;
  try {
    const optionQuote = await fetchOptionQuote(trade, { forceRefresh: true });
    if (optionQuote) {
      if (String(optionQuote.quoteSource || "").toLowerCase() !== "live_quote") {
        throw Object.assign(new Error("live_option_quote_unavailable"), {
          details: {
            reason: "live_option_quote_unavailable",
            quoteSource: optionQuote.quoteSource || null
          }
        });
      }

      quoteContext.optionTradingsymbol = optionQuote.tradingsymbol;
      quoteContext.optionSymbolToken = optionQuote.symboltoken;
      quoteContext.lotAmount = optionQuote.lotAmount;
      quoteContext.quantity = optionQuote.quantity;
      quoteContext.quoteSource = optionQuote.quoteSource || "live_quote";
      if (String(quoteContext.quoteSource).toLowerCase() === "live_quote") {
        quoteContext.currentOptionPrice = optionQuote.optionPrice;
      }
    }
  } catch (error) {
    console.error("Option exit quote fetch failed:", formatError(error));
  }

  if (PAPER_MODE || !ENABLE_REAL_TRADING) {
    return buildSimulatedExit(trade, quoteContext);
  }

  if (stopLossOrderId) {
    try {
      const { jwtToken } = await login();
      const orderBook = await fetchAngelOrderBook(jwtToken);
      const brokerStopOrder = (Array.isArray(orderBook) ? orderBook : orderBook?.data || [])
        .find((order) => String(order?.orderid || order?.data?.orderid || "") === String(stopLossOrderId));
      const status = String(brokerStopOrder?.orderstatus || brokerStopOrder?.status || "").toLowerCase();
      const isFilled = ["complete", "completed", "filled", "executed"].includes(status);

      if (!isFilled) {
        await cancelAngelOrder(jwtToken, stopLossOrderId, "STOPLOSS");
      } else {
        const exitPrice = Number(brokerStopOrder?.averageprice || brokerStopOrder?.price || brokerStopOrder?.triggerprice || quoteContext.currentOptionPrice || 0);
        const quantity = Number(brokerStopOrder?.filledshares || quoteContext.quantity || 0);
        return {
          mode: "live",
          trade,
          stopLossOrderId,
          stopLossOrderFilled: true,
          brokerResponse: brokerStopOrder || null,
          exitPrice: Number.isFinite(exitPrice) ? exitPrice : null,
          exitAmount: Number.isFinite(exitPrice) && Number.isFinite(quantity) ? Number((exitPrice * quantity).toFixed(2)) : null,
          quantity: Number.isFinite(quantity) ? quantity : null
        };
      }
    } catch (error) {
      console.error("Failed to cancel broker stop-loss order:", formatError(error));
    }
  }

  return realExitTrade(trade, quoteContext);
};

const getBrokerOrderBook = async () => {
  const { jwtToken } = await login();
  return fetchAngelOrderBook(jwtToken);
};

module.exports = {
  placeOrder,
  closeTrade,
  fetchOptionQuote,
  getBrokerOrderBook,
  getQuantityForTrade,
  startLiveMarketFeed,
  getLiveMarketSnapshot,
  updateLiveMarketSpotPrice,
  subscribeToLiveMarket,
  getLiveMarketFeedStatus
};
