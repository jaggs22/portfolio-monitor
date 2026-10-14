"""Evidence refresh: recompute what the reports can recompute, and say plainly what needs a human.

Per covered name this produces evidence/{T}.json containing
  tripwires    current reading of each tripwire from the latest statements, where the metric is mappable
  models       statistical cross-checks for the four drivers (models.py)
  needs_review reasons the narrative should be re-read (new filing, tripped tripwire, stale baseline, model divergence)
No narrative text is generated. Hand-sourced figures (cross-border volume, backlog, guidance) are never overwritten."""
import datetime as dt

from . import models

# ticker -> tripwire id -> binding. comparable=False means the statement basis (GAAP) differs from the tripwire's
# basis (company-adjusted), so the reading is shown beside the hand-sourced figure but never changes its status.
BINDINGS = {
    "V": {
        "v1": {"fn": "rev_yoy", "comparable": True},
        "v4": {"fn": "opex_vs_rev", "comparable": True, "needs": 2},
    },
    "LIN": {
        "l1": {"fn": "eps_q", "comparable": False},
    },
    "LLY": {
        "y3": {"fn": "gross_margin", "comparable": False},
    },
    "MU": {
        "m1": {"fn": "gross_margin", "comparable": False},
        "m2": {"fn": "revenue_b", "comparable": True},
    },
    "PG": {},
}
STALE_DAYS = 120
GAP_UNIT = {"rev_cagr": "points a year", "margin_end": "points", "share_chg": "points a year", "exit_pe": "turns"}


def _q(stmts, key):
    q = stmts["quarterly"]
    return q["period_ends"], q["rows"].get(key) or []


def _yoy_at(vals, i):
    if i < 4 or vals[i] is None or vals[i - 4] in (None, 0):
        return None
    return (vals[i] / vals[i - 4] - 1) * 100


def reading(fn, stmts, back=0):
    """Reading `back` quarters before the latest. Returns {value, period_end, basis} or None."""
    ends, _ = _q(stmts, "revenue")
    if not ends:
        return None
    i = len(ends) - 1 - back
    if i < 0:
        return None
    end = ends[i]
    if fn == "rev_yoy":
        v = _yoy_at(_q(stmts, "revenue")[1], i)
        basis = "GAAP revenue, year on year"
    elif fn == "opex_vs_rev":
        rev, op = _q(stmts, "revenue")[1], _q(stmts, "op_income")[1]
        if i < 4 or None in (rev[i], rev[i - 4], op[i], op[i - 4]):
            return None
        opex = [r - o if r is not None and o is not None else None for r, o in zip(rev, op)]
        a, b = _yoy_at(opex, i), _yoy_at(rev, i)
        v = None if a is None or b is None else a - b
        basis = "GAAP operating expense growth minus revenue growth, points"
    elif fn == "gross_margin":
        gp, rev = _q(stmts, "gross_profit")[1], _q(stmts, "revenue")[1]
        v = gp[i] / rev[i] * 100 if gp[i] is not None and rev[i] else None
        basis = "GAAP gross margin"
    elif fn == "revenue_b":
        rev = _q(stmts, "revenue")[1]
        v = rev[i] / 1000 if rev[i] is not None else None
        basis = "GAAP revenue, $B"
    elif fn == "eps_q":
        e = _q(stmts, "eps_diluted")[1]
        v = e[i]
        basis = "GAAP diluted EPS"
    else:
        return None
    if v is None:
        return None
    return {"value": round(v, 2), "period_end": end, "basis": basis}


def _breach(op, value, threshold):
    return value < threshold if op == "<" else value > threshold


def tripwire_status(tw, binding, stmts):
    r = reading(binding["fn"], stmts)
    if not r:
        return None
    out = {"id": tw["id"], "auto_value": r["value"], "period_end": r["period_end"], "basis": r["basis"],
           "comparable": binding["comparable"], "hand_value": tw.get("current")}
    if not binding["comparable"] or tw.get("threshold") is None:
        out["status"] = None
        out["note"] = "Statement basis differs from the report's adjusted figure, so this is shown for reference and does not change the status."
        return out
    need = binding.get("needs", 1)
    hits = 0
    for back in range(need):
        rb = reading(binding["fn"], stmts, back)
        if rb and _breach(tw["op"], rb["value"], tw["threshold"]):
            hits += 1
    near = abs(r["value"] - tw["threshold"]) <= 0.1 * max(abs(tw["threshold"]), 1)
    out["status"] = "tripped" if hits >= need else "watch" if hits or near else "ok"
    if hits and hits < need:
        out["note"] = f"Breached in {hits} of the last {need} quarters; it needs {need}."
    return out


def needs_review(research, filing, stmts, models_out, tripwires, now):
    reasons = []
    base_end = research.get("base_period_end")
    if filing and base_end and filing.get("period", "") > base_end:
        reasons.append({"kind": "new_filing", "text": f"A {filing['form']} for the period ending {filing['period']} was filed on {filing['filed']}. The baseline is anchored at {base_end}; re-read the narrative against the new filing."})
    latest = (stmts.get("meta") or {}).get("latest_period_end")
    if latest and base_end and latest > base_end and not filing:
        reasons.append({"kind": "new_statements", "text": f"Statements now run to {latest}, later than the baseline period {base_end}."})
    if base_end:
        age = (dt.date.fromtimestamp(now) - dt.date.fromisoformat(base_end)).days
        if age > STALE_DAYS:
            reasons.append({"kind": "stale", "text": f"The baseline is {age} days old; a newer quarterly filing is probably due or already out."})
    for t in tripwires:
        if t.get("status") == "tripped":
            reasons.append({"kind": "tripwire", "text": f"Tripwire {t['id']} reads {t['auto_value']} against its threshold; the thesis needs a decision."})
    for k, m in (models_out or {}).items():
        if m.get("flag"):
            reasons.append({"kind": "model_gap", "text": f"{k}: the engine's base {m['engine']} is {abs(m['gap'])} {GAP_UNIT.get(k, '')} away from the statistical read ({m['value']}), {m['verdict']}.".replace("  ", " ")})
    return reasons


def build_evidence(ticker, research, stmts, bars, filing, price, now):
    binds = BINDINGS.get(ticker, {})
    tws = []
    for tw in research.get("tripwires", []):
        b = binds.get(tw["id"])
        s = tripwire_status(tw, b, stmts) if b else None
        if s:
            tws.append(s)
    mods = models.driver_models(stmts, bars, research, price) if stmts else {}
    return {"ticker": ticker, "asof": dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "base_period_end": research.get("base_period_end"), "tripwires": tws, "models": mods,
            "needs_review": needs_review(research, filing, stmts, mods, tws, now),
            "unmapped_tripwires": [t["id"] for t in research.get("tripwires", []) if t["id"] not in {x["id"] for x in tws}],
            "note": "Computed from reported statements and price history. Narrative and sourced figures are not rewritten."}
