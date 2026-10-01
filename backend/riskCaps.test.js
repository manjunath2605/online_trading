const test = require('node:test');
const assert = require('node:assert/strict');

const { getSessionRiskSnapshot, getDailyLossSnapshot, getRiskCapGate } = require('./riskCaps');

test('session risk cap blocks when open trade risk exceeds the limit', () => {
  const snapshot = getSessionRiskSnapshot({
    trades: [
      { result: 'OPEN', price: 22000, stop_loss: 21900, option_stop_loss: 120, option_target_price: 170, currentOptionPrice: 130, estimated_option_price: 130, optionLotAmount: 1500 },
      { result: 'OPEN', price: 22050, stop_loss: 21950, option_stop_loss: 110, option_target_price: 190, currentOptionPrice: 140, estimated_option_price: 140, optionLotAmount: 1500 }
    ],
    sessionRiskLimit: 500
  });

  assert.equal(snapshot.sessionRiskUsed > snapshot.sessionRiskLimit, true);
  assert.equal(snapshot.sessionRiskExceeded, true);
});

test('daily max loss cap blocks when limit is breached', () => {
  const snapshot = getDailyLossSnapshot({
    trades: [
      { result: 'LOSS', createdAt: new Date(), lotPnl: -1200 },
      { result: 'LOSS', createdAt: new Date(), lotPnl: -900 },
      { result: 'OPEN', createdAt: new Date(), current_pnl: -300 }
    ],
    dailyLossLimit: 1500
  });

  assert.equal(snapshot.dailyPnl <= snapshot.dailyLossLimit * -1, true);
  assert.equal(snapshot.dailyLossExceeded, true);
});

test('risk cap gate returns the first blocking reason', () => {
  const gate = getRiskCapGate({
    trades: [
      { result: 'OPEN', price: 22000, stop_loss: 21900, option_stop_loss: 120, estimated_option_price: 130, optionLotAmount: 1500 },
      { result: 'OPEN', price: 22100, stop_loss: 22000, option_stop_loss: 130, estimated_option_price: 140, optionLotAmount: 1500 },
      { result: 'LOSS', createdAt: new Date(), lotPnl: -2500 }
    ],
    sessionRiskLimit: 500,
    dailyLossLimit: 1500
  });

  assert.equal(gate.allowed, false);
  assert.ok(gate.reason.includes('session_risk_cap_exceeded') || gate.reason.includes('daily_loss_cap_exceeded'));
});
