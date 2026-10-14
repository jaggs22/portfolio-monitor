"""SEC EDGAR: filing detection and normalized financial statements from XBRL companyfacts.

Statements are rebuilt from the issuer's own filings, so history is long (10 fiscal years, 20 quarters) and
authoritative. Quarterly flow items are derived from cumulative year-to-date facts where the filer reports only
those (cash flow statements always do), and Q4 is full year minus nine months. Derived cells are flagged."""
import datetime as dt

SUBMISSIONS = "https://data.sec.gov/submissions/CIK{cik}.json"
FACTS = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
PERIODIC = {"10-Q", "10-K", "10-K/A", "10-Q/A", "20-F", "40-F"}

# key -> (kind, [us-gaap concepts in priority order], scale)
INCOME = {
    "revenue": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet", "SalesRevenueGoodsNet"],
    "cogs": ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"],
    "gross_profit": ["GrossProfit"],
    "rnd": ["ResearchAndDevelopmentExpense", "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost"],
    "sga": ["SellingGeneralAndAdministrativeExpense"],
    "op_income": ["OperatingIncomeLoss"],
    "interest_expense": ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt"],
    "pretax": ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"],
    "tax": ["IncomeTaxExpenseBenefit"],
    "net_income": ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
    "eps_diluted": ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"],
    "shares_diluted": ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasicAndDiluted"],
}
CASHFLOW = {
    "cfo": ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsForCapitalImprovements"],
    "cfi": ["NetCashProvidedByUsedInInvestingActivities", "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations"],
    "cff": ["NetCashProvidedByUsedInFinancingActivities", "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations"],
    "da": ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "DepreciationAmortizationAndAccretionNet"],
    "sbc": ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"],
    "dividends": ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"],
    "buybacks": ["PaymentsForRepurchaseOfCommonStock"],
}
BALANCE = {
    "cash": ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
    "st_investments": ["MarketableSecuritiesCurrent", "ShortTermInvestments", "AvailableForSaleSecuritiesDebtSecuritiesCurrent"],
    "receivables": ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"],
    "inventory": ["InventoryNet"],
    "current_assets": ["AssetsCurrent"],
    "ppe": ["PropertyPlantAndEquipmentNet", "PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization"],
    "goodwill": ["Goodwill"],
    "intangibles": ["IntangibleAssetsNetExcludingGoodwill", "FiniteLivedIntangibleAssetsNet"],
    "total_assets": ["Assets"],
    "payables": ["AccountsPayableCurrent", "AccountsPayableAndAccruedLiabilitiesCurrent"],
    "current_liabilities": ["LiabilitiesCurrent"],
    "st_debt": ["DebtCurrent", "LongTermDebtCurrent", "ShortTermBorrowings"],
    "lt_debt": ["LongTermDebtNoncurrent", "LongTermDebt", "LongTermDebtAndCapitalLeaseObligations"],
    "total_liabilities": ["Liabilities"],
    "equity": ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
}
PER_SHARE = {"eps_diluted"}
SHARES = {"shares_diluted"}
SECTIONS = {"income": INCOME, "cashflow": CASHFLOW, "balance": BALANCE}


def _d(s):
    return dt.date.fromisoformat(s)


def latest_periodic(submissions):
    r = (submissions or {}).get("filings", {}).get("recent") or {}
    forms = r.get("form") or []
    best = None
    for i, f in enumerate(forms):
        if f not in PERIODIC:
            continue
        cand = {"form": f, "filed": r["filingDate"][i], "period": r["reportDate"][i], "accession": r["accessionNumber"][i]}
        if not cand["period"]:
            continue
        if best is None or cand["filed"] > best["filed"]:
            best = cand
    return best


def _entries(facts, concept, ns="us-gaap"):
    c = (((facts or {}).get("facts") or {}).get(ns) or {}).get(concept)
    if not c:
        return []
    u = c.get("units") or {}
    lst = u.get("USD") or u.get("USD/shares") or u.get("shares") or next(iter(u.values()), [])
    return [x for x in lst if isinstance(x.get("val"), (int, float)) and x.get("end")]


def _latest_by(entries, keyf):
    out = {}
    for e in entries:
        k = keyf(e)
        if k not in out or (e.get("filed") or "") >= (out[k].get("filed") or ""):
            out[k] = e
    return out


def _bucket(days):
    q = days / 91.3
    r = round(q)
    return r if r in (1, 2, 3, 4) and abs(q - r) < 0.3 else None


def flow_series(facts, concepts):
    """Annual and quarterly values for a flow concept, merged across tag changes.
    Returns (annual {end: val}, quarterly {end: (val, derived)})."""
    annual, quarterly = {}, {}
    for concept in concepts:
        es = [e for e in _entries(facts, concept) if e.get("start")]
        if not es:
            continue
        es = list(_latest_by(es, lambda e: (e["start"], e["end"])).values())
        disc, groups = {}, {}
        for e in es:
            days = (_d(e["end"]) - _d(e["start"])).days
            b = _bucket(days)
            if b is None:
                continue
            if b == 1:
                disc[e["end"]] = e["val"]
            # group cumulative facts by fiscal-year start (cluster starts within a week)
            key = None
            for k in groups:
                if abs((_d(k) - _d(e["start"])).days) <= 7:
                    key = k; break
            key = key or e["start"]
            groups.setdefault(key, {})[b] = (e["end"], e["val"])
        c_annual, c_q = {}, {}
        for end, v in disc.items():
            c_q[end] = (v, False)
        for g in groups.values():
            if 4 in g:
                c_annual[g[4][0]] = g[4][1]
            for b in (2, 3, 4):
                if b in g and (b - 1) in g:
                    end, v = g[b][0], g[b][1] - g[b - 1][1]
                    if not any(abs((_d(end) - _d(x)).days) <= 6 for x in c_q):
                        c_q[end] = (v, True)
            # Q1 from the cumulative group when no discrete fact exists
            if 1 in g and not any(abs((_d(g[1][0]) - _d(x)).days) <= 6 for x in c_q):
                c_q[g[1][0]] = (g[1][1], False)
        # Q4 = full year minus the three discrete quarters, when no cumulative nine-month fact was filed
        for end, val in list(c_annual.items()):
            if any(abs((_d(end) - _d(x)).days) <= 6 for x in c_q):
                continue
            inside = [x for x in c_q if 60 < (_d(end) - _d(x)).days < 300]
            if len(inside) == 3:
                c_q[end] = (val - sum(c_q[x][0] for x in inside), True)
        # older tags only fill periods the newer tag did not cover
        for end, v in c_annual.items():
            if not any(abs((_d(end) - _d(x)).days) <= 6 for x in annual):
                annual[end] = v
        for end, v in c_q.items():
            if not any(abs((_d(end) - _d(x)).days) <= 6 for x in quarterly):
                quarterly[end] = v
    return annual, quarterly


def instant_series(facts, concepts):
    out = {}
    for concept in concepts:
        es = [e for e in _entries(facts, concept) if not e.get("start") or (_d(e["end"]) - _d(e["start"])).days == 0]
        for end, e in _latest_by(es, lambda e: e["end"]).items():
            if not any(abs((_d(end) - _d(x)).days) <= 6 for x in out):
                out[end] = e["val"]
    return out


def _scale(key, v):
    if v is None:
        return None
    if key in PER_SHARE:
        return round(v, 4)
    return round(v / 1e6, 3)


def _match(d, end, tol=6):
    for k in d:
        if abs((_d(k) - _d(end)).days) <= tol:
            return k
    return None


def build_statements(facts, max_years=10, max_quarters=20):
    """Normalized statements. Returns {'annual': {...}, 'quarterly': {...}, 'ttm': {...}, 'meta': {...}} in USD millions."""
    flow = {}
    for sec, mapping in (("income", INCOME), ("cashflow", CASHFLOW)):
        for key, concepts in mapping.items():
            flow[key] = flow_series(facts, concepts)
    inst = {key: instant_series(facts, concepts) for key, concepts in BALANCE.items()}

    # period spines: fiscal year ends come from the best income concept; quarter ends from all flows
    a_ends = sorted({e for k in ("revenue", "net_income", "op_income", "cfo") for e in flow[k][0]})
    merged = []
    for e in a_ends:
        if not merged or abs((_d(e) - _d(merged[-1])).days) > 10:
            merged.append(e)
    a_ends = merged[-max_years:]
    q_all = sorted({e for k in ("revenue", "net_income", "op_income", "eps_diluted") for e in flow[k][1]})
    merged = []
    for e in q_all:
        if not merged or abs((_d(e) - _d(merged[-1])).days) > 10:
            merged.append(e)
    q_ends = merged[-max_quarters:]

    def pull(key, ends, which):
        out, derived = [], []
        for end in ends:
            if key in inst:
                m = _match(inst[key], end, 12)
                out.append(_scale(key, inst[key][m]) if m else None); derived.append(False)
            else:
                d = flow[key][which]
                m = _match(d, end, 8)
                if m is None:
                    out.append(None); derived.append(False)
                elif which == 0:
                    out.append(_scale(key, d[m])); derived.append(False)
                else:
                    out.append(_scale(key, d[m][0])); derived.append(bool(d[m][1]))
        return out, derived

    result = {}
    for name, ends, which in (("annual", a_ends, 0), ("quarterly", q_ends, 1)):
        rows, flags = {}, {}
        for key in list(INCOME) + list(CASHFLOW) + list(BALANCE):
            vals, drv = pull(key, ends, which)
            rows[key] = vals
            if any(drv):
                flags[key] = drv
        n = len(ends)
        # derived lines
        def col(k):
            return rows.get(k) or [None] * n
        rows["gross_profit"] = [g if g is not None else (r - c if r is not None and c is not None else None)
                                for g, r, c in zip(col("gross_profit"), col("revenue"), col("cogs"))]
        rows["ebitda"] = [o + d if o is not None and d is not None else None for o, d in zip(col("op_income"), col("da"))]
        rows["total_debt"] = [(s or 0) + (l or 0) if (s is not None or l is not None) else None for s, l in zip(col("st_debt"), col("lt_debt"))]
        rows["net_debt"] = [d - (c or 0) - (i or 0) if d is not None else None for d, c, i in zip(rows["total_debt"], col("cash"), col("st_investments"))]
        rows["fcf"] = [c - x if c is not None and x is not None else None for c, x in zip(col("cfo"), col("capex"))]
        # EPS fallback: net income over diluted shares when the filer reports EPS only by class
        rows["eps_diluted"] = [e if e is not None else (round(n_ / s, 4) if n_ is not None and s else None)
                               for e, n_, s in zip(col("eps_diluted"), col("net_income"), col("shares_diluted"))]
        result[name] = {"period_ends": ends, "rows": rows, "derived": flags}

    # trailing twelve months from the last four quarters (flow lines only)
    ttm = {}
    q = result["quarterly"]
    if len(q["period_ends"]) >= 4:
        for key in list(INCOME) + list(CASHFLOW) + ["gross_profit", "ebitda", "fcf"]:
            if key in SHARES:
                continue
            last4 = q["rows"].get(key, [])[-4:]
            if len(last4) == 4 and all(v is not None for v in last4):
                ttm[key] = round(sum(last4), 4 if key in PER_SHARE else 3)
        sh = [v for v in q["rows"].get("shares_diluted", [])[-1:] if v is not None]
        if sh:
            ttm["shares_diluted"] = sh[0]
    latest = q["period_ends"][-1] if q["period_ends"] else (result["annual"]["period_ends"][-1] if result["annual"]["period_ends"] else None)
    missing = [k for k in ("revenue", "net_income", "op_income", "cfo", "total_assets", "equity") if not any(v is not None for v in result["annual"]["rows"].get(k, []))]
    return {"annual": result["annual"], "quarterly": result["quarterly"], "ttm": ttm,
            "meta": {"latest_period_end": latest, "units": "USD millions; per-share in USD; shares in millions", "missing": missing}}


def build_filing(facts, latest, base_end):
    """Growth ratios (new TTM over TTM at the research base period). Ratios, not absolutes, because EDGAR is GAAP
    and the research baseline uses the company's adjusted figures."""
    if not latest or not latest.get("period") or latest["period"] <= base_end:
        return None
    st = build_statements(facts, 3, 8)
    q = st["quarterly"]
    ends = q["period_ends"]

    def ttm_at(key, end):
        if end not in ends:
            return None
        i = ends.index(end)
        vals = q["rows"].get(key, [])[max(0, i - 3): i + 1]
        return sum(vals) if len(vals) == 4 and all(v is not None for v in vals) else None

    def near_end(target):
        m = _match({e: 1 for e in ends}, target, 12)
        return m

    e_new, e_old = near_end(latest["period"]), near_end(base_end)
    out = {"form": latest["form"], "period": latest["period"], "filed": latest["filed"], "accession": latest["accession"]}
    any_metric = False
    if e_new and e_old:
        for key, name in (("eps_diluted", "eps_ratio"), ("revenue", "rev_ratio")):
            a, b = ttm_at(key, e_new), ttm_at(key, e_old)
            if a is not None and b and b > 0:
                out[name] = round(a / b, 6); any_metric = True
        i_new, i_old = ends.index(e_new), ends.index(e_old)
        s_new, s_old = q["rows"]["shares_diluted"][i_new], q["rows"]["shares_diluted"][i_old]
        if s_new and s_old:
            out["shares_ratio"] = round(s_new / s_old, 6); any_metric = True
    out["metrics"] = any_metric
    return out
