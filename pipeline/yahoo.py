"""Yahoo chart feed (quotes, intraday, daily history) with a Stooq fallback for daily bars.
The chart endpoint needs no crumb. It is unofficial: every caller must tolerate failure."""
import csv
import io
import time
from urllib.parse import quote

CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range={rng}&interval={itv}&includePrePost=false&events=div%2Csplits"


def _num(x):
    return x if isinstance(x, (int, float)) and x == x else None


def parse_chart(doc):
    """Return {meta, bars} from a Yahoo chart response, or None. bars are [t, o, h, l, c, v] with t in epoch seconds."""
    try:
        res = doc["chart"]["result"][0]
    except (KeyError, IndexError, TypeError):
        return None
    meta = res.get("meta") or {}
    ts = res.get("timestamp") or []
    q = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    adj = ((res.get("indicators") or {}).get("adjclose") or [{}])[0].get("adjclose")
    bars = []
    for i, t in enumerate(ts):
        c = _num((q.get("close") or [None] * (i + 1))[i])
        if c is None:
            continue  # holiday or halted bar
        row = [t,
               _num(q["open"][i]) if q.get("open") else None,
               _num(q["high"][i]) if q.get("high") else None,
               _num(q["low"][i]) if q.get("low") else None,
               c,
               _num(q["volume"][i]) if q.get("volume") else None]
        if adj and i < len(adj) and _num(adj[i]) is not None:
            row.append(round(adj[i], 4))
        bars.append(row)
    return {"meta": meta, "bars": bars}


def market_state(meta, now=None):
    """open, pre, post or closed, from the regular trading period in the chart meta."""
    now = now or time.time()
    try:
        cur = meta["currentTradingPeriod"]
        reg, pre, post = cur["regular"], cur.get("pre"), cur.get("post")
        if reg["start"] <= now < reg["end"]:
            return "open"
        if pre and pre["start"] <= now < pre["end"]:
            return "pre"
        if post and post["start"] <= now < post["end"]:
            return "post"
    except (KeyError, TypeError):
        pass
    return "closed"


def quote_from_chart(parsed, now=None):
    """Latest quote from a 1d/5m chart. Previous close is the close before the session, not the previous bar."""
    if not parsed:
        return None
    m = parsed["meta"]
    price = _num(m.get("regularMarketPrice"))
    if price is None and parsed["bars"]:
        price = parsed["bars"][-1][4]
    prev = _num(m.get("chartPreviousClose"))
    if prev is None:
        prev = _num(m.get("previousClose"))
    if price is None:
        return None
    change = (price - prev) if prev else None
    return {
        "price": round(price, 4),
        "prev_close": round(prev, 4) if prev else None,
        "change": round(change, 4) if change is not None else None,
        "pct": round(change / prev * 100, 4) if change is not None and prev else None,
        "day_high": _num(m.get("regularMarketDayHigh")),
        "day_low": _num(m.get("regularMarketDayLow")),
        "volume": _num(m.get("regularMarketVolume")),
        "hi52": _num(m.get("fiftyTwoWeekHigh")),
        "lo52": _num(m.get("fiftyTwoWeekLow")),
        "currency": m.get("currency"),
        "exchange": m.get("exchangeName"),
        "state": market_state(m, now),
        "asof": _num(m.get("regularMarketTime")),
        "provider": "yahoo",
    }


def fetch_chart(http, symbol, rng="1d", interval="5m"):
    url = CHART.format(sym=quote(symbol, safe=""), rng=rng, itv=interval)
    return parse_chart(http.json(url))


def parse_stooq_csv(text):
    """Daily bars from a Stooq CSV: Date,Open,High,Low,Close,Volume. Returns [t, o, h, l, c, v] ascending."""
    import datetime as dt
    rows = []
    for r in csv.DictReader(io.StringIO(text.strip())):
        try:
            d = dt.datetime.strptime(r["Date"], "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)
            rows.append([int(d.timestamp()), float(r["Open"]), float(r["High"]), float(r["Low"]), float(r["Close"]),
                         float(r.get("Volume") or 0)])
        except (KeyError, ValueError, TypeError):
            continue
    rows.sort(key=lambda x: x[0])
    return rows


def stooq_history(http, ticker):
    sym = ticker.lower().replace(".", "-") + ".us"
    return parse_stooq_csv(http.text(f"https://stooq.com/q/d/l/?s={sym}&i=d"))


def quote_from_bars(bars):
    """End-of-day quote from the last two daily bars (backup when the Yahoo chart feed refuses the runner)."""
    if len(bars) < 2:
        return None
    last, prev = bars[-1], bars[-2]
    return {"price": round(last[4], 4), "prev_close": round(prev[4], 4), "change": round(last[4] - prev[4], 4),
            "pct": round((last[4] / prev[4] - 1) * 100, 4), "day_high": last[2], "day_low": last[3], "volume": last[5],
            "hi52": None, "lo52": None, "currency": "USD", "exchange": None, "state": "CLOSED", "asof": last[0], "provider": "stooq"}
