"""Peer valuation table for the core names, from yfinance.

For every company and its peers the job publishes LTM and NTM multiples (EV/EBITDA, P/E, EV/operating cash flow,
EV/free cash flow) plus size and quality columns (market cap, EBITDA, EBITDA margin, revenue growth, ROIC, leverage).

Method, stated in the output so the app can show it:
- EBITDA and LTM earnings exclude unusual items as Yahoo tags them (Normalized EBITDA, Normalized Income), so one-off
  impairments and acquired IPR&D charges do not distort the multiples; reported EBITDA is the fallback.
- LTM flows are the sum of the last four reported quarters (yfinance quarterly statements), with Yahoo's TTM fields as a
  fallback. Balance sheet items are the latest quarter.
- NTM uses consensus. NTM P/E divides the price by consensus EPS for the next twelve months (current and next fiscal
  year, weighted by how much of the current year is still ahead), on the adjusted basis brokers quote. NTM EBITDA, operating cash flow and free
  cash flow scale the LTM figure by the NTM / LTM revenue ratio, holding margins flat. There is no free consensus for
  those three lines, so they are labelled as derived.
- Statements can be in a different currency from the share price (Novo Nordisk's ADR trades in USD and reports in DKK).
  Every ratio is computed in the reporting currency, and sizes are converted to USD for display.
- ROIC = LTM operating income x (1 - effective tax rate) / (total debt + equity - cash), latest balance sheet.
Pure functions take plain dicts so the tests run offline; fetch() is the only part that touches the network.
"""
import datetime as dt
import math

# EV-based multiples mean little for a lender: its debt is raw material, not financing. P/E only for these.
EV_NOT_MEANINGFUL = {"AXP": "American Express is a lender as well as a network, so EV-based multiples are not meaningful; compare on P/E."}

# Default peers are switched on in the table; optional peers can be added by the user in the app.
PEERS = {
    "LIN": {
        "default": ["AI.PA", "APD", "4091.T"],
        "optional": ["ECL", "SHW"],
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
    "Total Revenue": "revenue", "Operating Income": "op_income", "EBITDA": "ebitda_gaap", "Normalized EBITDA": "ebitda",
    "Normalized Income": "ni_norm", "Net Income Common Stockholders": "net_income", "Net Income": "net_income_all", "Pretax Income": "pretax",
    "Tax Provision": "tax", "Operating Cash Flow": "cfo", "Capital Expenditure": "capex",
    "Total Debt": "total_debt", "Cash And Cash Equivalents": "cash",
    "Cash Cash Equivalents And Short Term Investments": "cash_sti", "Stockholders Equity": "equity",
    "Interest Expense": "interest",
}
FLOWS = ("revenue", "op_income", "ebitda", "ebitda_gaap", "ni_norm", "net_income", "net_income_all", "pretax", "tax", "cfo",
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
    if vals.get("ebitda") is None and vals.get("ebitda_gaap") is not None:  # no normalised line: fall back to reported
        vals["ebitda"] = vals["ebitda_gaap"]
        basis["ebitda"] = basis.get("ebitda_gaap")
        basis["ebitda_kind"] = "reported"
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


def frac_of_year_left(last_fy_end_epoch, today=None):
    """Share of the consensus 'current year' (the year after the last reported fiscal year) still ahead.
    Zero when that year has ended but is not yet reported, so NTM then rests on next year's consensus."""
    if not last_fy_end_epoch:
        return None
    today = today or dt.date.today()
    last = dt.datetime.fromtimestamp(int(last_fy_end_epoch), dt.timezone.utc).date()
    cur_end = last + dt.timedelta(days=365)
    days = (cur_end - today).days
    return max(0.0, min(1.0, days / 365.0)), last


def sane_growth(g):
    return g if g is not None and -0.6 < g < 1.5 else None


def ratio(a, b):
    a, b = _f(a), _f(b)
    if a is None or b is None or b <= 0:
        return None
    return round(a / b, 2)


def _fy_row(annual, last_fy):
    """The annual row for the last reported fiscal year (within 20 days), else the latest."""
    if not annual:
        return {}
    if last_fy:
        for end, row in annual:
            if abs((dt.date.fromisoformat(end) - last_fy).days) <= 20:
                return row
    return annual[0][1]


def build_row(ticker, info, quarters, annual, est, fx_to_fin, fx_fin_to_usd, today=None):
    """One peer row. info: yfinance info dict. quarters/annual: frame_to_periods output in reporting currency.
    est: consensus {'rev_g0','rev_g1','eps0','eps1'} (growth decimals, EPS averages) or empty.
    fx_to_fin: quote currency -> reporting currency. fx_fin_to_usd: reporting currency -> USD."""
    v, basis = ltm(quarters, annual)
    mcap_q = _f(info.get("marketCap"))
    notes = []
    if mcap_q is None:
        return None
    mcap = mcap_q * fx_to_fin
    debt, cash = v.get("total_debt"), v.get("cash_sti", v.get("cash"))
    if debt is None and _f(info.get("totalDebt")) is not None:
        debt = _f(info["totalDebt"]) * fx_to_fin
        notes.append("Debt from Yahoo summary (no quarterly balance sheet).")
    if cash is None and _f(info.get("totalCash")) is not None:
        cash = _f(info["totalCash"]) * fx_to_fin
    debt, cash = debt or 0.0, cash or 0.0
    ev = mcap + debt - cash
    ebitda, cfo, capex, rev = v.get("ebitda"), v.get("cfo"), v.get("capex"), v.get("revenue")
    ni = v.get("ni_norm") if v.get("ni_norm") is not None else v.get("net_income")
    fcf = cfo + capex if cfo is not None and capex is not None else None
    # NTM: consensus for the current and next fiscal year, weighted by time
    fl = frac_of_year_left(info.get("lastFiscalYearEnd"), today)
    frac, last_fy = fl if fl else (None, None)
    fy = _fy_row(annual, last_fy)
    g0, g1 = sane_growth((est or {}).get("rev_g0")), sane_growth((est or {}).get("rev_g1"))
    ntm_rev = None
    if frac is not None and g0 is not None and fy.get("revenue"):
        fac = frac * (1 + g0) + (1 - frac) * (1 + g0) * (1 + (g1 if g1 is not None else 0))
        ntm_rev = fy["revenue"] * fac
        if g1 is None:
            notes.append("Next-year revenue consensus missing; NTM holds the current-year level.")
    scale = ntm_rev / rev if ntm_rev and rev else None
    if scale is not None and not 0.6 < scale < 1.8:
        notes.append("NTM revenue looked inconsistent with LTM, so derived NTM multiples are hidden.")
        scale = None
    # NTM P/E on consensus EPS (adjusted basis, as brokers quote it), checked against Yahoo's forward P/E
    price = _f(info.get("currentPrice")) or _f(info.get("regularMarketPrice"))
    e0, e1 = _f((est or {}).get("eps0")), _f((est or {}).get("eps1"))
    fwd_eps = _f(info.get("forwardEps"))
    same_ccy = (info.get("currency") or "") == (info.get("financialCurrency") or info.get("currency") or "")
    if fwd_eps and fwd_eps > 0 and same_ccy and e1 and abs(e1 / fwd_eps - 1) > 0.04:
        notes.append(f"Next-year consensus EPS ({e1:.2f}) disagreed with Yahoo's forward EPS ({fwd_eps:.2f}); forward EPS used.")
        e1 = fwd_eps
    ntm_pe = None
    if price and frac is not None and e1 and e1 > 0:
        ntm_eps = frac * (e0 if e0 and e0 > 0 else e1) + (1 - frac) * e1
        ntm_pe = round(price / ntm_eps, 2)
    fpe = _f(info.get("forwardPE"))
    if fpe and (ntm_pe is None or not 0.6 < ntm_pe / fpe < 1.6):
        if ntm_pe is not None:
            notes.append("Consensus EPS looked mis-scaled (ADR ratio or currency); NTM P/E uses Yahoo's forward P/E.")
        ntm_pe = round(fpe, 2)
    ntm = {
        "ev_ebitda": ratio(ev, ebitda * scale) if ebitda and scale else None,
        "pe": ntm_pe,
        "ev_ocf": ratio(ev, cfo * scale) if cfo and scale else None,
        "ev_fcf": ratio(ev, fcf * scale) if fcf and fcf > 0 and scale else None,
        "rev_growth": round(scale - 1, 4) if scale else None,
    }
    ltm_m = {"ev_ebitda": ratio(ev, ebitda), "pe": ratio(mcap, ni) if ni and ni > 0 else None, "ev_ocf": ratio(ev, cfo),
             "ev_fcf": ratio(ev, fcf) if fcf and fcf > 0 else None}
    if ltm_m["pe"] and ntm["pe"] and ltm_m["pe"] > 1.8 * ntm["pe"]:
        notes.append("Trailing earnings are depressed by one-off charges (for pharma, usually acquired IPR&D); NTM is the cleaner read.")
    if ticker in EV_NOT_MEANINGFUL:
        for blk in (ltm_m, ntm):
            for k in ("ev_ebitda", "ev_ocf", "ev_fcf"):
                blk[k] = None
        notes.append(EV_NOT_MEANINGFUL[ticker])
    # quality
    tax_rate = None
    if v.get("tax") is not None and v.get("pretax"):
        tax_rate = max(0.0, min(0.35, v["tax"] / v["pretax"]))
    ic = debt + (v.get("equity") or 0.0) - cash
    roic = None
    if v.get("op_income") is not None and v.get("equity") is not None and ic > 0 and ticker not in EV_NOT_MEANINGFUL:
        roic = round(v["op_income"] * (1 - (tax_rate if tax_rate is not None else 0.21)) / ic, 4)
        if tax_rate is None:
            notes.append("ROIC uses a 21% tax rate; the effective rate was not retrieved.")
    # growth: last reported fiscal year over the one before
    rev_g, growth_basis = None, None
    if len(annual) >= 2 and fy.get("revenue"):
        idx = next((i for i, (_, r) in enumerate(annual) if r is fy), 0)
        if idx + 1 < len(annual) and annual[idx + 1][1].get("revenue"):
            rev_g = round(fy["revenue"] / annual[idx + 1][1]["revenue"] - 1, 4)
            growth_basis = "FY " + annual[idx][0][:4]
    usd = lambda x: round(x * fx_fin_to_usd / 1e9, 2) if x is not None else None  # noqa: E731
    return {
        "ticker": ticker, "name": NAMES.get(ticker) or info.get("shortName") or ticker,
        "quote_currency": info.get("currency"), "report_currency": info.get("financialCurrency") or info.get("currency"),
        "mcap_usd_b": usd(mcap), "ev_usd_b": usd(ev) if ticker not in EV_NOT_MEANINGFUL else None,
        "revenue_usd_b": usd(rev), "ebitda_usd_b": usd(ebitda) if ticker not in EV_NOT_MEANINGFUL else None,
        "ltm": ltm_m, "ntm": ntm,
        "ebitda_margin": round(ebitda / rev, 4) if ebitda and rev and ticker not in EV_NOT_MEANINGFUL else None,
        "op_margin": round(v["op_income"] / rev, 4) if v.get("op_income") is not None and rev else None,
        "rev_growth_fy": rev_g, "growth_basis": growth_basis,
        "roic": roic,
        "net_debt_ebitda": round((debt - cash) / ebitda, 2) if ebitda and ebitda > 0 and ticker not in EV_NOT_MEANINGFUL else None,
        "interest_cover": ratio(v.get("op_income"), abs(v["interest"])) if v.get("interest") else None,
        "basis": basis.get("revenue", "n/a"), "ebitda_kind": basis.get("ebitda_kind", "adjusted"),
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
        est = {"rev_g0": _growth(re_, "0y"), "rev_g1": _growth(re_, "+1y"), "eps0": _growth(ee, "0y", "avg"), "eps1": _growth(ee, "+1y", "avg")}
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
