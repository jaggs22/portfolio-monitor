import datetime as dt
import json
import time

from pipeline import evidence, jobs, llm, mgmt, models

NOW = dt.datetime(2026, 10, 15, tzinfo=dt.timezone.utc).timestamp()


def qends(n, last=(2026, 6, 30)):
    out, y, m = [], last[0], last[1]
    for _ in range(n):
        d = {3: 31, 6: 30, 9: 30, 12: 31}[m]
        out.append(f"{y}-{m:02d}-{d}")
        m -= 3
        if m < 1:
            m, y = 12, y - 1
    return out[::-1]


def stmts(growth=0.12, n=20):
    ends = qends(n)
    rev = [100 * (1 + growth) ** (i / 4) for i in range(n)]
    q = {"period_ends": ends, "rows": {
        "revenue": rev, "op_income": [r * 0.30 for r in rev], "net_income": [r * 0.22 for r in rev],
        "gross_profit": [r * 0.80 for r in rev], "eps_diluted": [r * 0.22 / 50 for r in rev], "shares_diluted": [50 - i * 0.1 for i in range(n)]}}
    ann_rev = [sum(rev[i:i + 4]) for i in range(n - 4, -1, -4)][::-1]
    na = len(ann_rev)
    a = {"period_ends": [f"{2026 - na + 1 + i}-12-31" for i in range(na)], "rows": {
        "revenue": ann_rev, "op_income": [r * 0.30 for r in ann_rev], "net_income": [r * 0.22 for r in ann_rev],
        "cfo": [r * 0.28 for r in ann_rev], "capex": [r * 0.04 for r in ann_rev], "total_assets": [r * 2 for r in ann_rev],
        "equity": [r * 0.9 for r in ann_rev], "total_debt": [r * 0.3 for r in ann_rev], "cash": [r * 0.2 for r in ann_rev],
        "net_debt": [r * 0.1 for r in ann_rev], "ebitda": [r * 0.34 for r in ann_rev], "tax": [r * 0.05 for r in ann_rev],
        "pretax": [r * 0.27 for r in ann_rev], "dividends": [r * 0.05 for r in ann_rev], "buybacks": [r * 0.10 for r in ann_rev],
        "goodwill": [r * 0.2 for r in ann_rev], "shares_diluted": [50 - i * 1.2 for i in range(na)]}}
    return {"annual": a, "quarterly": q, "ttm": {}, "meta": {"latest_period_end": ends[-1]}}


def research():
    return {"base_period_end": "2026-03-31", "base": {"eps0": 10.0, "shares0": 0.05, "rev0": 1.0 * 0.5 / 0.22 * 0.22 * 10 / 10},
            "drivers": {"rev_cagr": {"base": 11, "bear": 6, "bull": 13}, "margin_end": {"base": 22, "bear": 18, "bull": 24},
                        "share_chg": {"base": -2.5, "bear": -2, "bull": -3}, "exit_pe": {"base": 27, "bear": 21, "bull": 31}},
            "tripwires": [{"id": "v1", "metric": "net_rev_growth", "op": "<", "threshold": 10, "current": 14},
                          {"id": "v4", "metric": "opex_vs_rev", "op": ">", "threshold": 0, "current": 5},
                          {"id": "x9", "metric": "xborder", "op": "<", "threshold": 8, "current": 12}]}


def test_reading_and_tripwire_status():
    s = stmts(0.12)
    r = evidence.reading("rev_yoy", s)
    assert abs(r["value"] - 12.0) < 0.2 and r["period_end"] == "2026-06-30"
    tw = research()["tripwires"][0]
    st = evidence.tripwire_status(tw, evidence.BINDINGS["V"]["v1"], s)
    assert st["status"] == "ok"
    slow = stmts(0.05)
    assert evidence.tripwire_status(tw, evidence.BINDINGS["V"]["v1"], slow)["status"] == "tripped"


def test_uncomparable_never_sets_status():
    tw = {"id": "l1", "op": "<", "threshold": 4.45, "current": 4.5}
    st = evidence.tripwire_status(tw, evidence.BINDINGS["LIN"]["l1"], stmts())
    assert st["status"] is None and st["auto_value"] is not None


def test_two_quarter_rule():
    s = stmts(0.10)
    rows = s["quarterly"]["rows"]
    # opex grows faster than revenue only in the latest quarter
    rows["op_income"][-1] = rows["revenue"][-1] * 0.20
    tw = {"id": "v4", "op": ">", "threshold": 0, "current": 5}
    st = evidence.tripwire_status(tw, evidence.BINDINGS["V"]["v4"], s)
    assert st["status"] == "watch" and "1 of the last 2" in st["note"]
    rows["op_income"][-2] = rows["revenue"][-2] * 0.20
    assert evidence.tripwire_status(tw, evidence.BINDINGS["V"]["v4"], s)["status"] == "tripped"


def test_models_have_methods_and_flags():
    s = stmts(0.12)
    bars = []
    for i, e in enumerate(s["quarterly"]["period_ends"]):
        t = int(dt.datetime.fromisoformat(e).replace(tzinfo=dt.timezone.utc).timestamp())
        bars.append([t, 100 + i, 101 + i, 99 + i, 100 + i * 4, 1000])
    m = models.driver_models(s, bars, research(), 400.0)
    assert 4 < m["rev_cagr"]["value"] < 12 and "decaying" in m["rev_cagr"]["method"]
    assert m["share_chg"]["value"] < 0
    assert "persistence" in m["margin_end"]["method"]
    assert m["exit_pe"].get("own_median") or m["exit_pe"].get("status")
    assert "flag" in m["rev_cagr"]


def test_needs_review_reasons():
    s = stmts()
    ev = evidence.build_evidence("V", research(), s, [], {"form": "10-Q", "period": "2026-06-30", "filed": "2026-08-01"}, 400.0, NOW)
    kinds = {r["kind"] for r in ev["needs_review"]}
    assert "new_filing" in kinds and "stale" in kinds
    assert "x9" in ev["unmapped_tripwires"]


def test_surprise_and_scores():
    rows = [{"date": f"2024-{m:02d}-01", "estimate": 1.0, "actual": 1.05} for m in range(1, 13)]
    rows[3]["actual"] = 0.9
    st = mgmt.surprise_stats(rows)
    assert st["beats"] == 11 and st["misses"] == 1 and st["streak_no_miss"] == 8
    sc, note = mgmt.score_delivery(st)
    assert 70 < sc <= 100
    assert mgmt.score_delivery(mgmt.surprise_stats(rows[:3])) is None


def test_composite_renormalises_and_reports_coverage():
    c = mgmt.composite({"delivery": (80, ""), "guidance": None, "earnings_quality": (60, ""), "capital_allocation": None,
                        "balance_sheet": None, "governance": None, "insiders": None})
    assert c["score"] == 70.0 and c["coverage"] < 0.5 and "thin" in c["grade"]


def test_build_mgmt_from_statements():
    d = mgmt.build_mgmt("V", stmts(), {"earnings": [], "insiders": [], "governance": {}}, None, "2026-10-15T00:00:00Z")
    keys = {c["key"]: c["score"] for c in d["components"]}
    assert keys["earnings_quality"] is not None and keys["capital_allocation"] is not None and keys["delivery"] is None
    assert any("EPS surprise" in g for g in d["gaps"])


RELEASE1 = "Fiscal 2026 guidance. We expect revenue for fiscal 2026 to be between $9,000 and $9,400 million. Results were strong."
RELEASE2 = "Raised outlook. We now expect revenue for fiscal 2026 to be between $9,300 and $9,500 million. Other text here."
RELEASE3 = "Fiscal 2026 results. Revenue for fiscal 2026 was $9,100 million, up from last year. More text follows here."


def fake_call(guidance=None, reported=None):
    def call(prompt):
        return json.dumps({"guidance": guidance or [], "reported": reported or []})
    return call


def test_verifier_rejects_unquoted_and_wrong_numbers():
    g = [{"metric": "revenue", "period": "FY2026", "low": 9000, "high": 9400, "unit": "usd_millions", "direction": "initiate",
          "quote": "We expect revenue for fiscal 2026 to be between $9,000 and $9,400 million."},
         {"metric": "revenue", "period": "FY2026", "low": 9000, "high": 9900, "unit": "usd_millions", "direction": "initiate",
          "quote": "We expect revenue for fiscal 2026 to be between $9,000 and $9,400 million."},
         {"metric": "revenue", "period": "FY2026", "low": 1, "high": 2, "unit": "usd_millions", "direction": "initiate",
          "quote": "This sentence was invented by the model and is not present."}]
    ex = llm.extract(fake_call(guidance=g), "X", "2026-01-01", RELEASE1)
    assert len(ex["guidance"]) == 1 and ex["rejected"] == 2


def test_billions_rescale_in_quote():
    g = [{"metric": "revenue", "period": "FY2026", "low": 9000, "high": 9400, "unit": "usd_millions", "direction": "initiate",
          "quote": "We expect revenue to be between $9.0 and $9.4 billion in fiscal 2026."}]
    ex = llm.extract(fake_call(guidance=g), "X", "d", "We expect revenue to be between $9.0 and $9.4 billion in fiscal 2026.")
    assert len(ex["guidance"]) == 1


def test_ledger_hit_miss_and_revisions():
    def g(lo, hi, q):
        return {"metric": "revenue", "period": "FY2026", "low": lo, "high": hi, "unit": "usd_millions", "direction": "initiate", "quote": q}
    r = {"metric": "revenue", "period": "FY2026", "value": 9100, "unit": "usd_millions", "basis": "gaap", "quote": "Revenue for fiscal 2026 was $9,100 million"}
    e = [{"date": "2026-01-01", "guidance": [g(9000, 9400, "q1")], "reported": []},
         {"date": "2026-04-01", "guidance": [g(9300, 9500, "q2")], "reported": []},
         {"date": "2026-09-01", "guidance": [], "reported": [r]}]
    led = llm.build_ledger(e)
    assert led["n"] == 1 and led["entries"][0]["outcome"] == "hit" and led["entries"][0]["raises"] == 1
    miss = dict(r, value=8800)
    e[2]["reported"] = [miss]
    assert llm.build_ledger(e)["entries"][0]["outcome"] == "miss"
    e[2]["reported"] = [dict(r, value=9700)]
    assert llm.build_ledger(e)["entries"][0]["outcome"] == "beat"


def test_exhibit_and_filings_pick():
    idx = {"directory": {"item": [{"name": "d123.htm"}, {"name": "d123dex991.htm"}, {"name": "x.xml"}]}}
    assert llm.pick_exhibit(idx) == "d123dex991.htm"
    subs = {"filings": {"recent": {"form": ["8-K", "10-Q", "8-K"], "items": ["2.02,9.01", "", "5.02"], "accessionNumber": ["a-1", "a-2", "a-3"],
                                    "filingDate": ["2026-05-01", "2026-05-02", "2026-06-01"], "primaryDocument": ["p1", "p2", "p3"]}}}
    assert [f["accession"] for f in llm.earnings_filings(subs)] == ["a-1"]


def test_job_evidence_and_mgmt_roundtrip(tmp_path):
    out, rd = tmp_path / "out", tmp_path / "research"
    rd.mkdir()
    (rd / "V.json").write_text(json.dumps(research()))
    jobs.write_json(out / "fundamentals" / "V.json", stmts())
    assert jobs.job_evidence(out, rd, ["V"], NOW) == 1
    ev = json.loads((out / "evidence" / "V.json").read_text())
    assert ev["tripwires"] and ev["models"]["rev_cagr"]["value"]

    class FakeSec:
        def json(self, url):
            if "submissions" in url:
                return {"filings": {"recent": {"form": ["8-K"], "items": ["2.02"], "accessionNumber": ["0001-26-1"], "filingDate": ["2026-05-01"], "primaryDocument": ["p"]}}}
            return {"directory": {"item": [{"name": "ex991.htm"}]}}

        def text(self, url):
            return "<html><body><p>" + RELEASE1 + "</p></body></html>"

    g = [{"metric": "revenue", "period": "FY2026", "low": 9000, "high": 9400, "unit": "usd_millions", "direction": "initiate",
          "quote": "We expect revenue for fiscal 2026 to be between $9,000 and $9,400 million."}]
    yfm = lambda sym: ({"earnings": [{"date": f"2024-{m:02d}-01", "estimate": 1.0, "actual": 1.1} for m in range(1, 9)], "insiders": [], "governance": {"audit_risk": 2, "board_risk": 3, "compensation_risk": 4, "shareholder_rights_risk": 3}}, [])
    assert jobs.job_mgmt(FakeSec(), yfm, fake_call(guidance=g), out, ["V"], NOW, {"V": "0000000001"}) == 1
    m = json.loads((out / "mgmt" / "V.json").read_text())
    assert m["releases_parsed"] == 1 and m["surprises"]["beats"] == 8 and m["composite"]["score"] is not None
    # second run does not re-send the same release
    calls = []
    def counting(prompt):
        calls.append(1); return "{}"
    jobs.job_mgmt(FakeSec(), yfm, counting, out, ["V"], NOW, {"V": "0000000001"})
    assert not calls
