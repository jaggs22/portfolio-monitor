"""News headlines: yfinance when available, the Yahoo RSS feed as a fallback. Headline, source, time and link only."""
import datetime as dt
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime


def _ts(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    try:
        return int(dt.datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp())
    except ValueError:
        try:
            return int(parsedate_to_datetime(str(v)).timestamp())
        except (TypeError, ValueError):
            return None


def parse_yf_news(items):
    """yfinance has shipped two shapes: flat dicts and {'content': {...}}. Accept both."""
    out = []
    for it in items or []:
        c = it.get("content") if isinstance(it.get("content"), dict) else it
        title = c.get("title")
        if not title:
            continue
        url = None
        for k in ("canonicalUrl", "clickThroughUrl"):
            if isinstance(c.get(k), dict) and c[k].get("url"):
                url = c[k]["url"]; break
        url = url or c.get("link") or c.get("url")
        prov = c.get("provider")
        src = prov.get("displayName") if isinstance(prov, dict) else (c.get("publisher") or prov)
        t = _ts(c.get("pubDate") or c.get("providerPublishTime") or c.get("displayTime"))
        if url and url.startswith("http"):
            out.append({"title": title.strip(), "url": url, "source": src or "Yahoo Finance", "t": t})
    return out


def parse_rss(xml_text):
    out = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return out
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        if title and link.startswith("http"):
            out.append({"title": title, "url": link, "source": "Yahoo Finance", "t": _ts(it.findtext("pubDate"))})
    return out


def merge(per_ticker, limit=60):
    """per_ticker: {ticker: [items]}. Returns the merged, de-duplicated, newest-first list with tickers attached."""
    seen, merged = {}, []
    for tk, items in per_ticker.items():
        for it in items:
            key = it["url"]
            if key in seen:
                if tk not in seen[key]["tickers"]:
                    seen[key]["tickers"].append(tk)
                continue
            row = dict(it, tickers=[tk])
            seen[key] = row
            merged.append(row)
    merged.sort(key=lambda r: r.get("t") or 0, reverse=True)
    return merged[:limit]
