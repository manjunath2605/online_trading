import pandas as pd


def calculate_atr(df, period=14):

    high_low = df["High"] - df["Low"]

    high_close = (df["High"] - df["Close"].shift()).abs()

    low_close = (df["Low"] - df["Close"].shift()).abs()

    tr = pd.concat([high_low, high_close, low_close], axis=1).max(axis=1)

    atr = tr.rolling(period).mean()

    return atr


def detect_market_structure(df):

    if df is None or len(df) < 60:

        return "UNKNOWN"

    df = df.copy()

    df["ATR"] = calculate_atr(df)

    day_high = df["High"].max()

    day_low = df["Low"].min()

    price_range = day_high - day_low

    atr = df["ATR"].iloc[-1]

    last_price = df["Close"].iloc[-1]

    midpoint = (day_high + day_low) / 2

    if atr == 0 or pd.isna(atr):

        return "RANGE"

    volatility_ratio = price_range / atr

    # ---------------------------
    # TREND DAY
    # ---------------------------

    if volatility_ratio > 3:

        if last_price > midpoint:

            return "TREND_UP"

        else:

            return "TREND_DOWN"

    # ---------------------------
    # RANGE DAY
    # ---------------------------

    if volatility_ratio < 1.8:

        return "RANGE"

    # ---------------------------
    # BREAKOUT DAY
    # ---------------------------

    return "BREAKOUT"


def market_bias(df):

    structure = detect_market_structure(df)

    if structure == "TREND_UP":

        return {
            "structure": "TREND_UP",
            "bias": "BULLISH",
            "strategy": "BUY_CALLS"
        }

    if structure == "TREND_DOWN":

        return {
            "structure": "TREND_DOWN",
            "bias": "BEARISH",
            "strategy": "BUY_PUTS"
        }

    if structure == "RANGE":

        return {
            "structure": "RANGE",
            "bias": "SIDEWAYS",
            "strategy": "SCALP"
        }

    if structure == "BREAKOUT":

        return {
            "structure": "BREAKOUT",
            "bias": "VOLATILE",
            "strategy": "BREAKOUT"
        }

    return {
        "structure": "UNKNOWN",
        "bias": "NEUTRAL",
        "strategy": "WAIT"
    }