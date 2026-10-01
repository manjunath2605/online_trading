import pandas as pd


def detect_liquidity_sweep(df):

    if df is None or len(df) < 30:
        return "NONE"

    highs = df["High"]
    lows = df["Low"]
    closes = df["Close"]
    opens = df["Open"]

    last_high = highs.iloc[-1]
    last_low = lows.iloc[-1]

    prev_high = highs.iloc[-2]
    prev_low = lows.iloc[-2]

    prev_close = closes.iloc[-2]
    last_close = closes.iloc[-1]

    resistance = highs.rolling(20).max().iloc[-2]
    support = lows.rolling(20).min().iloc[-2]

    # ---------------------------
    # STOP HUNT ABOVE RESISTANCE
    # ---------------------------

    if last_high > resistance and last_close < resistance:

        return "SWEEP_HIGH"

    # ---------------------------
    # STOP HUNT BELOW SUPPORT
    # ---------------------------

    if last_low < support and last_close > support:

        return "SWEEP_LOW"

    # ---------------------------
    # STRONG BREAKOUT
    # ---------------------------

    if last_close > resistance and prev_close <= resistance:

        return "BREAKOUT_UP"

    if last_close < support and prev_close >= support:

        return "BREAKOUT_DOWN"

    return "NONE"


def liquidity_bias(df):

    sweep = detect_liquidity_sweep(df)

    if sweep == "SWEEP_LOW":

        return {
            "signal": "BUY_CALL",
            "reason": "LIQUIDITY_SWEEP_LOW"
        }

    if sweep == "SWEEP_HIGH":

        return {
            "signal": "BUY_PUT",
            "reason": "LIQUIDITY_SWEEP_HIGH"
        }

    if sweep == "BREAKOUT_UP":

        return {
            "signal": "BUY_CALL",
            "reason": "BREAKOUT"
        }

    if sweep == "BREAKOUT_DOWN":

        return {
            "signal": "BUY_PUT",
            "reason": "BREAKOUT"
        }

    return {
        "signal": "NONE",
        "reason": "NO_SWEEP"
    }