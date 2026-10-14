"""Management quality: what the record says about the people running the company.

Every component is computed from reported data, scores 0 to 100 through a stated transform, and is dropped (with its
weight) when the data is not there. The composite reports its coverage so a score built on three components is not
mistaken for one built on seven. Nothing here is a judgment about character; it is a record of delivery."""
import statistics

WEIGHTS = {"delivery": 1.5, "guidance": 2.0, "earnings_quality": 1.5, "capital_allocation": 2.0, "balance_sheet": 1.0, "governance": 1.0, "insiders": 0.5}
LABELS = {"delivery": "Earnings delivery", "guidance": "Guidance reliability", "earnings_quality": "Earnings quality",
          "capital_allocation": "Capital allocation", "balance_sheet": "Balance sheet discipline", "governance": "Governance risk",
          "insiders": "Insider behaviour"}


def lin(x, pts):
    """Piecewise-linear transform through (x, score) anchor points, clamped at the ends."""
    if x is None:
        return None
    pts = sorted(pts)
    if x <= pts[0][0]:
        return float(pts[0][1])
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return float(pts[-1][1])


def _c(xs):
    return [x for x in xs if x is not None]


# ---------- earnings delivery (yfinance earnings history) ----------
def surprise_stats(rows, n=12):
    """rows: [{date, estimate, actual}] any order. Beat means actual above the consensus estimate."""
    rows = sorted((r for r in rows if r.get("estimate") is not None and r.get("actual") is not None), key=lambda r: r["date"])[-n:]
    if not rows:
        return None
    beats = inline = misses = 0
    sp = []
    for r in rows:
        e, a = r["estimate"], r["actual"]
        s = (a - e) / abs(e) * 100 if e else 0.0
        sp.append(s)
        if round(a, 2) > round(e, 2):
            beats += 1
        elif round(a, 2) < round(e, 2):
            misses += 1
        else:
            inline += 1
    streak = 0
    for r in reversed(rows):
        if round(r["actual"], 2) >= round(r["estimate"], 2):
            streak += 1
        else:
            break
    k = len(rows)
    return {"n": k, "beats": beats, "inline": inline, "misses": misses, "beat_rate": round(beats / k, 3),
            "avg_surprise_pct": round(statistics.fmean(sp), 1), "worst_pct": round(min(sp), 1),
            "streak_no_miss": streak, "since": rows[0]["date"], "rows": [{"date": r["date"], "estimate": r["estimate"], "actual": r["actual"]} for r in rows]}


def score_delivery(s):
    if not s or s["n"] < 6:
        return None
    base = lin(s["beat_rate"] * 100, [(30, 10), (60, 50), (80, 80), (95, 100)])
    pen = lin(-s["worst_pct"], [(0, 0), (3, 0), (10, 8), (25, 20)])  # one very large miss costs up to 20 points
    return round(max(0.0, base - pen), 1), f"Beat consensus EPS in {s['beats']} of the last {s['n']} quarters; worst miss {s['worst_pct']}%."


# ---------- guidance reliability (ledger from company releases) ----------
def score_guidance(ledger):
    if not ledger or ledger.get("n", 0) < 4:
        return None
    hit = ledger["hit_rate"] * 100
    s = lin(hit, [(40, 10), (70, 50), (90, 85), (100, 100)])
    s -= min(15, ledger.get("cut_rate", 0) * 40)
    return round(max(0, s), 1), f"Delivered at or above the guided range in {ledger['hits']} of {ledger['n']} verifiable guides; cut guidance in {round(ledger.get('cut_rate', 0) * 100)}% of revisions."


# ---------- statement-based components ----------
def _ann(stmts, key):
    return (stmts.get("annual", {}).get("rows") or {}).get(key) or []


def cash_conversion(stmts, years=5):
    cfo, ni = _ann(stmts, "cfo"), _ann(stmts, "net_income")
    pairs = [(c, n) for c, n in zip(cfo, ni) if c is not None and n not in (None, 0) and n > 0][-years:]
    if len(pairs) < 3:
        return None
    return round(sum(c for c, _ in pairs) / sum(n for _, n in pairs), 2), len(pairs)


def accrual_ratio(stmts, years=5):
    cfo, ni, ta = _ann(stmts, "cfo"), _ann(stmts, "net_income"), _ann(stmts, "total_assets")
    xs = []
    for i in range(1, len(ta)):
        if None in (cfo[i], ni[i], ta[i], ta[i - 1]):
            continue
        xs.append((ni[i] - cfo[i]) / ((ta[i] + ta[i - 1]) / 2))
    xs = xs[-years:]
    return round(statistics.fmean(xs), 3) if len(xs) >= 3 else None


def margin_stability(stmts, years=6):
    op, rev = _ann(stmts, "op_income"), _ann(stmts, "revenue")
    m = [o / r * 100 for o, r in zip(op, rev) if o is not None and r][-years:]
    return (round(statistics.pstdev(m), 2), len(m)) if len(m) >= 4 else None


def score_quality(stmts):
    parts, notes = [], []
    cc = cash_conversion(stmts)
    if cc:
        parts.append(lin(cc[0], [(0.6, 0), (0.9, 55), (1.1, 85), (1.4, 100)]))
        notes.append(f"Operating cash flow was {cc[0]}x net income over {cc[1]} years.")
    ac = accrual_ratio(stmts)
    if ac is not None:
        parts.append(lin(ac, [(-0.05, 100), (0.0, 80), (0.05, 40), (0.12, 0)]))
        notes.append(f"Average accruals {ac * 100:.1f}% of assets.")
    ms = margin_stability(stmts)
    if ms:
        parts.append(lin(ms[0], [(0.5, 100), (2.0, 80), (5.0, 45), (10.0, 10)]))
        notes.append(f"Operating margin standard deviation {ms[0]} points over {ms[1]} years.")
    if not parts:
        return None
    return round(statistics.fmean(parts), 1), " ".join(notes)


def roic_series(stmts):
    op, tax, pt = _ann(stmts, "op_income"), _ann(stmts, "tax"), _ann(stmts, "pretax")
    eq, debt, cash = _ann(stmts, "equity"), _ann(stmts, "total_debt"), _ann(stmts, "cash")
    out = []
    for i in range(len(op)):
        if None in (op[i], eq[i]) or i >= len(debt):
            out.append(None)
            continue
        t = tax[i] / pt[i] if tax[i] is not None and pt[i] else 0.21
        t = min(0.35, max(0.0, t))
        ic = eq[i] + (debt[i] or 0) - (cash[i] or 0)
        out.append(op[i] * (1 - t) / ic if ic and ic > 0 else None)
    return out


def capital_allocation(stmts, years=5):
    cfo, capex = _ann(stmts, "cfo"), _ann(stmts, "capex")
    div, bb = _ann(stmts, "dividends"), _ann(stmts, "buybacks")
    sh = _c(_ann(stmts, "shares_diluted"))
    gw, ta = _ann(stmts, "goodwill"), _ann(stmts, "total_assets")
    out = {}
    r = _c(roic_series(stmts))[-years:]
    if len(r) >= 3:
        out["roic_avg_pct"] = round(statistics.fmean(r) * 100, 1)
        out["roic_latest_pct"] = round(r[-1] * 100, 1)
    if len(sh) >= 4:
        n = min(5, len(sh) - 1)
        out["share_change_pct_pa"] = round(((sh[-1] / sh[-1 - n]) ** (1 / n) - 1) * 100, 2)
    fcf, ret = [], []
    for i in range(len(cfo)):
        if cfo[i] is not None and capex[i] is not None:
            f = cfo[i] - capex[i]
            fcf.append(f)
            ret.append((div[i] or 0) + (bb[i] or 0) if i < len(div) and i < len(bb) else None)
    pairs = [(r_, f) for r_, f in zip(ret, fcf) if r_ is not None and f > 0][-years:]
    if len(pairs) >= 3:
        out["payout_of_fcf_pct"] = round(sum(r_ for r_, _ in pairs) / sum(f for _, f in pairs) * 100)
    g = [g_ / t_ * 100 for g_, t_ in zip(gw, ta) if g_ is not None and t_]
    if len(g) >= 4:
        out["goodwill_pct_assets"] = round(g[-1], 1)
        out["goodwill_drift_pts"] = round(g[-1] - g[-min(5, len(g))], 1)
    return out


def score_capital(stmts):
    ca = capital_allocation(stmts)
    parts, notes = [], []
    if "roic_avg_pct" in ca:
        parts.append(lin(ca["roic_avg_pct"], [(4, 0), (8, 40), (15, 75), (25, 100)]))
        notes.append(f"Average ROIC {ca['roic_avg_pct']}%.")
    if "share_change_pct_pa" in ca:
        parts.append(lin(ca["share_change_pct_pa"], [(-3, 100), (-1, 80), (0, 55), (2, 20), (4, 0)]))
        notes.append(f"Diluted share count {ca['share_change_pct_pa']:+.1f}% a year.")
    if "payout_of_fcf_pct" in ca:
        parts.append(lin(ca["payout_of_fcf_pct"], [(30, 70), (70, 100), (100, 75), (130, 35), (180, 5)]))
        notes.append(f"Dividends and buybacks took {ca['payout_of_fcf_pct']}% of free cash flow.")
    if "goodwill_drift_pts" in ca:
        parts.append(lin(ca["goodwill_drift_pts"], [(-5, 100), (0, 85), (8, 45), (20, 10)]))
        notes.append(f"Goodwill {ca['goodwill_pct_assets']}% of assets ({ca['goodwill_drift_pts']:+.1f} points over the window).")
    if not parts:
        return None, ca
    return (round(statistics.fmean(parts), 1), " ".join(notes)), ca


def score_balance(stmts):
    nd, eb = _c(_ann(stmts, "net_debt")), _c(_ann(stmts, "ebitda"))
    if not nd or not eb or eb[-1] <= 0:
        return None
    lev = nd[-1] / eb[-1]
    s = 100.0 if lev <= 0 else lin(lev, [(0.5, 95), (1.5, 80), (2.5, 60), (4, 30), (6, 5)])
    return round(s, 1), f"Net debt is {lev:.1f}x EBITDA." if lev > 0 else "Net cash position."


# ---------- governance and insiders (yfinance) ----------
def score_governance(gov):
    vals = _c([gov.get(k) for k in ("audit_risk", "board_risk", "compensation_risk", "shareholder_rights_risk")]) if gov else []
    if len(vals) < 3:
        return None
    avg = statistics.fmean(vals)
    return round(lin(avg, [(1, 100), (4, 75), (7, 30), (10, 0)]), 1), f"Average of Yahoo's audit, board, compensation and shareholder-rights risk scores: {avg:.1f} of 10 (lower is better)."


def insider_stats(rows, now_iso):
    """rows: [{date, shares, value, kind}] kind buy/sell/other. Last 12 months."""
    cutoff = f"{int(now_iso[:4]) - 1}{now_iso[4:10]}"
    win = [r for r in rows if r.get("date", "") >= cutoff]
    if not win:
        return None
    buys = [r for r in win if r["kind"] == "buy"]
    sells = [r for r in win if r["kind"] == "sell"]
    return {"buy_count": len(buys), "sell_count": len(sells), "bought_value": round(sum(r.get("value") or 0 for r in buys)),
            "sold_value": round(sum(r.get("value") or 0 for r in sells)), "window_from": cutoff}


def score_insiders(st):
    if not st or (st["buy_count"] + st["sell_count"]) < 3:
        return None
    ratio = st["buy_count"] / (st["buy_count"] + st["sell_count"])
    return round(lin(ratio, [(0, 40), (0.1, 50), (0.4, 75), (0.7, 95)]), 1), \
        f"{st['buy_count']} open-market buys and {st['sell_count']} sales in the last 12 months. Executive selling is routine, so this is a weak signal."


# ---------- composite ----------
def composite(parts):
    avail = {k: v for k, v in parts.items() if v}
    if not avail:
        return {"score": None, "grade": "Insufficient data", "coverage": 0.0}
    tw = sum(WEIGHTS[k] for k in avail)
    score = sum(avail[k][0] * WEIGHTS[k] for k in avail) / tw
    cov = tw / sum(WEIGHTS.values())
    grade = "Strong record" if score >= 75 else "Good record" if score >= 62 else "Mixed record" if score >= 48 else "Weak record"
    if cov < 0.5:
        grade += " (thin evidence)"
    return {"score": round(score, 1), "grade": grade, "coverage": round(cov, 2)}


def build_mgmt(ticker, stmts, yfm, ledger, now_iso):
    yfm = yfm or {}
    stats = surprise_stats(yfm.get("earnings") or [])
    cap, capd = score_capital(stmts) if stmts else (None, {})
    parts = {
        "delivery": score_delivery(stats),
        "guidance": score_guidance(ledger),
        "earnings_quality": score_quality(stmts) if stmts else None,
        "capital_allocation": cap,
        "balance_sheet": score_balance(stmts) if stmts else None,
        "governance": score_governance(yfm.get("governance")),
        "insiders": score_insiders(insider_stats(yfm.get("insiders") or [], now_iso)),
    }
    comps = [{"key": k, "label": LABELS[k], "weight": WEIGHTS[k], "score": parts[k][0] if parts[k] else None,
              "note": parts[k][1] if parts[k] else None} for k in WEIGHTS]
    gaps = []
    if not parts["delivery"]:
        gaps.append("EPS surprise history not retrieved (needs at least six quarters of consensus estimates).")
    if not parts["guidance"]:
        gaps.append("Guidance ledger has too few verified entries. It fills as earnings releases are parsed; no free source supplies a clean guidance history.")
    if not parts["governance"]:
        gaps.append("Governance risk scores not retrieved.")
    if not parts["insiders"]:
        gaps.append("Too few insider transactions in the last 12 months to read.")
    return {"ticker": ticker, "asof": now_iso, "composite": composite(parts), "components": comps,
            "surprises": stats, "guidance": ledger or None, "capital": capd, "gaps": gaps,
            "insiders": insider_stats(yfm.get("insiders") or [], now_iso),
            "note": "A record of delivery from reported data, not a view on character. Components missing data are excluded and the weights re-normalised; coverage says how much of the model the score rests on."}
