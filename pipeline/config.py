"""Shared configuration for the data pipeline."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
MARKET_JSON = PUBLIC / "data" / "market.json"
RESEARCH_DIR = PUBLIC / "data" / "research"

# SEC fair access requires a User-Agent that identifies the operator.
SEC_USER_AGENT = os.environ.get("SEC_USER_AGENT", "")
YAHOO_UA = os.environ.get(
    "YAHOO_UA",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
)

# The 15 covered names: 3 core, 2 lighter, 10 basic view.
TIERS = {
    "V": "core", "LIN": "core", "LLY": "core",
    "MU": "lighter", "PG": "lighter",
}
BASIC = ["MSFT", "JPM", "GOOGL", "WM", "COST", "KO", "AMZN", "XOM", "NEE", "AMT"]
TICKERS = list(TIERS) + BASIC

# Index, rates, FX and commodity symbols for the markets strip.
MARKET_SYMBOLS = {
    "^GSPC": "S&P 500",
    "^NDX": "Nasdaq 100",
    "^DJI": "Dow Jones",
    "^RUT": "Russell 2000",
    "^VIX": "VIX",
    "^TNX": "US 10Y yield",
    "DX-Y.NYB": "US dollar index",
    "GC=F": "Gold",
    "CL=F": "WTI crude",
    "BTC-USD": "Bitcoin",
}


def ciks():
    """CIK per ticker, from the committed market file so the app and the pipeline agree."""
    try:
        stocks = json.loads(MARKET_JSON.read_text())["stocks"]
        return {t: s["cik"] for t, s in stocks.items() if s.get("cik")}
    except Exception:
        return {}


def base_period_ends():
    """Period end each research file was built from, used to detect a newer filing."""
    out = {}
    for t in TICKERS:
        p = RESEARCH_DIR / f"{t}.json"
        if p.exists():
            try:
                out[t] = json.loads(p.read_text()).get("base_period_end")
            except Exception:
                pass
    return {k: v for k, v in out.items() if v}
