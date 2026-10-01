import unittest
from unittest.mock import patch

import pandas as pd

from backtest import (
    daily_loss_limit_reached,
    detect_candlestick_confirmation,
    risk_fraction,
    run_backtest_on_frame,
    summarize_results
)


class BacktestRiskTests(unittest.TestCase):
    def test_detects_direction_matched_engulfing_candles(self):
        bullish = pd.DataFrame([
            {"Open": 101, "High": 101.3, "Low": 99.8, "Close": 100},
            {"Open": 99.9, "High": 101.2, "Low": 99.7, "Close": 101.1}
        ])
        bearish = pd.DataFrame([
            {"Open": 100, "High": 101.2, "Low": 99.8, "Close": 101},
            {"Open": 101.1, "High": 101.2, "Low": 99.8, "Close": 99.9}
        ])

        self.assertEqual(detect_candlestick_confirmation(bullish, "BUY CALL"), "BULLISH_ENGULFING")
        self.assertEqual(detect_candlestick_confirmation(bearish, "BUY PUT"), "BEARISH_ENGULFING")
        self.assertIsNone(detect_candlestick_confirmation(bullish, "BUY PUT"))

    def test_detects_direction_matched_rejection_candles(self):
        bullish = pd.DataFrame([
            {"Open": 101, "High": 101.3, "Low": 99.8, "Close": 100},
            {"Open": 100, "High": 100.6, "Low": 98.9, "Close": 100.5}
        ])
        bearish = pd.DataFrame([
            {"Open": 100, "High": 101.1, "Low": 99.8, "Close": 101},
            {"Open": 100.5, "High": 101.6, "Low": 99.9, "Close": 100}
        ])

        self.assertEqual(detect_candlestick_confirmation(bullish, "BUY CALL"), "BULLISH_REJECTION")
        self.assertEqual(detect_candlestick_confirmation(bearish, "BUY PUT"), "BEARISH_REJECTION")

    def test_summary_reports_pattern_expectancy(self):
        result = summarize_results(
            "NIFTY", "test", "1m", 100, 103, {},
            [
                {"pnl": 5, "candle_pattern": "BULLISH_ENGULFING"},
                {"pnl": -2, "candle_pattern": "BULLISH_ENGULFING"}
            ],
            [100, 105, 103], 0, 0
        )

        self.assertEqual(result["candle_pattern_performance"]["BULLISH_ENGULFING"]["trades"], 2)
        self.assertEqual(result["candle_pattern_performance"]["BULLISH_ENGULFING"]["expectancy_per_trade"], 1.5)

    def test_risk_fraction_rejects_invalid_stop_direction(self):
        self.assertEqual(risk_fraction("BUY CALL", 100, 99), 0.01)
        self.assertEqual(risk_fraction("BUY PUT", 100, 101), 0.01)
        self.assertEqual(risk_fraction("BUY CALL", 100, 101), float("inf"))

    def test_daily_loss_limit_uses_capital_fraction(self):
        self.assertFalse(daily_loss_limit_reached(-4.99, 100, 0.05))
        self.assertTrue(daily_loss_limit_reached(-5, 100, 0.05))

    def test_daily_loss_limit_blocks_later_entry(self):
        index = pd.date_range("2024-01-02 09:15", periods=264, freq="min")
        frame = pd.DataFrame({
            "Open": [100.0] * 264,
            "High": [101.0] * 264,
            "Low": [99.5] * 264,
            "Close": [100.5] * 264,
            "Volume": [1500.0] * 264
        }, index=index)
        frame.iloc[221, frame.columns.get_loc("Open")] = 100.5
        frame.iloc[221, frame.columns.get_loc("Low")] = 98.5
        frame.iloc[221, frame.columns.get_loc("Close")] = 99.5
        frame.iloc[222, frame.columns.get_loc("Close")] = 100.6

        signal = {
            "signal": "BUY CALL",
            "confidence": 80,
            "quality_score": 80,
            "risk_reward": 2,
            "volume_ratio": 1.2,
            "support": 99,
            "resistance": 100.6,
            "market_regime": "TREND_UP",
            "stop_loss": 99,
            "target": 105
        }
        filters = {
            "min_confidence": 60,
            "min_quality_score": 55,
            "min_risk_reward": 1.4,
            "min_volume_ratio": 1.1
        }

        with patch("backtest.compute_signal_payload", return_value=signal):
            result = run_backtest_on_frame(
                frame,
                "NIFTY",
                "synthetic",
                "1m",
                100,
                filters,
                brokerage_per_side=0,
                slippage_per_side=0,
                max_risk_per_trade=0.02,
                max_daily_loss=0.01
            )

        self.assertEqual(result["total_trades"], 1)
        self.assertEqual(result["trades"][0]["exit_reason"], "STOP_LOSS_HIT")


if __name__ == "__main__":
    unittest.main()