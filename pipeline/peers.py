"""Peer valuation table for the core names, from yfinance.

For every company and its peers the job publishes LTM and NTM multiples (EV/EBITDA, P/E, EV/operating cash flow,
EV/free cash flow) plus size and quality columns (market cap, EBITDA, EBITDA margin, revenue growth, ROIC, leverage).

Method, stated in the output so the app can show it:
- LTM flows are the sum of the last four reported quarters (yfinance quarterly statements), with Yahoo's TTM fields as a
  fallback. Balance sheet items are the latest quarter.
- NTM uses consensus. NTM revenue and net income are built from the consensus growth rates for the current and next
  fiscal year, weighted by how much of the current fiscal year is still ahead. NTM EBITDA, operating cash flow and free
  cash flow scale the LTM figure by the NTM / LTM revenue ratio, holding margins flat. There is no free consensus for
  those three lines, so they are labelled as derived.
- Statements can be in a different currency from the share price (Novo Nordisk's ADR trades in USD and reports in DKK).
  Every ratio is computed in the reporting currency, and sizes are converted to USD for display.
- ROIC = LTM operating income x (1 - effective tax rate) / (total debt + equity - cash), latest balance sheet.
Pure functions take plain dicts so the tests run offline; fetch() is the only part that touches the network.
"""
import datetime as dt
import math

# Default peers are switched on in the table; optional peers can be added by the user in the app.
PEERS = {
    "LIN": {
        "default": ["AI.PA", "APD", "4091.T"],
        "optional": ["ECL", "SHW", "DD"],
        "why": "Air Liquide, Air Products and Nippon Sanso are the other three global industrial gas majors. Ecolab and "
               "Sherwin-Williams are optional quality-industrial comparisons that the market prices on similar terms.",
    },
    "LLY": {
        "default": ["NVO", "ABBV", "MRK", "AZN"],
        "optional": ["JNJ", "PFE", "AMGN"],
        "why": "Novo Nordisk is the direct incretin competitor. AbbVie, Merck and AstraZeneca are the large-cap pharma "
               "names investors most often weigh against Lilly for growth and pipeline.",
    },
    "V": {
        "default": ["MA", "AXP", "PYPL"],
        "optional": ["FI", "ADYEN.AS", "FIS"],
        "why": "Mastercard is the only true like-for-like network. American Express is a closed-loop network and lender. "
               "PayPal, Fiserv and Adyen are the processing and wallet layer that competes for the same transactions.",
    },
}

NAMES = {
    "LIN": "Linde", "AI.PA": "Air Liquide", "APD": "Air Products", "4091.T": "Nippon Sanso", "ECL": "Ecolab",
    "SHW": "Sherwin-Williams", "DD": "DuPont", "LLY": "Eli Lilly", "NVO": "Novo Nordisk", "ABBV": "AbbVie",
    "MRK": "Merck", "AZN": "AstraZeneca", "JNJ": "Johnson & Johnson", "PFE": "Pfizer", "AMGN": "Amgen", "V": "Visa",
    "MA": "Mastercard", "AXP": "American Express", "PYPL": "PayPal", "FI": "Fiserv", "ADYEN.AS": "Adyen", "FIS": "FIS",
}

QROWS = {
    "Total Revenue": "revenue", "Operating Income": "op_income", "EBITDA": "ebitda", "Normalized EBITDA": "ebitda_norm",
    "Net Income Common Stockholders": "net_income", "Net Income": "net_income_all", "Pretax Income": "pretax",
    "Tax Provision": "tax", "Operating Cash Flow": "cfo", "Capital Expenditure": "capex",
    "Total Debt": "total_debt", "Cash And Cash Equivalents": "cash",
    "Cash Cash Equivalents And Short Term Investments": "cash_sti", "Stockholders Equity": "equity",
    "Interest Expense": "interest",
}
FLOWS = ("revenue", "op_income", "ebitda", "ebitda_norm", "net_income", "net_income_all", "pretax", "tax", "cfo",
         "capex", "interest")
STOCKS = ("total_debt", "cash", "cash_sti", "equity")


def _f(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return None if v != v or math.isinf(v) else v


def frame_to_periods(df):
    """yfinance statement frame -> [(end_iso, {key: value})] newest first, raw currency units."""
    out = []
    if df is None or getattr(df, "empty", True):
        return out
    for col in df.columns:
        end = (col.date() if hasattr(col, "date") else col)
        row = {}
        for name, key in QROWS.items():
            if name in df.index:
                v = _f(df.at[name, col])
                if v is not None:
                    row[key] = v
        out.append((str(end)[:10], row))
    out.sort(key=lambda x: x[0], reverse=True)
    return out


def ltm(quarters, annual=None):
    """Sum the last four quarters for flows; latest quarter for balances. Falls back to the latest annual figure per
    line when four quarters are not available. Returns (values, basis per line)."""
    vals, basis = {}, {}
    q4 = quarters[:4]
    for k in FLOWS:
        xs = [row.get(k) for _, row in q4]
        if len(xs) == 4 and all(x is not None for x in xs):
            vals[k] = sum(xs)
            basis[k] = "LTM"
        elif annual and annual[0][1].get(k) is not None:
            vals[k] = annual[0][1][k]
            basis[k] = "FY " + annual[0][0][:4]
    src = quarters[0][1] if quarters else (annual[0][1] if annual else {})
    for k in STOCKS:
        if src.get(k) is not None:
            vals[k] = src[k]
    if "capex" in vals:
        vals["capex"] = -abs(vals["capex"])
    if vals.get("ebitda") is None and vals.get("ebitda_norm") is not None:
        vals["ebitda"] = vals["ebitda_norm"]
        basis["ebitda"] = basis.get("ebitda_norm")
    if vals.get("net_income") is None and vals.get("net_income_all") is not None:
        vals["net_income"] = vals["net_income_all"]
    return vals, basis


def ntm_factors(rev_growth_0y, rev_growth_1y, eps_growth_0y, eps_growth_1y, frac_left):
    """Return (revenue factor, earnings factor): NTM over the last fiscal year, consensus-weighted.

    frac_left is the share of the current fiscal year still ahead (0..1). NTM = frac_left x FY0 + (1 - frac_left) x FY1.
    """
    def fac(g0, g1):
        if g0 is None:
            return None
        fy0 = 1 + g0
        fy1 = fy0 * (1 + g1) if g1 is not None else None
        if fy1 is None:
            return fy0
        return frac_left * fy0 + (1 - frac_left) * fy1
    return fac(rev_growth_0y, rev_growth_1y), fac(eps_growth_0y, eps_growth_1y)


def frac_of_year_left(next_fy_end_epoch, today=None):
    if not next_fy_end_epoch:
        return None
    today = today or dt.date.today()
    end = dt.datetime.fromtimestamp(int(next_fy_end_epoch), dt.timezone.utc).date()
    while end < today:  # Yahoo sometimes lags by a year
        end = end.replace(year=end.year + 1)
    days = (end - today).days
    return max(0.0, min(1.0, days / 365.0))


def ratio(a, b):
    a, b = _f(a), _f(b)
    if a is None or b is None or b <= 0:
        return None
    return round(a / b, 2)


def build_row(ticker, info, quarters, annual, est, fx_to_fin, fx_fin_to_usd, today=None):
    """One peer row. info: yfinance info dict. quarters/annual: frame_to_periods output in reporting currency.
    est: {'rev_g0','rev_g1','eps_g0','eps_g1'} consensus growth rates (decimals) or empty.
    fx_to_fin: multiply a quote-currency amount by this to get reporting currency.
    fx_fin_to_usd: multiply a reporting-currency amount by this to get USD."""
    v, basis = ltm(quarters, annual)
    mcap_q = _f(info.get("marketCap"))
    notes = []
    if mcap_q is None:
        return None
    mcap = mcap_q * fx_to_fin
    debt, cash = v.get("total_debt") or 0.0, v.get("cash_sti", v.get("cash")) or 0.0
    ev = mcap + debt - cash
    if v.get("revenue") is None:
        notes.append("Revenue not retrieved.")
    ebitda, ni, cfo, capex, rev = v.get("ebitda"), v.get("net_income"), v.get("cfo"), v.get("capex"), v.get("revenue")
    fcf = cfo + capex if cfo is not None and capex is not None else None
    # NTM
    last_fy_rev = annual[0][1].get("revenue") if annual else None
    last_fy_ni = (annual[0][1].get("net_income") or annual[0][1].get("net_income_all")) if annual else None
    fl = frac_of_year_left(info.get("nextFiscalYearEnd"), today)
    rf, ef = (None, None)
    if est and fl is not None:
        rf, ef = ntm_factors(est.get("rev_g0"), est.get("rev_g1"), est.get("eps_g0"), est.get("eps_g1"), fl)
    ntm_rev = last_fy_rev * rf if rf is not None and last_fy_rev else None
    ntm_ni = last_fy_ni * ef if ef is not None and last_fy_ni and last_fy_ni > 0 else None
    scale = ntm_rev / rev if ntm_rev and rev else None
    ntm = {
        "ev_ebitda": ratio(ev, ebitda * scale) if ebitda and scale else None,
        "pe": ratio(mcap, ntm_ni) if ntm_ni else None,
        "ev_ocf": ratio(ev, cfo * scale) if cfo and scale else None,
        "ev_fcf": ratio(ev, fcf * scale) if fcf and fcf > 0 and scale else None,
        "rev_growth": round(scale - 1, 4) if scale else None,
    }
    if ntm["pe"] is None and _f(info.get("forwardPE")):
        ntm["pe"] = round(_f(info.get("forwardPE")), 2)
        notes.append("NTM P/E is Yahoo's forward P/E (next fiscal year).")
    # quality
    tax_rate = None
    if v.get("tax") is not None and v.get("pretax"):
        tax_rate = max(0.0, min(0.35, v["tax"] / v["pretax"]))
    ic = (v.get("total_debt") or 0.0) + (v.get("equity") or 0.0) - (v.get("cash") or 0.0)
    roic = None
    if v.get("op_income") is not None and ic > 0:
        roic = round(v["op_income"] * (1 - (tax_rate if tax_rate is not None else 0.21)) / ic, 4)
        if tax_rate is None:
            notes.append("ROIC uses a 21% tax rate; the effective rate was not retrieved.")
    prior = None
    if len(quarters) >= 8 and all(quarters[i][1].get("revenue") is not None for i in range(8)):
        prior = sum(quarters[i][1]["revenue"] for i in range(4, 8))
    elif len(annual) >= 2:
        prior = annual[1][1].get("revenue")
    rev_g = round(rev / prior - 1, 4) if rev and prior else None
    usd = lambda x: round(x * fx_fin_to_usd / 1e9, 2) if x is not None else None  # noqa: E731
    return {
        "ticker": ticker, "name": NAMES.get(ticker) or info.get("shortName") or ticker,
        "quote_currency": info.get("currency"), "report_currency": info.get("financialCurrency") or info.get("currency"),
        "mcap_usd_b": usd(mcap), "ev_usd_b": usd(ev), "revenue_usd_b": usd(rev), "ebitda_usd_b": usd(ebitda),
        "ltm": {"ev_ebitda": ratio(ev, ebitda), "pe": ratio(mcap, ni), "ev_ocf": ratio(ev, cfo), "ev_fcf": ratio(ev, fcf) if fcf and fcf > 0 else None},
        "ntm": ntm,
        "ebitda_margin": round(ebitda / rev, 4) if ebitda and rev else None,
        "op_margin": round(v["op_income"] / rev, 4) if v.get("op_income") is not None and rev else None,
        "rev_growth_ltm": rev_g,
        "roic": roic,
        "net_debt_ebitda": round((debt - cash) / ebitda, 2) if ebitda and ebitda > 0 else None,
        "interest_cover": ratio(v.get("op_income"), abs(v["interest"])) if v.get("interest") else None,
        "basis": basis.get("revenue", "n/a"),
        "notes": notes,
    }


def summarise(rows, subject, include):
    """Peer median of each multiple across the included peers (not the subject), and the subject's premium to it."""
    peers = [r for r in rows if r and r["ticker"] in include and r["ticker"] != subject]
    me = next((r for r in rows if r and r["ticker"] == subject), None)
    out = {}
    for block in ("ltm", "ntm"):
        for k in ("ev_ebitda", "pe", "ev_ocf", "ev_fcf"):
            xs = sorted(r[block][k] for r in peers if r[block].get(k) is not None and r[block][k] > 0)
            if not xs:
                continue
            n = len(xs)
            med = xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2
            mine = me[block].get(k) if me else None
            out[f"{block}_{k}"] = {"median": round(med, 2), "subject": mine,
                                   "premium": round(mine / med - 1, 4) if mine and med else None, "n": n}
    return out


# ---------- network ----------
def _growth(df, row, col="growth"):
    try:
        v = df.loc[row, col]
        return _f(v)
    except Exception:  # noqa: BLE001
        return None


def _fx(yf, frm, to):
    if not frm or not to or frm == to:
        return 1.0
    if frm == "GBp":
        return _fx(yf, "GBP", to) / 100
    try:
        px = yf.Ticker(f"{frm}{to}=X").fast_info["last_price"]
        return float(px) if px else None
    except Exception:  # noqa: BLE001
        return None


def fetch(ticker):
    """Live yfinance call for one ticker. Returns (row, errors)."""
    import yfinance as yf
    errors = []
    t = yf.Ticker(ticker)
    try:
        info = t.info or {}
    except Exception as e:  # noqa: BLE001
        return None, [f"{ticker} info: {e}"]
    q, a = [], []
    try:
        q = frame_to_periods(_merge(t.quarterly_income_stmt, t.quarterly_cashflow, t.quarterly_balance_sheet))
        a = frame_to_periods(_merge(t.income_stmt, t.cashflow, t.balance_sheet))
    except Exception as e:  # noqa: BLE001
        errors.append(f"{ticker} statements: {e}")
    est = {}
    try:
        re_ = t.revenue_estimate
        ee = t.earnings_estimate
        est = {"rev_g0": _growth(re_, "0y"), "rev_g1": _growth(re_, "+1y"), "eps_g0": _growth(ee, "0y"), "eps_g1": _growth(ee, "+1y")}
    except Exception as e:  # noqa: BLE001
        errors.append(f"{ticker} estimates: {e}")
    qc, fc = info.get("currency"), info.get("financialCurrency") or info.get("currency")
    to_fin = _fx(yf, qc, fc)
    fin_usd = _fx(yf, fc, "USD")
    if to_fin is None or fin_usd is None:
        return None, errors + [f"{ticker}: FX {qc}->{fc} or {fc}->USD not retrieved"]
    row = build_row(ticker, info, q, a, est, to_fin, fin_usd)
    if row:
        row["estimates"] = est
    return row, errors


def _merge(*dfs):
    import pandas as pd
    frames = [d for d in dfs if d is not None and not getattr(d, "empty", True)]
    if not frames:
        return None
    df = pd.concat(frames)
    return df[~df.index.duplicated(keep="first")]
