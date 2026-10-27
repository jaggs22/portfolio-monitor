"""Segment and revenue-mix data straight from the company's latest 10-Q and 10-K XBRL.

SEC's companyfacts API drops dimensional facts, so segment sales, segment profit and product revenue are only in the
filing's own XBRL instance. This module finds the instance in the filing directory, reads every monetary fact that sits
on one reporting axis (business segment, product or service, geography), and builds a simple view per axis:
latest period versus the same period a year earlier, with growth, share of total, profit, margin and EBITDA where the
company discloses segment depreciation.

Nothing is estimated here. A line the company does not tag is left out, and the view says which concept it used.
Parsing is pure (text in, dicts out); only fetch_* functions touch the network.
"""
import datetime as dt
import re
import xml.etree.ElementTree as ET

AXES = {
    "StatementBusinessSegmentsAxis": "segment",
    "ProductOrServiceAxis": "product",
    "StatementGeographicalAxis": "geography",
    "SegmentGeographicalAxis": "geography",
}
REVENUE = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax",
           "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet", "SalesRevenueGoodsNet"]
PROFIT = ["OperatingIncomeLoss", "SegmentReportingInformationOperatingIncomeLoss"]
DA = ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "CostDepreciationAmortizationAndDepletion",
      "DepreciationAmortizationAndAccretionNet"]
CUSTOM_REV = re.compile(r"^(Net)?(Sales|Revenues?)(Net)?$", re.I)
CUSTOM_PROFIT = re.compile(r"(Segment)?Operating(Profit|Income)(Loss)?$", re.I)
NS = {"xbrli": "http://www.xbrl.org/2003/instance", "xbrldi": "http://xbrl.org/2006/xbrldi"}


def humanize(qname):
    """'lin:AmericasSegmentMember' -> 'Americas'; 'lly:MounjaroMember' -> 'Mounjaro'."""
    name = qname.split(":")[-1]
    name = re.sub(r"(Segment)?Member$", "", name)
    name = re.sub(r"Segment$", "", name)
    words = re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", " ", name).strip()
    fixes = {"Emea": "EMEA", "Apac": "APAC", "Us": "US", "U S": "US", "Non U S": "Outside US", "Non US": "Outside US"}
    for a, b in fixes.items():
        words = re.sub(rf"\b{a}\b", b, words)
    return words


def parse_instance(xml_text):
    """XBRL instance -> list of facts {concept, ns, dims: {axis: member}, start, end, value}. Monetary duration facts only."""
    root = ET.fromstring(xml_text.encode("utf-8") if isinstance(xml_text, str) else xml_text)
    contexts = {}
    for c in root.findall("xbrli:context", NS):
        cid = c.get("id")
        per = c.find("xbrli:period", NS)
        s, e = per.find("xbrli:startDate", NS), per.find("xbrli:endDate", NS)
        if s is None or e is None:
            continue
        dims = {}
        seg = c.find("xbrli:entity/xbrli:segment", NS)
        if seg is not None:
            for m in seg:
                tag = m.tag.split("}")[-1]
                if tag != "explicitMember":
                    dims = None  # typed dimensions: skip the context
                    break
                dims[m.get("dimension").split(":")[-1]] = m.text.strip()
        if dims is None:
            continue
        contexts[cid] = {"start": s.text.strip(), "end": e.text.strip(), "dims": dims}
    units = {}
    for u in root.findall("xbrli:unit", NS):
        meas = [x.text for x in u.iter() if x.tag.endswith("measure") and x.text]
        units[u.get("id")] = meas
    facts = []
    for el in root:
        ref = el.get("contextRef")
        if not ref or ref not in contexts:
            continue
        unit = units.get(el.get("unitRef"), [])
        if not any(m.lower().endswith("usd") for m in unit) or len(unit) != 1:
            continue
        try:
            v = float(el.text)
        except (TypeError, ValueError):
            continue
        ns, concept = el.tag[1:].split("}") if el.tag.startswith("{") else ("", el.tag)
        ctx = contexts[ref]
        facts.append({"concept": concept, "ns": ns, "dims": _clean(ctx["dims"]), "raw_dims": ctx["dims"], "start": ctx["start"], "end": ctx["end"], "value": v})
    return facts


NEUTRAL = {"ConsolidationItemsAxis": ("OperatingSegmentsMember",), "SegmentReportingInformationAdditionalItemAxis": ()}


def _clean(dims):
    """Drop axes that only say 'this is the operating segment figure' so a segment fact tagged with them still counts."""
    out = {}
    for a, m in dims.items():
        if a in NEUTRAL and (not NEUTRAL[a] or any(m.endswith(x) for x in NEUTRAL[a])):
            continue
        out[a] = m
    return out


def inventory(facts):
    """(concept, axes) -> number of facts; written beside the views to help map new concepts."""
    inv = {}
    for f in facts:
        k = f["concept"] + " | " + ",".join(sorted(f.get("raw_dims", f["dims"])))
        inv[k] = inv.get(k, 0) + 1
    return dict(sorted(inv.items()))


def _days(f):
    return (dt.date.fromisoformat(f["end"]) - dt.date.fromisoformat(f["start"])).days


def _pick_concept(facts, preferred, custom_re, axis):
    have = {}
    for f in facts:
        if list(f["dims"]) == [axis]:
            have.setdefault(f["concept"], set()).add(f["dims"][axis])
    for c in preferred:
        if len(have.get(c, ())) >= 2:
            return c
    if custom_re:
        cands = sorted((c for c in have if custom_re.search(c) and len(have[c]) >= 2), key=lambda c: -len(have[c]))
        if cands:
            return cands[0]
    return None


def _periods(facts, concept, axis, days_lo, days_hi):
    """Distinct (start, end) windows of the given length for this concept on this axis, newest first."""
    ps = {(f["start"], f["end"]) for f in facts if f["concept"] == concept and list(f["dims"]) == [axis] and days_lo <= _days(f) <= days_hi}
    return sorted(ps, key=lambda p: p[1], reverse=True)


def _prior(periods, cur):
    """The window about one year before cur."""
    ce = dt.date.fromisoformat(cur[1])
    for p in periods:
        if abs((ce - dt.date.fromisoformat(p[1])).days - 365) <= 10:
            return p
    return None


def _vals(facts, concept, axis, window):
    out = {}
    if not concept:
        return out
    for f in facts:
        if f["concept"] == concept and list(f["dims"]) == [axis] and (f["start"], f["end"]) == window:
            out[f["dims"][axis]] = f["value"]
    return out


def _total(facts, concept, window):
    for f in facts:
        if f["concept"] == concept and not f["dims"] and (f["start"], f["end"]) == window:
            return f["value"]
    return None


def build_views(facts, quarterly=True):
    """One view per axis that has revenue for at least two members. quarterly picks ~3-month windows, else ~12-month."""
    lo, hi = (80, 100) if quarterly else (350, 380)
    axes_present = {a for f in facts for a in f["dims"] if a in AXES}
    views = []
    for axis in sorted(axes_present, key=lambda a: list(AXES).index(a)):
        rc = _pick_concept(facts, REVENUE, CUSTOM_REV, axis)
        if not rc:
            continue
        ps = _periods(facts, rc, axis, lo, hi)
        if not ps:
            continue
        cur = ps[0]
        pri = _prior(ps, cur)
        pc = _pick_concept(facts, PROFIT, CUSTOM_PROFIT, axis)
        dc = _pick_concept(facts, DA, None, axis)
        rev, rev0 = _vals(facts, rc, axis, cur), _vals(facts, rc, axis, pri) if pri else {}
        prof, prof0 = _vals(facts, pc, axis, cur), _vals(facts, pc, axis, pri) if pri and pc else {}
        da = _vals(facts, dc, axis, cur)
        total = _total(facts, rc, cur)
        pos_sum = sum(v for v in rev.values() if v > 0)
        rows = []
        for m, v in sorted(rev.items(), key=lambda kv: -kv[1]):
            p = prof.get(m)
            rows.append({
                "member": m, "name": humanize(m),
                "revenue": round(v / 1e6, 1),
                "revenue_prior": round(rev0[m] / 1e6, 1) if m in rev0 else None,
                "growth": round(v / rev0[m] - 1, 4) if rev0.get(m) and rev0[m] > 0 and v > 0 else None,
                "share": round(v / (total or pos_sum), 4) if v > 0 and (total or pos_sum) else None,
                "profit": round(p / 1e6, 1) if p is not None else None,
                "profit_prior": round(prof0[m] / 1e6, 1) if m in prof0 else None,
                "margin": round(p / v, 4) if p is not None and v > 0 else None,
                "margin_prior": round(prof0[m] / rev0[m], 4) if m in prof0 and rev0.get(m) else None,
                "da": round(da[m] / 1e6, 1) if m in da else None,
                "ebitda": round((p + da[m]) / 1e6, 1) if p is not None and m in da else None,
            })
        views.append({
            "axis": axis, "kind": AXES[axis], "period": {"start": cur[0], "end": cur[1]},
            "prior": {"start": pri[0], "end": pri[1]} if pri else None,
            "concepts": {"revenue": rc, "profit": pc, "da": dc},
            "total_revenue": round(total / 1e6, 1) if total else None,
            "rows": rows,
        })
    return views


# ---------- network ----------
SKIP = re.compile(r"(_cal|_def|_lab|_pre|FilingSummary|MetaLinks)", re.I)


def find_instance(index_json):
    names = [i.get("name", "") for i in (index_json or {}).get("directory", {}).get("item", [])]
    for n in names:
        if n.lower().endswith("_htm.xml"):
            return n
    for n in names:
        if n.lower().endswith(".xml") and not SKIP.search(n):
            return n
    return None


def latest_filings(submissions, forms=("10-Q", "10-K")):
    r = (submissions or {}).get("filings", {}).get("recent") or {}
    out = {}
    for i, f in enumerate(r.get("form") or []):
        if f in forms and f not in out:
            out[f] = {"form": f, "accession": r["accessionNumber"][i], "filed": r["filingDate"][i],
                      "period": r["reportDate"][i], "primary": r["primaryDocument"][i]}
    return out


def fetch_segments(sec_http, cik, submissions):
    """Returns ({quarterly: [...], annual: [...], filings: {...}}, errors)."""
    errors, res = [], {"quarterly": [], "annual": [], "filings": {}}
    lf = latest_filings(submissions)
    for form, key in (("10-Q", "quarterly"), ("10-K", "annual")):
        f = lf.get(form)
        if not f:
            continue
        # a 10-K covers the fourth quarter only as a full year, so a newer 10-K beats an older 10-Q for "latest"
        acc = f["accession"].replace("-", "")
        base = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc}"
        try:
            name = find_instance(sec_http.json(base + "/index.json"))
            if not name:
                errors.append(f"{form}: no XBRL instance in {base}")
                continue
            facts = parse_instance(sec_http.text(f"{base}/{name}"))
            res[key] = build_views(facts, quarterly=(form == "10-Q"))
            res.setdefault("inventory", {})[key] = inventory(facts)
            res["filings"][key] = dict(f, url=f"{base}/{f['primary']}")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{form}: {e}")
    return res, errors


def mdna_text(html_text, max_chars=120000):
    """The MD&A section of a 10-Q or 10-K as plain text (from 'Management's Discussion' to 'Quantitative and
    Qualitative'), so the narrative can be checked against management's own words."""
    from .llm import html_to_text
    txt = html_to_text(html_text)
    heads = [m.start() for m in re.finditer(r"management.{0,3}s discussion and analysis", txt, re.I)]
    start = heads[1] if len(heads) > 1 else (heads[0] if heads else 0)  # the first hit is usually the table of contents
    end_m = re.search(r"quantitative and qualitative disclosures", txt[start + 200:], re.I)
    end = start + 200 + end_m.start() if end_m else start + max_chars
    return txt[start:end][:max_chars]
