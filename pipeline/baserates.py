"""Base rates: how fast US-listed companies actually grew revenue, and how far their net margin moved, over 3, 5 and
10 years, by size. Built from SEC XBRL "frames" (one annual value per company per calendar year, every filer).

Why: a forecast is easier to judge against history. "Our base case grows revenue 18% a year for three years" means more
once you know that only about one large company in eight has done that (Mauboussin's base-rate approach).

Caveats, carried into the output so the app can show them:
- Survivorship: a company needs a value at both ends of a window, so firms that failed or were acquired drop out and
  growth is biased upward.
- Acquisitions count as growth; revenue tag changes (ASC 606 in 2018) can create jumps for some filers.
- Windows from different start years overlap, so observations are not independent.
"""
import math

FRAMES = "https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/USD/CY{year}.json"
# Priority order: the first tag a company reports for a year is its revenue that year.
REV_TAGS = [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueGoodsNet",
]
NI_TAG = "NetIncomeLoss"
HORIZONS = (3, 5, 10)
SIZE = [("Under $1B", 0, 1), ("$1B to $10B", 1, 10), ("$10B to $50B", 10, 50), ("Over $50B", 50, math.inf)]
MARGIN = [("Loss-making", -math.inf, 0), ("0 to 5%", 0, 5), ("5 to 10%", 5, 10), ("10 to 20%", 10, 20), ("20 to 30%", 20, 30), ("Over 30%", 30, math.inf)]
PCTS = list(range(0, 101, 5))
MIN_REV = 50e6  # ignore shells and pre-revenue companies at the start of a window


def fetch(http, first_year, last_year):
    """Returns (rev, ni) as {cik: {year: value}} plus a list of errors. One request per tag per year."""
    rev, ni, errors = {}, {}, []
    for year in range(first_year, last_year + 1):
        for tag in REV_TAGS:
            try:
                d = http.json(FRAMES.format(tag=tag, year=year))
            except Exception as e:  # noqa: BLE001  (a tag missing for a year is normal for older tags)
                errors.append(f"{tag} CY{year}: {e}")
                continue
            for row in d.get("data", []):
                c, v = row.get("cik"), row.get("val")
                if c is None or v is None:
                    continue
                rev.setdefault(c, {}).setdefault(year, v)  # keep the higher-priority tag
        try:
            d = http.json(FRAMES.format(tag=NI_TAG, year=year))
            for row in d.get("data", []):
                if row.get("cik") is not None and row.get("val") is not None:
                    ni.setdefault(row["cik"], {})[year] = row["val"]
        except Exception as e:  # noqa: BLE001
            errors.append(f"{NI_TAG} CY{year}: {e}")
    return rev, ni, errors


def pctiles(xs):
    """Values at 0, 5, ... 100th percentiles (linear interpolation)."""
    xs = sorted(xs)
    n = len(xs)
    out = []
    for p in PCTS:
        k = (n - 1) * p / 100
        lo, hi = math.floor(k), math.ceil(k)
        out.append(round(xs[lo] + (xs[hi] - xs[lo]) * (k - lo), 5))
    return out


def bucket(x, table):
    for name, lo, hi in table:
        if lo <= x < hi:
            return name
    return None


def build(rev, ni, first_year, last_year, min_n=40):
    growth, margin = {}, {}
    for h in HORIZONS:
        g = {name: [] for name, _, _ in SIZE}
        gc = {name: set() for name, _, _ in SIZE}
        m = {name: [] for name, _, _ in MARGIN}
        for cik, ys in rev.items():
            for y0 in range(first_year, last_year - h + 1):
                r0, r1 = ys.get(y0), ys.get(y0 + h)
                if r0 is None or r1 is None or r0 < MIN_REV or r1 <= 0:
                    continue
                cagr = (r1 / r0) ** (1 / h) - 1
                b = bucket(r0 / 1e9, SIZE)
                g[b].append(cagr)
                gc[b].add(cik)
                n0, n1 = ni.get(cik, {}).get(y0), ni.get(cik, {}).get(y0 + h)
                if n0 is None or n1 is None:
                    continue
                m0, m1 = n0 / r0 * 100, n1 / r1 * 100
                if abs(m0) > 100 or abs(m1) > 100:  # holding companies, one-offs: not a margin
                    continue
                m[bucket(m0, MARGIN)].append(m1 - m0)
        growth[str(h)] = {k: {"n": len(v), "companies": len(gc[k]), "p": pctiles(v)} for k, v in g.items() if len(v) >= min_n}
        margin[str(h)] = {k: {"n": len(v), "p": pctiles(v)} for k, v in m.items() if len(v) >= min_n}
    return {
        "pcts": PCTS,
        "years": [first_year, last_year],
        "size_buckets": [[n, lo, None if hi == math.inf else hi] for n, lo, hi in SIZE],
        "margin_buckets": [[n, None if lo == -math.inf else lo, None if hi == math.inf else hi] for n, lo, hi in MARGIN],
        "revenue_cagr": growth,
        "net_margin_change_pts": margin,
        "method": "SEC XBRL frames, one annual value per filer per calendar year. Revenue is the first of "
        + ", ".join(REV_TAGS) + " a company reports; net margin is NetIncomeLoss over that revenue. Windows start every "
        f"year from {first_year} and need a value at both ends; companies under ${MIN_REV / 1e6:.0f}M of revenue at the start are excluded. "
        "Size is revenue at the start of the window. Percentiles pool all windows.",
        "caveats": [
            "Survivorship: companies that failed or were acquired drop out, so growth is biased upward.",
            "Acquisitions count as growth, and a change of revenue tag can create a jump for some filers.",
            "Windows overlap, so observations are not independent.",
        ],
    }
