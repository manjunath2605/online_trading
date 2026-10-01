const mongoose = require("mongoose");

const TradeSchema = new mongoose.Schema({

  symbol: {
    type: String,
    required: true
  },

  trade: String,

  signal: String,

  price: {
    type: Number,
    default: 0
  },

  estimated_option_price: Number,
  quote_source: String,
  optionTradingsymbol: String,
  optionSymbolToken: String,
  optionLotAmount: Number,
  option_stop_loss: Number,
  option_target_price: Number,
  exit_option_price: Number,
  exitOptionLotAmount: Number,
  stopLossOrderId: String,
  stopLossOrderStatus: String,
  stopLossOrderResponse: mongoose.Schema.Types.Mixed,
  stopLossOrderSyncError: String,
  currentOptionPrice: Number,
  currentLotAmount: Number,
  current_pnl: Number,
  current_pnl_percent: Number,
  currentQuoteAvailable: {
    type: Boolean,
    default: false
  },
  currentQuoteUpdatedAt: Date,

  confidence: Number,
  risk_reward: Number,
  market_regime: String,
  quality_score: Number,
  volume_ratio: Number,
  liquidity_signal: String,
  higher_tf_bullish: Boolean,
  higher_tf_bearish: Boolean,
  reasons: [String],
  rejectionReason: String,

  stop_loss: Number,

  target: Number,

  result: {
    type: String,
    default: "OPEN",
    index: true
  },

  approvalStatus: {
    type: String,
    default: "PENDING"
  },

  executionMode: String,

  simulatedPrice: Number,
  simulatedQuantity: Number,
  simulatedAmount: Number,

  maxProfitSeen: {
    type: Number,
    default: 0
  },

  minProfitSeen: {
    type: Number,
    default: 0
  },

  partialBooked: {
    type: Boolean,
    default: false
  },

  movedToBreakeven: {
    type: Boolean,
    default: false
  },

  trailingStop: Number,

  partialPrice: Number,

  exit_reason: String,

  approvedAt: Date,
  rejectedAt: Date,

  orderResponse: mongoose.Schema.Types.Mixed,
  exitOrderResponse: mongoose.Schema.Types.Mixed,

  exit_price: Number,

  duplicateTrade: {
    type: Boolean,
    default: false
  },
  duplicateOfTradeId: String,
  duplicateReason: String,

  executionFingerprint: {
    type: String
  },

  closedAt: Date,

  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }

});

TradeSchema.index(
  { executionFingerprint: 1 },
  {
    unique: true,
    partialFilterExpression: {
      duplicateTrade: false,
      executionFingerprint: { $type: "string" }
    }
  }
);

module.exports = mongoose.model("Trade", TradeSchema);
