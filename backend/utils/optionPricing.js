const toNumber = (value, fallback = NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const firstFinite = (...values) => {
  for (const value of values) {
    const parsed = toNumber(value, NaN);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return NaN;
};

const getOptionQuantity = (trade) => firstFinite(
  trade?.simulatedQuantity,
  trade?.orderResponse?.quantity,
  trade?.optionQuantity
);

const getEntryOptionPrice = (trade) => firstFinite(
  trade?.estimated_option_price,
  trade?.simulatedPrice,
  trade?.entryOptionPrice
);

const getExitOptionPrice = (trade) => firstFinite(
  trade?.exit_option_price,
  trade?.exitOrderResponse?.exitPrice,
  trade?.exitOrderResponse?.exit_option_price,
  trade?.exitOrderResponse?.currentOptionPrice
);

const getExitOptionLotAmount = (trade, quantity = getOptionQuantity(trade)) => firstFinite(
  trade?.exitOptionLotAmount,
  trade?.exitOrderResponse?.exitAmount,
  getOptionLotAmount(getExitOptionPrice(trade), quantity)
);

const getOptionLotAmount = (price, quantity) => {
  const numericPrice = toNumber(price, NaN);
  const numericQuantity = toNumber(quantity, NaN);

  if (!Number.isFinite(numericPrice) || !Number.isFinite(numericQuantity) || numericPrice <= 0 || numericQuantity <= 0) {
    return NaN;
  }

  return Number((numericPrice * numericQuantity).toFixed(2));
};

module.exports = {
  firstFinite,
  getEntryOptionPrice,
  getExitOptionPrice,
  getExitOptionLotAmount,
  getOptionLotAmount,
  getOptionQuantity,
  toNumber
};
