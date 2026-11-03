import math
import random

from pipeline import baserates as B, jobs


class FakeSec:
    """Serves synthetic XBRL frames: 600 companies, revenue compounding at known rates, a 10% net margin drifting."""
    def __init__(self):
        rnd = random.Random(7)
        self.co = []
        for i in range(600):
            r0 = 10 ** rnd.uniform(8, 11.5)  # $100M to $300B
            g = rnd.uniform(-0.05, 0.25)
            m = rnd.uniform(0.02, 0.3)
            self.co.append((i + 1, r0, g, m))
        self.calls = 0

    def json(self, url):
        self.calls += 1
        tag = url.split("/us-gaap/")[1].split("/")[0]
        year = int(url.rsplit("CY", 1)[1].split(".")[0])
        rows = []
        for cik, r0, g, m in self.co:
            rev = r0 * (1 + g) ** (year - 2009)
            if tag == "Revenues" and cik % 2 == 0:
                rows.append({"cik": cik, "val": rev})
            elif tag == "RevenueFromContractWithCustomerExcludingAssessedTax" and cik % 2 == 1:
                rows.append({"cik": cik, "val": rev})
            elif tag == "SalesRevenueNet" and cik % 2 == 1:
                rows.append({"cik": cik, "val": rev * 5})  # lower-priority tag must not win
            elif tag == "NetIncomeLoss":
                rows.append({"cik": cik, "val": rev * (m + 0.002 * (year - 2009))})
        return {"data": rows}


def test_percentiles_are_ordered_and_interpolated():
    p = B.pctiles([0, 10])
    assert p[0] == 0 and p[-1] == 10 and abs(p[10] - 5) < 1e-9
    assert all(a <= b for a, b in zip(p, p[1:]))


def test_build_recovers_known_growth_and_margin_drift():
    sec = FakeSec()
    rev, ni, errs = B.fetch(sec, 2009, 2019)
    assert not errs
    assert all(v[2009] < 1e12 for v in rev.values())  # priority tag kept, not the 5x decoy
    res = B.build(rev, ni, 2009, 2019)
    for h in ("3", "5", "10"):
        for k, row in res["revenue_cagr"][h].items():
            assert -0.051 <= row["p"][0] and row["p"][-1] <= 0.251, (h, k)
    m = [row for row in res["net_margin_change_pts"]["3"].values()]
    assert m and all(abs(r["p"][10] - 0.6) < 0.05 for r in m)  # +0.2 pts a year for 3 years
    assert res["size_buckets"][-1][2] is None and res["caveats"]


def test_job_writes_once_then_respects_max_age(tmp_path):
    sec = FakeSec()
    # 600 synthetic filers is below the 1,000 sanity floor, so the job records a failure and writes nothing
    out = jobs.job_baserates(sec, tmp_path, now=1.8e9, last_year=2012)
    assert out is None
    h = jobs.read_json(tmp_path / "health.json")
    assert h["baserates"]["ok"] is False
