import os
import threading
import time

from flask import Flask, jsonify, request
import pandas as pd
import yfinance as yf

from marketStructure import detect_market_structure
from liquidityEngine import detect_liquidity_sweep

app = Flask(__name__)
MARKET_DATA_CACHE_TTL_SECONDS = max(int(os.environ.get("MARKET_DATA_CACHE_TTL_SECONDS", 120)), 0)
market_data_cache = {}
market_data_cache_lock = threading.Lock()
market_data_fetch_lock = threading.Lock()

SYMBOL_CONFIGS = {
    "nifty": {
        "ticker": "^NSEI",
        "name": "NIFTY"
    },
    "banknifty": {
        "ticker": "^NSEBANK",
        "name": "BANKNIFTY"
    }
}

# Keep the engine selective. These thresholds intentionally skip many trades.
PREMIUM_MIN_SCORE = 7.0
PREMIUM_MIN_EDGE = 2.0
PREMIUM_MIN_RR = 2.0
PREMIUM_MIN_VOLUME_RATIO = 1.1
PREMIUM_MAX_STRETCH_ATR = 1.0


def ema(series, length):
    return series.ewm(span=length).mean()


def rsi(series, length=14):
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)

    avg_gain = gain.rolling(length).mean()
    avg_loss = loss.rolling(length).mean()

    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def atr(high, low, close, length=14):
    tr1 = high - low
    tr2 = abs(high - close.shift())
    tr3 = abs(low - close.shift())

    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    return tr.rolling(length).mean()


def vwap(df):
    cumulative_volume = df["Volume"].replace(0, pd.NA).cumsum()
    cumulative_price_volume = (df["Close"] * df["Volume"]).cumsum()
    result = cumulative_price_volume / cumulative_volume
    return result.fillna(df["Close"])


def round_strike(price, symbol):
    step = 50 if symbol == "NIFTY" else 100
    return int(round(price / step) * step)


def build_setup_notes(direction, reasons, rr, score, edge):
    prefix = "Long" if direction == "BUY CALL" else "Short"
    summary = f"{prefix} setup selected only after premium filters aligned"
    details = [
        summary,
        f"Edge {edge:.2f} | RR {rr:.2f} | Score {score:.2f}"
    ]
    details.extend(reasons[:4])
    return details


def safe_float(value, default=0.0):
    try:
        numeric = float(value)
        if pd.isna(numeric):
            return default
        return numeric
    except (TypeError, ValueError):
        return default


def clamp(value, lower=0.0, upper=1.0):
    return max(lower, min(upper, value))


def normalize_symbol(symbol):
    return str(symbol or "").strip().lower()


def get_symbol_config(symbol):
    return SYMBOL_CONFIGS.get(normalize_symbol(symbol))


def resample_ohlcv(df, interval):
    aggregated = df.resample(interval).agg({
        "Open": "first",
        "High": "max",
        "Low": "min",
        "Close": "last",
        "Volume": "sum"
    })

    return aggregated.dropna()


def trend_slope(series, window=10):
    recent = series.tail(window).dropna()
    if len(recent) < 2:
        return 0.0

    return safe_float(recent.iloc[-1] - recent.iloc[0])


def build_hold_payload(symbol, reason, name=None):
    label = name or str(symbol or "").upper()
    return {
        "symbol": label,
        "signal": "HOLD",
        "trade": "WAIT",
        "confidence": 0,
        "buy_score": 0,
        "sell_score": 0,
        "buy_readiness": 0,
        "sell_readiness": 0,
        "reason": reason,
        "reasons": [reason],
        "failed_checks": [reason],
        "risk_reward": 0,
        "quality_score": 0,
        "support": None,
        "resistance": None,
        "liquidity_signal": "NONE",
        "market_regime": "UNKNOWN"
    }


def normalize_market_data(df):
    if df is None or df.empty:
        return None

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    frame = df.loc[:, ~df.columns.duplicated()].copy()
    required = ["Open", "High", "Low", "Close", "Volume"]
    missing = [column for column in required if column not in frame.columns]

    if missing:
        return None

    frame = frame[required].apply(pd.to_numeric, errors="coerce").dropna()
    if frame.empty:
        return None

    if not isinstance(frame.index, pd.DatetimeIndex):
        frame.index = pd.to_datetime(frame.index, errors="coerce")
        frame = frame[frame.index.notna()]

    if getattr(frame.index, "tz", None) is not None:
        frame.index = frame.index.tz_convert(None)

    return frame.sort_index()


def load_market_data(symbol, period="5d", interval="1m"):
    config = get_symbol_config(symbol)
    if not config:
        return None, None

    cache_key = (normalize_symbol(symbol), period, interval)
    with market_data_fetch_lock:
        now = time.monotonic()
        with market_data_cache_lock:
            cached = market_data_cache.get(cache_key)
            if cached and now - cached[0] < MARKET_DATA_CACHE_TTL_SECONDS:
                cached_frame = cached[1]
                return cached_frame.copy() if cached_frame is not None else None, cached[2]

        started_at = time.monotonic()
        try:
            df = yf.download(
                config["ticker"],
                period=period,
                interval=interval,
                auto_adjust=False,
                progress=False
            )
            normalized = normalize_market_data(df)
        except Exception as error:
            normalized = None
            app.logger.warning("Yahoo market data fetch failed for %s: %s", config["name"], error)

        if normalized is None and cached and cached[1] is not None:
            app.logger.info("Using previous cached market data for %s due to Yahoo error/rate limit", config["name"])
            normalized = cached[1].copy()

        elapsed_seconds = time.monotonic() - started_at
        app.logger.info("Yahoo market data fetch for %s took %.2f seconds", config["name"], elapsed_seconds)

        if MARKET_DATA_CACHE_TTL_SECONDS > 0 and normalized is not None:
            cached_frame = normalized.copy()
            with market_data_cache_lock:
                market_data_cache[cache_key] = (time.monotonic(), cached_frame, config["name"])

        return normalized, config["name"]


def compute_signal_payload(df, symbol_name):
    if df is None or len(df) < 60:
        return build_hold_payload(symbol_name, "Market data not ready", name=symbol_name)

    frame = df.copy()
    frame["EMA20"] = ema(frame["Close"], 20)
    frame["EMA50"] = ema(frame["Close"], 50)
    frame["EMA200"] = ema(frame["Close"], 200)
    frame["RSI"] = rsi(frame["Close"])
    frame["ATR"] = atr(frame["High"], frame["Low"], frame["Close"])
    frame["VWAP"] = vwap(frame)
    frame["VOL20"] = frame["Volume"].rolling(20).mean()
    frame["RET5"] = frame["Close"].pct_change(5)
    frame["RET15"] = frame["Close"].pct_change(15)
    frame = frame.dropna()

    if len(frame) < 3:
        return build_hold_payload(symbol_name, "Indicator data not ready", name=symbol_name)

    df5 = resample_ohlcv(frame[["Open", "High", "Low", "Close", "Volume"]], "5min")
    if len(df5) >= 20:
        df5["EMA20"] = ema(df5["Close"], 20)
        df5["EMA50"] = ema(df5["Close"], 50)
        df5 = df5.dropna()

    price = frame["Close"].iloc[-1]
    prev = frame["Close"].iloc[-2]
    ema20 = frame["EMA20"].iloc[-1]
    ema50 = frame["EMA50"].iloc[-1]
    ema200 = frame["EMA200"].iloc[-1]
    rsi_val = frame["RSI"].iloc[-1]
    atr_val = frame["ATR"].iloc[-1]
    vwap_val = frame["VWAP"].iloc[-1]
    volume_available = bool(frame["Volume"].sum() > 0)
    avg_volume = max(safe_float(frame["VOL20"].iloc[-1], 1.0), 1.0)
    raw_volume_ratio = safe_float(frame["Volume"].iloc[-1], 0.0) / avg_volume
    volume_ratio = raw_volume_ratio if volume_available and raw_volume_ratio > 0 else 1.0
    short_slope = trend_slope(frame["EMA20"], 8)
    medium_slope = trend_slope(frame["EMA50"], 12)
    pullback_distance = abs(price - ema20)
    stretch_atr = pullback_distance / atr_val if atr_val > 0 else 0.0

    structure = detect_market_structure(frame)
    sweep = detect_liquidity_sweep(frame)

    support = frame["Low"].rolling(20).min().iloc[-2]
    resistance = frame["High"].rolling(20).max().iloc[-2]
    swing_support = frame["Low"].rolling(50).min().iloc[-2]
    swing_resistance = frame["High"].rolling(50).max().iloc[-2]

    breakout_up = price > resistance and prev <= resistance
    breakout_down = price < support and prev >= support
    strong_uptrend = price > ema20 > ema50 > ema200
    strong_downtrend = price < ema20 < ema50 < ema200
    above_vwap = price > vwap_val
    near_ema20 = pullback_distance <= atr_val * 0.6
    stretched_up = (price - ema20) > atr_val * 1.6
    stretched_down = (ema20 - price) > atr_val * 1.6
    bullish_momentum = safe_float(frame["RET5"].iloc[-1]) > 0 and safe_float(frame["RET15"].iloc[-1]) > 0
    bearish_momentum = safe_float(frame["RET5"].iloc[-1]) < 0 and safe_float(frame["RET15"].iloc[-1]) < 0
    bullish_liquidity_confirmed = sweep in {"SWEEP_LOW", "BREAKOUT_UP"}
    bearish_liquidity_confirmed = sweep in {"SWEEP_HIGH", "BREAKOUT_DOWN"}

    higher_tf_bullish = False
    higher_tf_bearish = False
    if len(df5) > 0:
        higher_tf_close = df5["Close"].iloc[-1]
        higher_tf_ema20 = df5["EMA20"].iloc[-1]
        higher_tf_ema50 = df5["EMA50"].iloc[-1]
        higher_tf_bullish = higher_tf_close > higher_tf_ema20 > higher_tf_ema50
        higher_tf_bearish = higher_tf_close < higher_tf_ema20 < higher_tf_ema50

    buy_score = 0
    sell_score = 0
    buy_reasons = []
    sell_reasons = []
    bullish_quality_bonus = 0
    bearish_quality_bonus = 0

    if strong_uptrend:
        buy_score += 3.0
        buy_reasons.append("1m trend is aligned bullish")
        bullish_quality_bonus += 1.0
    if strong_downtrend:
        sell_score += 3.0
        sell_reasons.append("1m trend is aligned bearish")
        bearish_quality_bonus += 1.0

    if higher_tf_bullish:
        buy_score += 2.0
        buy_reasons.append("5m trend confirms bullish bias")
        bullish_quality_bonus += 1.0
    if higher_tf_bearish:
        sell_score += 2.0
        sell_reasons.append("5m trend confirms bearish bias")
        bearish_quality_bonus += 1.0

    if above_vwap:
        buy_score += 1.0
        buy_reasons.append("Price is above VWAP")
        bullish_quality_bonus += 0.5
    else:
        sell_score += 1.0
        sell_reasons.append("Price is below VWAP")
        bearish_quality_bonus += 0.5

    if structure == "TREND_UP":
        buy_score += 2.0
        buy_reasons.append("Session structure is trend-up")
        bullish_quality_bonus += 0.75
    elif structure == "TREND_DOWN":
        sell_score += 2.0
        sell_reasons.append("Session structure is trend-down")
        bearish_quality_bonus += 0.75
    elif structure == "RANGE":
        buy_score -= 1.0
        sell_score -= 1.0
        buy_reasons.append("Range structure is not strong enough to trade")
        sell_reasons.append("Range structure is not strong enough to trade")

    if breakout_up:
        buy_score += 3.5
        buy_reasons.append("Price is breaking recent resistance")
        bullish_quality_bonus += 0.75
    if breakout_down:
        sell_score += 3.5
        sell_reasons.append("Price is breaking recent support")
        bearish_quality_bonus += 0.75

    if sweep == "SWEEP_LOW":
        buy_score += 2.0
        buy_reasons.append("Liquidity sweep below support favors reversal up")
        bullish_quality_bonus += 0.75
    if sweep == "SWEEP_HIGH":
        sell_score += 2.0
        sell_reasons.append("Liquidity sweep above resistance favors reversal down")
        bearish_quality_bonus += 0.75

    if volume_ratio >= 1.2:
        if price > prev:
            buy_score += 1.0
            buy_reasons.append("Volume expansion supports the move")
            bullish_quality_bonus += 0.5
        if price < prev:
            sell_score += 1.0
            sell_reasons.append("Volume expansion supports the move")
            bearish_quality_bonus += 0.5
    elif volume_ratio < 1.0:
        buy_score -= 0.5
        sell_score -= 0.5
        buy_reasons.append("Volume is weak for a clean continuation")
        sell_reasons.append("Volume is weak for a clean continuation")

    if stretched_up:
        buy_score -= 1.0
        sell_score += 0.5
        sell_reasons.append("Long setup is stretched from EMA20")
    if stretched_down:
        sell_score -= 1.0
        buy_score += 0.5
        buy_reasons.append("Short setup is stretched from EMA20")

    if strong_uptrend and not above_vwap and bearish_momentum:
        sell_score += 0.5
        bearish_quality_bonus += 0.5
    if strong_downtrend and above_vwap and bullish_momentum:
        buy_score += 0.5
        bullish_quality_bonus += 0.5

    buy_score = round(min(10, buy_score), 2)
    sell_score = round(min(10, sell_score), 2)

    long_stop = min(support, ema20) - atr_val * 0.5
    long_target = max(resistance + atr_val * 1.4, price + atr_val * 1.8, swing_resistance)
    short_stop = max(resistance, ema20) + atr_val * 0.5
    short_target = min(support - atr_val * 1.4, price - atr_val * 1.8, swing_support)

    strict_long_stop = max(support * 0.9975, support - atr_val * 0.35)
    strict_short_stop = min(resistance * 1.0025, resistance + atr_val * 0.35)
    strict_long_target = max(price + atr_val * 2.2, resistance + atr_val * 1.4)
    strict_short_target = min(price - atr_val * 2.2, support - atr_val * 1.4)
    if strict_long_target <= price:
        strict_long_target = price + atr_val * 1.8
    if strict_short_target >= price:
        strict_short_target = price - atr_val * 1.8

    long_stop = strict_long_stop
    short_stop = strict_short_stop
    long_target = strict_long_target
    short_target = strict_short_target

    long_risk = max(price - long_stop, atr_val * 0.6)
    short_risk = max(short_stop - price, atr_val * 0.6)
    long_reward = max(long_target - price, 0)
    short_reward = max(price - short_target, 0)
    long_rr = round(long_reward / long_risk, 2) if long_risk > 0 else 0
    short_rr = round(short_reward / short_risk, 2) if short_risk > 0 else 0

    long_edge = round(buy_score - sell_score, 2)
    short_edge = round(sell_score - buy_score, 2)

    long_ready = (
        buy_score >= PREMIUM_MIN_SCORE
        and long_edge >= PREMIUM_MIN_EDGE
        and long_rr >= PREMIUM_MIN_RR
        and higher_tf_bullish
        and (structure == "TREND_UP" or breakout_up or bullish_liquidity_confirmed)
        and not stretched_up
        and stretch_atr <= PREMIUM_MAX_STRETCH_ATR
        and volume_ratio >= PREMIUM_MIN_VOLUME_RATIO
    )
    short_ready = (
        sell_score >= PREMIUM_MIN_SCORE
        and short_edge >= PREMIUM_MIN_EDGE
        and short_rr >= PREMIUM_MIN_RR
        and higher_tf_bearish
        and (structure == "TREND_DOWN" or breakout_down or bearish_liquidity_confirmed)
        and not stretched_down
        and stretch_atr <= PREMIUM_MAX_STRETCH_ATR
        and volume_ratio >= PREMIUM_MIN_VOLUME_RATIO
    )

    continuation_long_ready = (
        buy_score >= 6.5
        and long_edge >= 1.25
        and long_rr >= 1.4
        and higher_tf_bullish
        and (structure == "TREND_UP" or breakout_up or bullish_liquidity_confirmed)
        and stretch_atr <= 1.45
        and volume_ratio >= 0.95
    )

    continuation_short_ready = (
        sell_score >= 6.5
        and short_edge >= 1.25
        and short_rr >= 1.4
        and higher_tf_bearish
        and (structure == "TREND_DOWN" or breakout_down or bearish_liquidity_confirmed)
        and stretch_atr <= 1.45
        and volume_ratio >= 0.95
    )

    signal = "HOLD"
    trade = "WAIT"
    signal_reasons = ["No edge strong enough"]
    failed_checks = []
    risk_reward = 0
    stop_loss = None
    target = None
    selected_quality_bonus = 0.0

    strike = round_strike(price, symbol_name)

    breakout_long_confirmed = breakout_up and volume_ratio >= 1.0 and price > resistance and prev <= resistance
    breakout_short_confirmed = breakout_down and volume_ratio >= 1.0 and price < support and prev >= support
    trend_long_confirmed = strong_uptrend and above_vwap and higher_tf_bullish and price > ema20 and price > support
    trend_short_confirmed = strong_downtrend and not above_vwap and higher_tf_bearish and price < ema20 and price < resistance
    strict_bullish = (
        structure == "TREND_UP"
        and higher_tf_bullish
        and price > ema20
        and price > vwap_val
        and price > resistance
        and volume_ratio >= 1.05
        and price > prev
    )
    strict_bearish = (
        structure == "TREND_DOWN"
        and higher_tf_bearish
        and price < ema20
        and price < vwap_val
        and price < support
        and volume_ratio >= 1.05
        and price < prev
    )
    strong_directional_edge = abs(buy_score - sell_score) >= 1.5

    range_filter = structure == "RANGE" or (volume_available and volume_ratio < 0.8)
    long_entry_allowed = (strict_bullish or trend_long_confirmed or breakout_long_confirmed or (buy_score >= 6.0 and higher_tf_bullish and price > ema20)) and not range_filter and strong_directional_edge and buy_score >= 5.5
    short_entry_allowed = (strict_bearish or trend_short_confirmed or breakout_short_confirmed or (sell_score >= 6.0 and higher_tf_bearish and price < ema20)) and not range_filter and strong_directional_edge and sell_score >= 5.5

    if long_entry_allowed:
        signal = "BUY CALL"
        trade = f"{symbol_name} {strike} CE"
        stop_loss = long_stop
        target = long_target
        risk_reward = long_rr
        selected_quality_bonus = bullish_quality_bonus
        signal_reasons = build_setup_notes(signal, buy_reasons, long_rr, buy_score, long_edge)
    elif short_entry_allowed:
        signal = "BUY PUT"
        trade = f"{symbol_name} {strike} PE"
        stop_loss = short_stop
        target = short_target
        risk_reward = short_rr
        selected_quality_bonus = bearish_quality_bonus
        signal_reasons = build_setup_notes(signal, sell_reasons, short_rr, sell_score, short_edge)
    else:
        signal = "HOLD"
        trade = "WAIT"
        signal_reasons = ["No clean trend confirmation or breakout confirmation"]
        if structure == "RANGE":
            failed_checks.append("range_structure")
        if volume_ratio < 1.0:
            failed_checks.append("volume_support_missing")
        if not strong_directional_edge:
            failed_checks.append("directional_edge_too_small")
        if max(buy_score, sell_score) < 7.0:
            failed_checks.append("directional_score_below_threshold")
        if not (strict_bullish or strict_bearish or trend_long_confirmed or breakout_long_confirmed or trend_short_confirmed or breakout_short_confirmed):
            failed_checks.append("trend_or_breakout_missing")

        if buy_score >= sell_score:
            risk_reward = long_rr
        else:
            risk_reward = short_rr

    dominant_score = max(buy_score, sell_score)
    chart_confluence = 0
    if strong_uptrend or strong_downtrend:
        chart_confluence += 1
    if higher_tf_bullish or higher_tf_bearish:
        chart_confluence += 1
    if above_vwap and signal == "BUY CALL":
        chart_confluence += 1
    if not above_vwap and signal == "BUY PUT":
        chart_confluence += 1
    if bullish_liquidity_confirmed or bearish_liquidity_confirmed:
        chart_confluence += 1
    if near_ema20 and not stretched_up and not stretched_down:
        chart_confluence += 1
    if volume_ratio >= 1.2:
        chart_confluence += 0.75

    quality_base = dominant_score * 7.5 + chart_confluence * 8 + risk_reward * 12 + max(selected_quality_bonus, 0) * 8
    if signal == "HOLD":
        quality_base *= 0.72

    if signal == "BUY CALL":
        selected_edge_bonus = long_edge
    elif signal == "BUY PUT":
        selected_edge_bonus = short_edge
    else:
        selected_edge_bonus = dominant_score * 0.5

    confidence_base = dominant_score * 8 + chart_confluence * 7 + selected_edge_bonus
    if signal == "HOLD":
        confidence_base = dominant_score * 6 + chart_confluence * 4

    quality_score = round(min(100, quality_base), 2)
    confidence = round(min(95, confidence_base), 2)
    buy_readiness = round(min(100, buy_score * 10), 2)
    sell_readiness = round(min(100, sell_score * 10), 2)

    return {
        "symbol": symbol_name,
        "price": float(price),
        "signal": signal,
        "trade": trade,
        "confidence": confidence,
        "stop_loss": float(stop_loss) if stop_loss else None,
        "target": float(target) if target else None,
        "buy_score": buy_score,
        "sell_score": sell_score,
        "buy_readiness": buy_readiness,
        "sell_readiness": sell_readiness,
        "reason": signal_reasons[0] if signal_reasons else "No clear edge",
        "reasons": signal_reasons,
        "failed_checks": failed_checks,
        "risk_reward": risk_reward,
        "quality_score": quality_score,
        "liquidity_signal": sweep,
        "market_regime": structure,
        "support": float(support),
        "resistance": float(resistance),
        "volume_ratio": round(volume_ratio, 2),
        "volume_available": bool(volume_available),
        "higher_tf_bullish": bool(higher_tf_bullish),
        "higher_tf_bearish": bool(higher_tf_bearish),
        "estimated_option_price": round(max(25.0, atr_val * (2.2 if "BANK" in symbol_name else 2.5)), 2),
        "option_stop_loss": round(max(20.0, max(25.0, atr_val * (2.2 if "BANK" in symbol_name else 2.5)) * 0.82), 2) if signal != "HOLD" else None,
        "option_target_price": round(max(30.0, max(25.0, atr_val * (2.2 if "BANK" in symbol_name else 2.5)) * 1.25), 2) if signal != "HOLD" else None,
        "option_target_price_2": round(max(35.0, max(25.0, atr_val * (2.2 if "BANK" in symbol_name else 2.5)) * 1.45), 2) if signal != "HOLD" else None,
        "score_breakdown": {
            "bullish_quality_bonus": round(bullish_quality_bonus, 2),
            "bearish_quality_bonus": round(bearish_quality_bonus, 2),
            "chart_confluence": round(chart_confluence, 2),
            "dominant_score": dominant_score,
            "selected_quality_bonus": round(selected_quality_bonus, 2)
        }
    }


def get_data(symbol, period="5d", interval="1m"):
    return load_market_data(symbol, period=period, interval=interval)


def candles_to_dataframe(candles_list):
    if not candles_list or not isinstance(candles_list, list):
        return None
    rows = []
    for c in candles_list:
        if not isinstance(c, dict):
            continue
        try:
            t = c.get("time") or c.get("timestamp")
            o = float(c.get("open", 0))
            h = float(c.get("high", 0))
            l = float(c.get("low", 0))
            cl = float(c.get("close", 0))
            v = float(c.get("volume", 0))
            rows.append({"time": t, "Open": o, "High": h, "Low": l, "Close": cl, "Volume": v})
        except (ValueError, TypeError):
            continue
    if len(rows) < 10:
        return None
    df = pd.DataFrame(rows)
    df["time"] = pd.to_datetime(df["time"], errors="coerce")
    df = df.dropna(subset=["time"]).set_index("time").sort_index()
    return normalize_market_data(df)


@app.route("/analyze/<symbol>", methods=["GET", "POST"])
def analyze(symbol):
    try:
        config = get_symbol_config(symbol)
        name = config["name"] if config else str(symbol).upper()
        df = None

        if request.method == "POST" and request.is_json:
            payload = request.get_json(silent=True) or {}
            candles_list = payload.get("candles")
            if candles_list:
                df = candles_to_dataframe(candles_list)

        if df is None:
            df, fetched_name = get_data(symbol)
            if fetched_name:
                name = fetched_name

        if df is None or len(df) < 10:
            return jsonify(build_hold_payload(symbol, "Market data not ready", name=name))

        return jsonify(compute_signal_payload(df, name))
    except Exception as error:
        return jsonify(build_hold_payload(symbol, str(error)))


@app.route("/candles/<symbol>")
def candles(symbol):
    try:
        limit = int(request.args.get("limit", 180))
        period = request.args.get("period", "5d")
        interval = request.args.get("interval", "1m")

        df, name = get_data(symbol, period=period, interval=interval)
        if df is None:
            return jsonify({"candles": []})

        frame = df.tail(limit)
        payload = []

        for idx, row in frame.iterrows():
            payload.append({
                "time": str(idx),
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": float(row["Volume"])
            })

        return jsonify({
            "symbol": name,
            "candles": payload
        })
    except Exception as error:
        return jsonify({
            "candles": [],
            "error": str(error)
        })


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/backtest/<symbol>")
def backtest_route(symbol):
    try:
        from backtest import run_backtest

        result = run_backtest(
            symbol=symbol,
            period=request.args.get("period", "5d"),
            interval=request.args.get("interval", "1m"),
            initial_capital=float(request.args.get("capital", 100000.0)),
            min_confidence=float(request.args.get("min_confidence", 75)),
            min_quality_score=float(request.args.get("min_quality", 70)),
            min_risk_reward=float(request.args.get("min_rr", 2.0)),
            brokerage_per_side=float(request.args.get("brokerage", 20.0)),
            slippage_per_side=float(request.args.get("slippage", 2.0))
        )
        return jsonify(result)
    except Exception as error:
        return jsonify({
            "error": str(error)
        }), 500


@app.route("/walk-forward/<symbol>")
def walk_forward_route(symbol):
    try:
        from backtest import run_walk_forward

        result = run_walk_forward(
            symbol=symbol,
            period=request.args.get("period", "5d"),
            interval=request.args.get("interval", "1m"),
            initial_capital=float(request.args.get("capital", 100000.0)),
            train_days=int(request.args.get("train_days", 3)),
            brokerage_per_side=float(request.args.get("brokerage", 20.0)),
            slippage_per_side=float(request.args.get("slippage", 2.0))
        )
        return jsonify(result)
    except Exception as error:
        return jsonify({
            "error": str(error)
        }), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
