"""Synthetic but structurally faithful fixtures (SEC companyfacts and Yahoo chart shapes)."""


def fact(start, end, val, filed, form="10-Q", fy=None, fp=None):
    d = {"end": end, "val": val, "filed": filed, "form": form, "accn": "0000-00-000000"}
    if start:
        d["start"] = start
    if fy:
        d["fy"] = fy
    if fp:
        d["fp"] = fp
    return d


def facts_company():
    """Calendar-year filer. Income items: FY + discrete quarters. Cash flow: FY + YTD only (as filed).
    FY2024: revenue 100/110/120/130 per quarter (sum 460). FY2025: 120/125/130 for Q1-Q3, FY 520 so Q4 = 145."""
    rev = [
        fact("2024-01-01", "2024-03-31", 100e6, "2024-05-01"), fact("2024-04-01", "2024-06-30", 110e6, "2024-08-01"),
        fact("2024-07-01", "2024-09-30", 120e6, "2024-11-01"), fact("2024-01-01", "2024-12-31", 460e6, "2025-02-20", "10-K"),
        fact("2025-01-01", "2025-03-31", 120e6, "2025-05-01"), fact("2025-04-01", "2025-06-30", 125e6, "2025-08-01"),
        fact("2025-07-01", "2025-09-30", 130e6, "2025-11-01"), fact("2025-01-01", "2025-12-31", 520e6, "2026-02-20", "10-K"),
        fact("2026-01-01", "2026-03-31", 150e6, "2026-05-01"), fact("2026-04-01", "2026-06-30", 160e6, "2026-08-01"),
    ]
    ni = [dict(x, val=x["val"] * 0.2) for x in rev]
    eps = [dict(x, val=round(x["val"] / 1e6 * 0.2 / 50, 4)) for x in rev]  # 50M shares
    shares = [fact(x["start"], x["end"], 50e6, x["filed"], x["form"]) for x in rev]
    # cash flow: only cumulative year-to-date facts, as 10-Qs file them
    cfo = [
        fact("2024-01-01", "2024-03-31", 10e6, "2024-05-01"), fact("2024-01-01", "2024-06-30", 22e6, "2024-08-01"),
        fact("2024-01-01", "2024-09-30", 36e6, "2024-11-01"), fact("2024-01-01", "2024-12-31", 50e6, "2025-02-20", "10-K"),
        fact("2025-01-01", "2025-03-31", 12e6, "2025-05-01"), fact("2025-01-01", "2025-06-30", 26e6, "2025-08-01"),
        fact("2025-01-01", "2025-09-30", 41e6, "2025-11-01"), fact("2025-01-01", "2025-12-31", 58e6, "2026-02-20", "10-K"),
        fact("2026-01-01", "2026-03-31", 16e6, "2026-05-01"), fact("2026-01-01", "2026-06-30", 35e6, "2026-08-01"),
    ]
    capex = [dict(x, val=x["val"] * 0.3) for x in cfo]
    assets = [fact(None, e, v, f) for e, v, f in [
        ("2024-12-31", 800e6, "2025-02-20"), ("2025-12-31", 900e6, "2026-02-20"), ("2026-03-31", 950e6, "2026-05-01"), ("2026-06-30", 980e6, "2026-08-01")]]
    equity = [dict(x, val=x["val"] * 0.5) for x in assets]
    cash = [dict(x, val=x["val"] * 0.1) for x in assets]
    ltd = [dict(x, val=x["val"] * 0.2) for x in assets]

    def u(lst, unit="USD"):
        return {"units": {unit: lst}}

    return {"facts": {"us-gaap": {
        "Revenues": u(rev), "NetIncomeLoss": u(ni), "EarningsPerShareDiluted": u(eps, "USD/shares"),
        "WeightedAverageNumberOfDilutedSharesOutstanding": u(shares, "shares"),
        "NetCashProvidedByUsedInOperatingActivities": u(cfo), "PaymentsToAcquirePropertyPlantAndEquipment": u(capex),
        "Assets": u(assets), "StockholdersEquity": u(equity), "CashAndCashEquivalentsAtCarryingValue": u(cash),
        "LongTermDebtNoncurrent": u(ltd),
    }}}


def chart_response(prices, prev=None, state_now=None):
    """Yahoo v8 chart shape for 1d/5m."""
    n = len(prices)
    ts = [1760000000 + i * 300 for i in range(n)]
    return {"chart": {"result": [{
        "meta": {"currency": "USD", "exchangeName": "NYQ", "regularMarketPrice": prices[-1], "chartPreviousClose": prev,
                 "regularMarketDayHigh": max(prices), "regularMarketDayLow": min(prices), "regularMarketVolume": 123456,
                 "fiftyTwoWeekHigh": 500.0, "fiftyTwoWeekLow": 300.0, "regularMarketTime": ts[-1],
                 "currentTradingPeriod": {"regular": {"start": ts[0] - 10, "end": ts[-1] + 3600}}},
        "timestamp": ts,
        "indicators": {"quote": [{"open": prices, "high": [p + 1 for p in prices], "low": [p - 1 for p in prices],
                                  "close": prices, "volume": [1000] * n}]}}], "error": None}}
