"""yfinance integration: valuation profile, statement gap-filling, and a full fallback when SEC has no history
(for example a company that re-listed under a new CIK). Frames are passed in, so the logic is testable without a network."""
import datetime as dt

ROWS = {
    "Total Revenue": "revenue", "Cost Of Revenue": "cogs", "Gross Profit": "gross_profit",
    "Research And Development": "rnd", "Selling General And Administration": "sga", "Operating Income": "op_income",
    "Interest Expense": "interest_expense", "Pretax Income": "pretax", "Tax Provision": "tax", "Net Income": "net_income",
    "Diluted EPS": "eps_diluted", "Diluted Average Shares": "shares_diluted", "EBITDA": "ebitda",
    "Operating Cash Flow": "cfo", "Capital Expenditure": "capex", "Investing Cash Flow": "cfi", "Financing Cash Flow": "cff",
    "Depreciation And Amortization": "da", "Stock Based Compensation": "sbc", "Cash Dividends Paid": "dividends",
    "Repurchase Of Capital Stock": "buybacks", "Free Cash Flow": "fcf",
    "Cash And Cash Equivalents": "cash", "Other Short Term Investments": "st_investments", "Accounts Receivable": "receivables",
    "Inventory": "inventory", "Current Assets": "current_assets", "Net PPE": "ppe", "Goodwill": "goodwill",
    "Total Assets": "total_assets", "Accounts Payable": "payables", "Current Liabilities": "current_liabilities",
    "Current Debt": "st_debt", "Long Term Debt": "lt_debt", "Total Liabilities Net Minority Interest": "total_liabilities",
    "Stockholders Equity": "equity", "Total Debt": "total_debt", "Net Debt": "net_debt",
}
OUTFLOWS = {"capex", "dividends", "buybacks"}  # Yahoo reports these negative; the app stores magnitudes
PER_SHARE = {"eps_diluted"}


def _iso(c):
    return (c.date() if hasattr(c, "date") else c).isoformat() if not isinstance(c, str) else c[:10]


def normalize_frame(df):
    """DataFrame (rows: line names, columns: period timestamps) -> {end: {key: value}} in USD millions."""
    out = {}
    if df is None or getattr(df, "empty", True):
        return out
    for col in df.columns:
        end = _iso(col)
        for name, key in ROWS.items():
            if name in df.index:
                v = df.at[name, col]
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    continue
                if v != v:  # NaN
                    continue
                if key in OUTFLOWS:
                    v = abs(v)
                out.setdefault(end, {})[key] = round(v, 4) if key in PER_SHARE else round(v / 1e6, 3)
    return out


def merge_frames(*dfs):
    out = {}
    for df in dfs:
        for end, row in normalize_frame(df).items():
            out.setdefault(end, {}).update(row)
    return out


def _near(d, end, tol):
    t = dt.date.fromisoformat(end)
    for k in d:
        if abs((dt.date.fromisoformat(k) - t).days) <= tol:
            return k
    return None


def fill_missing(statements, yf):
    """Fill empty cells in the SEC statements from yfinance and report how many cells were filled."""
    filled = 0
    for part in ("annual", "quarterly"):
        sec_part, src = statements[part], yf.get(part) or {}
        for i, end in enumerate(sec_part["period_ends"]):
            k = _near(src, end, 10)
            if not k:
                continue
            for key, vals in sec_part["rows"].items():
                if vals[i] is None and key in src[k]:
                    vals[i] = src[k][key]
                    sec_part.setdefault("filled", {}).setdefault(key, [False] * len(vals))[i] = True
                    filled += 1
    return filled


def from_yf_only(yf, max_years=10, max_quarters=20):
    """Statements entirely from yfinance (shorter history), in the same shape as sec.build_statements."""
    from .sec import BALANCE, CASHFLOW, INCOME
    keys = list(INCOME) + list(CASHFLOW) + list(BALANCE) + ["ebitda", "fcf", "total_debt", "net_debt"]
    out = {}
    for part, limit in (("annual", max_years), ("quarterly", max_quarters)):
        src = yf.get(part) or {}
        ends = sorted(src)[-limit:]
        out[part] = {"period_ends": ends, "rows": {k: [src[e].get(k) for e in ends] for k in keys}, "derived": {}, "filled": {}}
    q = out["quarterly"]
    ttm = {}
    if len(q["period_ends"]) >= 4:
        for k in list(INCOME) + list(CASHFLOW) + ["ebitda", "fcf"]:
            last4 = q["rows"][k][-4:]
            if all(v is not None for v in last4) and k != "shares_diluted":
                ttm[k] = round(sum(last4), 4)
    latest = (q["period_ends"] or out["annual"]["period_ends"] or [None])[-1]
    out.update({"ttm": ttm, "meta": {"latest_period_end": latest, "units": "USD millions; per-share in USD; shares in millions", "missing": [], "source_note": "yfinance only"}})
    return out


PROFILE_KEYS = {
    "sector": "sector", "industry": "industry", "fullTimeEmployees": "employees", "website": "website",
    "longBusinessSummary": "summary", "beta": "beta", "trailingEps": "trailing_eps", "forwardEps": "forward_eps",
    "trailingPE": "trailing_pe", "forwardPE": "forward_pe", "pegRatio": "peg", "priceToBook": "price_to_book",
    "enterpriseValue": "enterprise_value", "marketCap": "market_cap", "sharesOutstanding": "shares_outstanding",
    "dividendRate": "dividend_rate", "dividendYield": "dividend_yield", "payoutRatio": "payout_ratio",
    "exDividendDate": "ex_dividend_date", "targetMeanPrice": "target_mean", "targetHighPrice": "target_high",
    "targetLowPrice": "target_low", "targetMedianPrice": "target_median", "recommendationKey": "recommendation",
    "numberOfAnalystOpinions": "analyst_count", "heldPercentInstitutions": "institutions_pct",
    "heldPercentInsiders": "insiders_pct", "shortPercentOfFloat": "short_pct_float", "returnOnEquity": "roe_yahoo",
    "fiftyTwoWeekHigh": "hi52", "fiftyTwoWeekLow": "lo52",
}


def profile_from_info(info):
    out = {}
    for src, dst in PROFILE_KEYS.items():
        v = (info or {}).get(src)
        if v is None or (isinstance(v, float) and v != v):
            continue
        out[dst] = v
    return out


def fetch_yf(ticker):
    """Live call into yfinance. Returns (frames_normalized, profile, news_items). Each part fails independently."""
    import yfinance as yf
    t = yf.Ticker(ticker)
    res = {"annual": {}, "quarterly": {}}
    prof, news = {}, []
    errors = []
    try:
        res["annual"] = merge_frames(t.income_stmt, t.balance_sheet, t.cashflow)
        res["quarterly"] = merge_frames(t.quarterly_income_stmt, t.quarterly_balance_sheet, t.quarterly_cashflow)
    except Exception as e:  # noqa: BLE001 - Yahoo failures are expected
        errors.append(f"statements: {e}")
    try:
        prof = profile_from_info(t.info)
    except Exception as e:  # noqa: BLE001
        errors.append(f"info: {e}")
    try:
        news = t.news or []
    except Exception as e:  # noqa: BLE001
        errors.append(f"news: {e}")
    return res, prof, news, errors


def normalize_earnings(df):
    """yfinance earnings_dates frame -> [{date, estimate, actual}] for reported quarters only."""
    rows = []
    try:
        for idx, r in df.iterrows():
            est, act = r.get("EPS Estimate"), r.get("Reported EPS")
            if est is None or act is None or est != est or act != act:
                continue
            rows.append({"date": str(idx)[:10], "estimate": float(est), "actual": float(act)})
    except Exception:  # noqa: BLE001
        return []
    return rows


def normalize_insiders(df):
    rows = []
    try:
        for _, r in df.iterrows():
            text = str(r.get("Text") or "") + " " + str(r.get("Transaction") or "")
            low = text.lower()
            kind = "buy" if "purchase" in low or "bought" in low else "sell" if "sale" in low or "sold" in low else "other"
            if "gift" in low or "award" in low or "grant" in low or "exercise" in low:
                kind = "other"
            v = r.get("Value")
            rows.append({"date": str(r.get("Start Date"))[:10], "shares": float(r.get("Shares") or 0),
                         "value": float(v) if v == v and v is not None else None, "kind": kind})
    except Exception:  # noqa: BLE001
        return []
    return rows


def governance_from_info(info):
    g = {"audit_risk": (info or {}).get("auditRisk"), "board_risk": (info or {}).get("boardRisk"),
         "compensation_risk": (info or {}).get("compensationRisk"), "shareholder_rights_risk": (info or {}).get("shareHolderRightsRisk")}
    return {k: v for k, v in g.items() if isinstance(v, (int, float))}


def fetch_yf_mgmt(ticker):
    """Live call: earnings surprise history, insider transactions and governance risk scores. Parts fail independently."""
    import yfinance as yf
    t = yf.Ticker(ticker)
    out, errors = {"earnings": [], "insiders": [], "governance": {}}, []
    try:
        out["earnings"] = normalize_earnings(t.get_earnings_dates(limit=24))
    except Exception as e:  # noqa: BLE001
        errors.append(f"earnings: {e}")
    try:
        out["insiders"] = normalize_insiders(t.insider_transactions)
    except Exception as e:  # noqa: BLE001
        errors.append(f"insiders: {e}")
    try:
        out["governance"] = governance_from_info(t.info)
    except Exception as e:  # noqa: BLE001
        errors.append(f"governance: {e}")
    return out, errors
