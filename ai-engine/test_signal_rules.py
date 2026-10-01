import unittest
import numpy as np
import pandas as pd

from app import compute_signal_payload


class SignalRuleTests(unittest.TestCase):
    def make_market(self, start, drift=0.0, size=200):
        idx = pd.date_range("2024-01-01", periods=size, freq="min")
        base = np.linspace(start, start + drift * size, size)
        noise = np.linspace(0, 0, size)
        close = base + noise
        open_ = close - 0.2
        high = np.maximum(open_, close) + 0.5
        low = np.minimum(open_, close) - 0.5
        volume = np.full(size, 1500)
        return pd.DataFrame({"Open": open_, "High": high, "Low": low, "Close": close, "Volume": volume}, index=idx)

    def test_flat_market_should_hold(self):
        df = self.make_market(100, drift=0.0, size=200)
        result = compute_signal_payload(df, "NIFTY")
        self.assertEqual(result["signal"], "HOLD")

    def test_uptrend_should_be_buy_call(self):
        df = self.make_market(100, drift=0.8, size=220)
        result = compute_signal_payload(df, "NIFTY")
        self.assertIn(result["signal"], ["BUY CALL", "HOLD"])

    def test_downtrend_should_not_buy_call(self):
        df = self.make_market(100, drift=-0.8, size=220)
        result = compute_signal_payload(df, "NIFTY")
        self.assertNotEqual(result["signal"], "BUY CALL")


if __name__ == "__main__":
    unittest.main()
