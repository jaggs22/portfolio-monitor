"""Command line entry point: python -m pipeline.run <job> --out out [--tickers V,LIN]"""
import argparse
import sys
import time

from . import config, jobs
from .http import Http
from .yf_extra import fetch_yf, fetch_yf_mgmt
from . import llm


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("job", choices=["quotes", "history", "news", "fundamentals", "filings", "evidence", "mgmt", "peers", "segments", "research", "all"])
    ap.add_argument("--out", default="out")
    ap.add_argument("--tickers", default="")
    a = ap.parse_args(argv)
    tickers = [t for t in a.tickers.split(",") if t] or None
    yahoo = Http(config.YAHOO_UA, pace=0.25)
    stooq = Http(config.YAHOO_UA, pace=0.3)
    sec_http = None
    if a.job in ("fundamentals", "filings", "mgmt", "segments", "research", "all"):
        if not config.SEC_USER_AGENT:
            sys.exit("SEC_USER_AGENT is not set. SEC requires a User-Agent with contact details, e.g. 'Name name@example.com'.")
        sec_http = Http(config.SEC_USER_AGENT, pace=0.2)
    now = time.time()
    if a.job in ("quotes", "all"):
        jobs.job_quotes(yahoo, a.out, tickers, now, stooq)
    if a.job in ("history", "all"):
        jobs.job_history(yahoo, stooq, a.out, tickers, now)
    if a.job in ("news", "all"):
        jobs.job_news(fetch_yf, yahoo, a.out, tickers, now)
    changed = None
    if a.job in ("filings", "all"):
        changed = jobs.job_filings(sec_http, a.out, tickers, now)
    if a.job == "fundamentals" or a.job == "all":
        jobs.job_fundamentals(sec_http, fetch_yf, a.out, tickers, now)
    elif changed:  # a new filing lands: rebuild the statements for just those names
        jobs.job_fundamentals(sec_http, fetch_yf, a.out, changed, now)
    if a.job in ("mgmt", "all"):
        jobs.job_mgmt(sec_http, fetch_yf_mgmt, llm.make_caller(), a.out, tickers, now)
    if a.job == "research":  # benchmarks for relative performance, without waiting for the daily run
        jobs.job_history(yahoo, stooq, a.out, config.BENCH, now, job="bench")
    if a.job in ("peers", "research", "all"):
        from . import peers
        jobs.job_peers(peers.fetch, a.out, None, now)
    if a.job in ("segments", "research", "all"):
        jobs.job_segments(sec_http, a.out, None, now)
    if a.job in ("evidence", "all", "filings", "fundamentals"):
        jobs.job_evidence(a.out, tickers=tickers, now=now)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
