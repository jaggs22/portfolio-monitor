"""Pipeline jobs. Each job is a function of injected clients and an output directory, so tests run offline."""
import datetime as dt
import json
import time
from pathlib import Path

from . import config, history, news as newsmod, sec, yahoo, yf_extra


def write_json(path, obj, compact=True):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":") if compact else None, indent=None if compact else 1, allow_nan=False, default=str))
    tmp.replace(path)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def iso(ts=None):
    return dt.datetime.fromtimestamp(ts or time.time(), dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def record(out, job, ok, errors, count, now=None):
    h = read_json(Path(out) / "health.json", {}) or {}
    h[job] = {"last_run": iso(now), "ok": ok, "count": count, "errors": errors[:20]}
    h["generated_at"] = iso(now)
    write_json(Path(out) / "health.json", h, compact=False)


def job_quotes(http, out, tickers=None, now=None, stooq_http=None):
    tickers = tickers or config.TICKERS
    out = Path(out)
    prev = read_json(out / "quotes.json", {}) or {}
    quotes, markets, errors = dict(prev.get("quotes") or {}), dict(prev.get("markets_by_symbol") or {}), []
    fresh = 0
    for sym in tickers:
        try:
            parsed = yahoo.fetch_chart(http, sym, "1d", "5m")
            q = yahoo.quote_from_chart(parsed, now)
            if not q:
                raise ValueError("no quote in response")
            quotes[sym] = q
            fresh += 1
            write_json(out / "intraday" / f"{sym}.json", {"ticker": sym, "asof": iso(now), "prev_close": q["prev_close"], "bars": [b[:6] for b in parsed["bars"]]})
        except Exception as e:  # noqa: BLE001
            errors.append(f"{sym}: {e}")
            q = None
            if stooq_http is not None:  # Yahoo sometimes refuses cloud runners: fall back to Stooq's end-of-day bars
                try:
                    q = yahoo.quote_from_bars(yahoo.stooq_history(stooq_http, sym))
                except Exception as e2:  # noqa: BLE001
                    errors.append(f"{sym} stooq: {e2}")
            if q and not (quotes.get(sym) and quotes[sym].get("provider") == "yahoo" and quotes[sym].get("asof", 0) > q["asof"]):
                quotes[sym] = q
                fresh += 1
            elif sym in quotes:
                quotes[sym]["stale"] = True
    for sym, label in config.MARKET_SYMBOLS.items():
        try:
            parsed = yahoo.fetch_chart(http, sym, "1d", "15m")
            q = yahoo.quote_from_chart(parsed, now)
            if not q:
                raise ValueError("no quote in response")
            markets[sym] = dict(q, label=label, symbol=sym)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{sym}: {e}")
            if sym in markets:
                markets[sym]["stale"] = True
    doc = {"asof": iso(now), "provider": "Yahoo Finance chart feed", "delayed": True, "quotes": quotes,
           "markets": [markets[s] for s in config.MARKET_SYMBOLS if s in markets], "markets_by_symbol": markets}
    write_json(out / "quotes.json", doc)
    record(out, "quotes", fresh > 0, errors, fresh, now)
    return doc


def job_history(http, stooq_http, out, tickers=None, now=None, job="history"):
    tickers = tickers or (config.TICKERS + config.BENCH)
    errors, done = [], 0
    for sym in tickers:
        bars, source = [], "yahoo"
        try:
            bars = yahoo.fetch_chart(http, sym, "5y", "1d")["bars"]
        except Exception as e:  # noqa: BLE001
            errors.append(f"{sym} yahoo: {e}")
        if len(bars) < 30:
            try:
                bars, source = yahoo.stooq_history(stooq_http, sym), "stooq"
            except Exception as e:  # noqa: BLE001
                errors.append(f"{sym} stooq: {e}")
        if len(bars) < 30:
            continue
        doc = history.build_history(bars)
        doc.update({"ticker": sym, "asof": iso(now), "source": source})
        write_json(Path(out) / "history" / f"{sym}.json", doc)
        done += 1
    record(out, job, done > 0, errors, done, now)
    return done


def job_news(yf_fetch, rss_http, out, tickers=None, now=None):
    tickers = tickers or config.TICKERS
    per, errors = {}, []
    for sym in tickers:
        items = []
        try:
            items = newsmod.parse_yf_news(yf_fetch(sym)[2])
        except Exception as e:  # noqa: BLE001
            errors.append(f"{sym} yfinance: {e}")
        if not items:
            try:
                items = newsmod.parse_rss(rss_http.text(f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={sym}&region=US&lang=en-US"))
            except Exception as e:  # noqa: BLE001
                errors.append(f"{sym} rss: {e}")
        per[sym] = items[:12]
        write_json(Path(out) / "news" / f"{sym}.json", {"ticker": sym, "asof": iso(now), "items": per[sym]})
    merged = newsmod.merge(per)
    write_json(Path(out) / "news.json", {"asof": iso(now), "items": merged})
    record(out, "news", bool(merged), errors, len(merged), now)
    return merged


def job_fundamentals(sec_http, yf_fetch, out, tickers=None, now=None, ciks=None):
    tickers = tickers or config.TICKERS
    ciks = ciks or config.ciks()
    errors, done = [], 0
    for sym in tickers:
        stmt, source, notes = None, [], []
        try:
            if sym in ciks:
                facts = sec_http.json(sec.FACTS.format(cik=ciks[sym]))
                stmt = sec.build_statements(facts)
                if not stmt["annual"]["period_ends"] or "revenue" in stmt["meta"]["missing"] and "net_income" in stmt["meta"]["missing"]:
                    stmt = None
                    notes.append("SEC returned no usable history")
                else:
                    source.append("SEC EDGAR XBRL companyfacts")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{sym} sec: {e}")
        yfn, prof = {"annual": {}, "quarterly": {}}, {}
        try:
            yfn, prof, _news, yerrs = yf_fetch(sym)
            errors.extend(f"{sym} yfinance {x}" for x in yerrs)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{sym} yfinance: {e}")
        if stmt:
            n = yf_extra.fill_missing(stmt, yfn)
            if n:
                source.append(f"Yahoo Finance (filled {n} empty cells)")
        elif yfn["annual"] or yfn["quarterly"]:
            stmt = yf_extra.from_yf_only(yfn)
            source.append("Yahoo Finance (SEC history unavailable)")
        if not stmt:
            continue
        doc = {"ticker": sym, "asof": iso(now), "sources": source, "notes": notes, "profile": prof}
        doc.update(stmt)
        write_json(Path(out) / "fundamentals" / f"{sym}.json", doc)
        done += 1
    record(out, "fundamentals", done > 0, errors, done, now)
    return done


def job_filings(sec_http, out, tickers=None, now=None, ciks=None, bases=None):
    """Detect new 10-Q/10-K filings, compute growth ratios, and return the tickers whose filing changed."""
    tickers = tickers or config.TICKERS
    ciks = ciks or config.ciks()
    bases = bases or config.base_period_ends()
    out = Path(out)
    state = read_json(out / "filings.json", {}) or {}
    filings = dict(state.get("filings") or {})
    errors, changed = [], []
    for sym in tickers:
        if sym not in ciks or sym not in bases:
            continue
        try:
            latest = sec.latest_periodic(sec_http.json(sec.SUBMISSIONS.format(cik=ciks[sym])))
            known = filings.get(sym)
            if latest and latest["period"] > bases[sym] and (not known or known.get("accession") != latest["accession"]):
                f = sec.build_filing(sec_http.json(sec.FACTS.format(cik=ciks[sym])), latest, bases[sym])
                if f:
                    filings[sym] = f
                    changed.append(sym)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{sym}: {e}")
    write_json(out / "filings.json", {"generated_at": iso(now), "source": "SEC EDGAR", "filings": filings}, compact=False)
    record(out, "filings", not errors or bool(filings), errors, len(changed), now)
    return changed


def job_evidence(out, research_dir=None, tickers=None, now=None):
    """Recompute tripwire readings, statistical driver checks and review flags from what the other jobs published."""
    from . import evidence
    out, research_dir = Path(out), Path(research_dir or config.RESEARCH_DIR)
    tickers = [t for t in (tickers or config.TICKERS) if (research_dir / f"{t}.json").exists()]
    filings = (read_json(out / "filings.json", {}) or {}).get("filings", {})
    quotes = (read_json(out / "quotes.json", {}) or {}).get("quotes", {})
    errors, done = [], 0
    for sym in tickers:
        try:
            research = read_json(research_dir / f"{sym}.json")
            stmts = read_json(out / "fundamentals" / f"{sym}.json")
            if not stmts:
                errors.append(f"{sym}: no statements yet")
                continue
            bars = (read_json(out / "history" / f"{sym}.json", {}) or {}).get("bars") or []
            price = (quotes.get(sym) or {}).get("price")
            write_json(out / "evidence" / f"{sym}.json", evidence.build_evidence(sym, research, stmts, bars, filings.get(sym), price, now or time.time()))
            done += 1
        except Exception as e:  # noqa: BLE001
            errors.append(f"{sym}: {e}")
    record(out, "evidence", done > 0, errors, done, now)
    return done


def job_mgmt(sec_http, yf_mgmt, llm_call, out, tickers=None, now=None, ciks=None, max_new_releases=3):
    """Management quality. Releases are parsed incrementally: only 8-K earnings releases not already in the cache are
    sent for extraction, so the free-tier model sees a few documents a day at most."""
    from . import llm, mgmt
    tickers = tickers or config.TICKERS
    ciks = ciks or config.ciks()
    out = Path(out)
    errors, done = [], 0
    cache = read_json(out / "mgmt_cache.json", {}) or {}
    for sym in tickers:
        yfm = {}
        try:
            yfm, errs = yf_mgmt(sym)
            errors.extend(f"{sym} yfinance {x}" for x in errs)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{sym} yfinance: {e}")
        ex = cache.setdefault(sym, {})
        if llm_call and sec_http and sym in ciks:
            try:
                subs = sec_http.json(sec.SUBMISSIONS.format(cik=ciks[sym]))
                new = 0
                for f in llm.earnings_filings(subs):
                    if f["accession"] in ex or new >= max_new_releases:
                        continue
                    text = llm.fetch_release(sec_http, ciks[sym], f)
                    new += 1
                    if not text:
                        ex[f["accession"]] = {"date": f["filed"], "guidance": [], "reported": [], "rejected": 0, "note": "no exhibit found"}
                        continue
                    ex[f["accession"]] = llm.extract(llm_call, sym, f["filed"], text)
            except Exception as e:  # noqa: BLE001
                errors.append(f"{sym} releases: {e}")
        ledger = llm.build_ledger(list(ex.values())) if ex else None
        stmts = read_json(out / "fundamentals" / f"{sym}.json")
        if not stmts and not yfm:
            continue
        doc = mgmt.build_mgmt(sym, stmts or {}, yfm, ledger if ledger and ledger["n"] else None, iso(now))
        doc["releases_parsed"] = len(ex)
        doc["llm"] = bool(llm_call)
        write_json(out / "mgmt" / f"{sym}.json", doc)
        done += 1
    write_json(out / "mgmt_cache.json", cache)
    record(out, "mgmt", done > 0, errors, done, now)
    return done


# ---------- peers and segments (core names) ----------
CORE = ["LIN", "LLY", "V"]


def job_peers(peer_fetch, out, tickers=None, now=None):
    """Peer valuation table per core name. peer_fetch(ticker) -> (row, errors). Each distinct ticker is fetched once."""
    from . import peers as P
    subjects = [t for t in (tickers or CORE) if t in P.PEERS]
    errors, cache, done = [], {}, 0
    prev = {t: read_json(Path(out) / "peers" / f"{t}.json", {}) or {} for t in subjects}
    for sub in subjects:
        cfg = P.PEERS[sub]
        rows = []
        for tk in [sub] + cfg["default"] + cfg["optional"]:
            if tk not in cache:
                try:
                    row, errs = peer_fetch(tk)
                    errors.extend(errs)
                except Exception as e:  # noqa: BLE001
                    row = None
                    errors.append(f"{tk}: {e}")
                if row is None:  # keep the last good row rather than drop the peer
                    old = next((r for r in prev[sub].get("rows", []) if r["ticker"] == tk), None)
                    if old:
                        row = dict(old, stale=True)
                cache[tk] = row
            if cache[tk]:
                rows.append(dict(cache[tk], role="subject" if tk == sub else "default" if tk in cfg["default"] else "optional"))
        if not rows:
            continue
        doc = {"ticker": sub, "asof": iso(now), "source": "Yahoo Finance via yfinance (statements, consensus estimates, FX)",
               "why": cfg["why"], "method": P.__doc__.split("Method, stated in the output so the app can show it:")[1].split("Pure functions")[0].strip(),
               "rows": rows, "summary": P.summarise(rows, sub, set(cfg["default"]))}
        write_json(Path(out) / "peers" / f"{sub}.json", doc)
        done += 1
    record(out, "peers", done > 0, errors, done, now)
    return done


def job_segments(sec_http, out, tickers=None, now=None, ciks=None):
    """Segment and revenue-mix views from each core name's latest 10-Q and 10-K, plus the plain-text MD&A and the
    latest earnings release saved under raw/ so the written analysis can be checked against the source."""
    from . import segments as S, llm
    ciks = ciks or config.ciks()
    errors, done = [], 0
    for sym in [t for t in (tickers or CORE) if t in CORE]:
        if sym not in ciks:
            continue
        try:
            subs = sec_http.json(sec.SUBMISSIONS.format(cik=ciks[sym]))
        except Exception as e:  # noqa: BLE001
            errors.append(f"{sym} submissions: {e}")
            continue
        res, errs = S.fetch_segments(sec_http, ciks[sym], subs)
        errors.extend(f"{sym} {x}" for x in errs)
        if res["quarterly"] or res["annual"]:
            write_json(Path(out) / "segments" / f"{sym}.json", dict(ticker=sym, asof=iso(now), source="SEC EDGAR XBRL instance (dimensional facts)", **res))
            done += 1
        # source text for the analysis
        lf = S.latest_filings(subs)
        f = max(lf.values(), key=lambda x: x["filed"]) if lf else None
        if f:
            try:
                acc = f["accession"].replace("-", "")
                html = sec_http.text(f"https://www.sec.gov/Archives/edgar/data/{int(ciks[sym])}/{acc}/{f['primary']}")
                (Path(out) / "raw").mkdir(parents=True, exist_ok=True)
                (Path(out) / "raw" / f"{sym}_mdna.txt").write_text(f"{f['form']} for period {f['period']}, filed {f['filed']}\n\n" + S.mdna_text(html))
            except Exception as e:  # noqa: BLE001
                errors.append(f"{sym} mdna: {e}")
        rel = llm.earnings_filings(subs, n=1)
        if rel:
            try:
                txt = llm.fetch_release(sec_http, ciks[sym], rel[0])
                if txt:
                    (Path(out) / "raw" / f"{sym}_release.txt").write_text(f"8-K earnings release filed {rel[0]['filed']}\n\n" + txt[:150000])
            except Exception as e:  # noqa: BLE001
                errors.append(f"{sym} release: {e}")
    record(out, "segments", done > 0, errors, done, now)
    return done
