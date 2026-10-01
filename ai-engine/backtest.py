import argparse
import json
from itertools import product

import pandas as pd

from app import compute_signal_payload, get_data


def to_number(value, default=0.0):
    try:
        numeric = float(value)
        if pd.isna(numeric):
            return default
        return numeric
    except (TypeError, ValueError):
        return default


def build_day_groups(df):
    if df is None or df.empty:
        return []

    frame = df.copy()
    frame["session_date"] = frame.index.date
    grouped = []

    for session_date, session_frame in frame.groupby("session_date"):
        grouped.append((str(session_date), session_frame.drop(columns=["session_date"])))

    return grouped


def signal_passes_filters(signal, filters):
    if signal.get("signal") not in {"BUY CALL", "BUY PUT"}:
        return False

    return (
        to_number(signal.get("confidence")) >= filters["min_confidence"] and
        to_number(signal.get("quality_score")) >= filters["min_quality_score"] and
        to_number(signal.get("risk_reward")) >= filters["min_risk_reward"] and
        to_number(signal.get("volume_ratio"), 0.0) >= filters["min_volume_ratio"]
    )


def close_position(position, exit_price, exit_time, exit_reason, brokerage_per_side, slippage_per_side):
    direction = 1 if position["signal"] == "BUY CALL" else -1
    gross_pnl = round((exit_price - position["entry_price"]) * direction, 2)
    total_costs = round((brokerage_per_side + slippage_per_side) * 2, 2)
    pnl = round(gross_pnl - total_costs, 2)

    return {
        "symbol": position["symbol"],
        "signal": position["signal"],
        "entry_time": position["entry_time"],
        "exit_time": exit_time,
        "entry_price": round(position["entry_price"], 2),
        "exit_price": round(exit_price, 2),
        "stop_loss": round(position["stop_loss"], 2),
        "target": round(position["target"], 2),
        "risk_reward": round(position["risk_reward"], 2),
        "quality_score": round(position["quality_score"], 2),
        "confidence": round(position["confidence"], 2),
        "gross_pnl": gross_pnl,
        "costs": total_costs,
        "pnl": pnl,
        "result": "WIN" if pnl > 0 else "LOSS" if pnl < 0 else "FLAT",
        "exit_reason": exit_reason
    }


def calculate_trade_risk(position):
    if position is None:
        return 0.0

    entry = float(position["entry_price"])
    stop = float(position["stop_loss"])
    if position["signal"] == "BUY CALL":
        risk = max(entry - stop, 0.0)
    else:
        risk = max(stop - entry, 0.0)
    return risk


def enforce_trade_rules(signal, price, support, resistance, volume_ratio, structure):
    if structure == "RANGE":
        return False
    if volume_ratio < 1.0:
        return False
    if signal.get("signal") == "BUY CALL":
        return price > resistance and signal.get("confidence", 0) >= 75
    if signal.get("signal") == "BUY PUT":
        return price < support and signal.get("confidence", 0) >= 75
    return False


def enforce_trade_rules(signal, price, support, resistance, volume_ratio, structure):
    if structure == "RANGE":
        return False
    if volume_ratio < 1.0:
        return False
    if signal.get("signal") == "BUY CALL":
        return price > resistance and signal.get("confidence", 0) >= 75
    if signal.get("signal") == "BUY PUT":
        return price < support and signal.get("confidence", 0) >= 75
    return False


def run_backtest(
    symbol,
    period="5d",
    interval="1m",
    initial_capital=100000.0,
    min_confidence=75,
    min_quality_score=70,
    min_risk_reward=2.0,
    min_volume_ratio=1.1,
    brokerage_per_side=20.0,
    slippage_per_side=2.0,
    max_risk_per_trade=0.01,
    max_daily_loss=0.05
):
    df, name = get_data(symbol, period=period, interval=interval)
    if df is None or len(df) < 260:
        raise RuntimeError(f"Not enough historical data for {symbol}.")

    filters = {
        "min_confidence": min_confidence,
        "min_quality_score": min_quality_score,
        "min_risk_reward": min_risk_reward,
        "min_volume_ratio": min_volume_ratio
    }

    capital = float(initial_capital)
    equity_curve = [capital]
    trades = []
    position = None
    warmup = 220

    for index in range(warmup, len(df) - 1):
        snapshot = df.iloc[: index + 1]
        candle = df.iloc[index]
        current_time = df.index[index]
        next_candle = df.iloc[index + 1]
        next_time = df.index[index + 1]

        if position is not None:
            exit_price = None
            exit_reason = None

            if position["signal"] == "BUY CALL":
                if candle["Low"] <= position["stop_loss"]:
                    exit_price = position["stop_loss"]
                    exit_reason = "STOP_LOSS_HIT"
                elif candle["High"] >= position["target"]:
                    exit_price = position["target"]
                    exit_reason = "TARGET_HIT"
            else:
                if candle["High"] >= position["stop_loss"]:
                    exit_price = position["stop_loss"]
                    exit_reason = "STOP_LOSS_HIT"
                elif candle["Low"] <= position["target"]:
                    exit_price = position["target"]
                    exit_reason = "TARGET_HIT"

            session_ended = current_time.date() != next_time.date()
            if exit_price is None and session_ended:
                exit_price = float(candle["Close"])
                exit_reason = "DAY_END_EXIT"

            if exit_price is not None:
                trade = close_position(
                    position,
                    float(exit_price),
                    current_time.isoformat(),
                    exit_reason,
                    brokerage_per_side,
                    slippage_per_side
                )
                capital = round(capital + trade["pnl"], 2)
                equity_curve.append(capital)
                trades.append(trade)
                position = None
                continue

        if position is not None:
            continue

        signal = compute_signal_payload(snapshot, name)
        if not signal_passes_filters(signal, filters):
            continue

        position = {
            "symbol": name,
            "signal": signal["signal"],
            "entry_time": next_time.isoformat(),
            "entry_price": float(next_candle["Open"]),
            "stop_loss": to_number(signal["stop_loss"]),
            "target": to_number(signal["target"]),
            "risk_reward": to_number(signal["risk_reward"]),
            "quality_score": to_number(signal["quality_score"]),
            "confidence": to_number(signal["confidence"])
        }

    if position is not None:
        final_time = df.index[-1]
        final_close = float(df["Close"].iloc[-1])
        trade = close_position(
            position,
            final_close,
            final_time.isoformat(),
            "FORCED_EXIT",
            brokerage_per_side,
            slippage_per_side
        )
        capital = round(capital + trade["pnl"], 2)
        equity_curve.append(capital)
        trades.append(trade)

    return summarize_results(
        symbol=name,
        period=period,
        interval=interval,
        initial_capital=initial_capital,
        ending_capital=capital,
        filters=filters,
        trades=trades,
        equity_curve=equity_curve,
        brokerage_per_side=brokerage_per_side,
        slippage_per_side=slippage_per_side
    )


def summarize_results(symbol, period, interval, initial_capital, ending_capital, filters, trades, equity_curve, brokerage_per_side, slippage_per_side):
    wins = [trade for trade in trades if trade["pnl"] > 0]
    losses = [trade for trade in trades if trade["pnl"] < 0]
    gross_profit = round(sum(trade["pnl"] for trade in wins), 2)
    gross_loss = round(abs(sum(trade["pnl"] for trade in losses)), 2)
    total_pnl = round(sum(trade["pnl"] for trade in trades), 2)
    win_rate = round((len(wins) / len(trades)) * 100, 2) if trades else 0.0
    average_win = round(gross_profit / len(wins), 2) if wins else 0.0
    average_loss = round(gross_loss / len(losses), 2) if losses else 0.0
    expectancy = round(total_pnl / len(trades), 2) if trades else 0.0
    profit_factor = round(gross_profit / gross_loss, 2) if gross_loss else None

    peak = equity_curve[0] if equity_curve else initial_capital
    max_drawdown = 0.0
    for value in equity_curve:
        peak = max(peak, value)
        if peak:
            drawdown = ((peak - value) / peak) * 100
            max_drawdown = max(max_drawdown, drawdown)

    return {
        "symbol": symbol,
        "period": period,
        "interval": interval,
        "initial_capital": round(initial_capital, 2),
        "ending_capital": round(ending_capital, 2),
        "filters": filters,
        "total_trades": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": win_rate,
        "gross_profit": gross_profit,
        "gross_loss": gross_loss,
        "net_pnl": total_pnl,
        "average_win": average_win,
        "average_loss": average_loss,
        "expectancy_per_trade": expectancy,
        "profit_factor": profit_factor,
        "max_drawdown_percent": round(max_drawdown, 2),
        "brokerage_per_side": brokerage_per_side,
        "slippage_per_side": slippage_per_side,
        "trades": trades
    }


def score_result(result):
    profit_factor = result["profit_factor"] if result["profit_factor"] is not None else 0
    trade_count = result["total_trades"]
    if trade_count == 0:
        return -1000

    win_rate = result["win_rate"]
    expectancy = result["expectancy_per_trade"]
    drawdown_penalty = result["max_drawdown_percent"] * 6
    trade_bonus = min(trade_count, 25) * 1.5

    return (
        (result["net_pnl"] * 1.0) +
        (expectancy * 10) +
        (profit_factor * 20) +
        (win_rate * 1.2) +
        trade_bonus -
        drawdown_penalty
    )


def build_filter_grid():
    return [
        {
            "min_confidence": confidence,
            "min_quality_score": quality,
            "min_risk_reward": rr,
            "min_volume_ratio": volume
        }
        for confidence, quality, rr, volume in product(
            [55, 60, 65, 70],
            [50, 55, 60, 65, 70],
            [1.2, 1.4, 1.6, 1.8],
            [1.0, 1.1, 1.2]
        )
    ]


def combine_sessions(sessions):
    if not sessions:
        return None

    return pd.concat([session for _, session in sessions])


def build_validation_split(train_sessions):
    if len(train_sessions) <= 1:
        return combine_sessions(train_sessions), None

    core_sessions = train_sessions[:-1]
    validation_session = train_sessions[-1][1]
    core_frame = combine_sessions(core_sessions)

    if core_frame is None or core_frame.empty:
        core_frame = train_sessions[-1][1]
        validation_session = None

    return core_frame, validation_session


def run_walk_forward(
    symbol,
    period="5d",
    interval="1m",
    initial_capital=100000.0,
    train_days=3,
    brokerage_per_side=20.0,
    slippage_per_side=2.0
):
    df, name = get_data(symbol, period=period, interval=interval)
    if df is None or len(df) < 260:
        raise RuntimeError(f"Not enough historical data for {symbol}.")

    day_groups = build_day_groups(df)
    if len(day_groups) <= train_days:
        raise RuntimeError("Not enough daily sessions for walk-forward evaluation.")

    grid = build_filter_grid()
    windows = []
    aggregate_trades = []
    capital = float(initial_capital)
    equity_curve = [capital]

    for offset in range(train_days, len(day_groups)):
        train_sessions = day_groups[offset - train_days:offset]
        test_session = day_groups[offset]
        optimization_df, validation_df = build_validation_split(train_sessions)
        test_df = test_session[1]

        best_result = None
        best_filters = None
        best_candidate_score = None
        best_validation_result = None
        for candidate in grid:
            train_result = run_backtest_on_frame(
                optimization_df,
                name,
                period=f"{train_sessions[0][0]}->{train_sessions[-1][0]}",
                interval=interval,
                initial_capital=100000.0,
                filters=candidate,
                brokerage_per_side=brokerage_per_side,
                slippage_per_side=slippage_per_side
            )
            if validation_df is not None and not validation_df.empty:
                validation_result = run_backtest_on_frame(
                    validation_df,
                    name,
                    period=train_sessions[-1][0],
                    interval=interval,
                    initial_capital=100000.0,
                    filters=candidate,
                    brokerage_per_side=brokerage_per_side,
                    slippage_per_side=slippage_per_side
                )
            else:
                validation_result = train_result

            candidate_score = (
                score_result(train_result) * 0.6 +
                score_result(validation_result) * 0.4
            )

            train_win_rate = to_number(train_result["win_rate"])
            validation_win_rate = to_number(validation_result["win_rate"])
            train_pf = to_number(train_result["profit_factor"], 0)
            validation_pf = to_number(validation_result["profit_factor"], 0)
            candidate_score += max(0, 15 - abs(train_win_rate - validation_win_rate))
            candidate_score += max(0, 8 - abs(train_pf - validation_pf) * 2)
            candidate_score -= abs(to_number(train_result["max_drawdown_percent"]) - to_number(validation_result["max_drawdown_percent"])) * 0.5

            if best_candidate_score is None or candidate_score > best_candidate_score:
                best_candidate_score = candidate_score
                best_result = train_result
                best_validation_result = validation_result
                best_filters = candidate

        test_result = run_backtest_on_frame(
            test_df,
            name,
            period=test_session[0],
            interval=interval,
            initial_capital=capital,
            filters=best_filters,
            brokerage_per_side=brokerage_per_side,
            slippage_per_side=slippage_per_side
        )

        capital = round(capital + test_result["net_pnl"], 2)
        equity_curve.append(capital)
        aggregate_trades.extend(test_result["trades"])
        windows.append({
            "train_period": f"{train_sessions[0][0]} -> {train_sessions[-1][0]}",
            "test_period": test_session[0],
            "selected_filters": best_filters,
            "selection_score": round(best_candidate_score, 2) if best_candidate_score is not None else None,
            "training_snapshot": {
                "net_pnl": best_result["net_pnl"],
                "win_rate": best_result["win_rate"],
                "profit_factor": best_result["profit_factor"],
                "max_drawdown_percent": best_result["max_drawdown_percent"],
                "total_trades": best_result["total_trades"]
            },
            "validation_snapshot": {
                "net_pnl": best_validation_result["net_pnl"],
                "win_rate": best_validation_result["win_rate"],
                "profit_factor": best_validation_result["profit_factor"],
                "max_drawdown_percent": best_validation_result["max_drawdown_percent"],
                "total_trades": best_validation_result["total_trades"]
            },
            "test_snapshot": {
                "net_pnl": test_result["net_pnl"],
                "win_rate": test_result["win_rate"],
                "profit_factor": test_result["profit_factor"],
                "max_drawdown_percent": test_result["max_drawdown_percent"],
                "total_trades": test_result["total_trades"]
            }
        })

    summary = summarize_results(
        symbol=name,
        period=period,
        interval=interval,
        initial_capital=initial_capital,
        ending_capital=capital,
        filters={"mode": "walk_forward"},
        trades=aggregate_trades,
        equity_curve=equity_curve,
        brokerage_per_side=brokerage_per_side,
        slippage_per_side=slippage_per_side
    )
    summary["train_days"] = train_days
    summary["windows"] = windows
    return summary


def run_backtest_on_frame(frame, name, period, interval, initial_capital, filters, brokerage_per_side, slippage_per_side):
    if frame is None or len(frame) < 260:
        return summarize_results(
            symbol=name,
            period=period,
            interval=interval,
            initial_capital=initial_capital,
            ending_capital=initial_capital,
            filters=filters,
            trades=[],
            equity_curve=[initial_capital],
            brokerage_per_side=brokerage_per_side,
            slippage_per_side=slippage_per_side
        )

    trades = []
    capital = float(initial_capital)
    equity_curve = [capital]
    position = None
    warmup = 220

    for index in range(warmup, len(frame) - 1):
        snapshot = frame.iloc[: index + 1]
        candle = frame.iloc[index]
        current_time = frame.index[index]
        next_candle = frame.iloc[index + 1]
        next_time = frame.index[index + 1]

        if position is not None:
            exit_price = None
            exit_reason = None

            if position["signal"] == "BUY CALL":
                if candle["Low"] <= position["stop_loss"]:
                    exit_price = position["stop_loss"]
                    exit_reason = "STOP_LOSS_HIT"
                elif candle["High"] >= position["target"]:
                    exit_price = position["target"]
                    exit_reason = "TARGET_HIT"
            else:
                if candle["High"] >= position["stop_loss"]:
                    exit_price = position["stop_loss"]
                    exit_reason = "STOP_LOSS_HIT"
                elif candle["Low"] <= position["target"]:
                    exit_price = position["target"]
                    exit_reason = "TARGET_HIT"

            session_ended = current_time.date() != next_time.date()
            if exit_price is None and session_ended:
                exit_price = float(candle["Close"])
                exit_reason = "DAY_END_EXIT"

            if exit_price is not None:
                trade = close_position(
                    position,
                    float(exit_price),
                    current_time.isoformat(),
                    exit_reason,
                    brokerage_per_side,
                    slippage_per_side
                )
                capital = round(capital + trade["pnl"], 2)
                equity_curve.append(capital)
                trades.append(trade)
                position = None
                continue

        if position is not None:
            continue

        signal = compute_signal_payload(snapshot, name)
        if not signal_passes_filters(signal, filters):
            continue

        support = to_number(signal.get("support"), 0.0)
        resistance = to_number(signal.get("resistance"), 0.0)
        current_price = float(candle["Close"])
        volume_ratio = to_number(signal.get("volume_ratio"), 0.0)
        structure = str(signal.get("market_regime") or "").upper()
        if not enforce_trade_rules(signal, current_price, support, resistance, volume_ratio, structure):
            continue

        risk = abs(current_price - to_number(signal["stop_loss"], current_price))
        if risk <= 0:
            continue
        if 0 < 0.01 and risk / current_price > 0.01:
            continue

        position = {
            "symbol": name,
            "signal": signal["signal"],
            "entry_time": next_time.isoformat(),
            "entry_price": float(next_candle["Open"]),
            "stop_loss": to_number(signal["stop_loss"]),
            "target": to_number(signal["target"]),
            "risk_reward": to_number(signal["risk_reward"]),
            "quality_score": to_number(signal["quality_score"]),
            "confidence": to_number(signal["confidence"]),
            "risk": risk
        }

    if position is not None:
        final_time = frame.index[-1]
        final_close = float(frame["Close"].iloc[-1])
        trade = close_position(
            position,
            final_close,
            final_time.isoformat(),
            "FORCED_EXIT",
            brokerage_per_side,
            slippage_per_side
        )
        capital = round(capital + trade["pnl"], 2)
        equity_curve.append(capital)
        trades.append(trade)

    return summarize_results(
        symbol=name,
        period=period,
        interval=interval,
        initial_capital=initial_capital,
        ending_capital=capital,
        filters=filters,
        trades=trades,
        equity_curve=equity_curve,
        brokerage_per_side=brokerage_per_side,
        slippage_per_side=slippage_per_side
    )


def print_pretty(result, mode):
    print(f"{mode}: {result['symbol']} ({result['period']} @ {result['interval']})")
    print(f"Trades: {result['total_trades']}")
    print(f"Wins / Losses: {result['wins']} / {result['losses']}")
    print(f"Win Rate: {result['win_rate']}%")
    print(f"Net P&L: {result['net_pnl']}")
    print(f"Ending Capital: {result['ending_capital']}")
    print(f"Average Win / Loss: {result['average_win']} / {result['average_loss']}")
    print(f"Expectancy / Trade: {result['expectancy_per_trade']}")
    print(f"Profit Factor: {result['profit_factor']}")
    print(f"Max Drawdown: {result['max_drawdown_percent']}%")
    print(f"Filters: {result['filters']}")
    if mode == "Walk Forward":
        print(f"Windows: {len(result.get('windows', []))}")


def main():
    parser = argparse.ArgumentParser(description="Evaluate the current AI trading strategy.")
    parser.add_argument("--symbol", default="nifty", choices=["nifty", "banknifty"])
    parser.add_argument("--period", default="5d")
    parser.add_argument("--interval", default="1m")
    parser.add_argument("--capital", type=float, default=100000.0)
    parser.add_argument("--brokerage", type=float, default=20.0)
    parser.add_argument("--slippage", type=float, default=2.0)
    parser.add_argument("--min-confidence", type=float, default=60)
    parser.add_argument("--min-quality", type=float, default=55)
    parser.add_argument("--min-rr", type=float, default=1.4)
    parser.add_argument("--min-volume", type=float, default=1.1)
    parser.add_argument("--walk-forward", action="store_true")
    parser.add_argument("--train-days", type=int, default=3)
    parser.add_argument("--output", choices=["json", "pretty"], default="pretty")
    args = parser.parse_args()

    if args.walk_forward:
        result = run_walk_forward(
            symbol=args.symbol,
            period=args.period,
            interval=args.interval,
            initial_capital=args.capital,
            train_days=args.train_days,
            brokerage_per_side=args.brokerage,
            slippage_per_side=args.slippage
        )
        mode = "Walk Forward"
    else:
        result = run_backtest(
            symbol=args.symbol,
            period=args.period,
            interval=args.interval,
            initial_capital=args.capital,
            min_confidence=args.min_confidence,
            min_quality_score=args.min_quality,
            min_risk_reward=args.min_rr,
            min_volume_ratio=args.min_volume,
            brokerage_per_side=args.brokerage,
            slippage_per_side=args.slippage
        )
        mode = "Backtest"

    if args.output == "json":
        print(json.dumps(result, indent=2))
    else:
        print_pretty(result, mode)


if __name__ == "__main__":
    main()
