"""Statistical cross-checks for the four disputable drivers.

These are deliberately simple, transparent models fitted to each company's own reported history. They do not
replace the research judgment; they sit beside it so a reader can see when the judgment is far from what the
company's own record would imply. Every output carries its method and inputs.

Basis note: statements here are GAAP while the research baseline uses company-adjusted figures. For margins and
multiples the model therefore predicts a CHANGE from today's level and applies it to the research starting point."""
import datetime as dt
import math
import statistics

GDP_ANCHOR = 4.0   # long-run nominal growth the growth path decays toward, % a year
DECAY = 0.75       # share of the gap to the anchor that survives each year
HORIZON = 3


def _vals(rows, key):
    return rows.get(key) or []


def _clean(xs):
    return [x for x in xs if x is not None]


def ttm_series(stmts, key):
    """Rolling trailing-four-quarter sums aligned to quarter ends. Returns [(end, value)]."""
    q = stmts["quarterly"]
    ends, vals = q["period_ends"], _vals(q["rows"], key)
    out = []
    for i in range(3, len(ends)):
        w = vals[i - 3:i + 1]
        if all(v is not None for v in w):
            out.append((ends[i], sum(w)))
    return out


def growth_model(stmts, engine_base):
    ann = stmts["annual"]
    rev = _clean(_vals(ann["rows"], "revenue"))
    ttm = ttm_series(stmts, "revenue")
    if len(rev) < 4 or len(ttm) < 5:
        return None
    n3 = min(3, len(rev) - 1)
    cagr3 = (rev[-1] / rev[-1 - n3]) ** (1 / n3) - 1
    n5 = min(5, len(rev) - 1)
    cagr5 = (rev[-1] / rev[-1 - n5]) ** (1 / n5) - 1
    yoy = ttm[-1][1] / ttm[-5][1] - 1 if len(ttm) >= 5 and ttm[-5][1] else cagr3
    start = 0.5 * yoy + 0.3 * cagr3 + 0.2 * cagr5
    # growth decays toward the anchor; the driver is the average annual growth over the horizon
    path, g = [], start * 100
    for _ in range(HORIZON):
        g = GDP_ANCHOR + (g - GDP_ANCHOR) * DECAY
        path.append(g)
    value = sum(path) / HORIZON
    return {"value": round(value, 1), "unit": "% a year",
            "method": "Blend of latest TTM growth (50%), 3-year CAGR (30%) and 5-year CAGR (20%), decaying 25% a year toward 4% nominal growth",
            "inputs": {"ttm_yoy_pct": round(yoy * 100, 1), "cagr3_pct": round(cagr3 * 100, 1), "cagr5_pct": round(cagr5 * 100, 1)}}


def _ar1(xs):
    """OLS AR(1) on deviations from the mean. Returns (mu, phi) with phi clipped to a stable, plausible range."""
    if len(xs) < 5:
        return None
    mu = statistics.fmean(xs)
    d = [x - mu for x in xs]
    num = sum(a * b for a, b in zip(d[:-1], d[1:]))
    den = sum(a * a for a in d[:-1])
    phi = num / den if den else 0.8
    return mu, min(0.95, max(0.3, phi))


def margin_model(stmts, engine_current_margin):
    ann = stmts["annual"]["rows"]
    rev, ni = _vals(ann, "revenue"), _vals(ann, "net_income")
    ratio = [n / r for n, r in zip(ni, rev) if n is not None and r]
    ttm_r, ttm_n = ttm_series(stmts, "revenue"), ttm_series(stmts, "net_income")
    fit = _ar1(ratio)
    if not fit or not ttm_r or not ttm_n:
        return None
    mu, phi = fit
    cur = ttm_n[-1][1] / ttm_r[-1][1]
    year3 = mu + (phi ** HORIZON) * (cur - mu)
    delta = (year3 - cur) * 100
    out = {"gaap_now_pct": round(cur * 100, 1), "gaap_year3_pct": round(year3 * 100, 1), "delta_pts": round(delta, 1),
           "unit": "%", "method": f"AR(1) mean reversion of annual GAAP net margin (mean {mu * 100:.1f}%, persistence {phi:.2f}) projected {HORIZON} years",
           "inputs": {"mean_pct": round(mu * 100, 1), "persistence": round(phi, 2), "years": len(ratio)}}
    if engine_current_margin is not None:
        out["value"] = round(engine_current_margin + delta, 1)
    return out


def share_model(stmts):
    ann = stmts["annual"]["rows"]
    sh = _clean(_vals(ann, "shares_diluted"))
    q = ttm_series(stmts, "revenue")  # only to confirm there is recent data
    if len(sh) < 4 or not q:
        return None
    n = min(5, len(sh) - 1)
    chg3 = (sh[-1] / sh[-1 - min(3, len(sh) - 1)]) ** (1 / min(3, len(sh) - 1)) - 1
    chg5 = (sh[-1] / sh[-1 - n]) ** (1 / n) - 1
    value = (0.6 * chg3 + 0.4 * chg5) * 100
    return {"value": round(value, 2), "unit": "% a year",
            "method": "Annualised change in diluted share count: 3-year (60%) and 5-year (40%)",
            "inputs": {"chg3_pct": round(chg3 * 100, 2), "chg5_pct": round(chg5 * 100, 2)}}


def pe_history(stmts, bars):
    """P/E at each quarter end: close on or before the date over GAAP TTM EPS. Needs price bars [t,o,h,l,c,v]."""
    eps = ttm_series(stmts, "eps_diluted")
    if not eps or not bars:
        return []
    days = [(dt.datetime.fromtimestamp(b[0], dt.timezone.utc).date().isoformat() if b[0] > 1e8 else str(b[0]), b[4]) for b in bars]
    out = []
    for end, e in eps:
        if e is None or e <= 0:
            continue
        px = None
        for d, c in days:
            if d <= end:
                px = c
            else:
                break
        if px is not None and days and days[0][0] <= end:
            out.append((end, px / e))
    return out


def multiple_model(stmts, bars, engine_current_pe, gaap_price_pe_now=None):
    hist = pe_history(stmts, bars)
    if len(hist) < 6:
        return None
    pes = [p for _, p in hist if 3 < p < 150]
    if len(pes) < 6:
        return None
    med = statistics.median(pes)
    cur = hist[-1][1] if gaap_price_pe_now is None else gaap_price_pe_now
    lo, hi = min(pes), max(pes)
    pct_rank = sum(1 for p in pes if p <= cur) / len(pes)
    # halfway reversion toward the company's own median over three years, expressed as a ratio so the adjusted/GAAP gap cancels
    ratio = (med / cur) ** 0.5 if cur > 0 else 1.0
    out = {"gaap_now": round(cur, 1), "own_median": round(med, 1), "own_low": round(lo, 1), "own_high": round(hi, 1),
           "percentile_now": round(pct_rank * 100), "unit": "x", "quarters": len(pes),
           "method": "Half of the gap between today's GAAP P/E and the company's own median P/E (quarter ends, price over GAAP TTM EPS) closes over three years",
           "inputs": {"reversion_ratio": round(ratio, 3)}}
    if engine_current_pe:
        out["value"] = round(engine_current_pe * ratio, 1)
    return out


def driver_models(stmts, bars, research, price):
    """Returns {driver: model dict + engine comparison}. Each driver is independent and can be missing."""
    b = research["base"]
    eng_margin = b["eps0"] * b["shares0"] / b["rev0"] * 100 if b.get("rev0") else None
    eng_pe = price / b["eps0"] if price and b.get("eps0") else None
    models = {
        "rev_cagr": growth_model(stmts, research["drivers"]["rev_cagr"]["base"]),
        "margin_end": margin_model(stmts, eng_margin),
        "share_chg": share_model(stmts),
        "exit_pe": multiple_model(stmts, bars, eng_pe),
    }
    out = {}
    for k, m in models.items():
        if not m:
            out[k] = {"status": "not enough history"}
            continue
        base = research["drivers"][k]
        entry = dict(m, engine=base["base"], bear=base["bear"], bull=base["bull"])
        if m.get("value") is not None:
            gap = base["base"] - m["value"]
            span = max(abs(base["bull"] - base["bear"]) / 2, 0.5)
            entry["gap"] = round(gap, 1)
            entry["verdict"] = ("inside the model's neighbourhood" if abs(gap) <= span * 0.5 else
                                "above what the record implies" if gap > 0 else "below what the record implies")
            entry["flag"] = abs(gap) > span
        out[k] = entry
    return out
