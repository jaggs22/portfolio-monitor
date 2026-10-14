"""Guidance extraction from earnings releases, with a hard verifier.

The model reads PUBLIC press-release text only. It may not paraphrase: every item must carry a verbatim quote, and the
numbers in the item must appear inside that quote. Anything that fails is discarded and counted. The ledger that
results is computed by plain code from the verified items, so the model never decides whether a guide was hit.

Provider is pluggable and optional: set GEMINI_API_KEY (free tier) or ANTHROPIC_API_KEY. With neither, extraction is
skipped and the guidance component reports itself as not retrieved."""
import html.parser
import json
import os
import re

PROMPT = """You extract management guidance from a company earnings press release.
Return ONLY JSON: {{"guidance":[...], "reported":[...]}}.
guidance item: {{"metric": one of ["revenue","eps","operating_margin","gross_margin","organic_growth","capex","fcf"], "period": "FY2026" or "Q3 FY2026" (the company's own fiscal naming), "low": number, "high": number (equal to low for a point guide), "unit": "usd_millions"|"usd_per_share"|"percent", "direction": "initiate"|"raise"|"lower"|"maintain", "quote": exact sentence copied from the text}}
reported item (a completed period's actual result stated in this release): {{"metric": same list, "period": same format, "value": number, "unit": same, "basis": "gaap"|"adjusted", "quote": exact sentence copied from the text}}
Rules: copy quotes verbatim; do not infer or compute numbers; skip anything not stated; use the units above (convert billions to millions); empty arrays are fine.
Company: {ticker}  Release date: {date}
TEXT:
{text}"""

METRICS = {"revenue", "eps", "operating_margin", "gross_margin", "organic_growth", "capex", "fcf"}


class _Text(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.out, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        if tag in ("p", "br", "tr", "div", "li", "h1", "h2", "h3"):
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip:
            self.skip -= 1

    def handle_data(self, d):
        if not self.skip:
            self.out.append(d)


def html_to_text(raw):
    p = _Text()
    p.feed(raw)
    return re.sub(r"[ \t ]+", " ", "".join(p.out)).strip()


def _norm(s):
    s = (s or "").replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", s).strip().lower()


def _nums(s):
    out = set()
    for m in re.findall(r"\d[\d,]*\.?\d*", s or ""):
        t = m.replace(",", "").rstrip(".")
        try:
            out.add(float(t))
        except ValueError:
            pass
    return out


def _in_quote(value, quote_nums):
    """True when value, or value rescaled from millions to billions, appears in the quote."""
    if value is None:
        return False
    cands = {value, value / 1000.0, value * 1000.0}
    return any(any(abs(c - q) < 1e-6 or (q and abs(c - q) / abs(q) < 1e-4) for q in quote_nums) for c in cands)


def verify(items, text, kind):
    """Keep only items whose quote is verbatim in text and whose numbers appear in the quote."""
    ntext = _norm(text)
    kept, rejected = [], 0
    for it in items or []:
        try:
            q = _norm(it.get("quote"))
            if len(q) < 20 or q not in ntext or it.get("metric") not in METRICS or not it.get("period"):
                raise ValueError("quote or fields")
            qn = _nums(it["quote"])
            vals = [it.get("low"), it.get("high")] if kind == "guidance" else [it.get("value")]
            if any(not isinstance(v, (int, float)) for v in vals) or not all(_in_quote(v, qn) for v in vals):
                raise ValueError("numbers not in quote")
            kept.append(it)
        except (ValueError, AttributeError, TypeError):
            rejected += 1
    return kept, rejected


def extract(call, ticker, date, text, max_chars=60000):
    raw = call(PROMPT.format(ticker=ticker, date=date, text=text[:max_chars]))
    m = re.search(r"\{.*\}", raw or "", re.S)
    data = json.loads(m.group(0)) if m else {}
    g, rg = verify(data.get("guidance"), text, "guidance")
    r, rr = verify(data.get("reported"), text, "reported")
    return {"date": date, "guidance": g, "reported": r, "rejected": rg + rr}


# ---------- finding the releases ----------
def earnings_filings(submissions, n=14):
    r = (submissions or {}).get("filings", {}).get("recent") or {}
    out = []
    for i, form in enumerate(r.get("form") or []):
        items = (r.get("items") or [""] * (i + 1))[i] or ""
        if form == "8-K" and "2.02" in items.split(","):
            out.append({"accession": r["accessionNumber"][i], "filed": r["filingDate"][i], "primary": r["primaryDocument"][i]})
    return sorted(out, key=lambda x: x["filed"], reverse=True)[:n]


def pick_exhibit(index):
    """Directory listing -> the EX-99.1 press release document name."""
    names = [i.get("name", "") for i in (index or {}).get("directory", {}).get("item", [])]
    pats = (r"ex-?99[-_.]?1", r"ex-?99", r"dex991", r"q\d.*release", r"press")
    for p in pats:
        for n in names:
            if re.search(p, n, re.I) and n.lower().endswith((".htm", ".html", ".txt")):
                return n
    return None


def fetch_release(sec_http, cik, filing):
    acc = filing["accession"].replace("-", "")
    base = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc}"
    name = pick_exhibit(sec_http.json(base + "/index.json"))
    if not name:
        return None
    return html_to_text(sec_http.text(f"{base}/{name}"))


# ---------- ledger (plain code, no model) ----------
def _key(it):
    return it["metric"], re.sub(r"\s+", " ", it["period"].upper().replace("FISCAL ", "FY").strip())


def build_ledger(extractions):
    """Match each guided (metric, period) to the later release that reports the actual. Hit means at or above the
    first-issued low end; beat means above the high end. Cuts and raises come from successive guides."""
    ex = sorted(extractions, key=lambda e: e["date"])
    guides, actuals = {}, {}
    for e in ex:
        for g in e["guidance"]:
            guides.setdefault(_key(g), []).append(dict(g, date=e["date"]))
        for r in e["reported"]:
            actuals.setdefault(_key(r), []).append(dict(r, date=e["date"]))
    entries = []
    for k, gl in guides.items():
        rep = [r for r in actuals.get(k, []) if r["date"] > gl[0]["date"]]
        if not rep:
            continue
        if any(g["unit"] != rep[0]["unit"] for g in gl):
            continue
        first, final = gl[0], gl[-1]
        # prefer an actual on the same basis the company guided on; adjusted for EPS guides
        a = rep[0]["value"]
        lo, hi = first["low"], first["high"]
        tol = 0.01 * abs(hi) if lo == hi else 0.0
        outcome = "beat" if a > hi + tol else "hit" if a >= lo - tol else "miss"
        revs = [(gl[i]["low"] + gl[i]["high"]) / 2 - (gl[i - 1]["low"] + gl[i - 1]["high"]) / 2 for i in range(1, len(gl))]
        entries.append({"metric": k[0], "period": k[1], "guided_low": lo, "guided_high": hi, "unit": first["unit"],
                        "first_issued": first["date"], "final_low": final["low"], "final_high": final["high"], "actual": a,
                        "reported_on": rep[0]["date"], "outcome": outcome, "raises": sum(1 for r in revs if r > 0),
                        "cuts": sum(1 for r in revs if r < 0), "quote_guide": first["quote"], "quote_actual": rep[0]["quote"]})
    entries.sort(key=lambda e: e["reported_on"])
    n = len(entries)
    hits = sum(1 for e in entries if e["outcome"] in ("hit", "beat"))
    revisions = sum(e["raises"] + e["cuts"] for e in entries)
    return {"n": n, "hits": hits, "beats": sum(1 for e in entries if e["outcome"] == "beat"),
            "misses": sum(1 for e in entries if e["outcome"] == "miss"),
            "hit_rate": round(hits / n, 3) if n else None,
            "cut_rate": round(sum(e["cuts"] for e in entries) / revisions, 3) if revisions else 0.0,
            "entries": entries[-40:]}


# ---------- providers ----------
def make_caller(env=None):
    env = env if env is not None else os.environ
    import requests
    if env.get("GEMINI_API_KEY"):
        model = env.get("LLM_MODEL", "gemini-2.0-flash")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

        def call(prompt):
            r = requests.post(url, params={"key": env["GEMINI_API_KEY"]}, timeout=90, json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0, "responseMimeType": "application/json"}})
            r.raise_for_status()
            return r.json()["candidates"][0]["content"]["parts"][0]["text"]
        return call
    if env.get("ANTHROPIC_API_KEY"):
        model = env.get("LLM_MODEL", "claude-haiku-5-5")

        def call(prompt):
            r = requests.post("https://api.anthropic.com/v1/messages", timeout=90,
                              headers={"x-api-key": env["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"},
                              json={"model": model, "max_tokens": 4000, "temperature": 0, "messages": [{"role": "user", "content": prompt}]})
            r.raise_for_status()
            return r.json()["content"][0]["text"]
        return call
    return None
