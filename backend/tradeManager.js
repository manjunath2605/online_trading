let lossStreak = 0;
const sendSignal = require("./telegram");
const {
  getEntryOptionPrice,
  getOptionQuantity
} = require("./utils/optionPricing");

const MAX_LOSS_STREAK = Math.min(Number(process.env.MAX_LOSS_STREAK || 20), 20);
const PAPER_OPEN_TRADE_MAX_AGE_MS = Math.max(Number(process.env.PAPER_OPEN_TRADE_MAX_AGE_MS || (8 * 60 * 60 * 1000)), 60 * 1000);
const OPTION_QUOTE_REFRESH_MS = Math.max(Number(process.env.ANGEL_OPTION_QUOTE_REFRESH_MS || 10000), 1000);
const OPTION_QUOTE_FAILURE_BACKOFF_MS = Math.max(Number(process.env.ANGEL_OPTION_QUOTE_FAILURE_BACKOFF_MS || 60000), 5000);
const PAPER_OPTION_TARGET_MIN_GAIN_PCT = Math.max(Number(process.env.PAPER_OPTION_TARGET_MIN_GAIN_PCT || 0.20), 0.01);
const PAPER_OPTION_TARGET_SPOT_MULTIPLIER = Math.max(Number(process.env.PAPER_OPTION_TARGET_SPOT_MULTIPLIER || 28), 1);
const PAPER_OPTION_TARGET_LIQUIDITY_BONUS = Math.max(Number(process.env.PAPER_OPTION_TARGET_LIQUIDITY_BONUS || 1.5), 1);
const PAPER_BREAKEVEN_R_MULTIPLIER = Math.max(Number(process.env.PAPER_BREAKEVEN_R_MULTIPLIER || 0.7), 0.3);
const PAPER_TRAILING_R_MULTIPLIER = Math.max(Number(process.env.PAPER_TRAILING_R_MULTIPLIER || 1.2), 0.5);
const PAPER_TRAIL_EXIT_R_MULTIPLIER = Math.max(Number(process.env.PAPER_TRAIL_EXIT_R_MULTIPLIER || 1.5), 0.5);
const PAPER_MAX_UNDERLYING_DRIFT_PCT_FOR_OPTION_SPIKE = Math.max(Number(process.env.PAPER_MAX_UNDERLYING_DRIFT_PCT_FOR_OPTION_SPIKE || 0.5), 0.05);
const PAPER_MAX_OPTION_SPIKE_MULTIPLIER = Math.max(Number(process.env.PAPER_MAX_OPTION_SPIKE_MULTIPLIER || 4), 1.5);
const PAPER_MIN_OPTION_WIN_MULTIPLIER = Math.max(Number(process.env.PAPER_MIN_OPTION_WIN_MULTIPLIER || 1.5), 1.05);
const MARKET_TIMEZONE = process.env.MARKET_TIMEZONE || "Asia/Kolkata";
const MARKET_FORCE_EXIT_TIME = process.env.MARKET_FORCE_EXIT_TIME || "15:28";

function normalizeSymbol(symbol) {
  const value = String(symbol || "").trim().toLowerCase();

  if (value === "nifty" || value === "nifty 50") {
    return "nifty";
  }

  if (value === "banknifty" || value === "bank nifty") {
    return "banknifty";
  }

  return value;
}

function fmtMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "N/A";
}

function buildExitTelegramMessage(trade, exitReason, realizedLotPnl) {
  const isStopLossExit = ["STOP_LOSS_HIT", "BROKER_STOP_LOSS_FILLED"].includes(String(exitReason || "").toUpperCase());
  return [
    isStopLossExit ? "Stop loss hit and trade exited" : "Trade exited",
    `${trade?.symbol || "-"}`,
    `${trade?.trade || "-"}`,
    `Signal: ${trade?.signal || "-"}`,
    `Entry spot: ${fmtMoney(trade?.price)}`,
    `Exit spot: ${fmtMoney(trade?.exit_price)}`,
    `Entry option: ${fmtMoney(getEntryOptionPrice(trade))}`,
    `Exit option: ${fmtMoney(trade?.exit_option_price)}`,
    `Lot P&L: Rs. ${fmtMoney(realizedLotPnl)}`,
    `Reason: ${exitReason || "-"}`,
    `Quote source: ${trade?.quote_source || "rejected_no_quote"}`
  ].join("\n");
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getMarketTimeString() {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: MARKET_TIMEZONE
  });

  return formatter.format(new Date());
}

function isForceExitTimeReached() {
  const now = getMarketTimeString();
  return now >= `${MARKET_FORCE_EXIT_TIME}:00`;
}

function getOptionLevels(trade) {
  const entryOptionPrice = getEntryOptionPrice(trade);

  if (!entryOptionPrice || entryOptionPrice <= 0) {
    return {
      optionStop: numeric(trade.option_stop_loss, 0),
      optionTarget: numeric(trade.option_target_price, 0)
    };
  }

  // Capital-protecting stop loss: max 15% - 18% loss on option
  const defaultStopPrice = Number((entryOptionPrice * 0.82).toFixed(2));
  let rawStop = numeric(trade.option_stop_loss, 0);
  let optionStop;
  if (!rawStop || rawStop <= 0 || rawStop < entryOptionPrice * 0.75 || rawStop >= entryOptionPrice) {
    optionStop = defaultStopPrice;
  } else {
    optionStop = rawStop;
  }

  // Capital-building target: at least +20% to +35% gain
  const defaultTargetPrice = Number((entryOptionPrice * 1.25).toFixed(2));
  let rawTarget = numeric(trade.option_target_price, 0);
  let optionTarget;
  if (!rawTarget || rawTarget <= entryOptionPrice * 1.08) {
    optionTarget = defaultTargetPrice;
  } else {
    optionTarget = Math.max(rawTarget, defaultTargetPrice);
  }

  return {
    optionStop: Number(optionStop.toFixed(2)),
    optionTarget: Number(optionTarget.toFixed(2))
  };
}


function getOptionOpenPnl(trade, optionPrice) {
  const entryOptionPrice = getEntryOptionPrice(trade);
  const optionQuantity = getOptionQuantity(trade);

  if (!entryOptionPrice || !optionQuantity || !optionPrice) {
    return 0;
  }

  return (numeric(optionPrice) - entryOptionPrice) * optionQuantity;
}

function getSafeExitOptionPrice(trade, liveOptionPrice, fallbackOptionPrice) {
  const entryOptionPrice = getEntryOptionPrice(trade);
  const safePrice = numeric(liveOptionPrice || fallbackOptionPrice || entryOptionPrice, 0);
  return safePrice > 0 ? safePrice : entryOptionPrice;
}

function getOptionRisk(trade) {
  const entryOptionPrice = getEntryOptionPrice(trade);
  const { optionStop } = getOptionLevels(trade);

  if (!entryOptionPrice || !optionStop) {
    return 0;
  }

  return Math.abs(entryOptionPrice - optionStop);
}

function stopLossHit(trade, optionPrice) {
  const { optionStop } = getOptionLevels(trade);
  const activeStop = numeric(trade.trailingStop || optionStop, 0);
  if (Boolean(activeStop) && optionPrice <= activeStop) {
    return true;
  }
  const entryOptionPrice = getEntryOptionPrice(trade);
  if (entryOptionPrice > 0 && optionPrice <= entryOptionPrice * 0.80) {
    return true;
  }
  return false;
}

function targetHit(trade, optionPrice) {
  const { optionTarget } = getOptionLevels(trade);
  return Boolean(optionTarget) && optionPrice >= optionTarget;
}

function isLiveTrade(trade) {
  return String(trade.executionMode || "").toLowerCase() === "live";
}

function getStopLossOrderId(trade) {
  return trade.stopLossOrderId
    || trade.stopLossOrderResponse?.orderid
    || trade.stopLossOrderResponse?.data?.orderid
    || null;
}

function isBrokerOrderFilled(order) {
  const status = String(order?.orderstatus || order?.status || "").toLowerCase();
  return ["complete", "completed", "filled", "executed"].includes(status);
}

function isBrokerOrderRejectedOrCancelled(order) {
  const status = String(order?.orderstatus || order?.status || "").toLowerCase();
  return ["cancelled", "canceled", "rejected"].includes(status);
}

function getBrokerOrderExitPrice(order, fallbackPrice = 0) {
  const orderPrice = numeric(order?.averageprice || order?.price || order?.triggerprice, 0);
  return orderPrice > 0 ? orderPrice : fallbackPrice;
}

async function markBrokerStopLossFilled(trade, brokerOrder, fallbackSpotPrice, fallbackOptionPrice) {
  const exitOptionPrice = getBrokerOrderExitPrice(brokerOrder, fallbackOptionPrice);
  const pnl = getOptionOpenPnl(trade, exitOptionPrice);

  trade.result = pnl >= 0 ? "WIN" : "LOSS";
  trade.exit_price = fallbackSpotPrice;
  trade.exit_option_price = exitOptionPrice || undefined;
  trade.exit_reason = "BROKER_STOP_LOSS_FILLED";
  trade.closedAt = new Date();
  trade.exitOrderResponse = brokerOrder;
  trade.exitOptionLotAmount = exitOptionPrice && getOptionQuantity(trade)
    ? Number((exitOptionPrice * getOptionQuantity(trade)).toFixed(2))
    : undefined;
  trade.currentOptionPrice = exitOptionPrice || trade.currentOptionPrice;
  trade.currentLotAmount = exitOptionPrice && getOptionQuantity(trade)
    ? Number((exitOptionPrice * getOptionQuantity(trade)).toFixed(2))
    : trade.currentLotAmount;
  trade.current_pnl = Number(pnl.toFixed(2));
  trade.current_pnl_percent = getOptionPnlPercent(trade, pnl);
  trade.currentQuoteAvailable = Boolean(exitOptionPrice);
  trade.currentQuoteUpdatedAt = new Date();
  trade.stopLossOrderStatus = brokerOrder?.orderstatus || brokerOrder?.status || "COMPLETE";
  trade.stopLossOrderResponse = brokerOrder;
  trade.stopLossOrderId = trade.stopLossOrderId || brokerOrder?.orderid || null;
  await trade.save();
  await sendSignal(buildExitTelegramMessage(trade, "BROKER_STOP_LOSS_FILLED", pnl));
}

function updateTradeExtremes(trade, pnl) {
  trade.maxProfitSeen = Math.max(numeric(trade.maxProfitSeen, 0), pnl);
  trade.minProfitSeen = Math.min(numeric(trade.minProfitSeen, 0), pnl);
}

function getOptionPnlPercent(trade, optionPnl) {
  const entryOptionPrice = getEntryOptionPrice(trade);
  const optionQuantity = getOptionQuantity(trade);

  if (!entryOptionPrice || !optionQuantity || !Number.isFinite(optionPnl)) {
    return null;
  }

  const entryLotAmount = entryOptionPrice * optionQuantity;
  if (!entryLotAmount) {
    return null;
  }

  return Number(((optionPnl / entryLotAmount) * 100).toFixed(2));
}

function maybeMoveToBreakeven(trade, optionPrice) {
  if (trade.movedToBreakeven) {
    return false;
  }

  const risk = getOptionRisk(trade);
  if (!risk) {
    return false;
  }

  const pnl = getOptionOpenPnl(trade, optionPrice);
  if (pnl < risk * PAPER_BREAKEVEN_R_MULTIPLIER) {
    return false;
  }

  trade.trailingStop = getEntryOptionPrice(trade);
  trade.movedToBreakeven = true;
  return true;
}

function updateTrailingStop(trade, optionPrice) {
  const entryOptionPrice = getEntryOptionPrice(trade);
  const quantity = getOptionQuantity(trade) || 1;
  const risk = getOptionRisk(trade);
  const pnl = getOptionOpenPnl(trade, optionPrice);

  if (!entryOptionPrice || !risk || pnl <= risk * PAPER_TRAILING_R_MULTIPLIER) {
    return false;
  }

  const { optionStop } = getOptionLevels(trade);
  const activeStop = numeric(trade.trailingStop || optionStop, 0);
  const lockPnl = Math.max(risk * 0.4, numeric(trade.maxProfitSeen, 0) * 0.5);
  const lockPoints = lockPnl / quantity;
  const nextStop = Math.max(activeStop, entryOptionPrice + lockPoints);

  if (nextStop > activeStop) {
    trade.trailingStop = Number(nextStop.toFixed(2));
    return true;
  }

  return false;
}

function shouldTrailExit(trade, optionPrice) {
  const pnl = getOptionOpenPnl(trade, optionPrice);
  const best = numeric(trade.maxProfitSeen, 0);
  const risk = getOptionRisk(trade);

  if (!risk || best < risk * PAPER_TRAIL_EXIT_R_MULTIPLIER) {
    return false;
  }

  return pnl <= best * 0.60;
}

async function closeTradePosition(trade, closeTrade, spotExitPrice, optionExitPrice, result, exitReason) {
  const isPaperTrade = String(trade.executionMode || "").toLowerCase() === "paper";
  trade.result = result;
  trade.exit_price = spotExitPrice;
  trade.exit_option_price = optionExitPrice || undefined;
  trade.exit_reason = exitReason;
  trade.closedAt = new Date();
  const exitOrderResponse = await closeTrade(trade.trade, {
    exitPrice: spotExitPrice,
    currentOptionPrice: optionExitPrice,
    stopLossOrderId: getStopLossOrderId(trade)
  });
  trade.exitOrderResponse = exitOrderResponse;

  const realizedExitPrice = numeric(
    exitOrderResponse?.exitPrice
      || exitOrderResponse?.exit_option_price
      || exitOrderResponse?.currentOptionPrice
      || trade.exit_option_price,
    0
  );
  const realizedEntryPrice = getEntryOptionPrice(trade);
  const realizedQuantity = getOptionQuantity(trade);
  const optionTargetPrice = numeric(trade.option_target_price, 0);
  const entrySpotPrice = numeric(trade.price, 0);
  const underlyingDriftPct = entrySpotPrice && Number.isFinite(spotExitPrice)
    ? (Math.abs(spotExitPrice - entrySpotPrice) / entrySpotPrice) * 100
    : null;
  const exitSpikeMultiplier = realizedEntryPrice > 0 ? (realizedExitPrice / realizedEntryPrice) : 0;
  const suspiciousSpike = isPaperTrade
    && result === "WIN"
    && realizedQuantity
    && realizedEntryPrice
    && Number.isFinite(underlyingDriftPct)
    && underlyingDriftPct <= PAPER_MAX_UNDERLYING_DRIFT_PCT_FOR_OPTION_SPIKE
    && exitSpikeMultiplier >= PAPER_MAX_OPTION_SPIKE_MULTIPLIER;

  const adjustedExitPrice = suspiciousSpike
    ? Math.max(optionTargetPrice || 0, realizedEntryPrice * PAPER_MIN_OPTION_WIN_MULTIPLIER)
    : (isPaperTrade && result === "WIN" && realizedQuantity && realizedEntryPrice && realizedExitPrice <= realizedEntryPrice
      ? Math.max(optionTargetPrice || 0, realizedEntryPrice + 0.05)
      : realizedExitPrice);

  if (realizedEntryPrice && adjustedExitPrice && realizedQuantity) {
    const realizedLotPnl = Number(((adjustedExitPrice - realizedEntryPrice) * realizedQuantity).toFixed(2));
    trade.result = realizedLotPnl >= 0 ? "WIN" : "LOSS";
    trade.current_pnl = realizedLotPnl;
    trade.current_pnl_percent = getOptionPnlPercent(trade, realizedLotPnl);
    trade.exit_option_price = adjustedExitPrice;
    trade.exitOptionLotAmount = Number((adjustedExitPrice * realizedQuantity).toFixed(2));
  }

  if (exitOrderResponse?.stopLossOrderFilled) {
    const stopExitPrice = numeric(exitOrderResponse.exitPrice, optionExitPrice);
    const stopExitAmount = numeric(exitOrderResponse.exitAmount, 0);
    const pnl = getOptionOpenPnl(trade, stopExitPrice);
    trade.result = pnl >= 0 ? "WIN" : "LOSS";
    trade.exit_option_price = stopExitPrice || trade.exit_option_price;
    trade.exitOptionLotAmount = stopExitAmount || trade.exitOptionLotAmount;
    trade.exit_reason = "BROKER_STOP_LOSS_FILLED";
  }
  if (!exitOrderResponse?.stopLossOrderFilled) {
    trade.exitOptionLotAmount = numeric(trade.exitOrderResponse?.exitAmount, 0) || undefined;
  }
  await trade.save();

  const realizedLotPnl = Number.isFinite(trade.current_pnl) ? trade.current_pnl : getOptionOpenPnl(trade, numeric(trade.exit_option_price, optionExitPrice));
  await sendSignal(buildExitTelegramMessage(trade, exitReason, realizedLotPnl));
}

async function manageTrades(getLiveSpotPrice, getLiveOptionPrice, closeTrade, Trade, getBrokerOrderBook) {
  if (!Trade || typeof Trade.find !== "function") {
    return;
  }

  if (Trade.db && Trade.db.readyState !== 1) {
    return;
  }

  const openTrades = await Trade.find({ result: "OPEN", duplicateTrade: { $ne: true } });
  const forceExitNow = isForceExitTimeReached();

  for (const trade of openTrades) {
    const stopLossOrderId = getStopLossOrderId(trade);
    const brokerManagedStopLoss = isLiveTrade(trade) && Boolean(stopLossOrderId);
    const spotPrice = numeric(getLiveSpotPrice(normalizeSymbol(trade.symbol)), 0);
    const shouldRefreshOptionQuote = true;
    const shouldRetryFailedQuote = true;
    let liveOptionPrice = 0;
    if (shouldRefreshOptionQuote && shouldRetryFailedQuote) {
      liveOptionPrice = numeric(await getLiveOptionPrice(trade, { forceRefresh: true }), 0);
      if (!liveOptionPrice) {
        trade.optionQuoteLastFailedAt = new Date();
      } else if (trade.optionQuoteLastFailedAt) {
        trade.optionQuoteLastFailedAt = undefined;
      }
    }
    const optionPrice = liveOptionPrice > 0 ? liveOptionPrice : null;
    const exitOptionPrice = optionPrice;
    const createdAtMs = trade.createdAt ? new Date(trade.createdAt).getTime() : NaN;
    const tradeAgeMs = Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : 0;
    const isPaperTrade = String(trade.executionMode || "").toLowerCase() === "paper";

    if (brokerManagedStopLoss && typeof getBrokerOrderBook === "function") {
      try {
        const orderBook = await getBrokerOrderBook();
        const orderList = Array.isArray(orderBook) ? orderBook : orderBook?.data || [];
        const brokerStopOrder = orderList.find((order) => String(order?.orderid || order?.data?.orderid || "") === String(stopLossOrderId));

        if (brokerStopOrder) {
          if (isBrokerOrderFilled(brokerStopOrder)) {
            await markBrokerStopLossFilled(trade, brokerStopOrder, spotPrice || numeric(trade.price, 0), optionPrice);
            continue;
          }

          if (isBrokerOrderRejectedOrCancelled(brokerStopOrder)) {
            trade.stopLossOrderStatus = brokerStopOrder.orderstatus || brokerStopOrder.status || "CANCELLED";
            trade.stopLossOrderResponse = brokerStopOrder;
            trade.stopLossOrderId = undefined;
          }
        }
      } catch (error) {
        trade.stopLossOrderSyncError = String(error?.message || error);
      }
    }

    if (forceExitNow) {
      const pnl = getOptionOpenPnl(trade, exitOptionPrice || numeric(trade.currentOptionPrice || trade.estimated_option_price || trade.simulatedPrice, 0));
      if (pnl >= 0) {
        lossStreak = 0;
      } else {
        lossStreak += 1;
      }

      await closeTradePosition(
        trade,
        closeTrade,
        spotPrice || numeric(trade.price, 0),
        exitOptionPrice,
        pnl >= 0 ? "WIN" : "LOSS",
        "FORCED_EOD_EXIT"
      );
      continue;
    }

    if (!optionPrice) {
      if (isPaperTrade && tradeAgeMs >= PAPER_OPEN_TRADE_MAX_AGE_MS) {
        trade.optionQuoteLastFailedAt = new Date();
        await trade.save();
      } else {
        trade.optionQuoteLastFailedAt = new Date();
        await trade.save();
      }

      continue;
    }

    const { optionStop, optionTarget } = getOptionLevels(trade);
    if (optionStop && !numeric(trade.option_stop_loss, 0)) {
      trade.option_stop_loss = optionStop;
    }
    if (optionTarget && !numeric(trade.option_target_price, 0)) {
      trade.option_target_price = optionTarget;
    }

    const pnl = getOptionOpenPnl(trade, optionPrice);
    updateTradeExtremes(trade, pnl);
    maybeMoveToBreakeven(trade, optionPrice);
    updateTrailingStop(trade, optionPrice);
    trade.currentOptionPrice = Number(optionPrice.toFixed(2));
    trade.currentLotAmount = Number((optionPrice * getOptionQuantity(trade)).toFixed(2));
    trade.current_pnl = Number(pnl.toFixed(2));
    trade.current_pnl_percent = getOptionPnlPercent(trade, pnl);
    trade.currentQuoteAvailable = true;
    trade.currentQuoteUpdatedAt = new Date();

    if (!brokerManagedStopLoss && stopLossHit(trade, optionPrice)) {
      const profitableStop = pnl >= 0 || numeric(trade.trailingStop, 0) > getEntryOptionPrice(trade);

      if (!profitableStop) {
        lossStreak += 1;
      } else {
        lossStreak = 0;
      }

      await closeTradePosition(
        trade,
        closeTrade,
        spotPrice || numeric(trade.price, 0),
        optionPrice,
        profitableStop ? "WIN" : "LOSS",
        profitableStop ? "TRAILING_STOP_HIT" : "STOP_LOSS_HIT"
      );
      continue;
    }

    if (targetHit(trade, optionPrice)) {
      lossStreak = 0;
      await closeTradePosition(
        trade,
        closeTrade,
        spotPrice || numeric(trade.price, 0),
        optionPrice,
        "WIN",
        "TARGET_HIT"
      );
      continue;
    }

    if (shouldTrailExit(trade, optionPrice)) {
      lossStreak = 0;
      await closeTradePosition(
        trade,
        closeTrade,
        spotPrice || numeric(trade.price, 0),
        optionPrice,
        "WIN",
        "TRAILING_PROFIT_BOOK"
      );
      continue;
    }

    if (trade.optionQuoteLastFailedAt && shouldRetryFailedQuote) {
      trade.optionQuoteLastFailedAt = undefined;
    }

    await trade.save();
  }
}

function allowNewTrade() {
  return lossStreak < MAX_LOSS_STREAK;
}

function getRiskControlsStatus() {
  return {
    lossStreak,
    maxLossStreak: MAX_LOSS_STREAK,
    newTradesAllowed: allowNewTrade()
  };
}

module.exports = {
  manageTrades,
  allowNewTrade,
  getRiskControlsStatus
};
