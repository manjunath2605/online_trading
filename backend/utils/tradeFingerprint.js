const normalizeValue = (value) => String(value || "").trim().toUpperCase();

const getTradeMinuteKey = (tradeDate = new Date()) => {
  const date = new Date(tradeDate);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}Z`;
};

const getTradeExecutionFingerprint = (trade = {}, tradeDate = new Date()) => {
  const minuteKey = getTradeMinuteKey(tradeDate);
  const symbol = normalizeValue(trade.symbol);
  const contract = normalizeValue(trade.trade);
  const signal = normalizeValue(trade.signal);

  if (!minuteKey || !symbol || !contract || !signal) {
    return "";
  }

  return [minuteKey, symbol, contract, signal].join("|");
};

module.exports = {
  getTradeExecutionFingerprint,
  getTradeMinuteKey
};
