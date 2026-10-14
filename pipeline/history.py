"""Daily history products: return windows, moving averages, RSI, MACD, ATR, volatility, drawdown and a
technical read that always carries its reasons. Pure functions over [t, o, h, l, c, v] bars."""
import math


def sma(vals, n):
    return sum(vals[-n:]) / n if len(vals) >= n else None


def ema_series(vals, n):
    if len(vals) < n:
        return []
    k = 2 / (n + 1)
    out = [sum(vals[:n]) / n]
    for v in vals[n:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def rsi(closes, n=14):
    """Wilder RSI."""
    if len(closes) <= n:
        return None
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0)
        losses += max(-d, 0)
    ag, al = gains / n, losses / n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        ag = (ag * (n - 1) + max(d, 0)) / n
        al = (al * (n - 1) + max(-d, 0)) / n
    if al == 0:
        return 100.0
    return 100 - 100 / (1 + ag / al)


def macd(closes, fast=12, slow=26, sig=9):
    ef, es = ema_series(closes, fast), ema_series(closes, slow)
    if not es:
        return None
    ef = ef[len(ef) - len(es):]
    line = [a - b for a, b in zip(ef, es)]
    sg = ema_series(line, sig)
    if not sg:
        return None
    return {"macd": line[-1], "signal": sg[-1], "hist": line[-1] - sg[-1]}


def atr(bars, n=14):
    if len(bars) <= n:
        return None
    trs = []
    for i in range(1, len(bars)):
        h, l, pc = bars[i][2], bars[i][3], bars[i - 1][4]
        if h is None or l is None:
            continue
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    if len(trs) < n:
        return None
    a = sum(trs[:n]) / n
    for tr in trs[n:]:
        a = (a * (n - 1) + tr) / n
    return a


def ret(closes, n):
    return closes[-1] / closes[-1 - n] - 1 if len(closes) > n and closes[-1 - n] else None


def vol_annual(closes, n=20):
    if len(closes) <= n:
        return None
    rs = [math.log(closes[i] / closes[i - 1]) for i in range(len(closes) - n, len(closes)) if closes[i - 1] > 0]
    if len(rs) < 2:
        return None
    mu = sum(rs) / len(rs)
    var = sum((r - mu) ** 2 for r in rs) / (len(rs) - 1)
    return math.sqrt(var) * math.sqrt(252)


def max_drawdown(closes):
    peak, mdd = -1e18, 0.0
    for c in closes:
        peak = max(peak, c)
        mdd = min(mdd, c / peak - 1)
    return mdd


def technical_read(s):
    """Score signals and return a label with the reasons behind it. s is the stats dict."""
    score, reasons = 0.0, []
    px = s["close"]
    if s.get("sma200"):
        if px > s["sma200"]:
            score += 1; reasons.append(f"Price is {((px / s['sma200']) - 1) * 100:.1f}% above its 200-day average, a long-term uptrend.")
        else:
            score -= 1; reasons.append(f"Price is {((s['sma200'] / px) - 1) * 100:.1f}% below its 200-day average, a long-term downtrend.")
    if s.get("sma50"):
        if px > s["sma50"]:
            score += 0.5; reasons.append("Price is above its 50-day average.")
        else:
            score -= 0.5; reasons.append("Price is below its 50-day average.")
    if s.get("sma50") and s.get("sma200"):
        if s["sma50"] > s["sma200"]:
            score += 0.5; reasons.append("The 50-day average is above the 200-day average (golden-cross regime).")
        else:
            score -= 0.5; reasons.append("The 50-day average is below the 200-day average (death-cross regime).")
    r = s.get("rsi14")
    if r is not None:
        if r >= 70:
            score -= 0.5; reasons.append(f"RSI {r:.0f} is overbought; a pullback is more likely than usual.")
        elif r <= 30:
            score += 0.5; reasons.append(f"RSI {r:.0f} is oversold; a bounce is more likely than usual.")
        else:
            reasons.append(f"RSI {r:.0f} is in the neutral band.")
    m = s.get("macd_hist")
    if m is not None:
        if m > 0:
            score += 0.5; reasons.append("MACD histogram is positive: momentum is improving.")
        else:
            score -= 0.5; reasons.append("MACD histogram is negative: momentum is fading.")
    if s.get("ret_3m") is not None:
        if s["ret_3m"] > 0.08:
            score += 0.5; reasons.append(f"Up {s['ret_3m'] * 100:.0f}% over three months.")
        elif s["ret_3m"] < -0.08:
            score -= 0.5; reasons.append(f"Down {abs(s['ret_3m']) * 100:.0f}% over three months.")
    label = ("Bullish" if score >= 2 else "Constructive" if score >= 0.75 else "Neutral" if score > -0.75
             else "Cautious" if score > -2 else "Bearish")
    return {"label": label, "score": round(score, 2), "reasons": reasons}


def stats_from_bars(bars):
    """bars ascending [t, o, h, l, c, v]. Returns the stats dict or None when there is too little history."""
    if len(bars) < 30:
        return None
    closes = [b[4] for b in bars]
    last = closes[-1]
    yr = bars[-252:]
    hi52 = max(b[2] if b[2] is not None else b[4] for b in yr)
    lo52 = min(b[3] if b[3] is not None else b[4] for b in yr)
    import datetime as dt
    y0 = dt.datetime.fromtimestamp(bars[-1][0], dt.timezone.utc).year
    ytd_base = next((b[4] for b in bars if dt.datetime.fromtimestamp(b[0], dt.timezone.utc).year == y0), None)
    mc = macd(closes)
    s = {
        "close": last, "asof": bars[-1][0],
        "ret_1d": ret(closes, 1), "ret_1w": ret(closes, 5), "ret_1m": ret(closes, 21), "ret_3m": ret(closes, 63),
        "ret_6m": ret(closes, 126), "ret_1y": ret(closes, 252), "ret_3y": ret(closes, 756), "ret_5y": ret(closes, 1260),
        "ret_ytd": (last / ytd_base - 1) if ytd_base else None,
        "hi52": hi52, "lo52": lo52, "pos52": (last - lo52) / (hi52 - lo52) if hi52 > lo52 else None,
        "from_hi52": last / hi52 - 1,
        "sma20": sma(closes, 20), "sma50": sma(closes, 50), "sma100": sma(closes, 100), "sma200": sma(closes, 200),
        "rsi14": rsi(closes), "macd": mc["macd"] if mc else None, "macd_signal": mc["signal"] if mc else None,
        "macd_hist": mc["hist"] if mc else None,
        "atr14": atr(bars), "vol20": vol_annual(closes), "vol60": vol_annual(closes, 60),
        "max_dd_1y": max_drawdown([b[4] for b in yr]),
        "avg_vol_3m": (sum(b[5] or 0 for b in bars[-63:]) / min(len(bars), 63)),
    }
    s["technical"] = technical_read(s)
    return s


def build_history(bars):
    """The published history product: compact bars plus stats."""
    stats = stats_from_bars(bars)
    return {"bars": [[round(x, 4) if isinstance(x, float) else x for x in b[:6]] for b in bars], "stats": stats}
