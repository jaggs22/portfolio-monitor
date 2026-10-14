import math

from pipeline import history, news, sec, yahoo
from pipeline.tests.fixtures import chart_response, facts_company


def test_chart_quote_and_state():
    doc = chart_response([400.0, 401.0, 404.0, 402.5], prev=398.0)
    parsed = yahoo.parse_chart(doc)
    q = yahoo.quote_from_chart(parsed, now=parsed["bars"][-1][0])
    assert q["price"] == 402.5 and q["prev_close"] == 398.0
    assert math.isclose(q["pct"], (402.5 - 398.0) / 398.0 * 100, abs_tol=1e-3)
    assert q["state"] == "open" and q["hi52"] == 500.0
    assert yahoo.quote_from_chart(parsed, now=parsed["bars"][-1][0] + 99999)["state"] == "closed"


def test_chart_skips_null_bars_and_bad_docs():
    doc = chart_response([1.0, 2.0, 3.0], prev=1.0)
    doc["chart"]["result"][0]["indicators"]["quote"][0]["close"][1] = None
    assert len(yahoo.parse_chart(doc)["bars"]) == 2
    assert yahoo.parse_chart({"chart": {"result": None}}) is None
    assert yahoo.quote_from_chart(None) is None


def test_stooq_csv():
    rows = yahoo.parse_stooq_csv("Date,Open,High,Low,Close,Volume\n2026-10-12,1,2,0.5,1.5,100\n2026-10-13,1.5,2.5,1,2,200\nbad,row")
    assert [r[4] for r in rows] == [1.5, 2.0] and rows[0][0] < rows[1][0]


def test_statements_derive_q4_and_ytd_cash_flow():
    st = sec.build_statements(facts_company())
    a, q = st["annual"], st["quarterly"]
    assert a["period_ends"] == ["2024-12-31", "2025-12-31"]
    assert a["rows"]["revenue"] == [460.0, 520.0]
    # Q4 2024 = 460 - (100+110+120) = 130 ; Q4 2025 = 520 - (120+125+130) = 145, flagged derived
    qi = dict(zip(q["period_ends"], q["rows"]["revenue"]))
    assert qi["2024-12-31"] == 130.0 and qi["2025-12-31"] == 145.0 and qi["2026-06-30"] == 160.0
    assert q["derived"]["revenue"][q["period_ends"].index("2025-12-31")] is True
    # cash flow only has YTD facts: Q2 2025 = 26 - 12 = 14, Q3 = 41 - 26 = 15, Q4 = 58 - 41 = 17
    cf = dict(zip(q["period_ends"], q["rows"]["cfo"]))
    assert cf["2025-06-30"] == 14.0 and cf["2025-09-30"] == 15.0 and cf["2025-12-31"] == 17.0
    assert cf["2026-03-31"] == 16.0 and cf["2026-06-30"] == 19.0


def test_statements_derived_lines_and_ttm():
    st = sec.build_statements(facts_company())
    q = st["quarterly"]
    i = q["period_ends"].index("2026-06-30")
    assert q["rows"]["fcf"][i] == round(19.0 - 19.0 * 0.3, 3)
    assert q["rows"]["total_debt"][i] == round(980 * 0.2, 3)
    assert q["rows"]["net_debt"][i] == round(980 * 0.2 - 98.0, 3)
    # TTM revenue = Q3'25 130 + Q4'25 145 + Q1'26 150 + Q2'26 160 = 585
    assert st["ttm"]["revenue"] == 585.0
    assert st["ttm"]["shares_diluted"] == 50.0
    assert st["meta"]["latest_period_end"] == "2026-06-30" and st["meta"]["missing"] == ["op_income"]


def test_filing_ratios_only_for_newer_period():
    facts = facts_company()
    latest = {"form": "10-Q", "filed": "2026-08-01", "period": "2026-06-30", "accession": "x"}
    f = sec.build_filing(facts, latest, "2026-03-31")
    # TTM revenue to Jun-26 = 585 ; TTM to Mar-26 = 125+130+145+150 = 550
    assert f["metrics"] and math.isclose(f["rev_ratio"], 585 / 550, rel_tol=1e-5)
    assert sec.build_filing(facts, latest, "2026-06-30") is None


def test_latest_periodic_picks_newest_and_ignores_8k():
    sub = {"filings": {"recent": {"form": ["8-K", "10-Q", "10-K"], "filingDate": ["2026-09-01", "2026-08-01", "2026-02-20"],
                                  "reportDate": ["", "2026-06-30", "2025-12-31"], "accessionNumber": ["a", "b", "c"]}}}
    assert sec.latest_periodic(sub)["accession"] == "b"
    assert sec.latest_periodic({}) is None


def _bars(closes):
    return [[1700000000 + i * 86400, c, c + 1, c - 1, c, 1000] for i, c in enumerate(closes)]


def test_history_stats_trend_up():
    closes = [100 + i * 0.5 for i in range(260)]
    s = history.stats_from_bars(_bars(closes))
    assert s["sma50"] > s["sma200"] and s["close"] > s["sma200"]
    assert s["rsi14"] == 100.0
    assert s["technical"]["label"] in ("Bullish", "Constructive")
    assert s["ret_1y"] > 0 and s["max_dd_1y"] == 0
    assert any("200-day" in r for r in s["technical"]["reasons"])


def test_history_stats_trend_down_and_short_series():
    closes = [300 - i * 0.6 for i in range(260)]
    s = history.stats_from_bars(_bars(closes))
    assert s["technical"]["label"] in ("Cautious", "Bearish") and s["max_dd_1y"] < 0
    assert history.stats_from_bars(_bars([1, 2, 3])) is None


def test_rsi_wilder_known_value():
    # Classic Wilder example series: RSI(14) is about 70.5 at the 15th close
    closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28]
    assert abs(history.rsi(closes) - 70.46) < 0.5


def test_news_parsers_and_merge():
    new_shape = [{"content": {"title": "A beats", "pubDate": "2026-10-14T12:00:00Z", "provider": {"displayName": "Reuters"},
                              "canonicalUrl": {"url": "https://x.test/a"}}}]
    old_shape = [{"title": "B falls", "link": "https://x.test/b", "publisher": "Bloomberg", "providerPublishTime": 1760400000}]
    a, b = news.parse_yf_news(new_shape), news.parse_yf_news(old_shape)
    assert a[0]["source"] == "Reuters" and a[0]["t"] and b[0]["source"] == "Bloomberg"
    rss = "<rss><channel><item><title>C</title><link>https://x.test/c</link><pubDate>Tue, 14 Oct 2026 10:00:00 +0000</pubDate></item></channel></rss>"
    assert news.parse_rss(rss)[0]["title"] == "C" and news.parse_rss("not xml") == []
    merged = news.merge({"V": a + b, "MA": a})
    assert len(merged) == 2 and merged[0]["tickers"] == ["V", "MA"]


def test_yfinance_normalize_and_fill():
    import pandas as pd
    from pipeline import yf_extra
    cols = [pd.Timestamp("2026-06-30"), pd.Timestamp("2026-03-31")]
    inc = pd.DataFrame({cols[0]: [160e6, 40e6, 0.8], cols[1]: [150e6, 38e6, 0.76]}, index=["Total Revenue", "Net Income", "Diluted EPS"])
    cf = pd.DataFrame({cols[0]: [-5e6], cols[1]: [-4e6]}, index=["Capital Expenditure"])
    n = yf_extra.merge_frames(inc, cf)
    assert n["2026-06-30"]["revenue"] == 160.0 and n["2026-06-30"]["capex"] == 5.0 and n["2026-06-30"]["eps_diluted"] == 0.8
    st = sec.build_statements(facts_company())
    i = st["quarterly"]["period_ends"].index("2026-06-30")
    assert st["quarterly"]["rows"]["op_income"][i] is None
    st["quarterly"]["rows"]["op_income"]  # missing in SEC fixture
    n["2026-06-29"] = {"op_income": 33.0}  # Yahoo's date can differ by a day
    n["2026-06-30"].pop("op_income", None)
    filled = yf_extra.fill_missing(st, {"quarterly": {"2026-06-29": {"op_income": 33.0}}})
    assert filled >= 1 and st["quarterly"]["rows"]["op_income"][i] == 33.0 and st["quarterly"]["filled"]["op_income"][i]


def test_yf_only_fallback_and_profile():
    from pipeline import yf_extra
    yf = {"quarterly": {f"2025-{m:02d}-28": {"revenue": float(m), "eps_diluted": 1.0} for m in (3, 6, 9, 12)}, "annual": {"2025-12-31": {"revenue": 30.0}}}
    st = yf_extra.from_yf_only(yf)
    assert st["ttm"]["revenue"] == 30.0 and st["annual"]["rows"]["revenue"] == [30.0]
    assert yf_extra.profile_from_info({"sector": "Energy", "beta": float("nan"), "targetMeanPrice": 150})["target_mean"] == 150


# ---------- jobs end to end with fake clients ----------
import json as _json


class FakeHttp:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def _hit(self, url):
        self.calls.append(url)
        for k, v in self.routes.items():
            if k in url:
                if isinstance(v, Exception):
                    raise v
                return v
        raise RuntimeError("no route " + url)

    def json(self, url, **kw):
        return self._hit(url)

    def text(self, url, **kw):
        return self._hit(url)


def test_job_quotes_keeps_stale_on_failure(tmp_path):
    from pipeline import jobs
    ok = chart_response([100.0, 101.0, 102.0], prev=99.0)
    h = FakeHttp({"/V?": ok, "/LIN?": RuntimeError("boom"), "%5EGSPC": ok})
    doc = jobs.job_quotes(h, tmp_path, ["V", "LIN"], now=1760000600)
    assert doc["quotes"]["V"]["price"] == 102.0 and "LIN" not in doc["quotes"]
    assert (tmp_path / "intraday" / "V.json").exists()
    # second run: V fails now, previous value kept and flagged stale
    h2 = FakeHttp({"/V?": RuntimeError("down"), "/LIN?": ok})
    doc2 = jobs.job_quotes(h2, tmp_path, ["V", "LIN"], now=1760000900)
    assert doc2["quotes"]["V"]["stale"] is True and doc2["quotes"]["LIN"]["price"] == 102.0
    assert _json.loads((tmp_path / "health.json").read_text())["quotes"]["ok"] is True


def test_job_history_falls_back_to_stooq(tmp_path):
    from pipeline import jobs
    csv = "Date,Open,High,Low,Close,Volume\n" + "\n".join(f"2026-{1 + i // 28:02d}-{1 + i % 28:02d},1,2,0.5,{10 + i},100" for i in range(60))
    y = FakeHttp({"/V?": RuntimeError("blocked")})
    s = FakeHttp({"v.us": csv})
    n = jobs.job_history(y, s, tmp_path, ["V"], now=1760000600)
    doc = _json.loads((tmp_path / "history" / "V.json").read_text())
    assert n == 1 and doc["source"] == "stooq" and doc["stats"]["close"] == 69


def test_job_fundamentals_sec_with_yf_fill(tmp_path):
    from pipeline import jobs
    sec_http = FakeHttp({"CIK0000000001": facts_company()})
    yf = lambda s: ({"annual": {}, "quarterly": {"2026-06-30": {"op_income": 31.0}}}, {"sector": "Tech"}, [], [])
    n = jobs.job_fundamentals(sec_http, yf, tmp_path, ["ABC"], now=1760000600, ciks={"ABC": "0000000001"})
    d = _json.loads((tmp_path / "fundamentals" / "ABC.json").read_text())
    assert n == 1 and d["profile"]["sector"] == "Tech" and any("filled" in s for s in d["sources"])
    assert d["quarterly"]["rows"]["op_income"][-1] == 31.0


def test_job_fundamentals_falls_back_to_yf_when_sec_empty(tmp_path):
    from pipeline import jobs
    sec_http = FakeHttp({"CIK0000000002": {"facts": {"us-gaap": {}}}})
    yfq = {f"2025-{m:02d}-28": {"revenue": 10.0, "net_income": 2.0} for m in (3, 6, 9, 12)}
    yf = lambda s: ({"annual": {"2025-12-31": {"revenue": 40.0}}, "quarterly": yfq}, {}, [], [])
    n = jobs.job_fundamentals(sec_http, yf, tmp_path, ["NEW"], now=1760000600, ciks={"NEW": "0000000002"})
    d = _json.loads((tmp_path / "fundamentals" / "NEW.json").read_text())
    assert n == 1 and d["ttm"]["revenue"] == 40.0 and "SEC history unavailable" in d["sources"][0]


def test_job_filings_detects_new_filing_once(tmp_path):
    from pipeline import jobs
    sub = {"filings": {"recent": {"form": ["10-Q"], "filingDate": ["2026-08-01"], "reportDate": ["2026-06-30"], "accessionNumber": ["acc1"]}}}
    h = FakeHttp({"submissions/CIK0000000001": sub, "companyfacts/CIK0000000001": facts_company()})
    ch = jobs.job_filings(h, tmp_path, ["ABC"], now=1, ciks={"ABC": "0000000001"}, bases={"ABC": "2026-03-31"})
    assert ch == ["ABC"]
    f = _json.loads((tmp_path / "filings.json").read_text())["filings"]["ABC"]
    assert f["accession"] == "acc1" and f["rev_ratio"] > 1
    n_calls = len(h.calls)
    ch2 = jobs.job_filings(h, tmp_path, ["ABC"], now=2, ciks={"ABC": "0000000001"}, bases={"ABC": "2026-03-31"})
    assert ch2 == [] and len(h.calls) == n_calls + 1  # only the submissions feed is re-read


def test_job_news_prefers_yfinance_then_rss(tmp_path):
    from pipeline import jobs
    yf = lambda s: ({}, {}, [{"title": "X", "link": "https://x.test/" + s, "publisher": "P", "providerPublishTime": 1760000000}] if s == "V" else [], [])
    rss = FakeHttp({"s=LIN": "<rss><channel><item><title>Y</title><link>https://x.test/y</link></item></channel></rss>"})
    m = jobs.job_news(yf, rss, tmp_path, ["V", "LIN"], now=1760000600)
    assert {x["title"] for x in m} == {"X", "Y"}


def test_quotes_fall_back_to_stooq_when_yahoo_refuses(tmp_path):
    from pipeline import jobs
    class Refuse:
        def json(self, url):
            raise RuntimeError("429")

    class Stooq:
        def text(self, url):
            return "Date,Open,High,Low,Close,Volume\n2026-10-13,10,11,9,10,100\n2026-10-14,10,12,9,11,200"

    doc = jobs.job_quotes(Refuse(), tmp_path, ["V"], 1760000000, Stooq())
    q = doc["quotes"]["V"]
    assert q["provider"] == "stooq" and q["price"] == 11 and round(q["pct"], 1) == 10.0 and q["state"] == "CLOSED"
