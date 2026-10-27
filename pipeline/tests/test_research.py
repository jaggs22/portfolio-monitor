"""Offline tests for the peer table and the XBRL segment parser."""
import datetime as dt

from pipeline import peers as P, segments as S

B = 1e9


def _q(rev, ebitda, ni, cfo, capex, op, tax=20, pre=100):
    return {"revenue": rev, "ebitda": ebitda, "net_income": ni, "cfo": cfo, "capex": capex, "op_income": op, "tax": tax, "pretax": pre,
            "total_debt": 20 * B, "cash": 5 * B, "equity": 40 * B}


def test_ltm_sums_four_quarters_and_uses_latest_balance():
    qs = [(f"2026-0{i}-30", _q(10 * B, 3 * B, 2 * B, 2.5 * B, -1 * B, 2.6 * B)) for i in (6, 3)] + \
         [(f"2025-{m}-30", _q(10 * B, 3 * B, 2 * B, 2.5 * B, -1 * B, 2.6 * B)) for m in ("12", "09")]
    v, basis = P.ltm(qs)
    assert v["revenue"] == 40 * B and basis["revenue"] == "LTM"
    assert v["capex"] == -4 * B and v["total_debt"] == 20 * B


def test_ntm_factor_weights_current_and_next_year():
    rf, ef = P.ntm_factors(0.10, 0.08, 0.12, 0.10, 0.25)
    assert abs(rf - (0.25 * 1.10 + 0.75 * 1.10 * 1.08)) < 1e-9
    assert abs(ef - (0.25 * 1.12 + 0.75 * 1.12 * 1.10)) < 1e-9


def test_build_row_multiples_and_currency():
    q = [(e, _q(10 * B, 3 * B, 2 * B, 2.5 * B, -1 * B, 2.6 * B, 0.5 * B, 2.5 * B)) for e in ("2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30")]
    a = [("2025-12-31", {"revenue": 38 * B, "net_income": 7.5 * B})]
    fy_end = int(dt.datetime(2025, 12, 31, tzinfo=dt.timezone.utc).timestamp())
    info = {"marketCap": 200 * B, "currency": "USD", "financialCurrency": "DKK", "lastFiscalYearEnd": fy_end, "currentPrice": 40.0}
    # quote currency USD, reporting DKK: 1 USD = 6.5 DKK; 1 DKK = 1/6.5 USD
    row = P.build_row("NVO", info, q, a, {"rev_g0": 0.10, "rev_g1": 0.10, "eps0": 2.0, "eps1": 2.2}, 6.5, 1 / 6.5, today=dt.date(2026, 9, 30))
    mcap_dkk = 200 * B * 6.5
    ev_dkk = mcap_dkk + 15 * B
    assert row["ltm"]["ev_ebitda"] == round(ev_dkk / (12 * B), 2)
    assert row["ltm"]["pe"] == round(mcap_dkk / (8 * B), 2)
    frac = (dt.date(2026, 12, 31) - dt.date(2026, 9, 30)).days / 365
    assert row["ntm"]["pe"] == round(40.0 / (frac * 2.0 + (1 - frac) * 2.2), 2)
    assert row["ltm"]["ev_fcf"] == round(ev_dkk / (6 * B), 2)
    assert abs(row["mcap_usd_b"] - 200) < 0.01
    assert row["ntm"]["ev_ebitda"] < row["ltm"]["ev_ebitda"]  # growth lowers the forward multiple
    assert 0 < row["roic"] < 1


def test_frac_zero_when_current_year_has_ended():
    last = int(dt.datetime(2025, 9, 30, tzinfo=dt.timezone.utc).timestamp())
    frac, _ = P.frac_of_year_left(last, dt.date(2026, 10, 27))
    assert frac == 0.0


def test_lender_has_no_ev_multiples():
    q = [(e, _q(10 * B, 3 * B, 2 * B, 2.5 * B, -1 * B, 2.6 * B)) for e in ("2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30")]
    row = P.build_row("AXP", {"marketCap": 200 * B}, q, [], {}, 1.0, 1.0)
    assert row["ltm"]["ev_ebitda"] is None and row["ltm"]["pe"] is not None and row["ev_usd_b"] is None


def test_summary_median_excludes_subject_and_optional():
    rows = [{"ticker": t, "ltm": {"ev_ebitda": x, "pe": None, "ev_ocf": None, "ev_fcf": None}, "ntm": {"ev_ebitda": None, "pe": None, "ev_ocf": None, "ev_fcf": None}}
            for t, x in (("LIN", 20.0), ("A", 10.0), ("B", 14.0), ("C", 30.0))]
    s = P.summarise(rows, "LIN", {"A", "B"})
    assert s["ltm_ev_ebitda"]["median"] == 12.0 and s["ltm_ev_ebitda"]["n"] == 2
    assert abs(s["ltm_ev_ebitda"]["premium"] - (20 / 12 - 1)) < 1e-3


XML = """<?xml version="1.0"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi"
 xmlns:us-gaap="http://fasb.org/us-gaap/2024" xmlns:lin="http://linde.com/2026" xmlns:iso4217="http://www.xbrl.org/2003/iso4217">
 <xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
 <xbrli:context id="t"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2026-04-01</xbrli:startDate><xbrli:endDate>2026-06-30</xbrli:endDate></xbrli:period></xbrli:context>
 <xbrli:context id="a"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">lin:AmericasSegmentMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2026-04-01</xbrli:startDate><xbrli:endDate>2026-06-30</xbrli:endDate></xbrli:period></xbrli:context>
 <xbrli:context id="e"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">lin:EMEASegmentMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2026-04-01</xbrli:startDate><xbrli:endDate>2026-06-30</xbrli:endDate></xbrli:period></xbrli:context>
 <xbrli:context id="a0"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">lin:AmericasSegmentMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2025-06-30</xbrli:endDate></xbrli:period></xbrli:context>
 <xbrli:context id="e0"><xbrli:entity><xbrli:identifier scheme="x">1</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">lin:EMEASegmentMember</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2025-06-30</xbrli:endDate></xbrli:period></xbrli:context>
 <us-gaap:Revenues contextRef="t" unitRef="usd" decimals="-6">9000000000</us-gaap:Revenues>
 <us-gaap:Revenues contextRef="a" unitRef="usd" decimals="-6">4000000000</us-gaap:Revenues>
 <us-gaap:Revenues contextRef="e" unitRef="usd" decimals="-6">2000000000</us-gaap:Revenues>
 <us-gaap:Revenues contextRef="a0" unitRef="usd" decimals="-6">3800000000</us-gaap:Revenues>
 <us-gaap:Revenues contextRef="e0" unitRef="usd" decimals="-6">1900000000</us-gaap:Revenues>
 <us-gaap:OperatingIncomeLoss contextRef="a" unitRef="usd" decimals="-6">1200000000</us-gaap:OperatingIncomeLoss>
 <us-gaap:OperatingIncomeLoss contextRef="e" unitRef="usd" decimals="-6">700000000</us-gaap:OperatingIncomeLoss>
 <us-gaap:OperatingIncomeLoss contextRef="a0" unitRef="usd" decimals="-6">1150000000</us-gaap:OperatingIncomeLoss>
 <us-gaap:DepreciationDepletionAndAmortization contextRef="a" unitRef="usd" decimals="-6">400000000</us-gaap:DepreciationDepletionAndAmortization>
 <us-gaap:DepreciationDepletionAndAmortization contextRef="e" unitRef="usd" decimals="-6">200000000</us-gaap:DepreciationDepletionAndAmortization>
</xbrli:xbrl>"""


def test_parse_and_view():
    facts = S.parse_instance(XML)
    assert len(facts) == 10
    v = S.build_views(facts)[0]
    assert v["kind"] == "segment" and v["total_revenue"] == 9000.0
    am = v["rows"][0]
    assert am["name"] == "Americas" and am["share"] == round(4 / 9, 4)
    assert am["growth"] == round(4 / 3.8 - 1, 4) and am["margin"] == 0.3 and am["ebitda"] == 1600.0
    assert v["rows"][1]["name"] == "EMEA"


def test_humanize():
    assert S.humanize("lly:MounjaroMember") == "Mounjaro"
    assert S.humanize("v:DataProcessingRevenuesMember") == "Data Processing Revenues"
    assert S.humanize("country:US") == "US"
