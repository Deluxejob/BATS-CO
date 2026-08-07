#!/usr/bin/env python3
"""
Refresh data/market_news.json with the latest broad US stock-market headlines
from Yahoo Finance's search endpoint. Runs from the same hourly cron that
refreshes SPY news.

TradingView's Timeline widget started silently dropping our feedMode config
and its broad-market feed went stale. Rather than fight opaque widget
behavior, we scrape Yahoo like we do for SPY news.

Safe on failure: if the fetch or parse errors out, the existing JSON is
left alone and a warning is logged.
"""

from __future__ import annotations
import json
import os
import sys
import time
import urllib.parse
import urllib.request

# Yahoo caps each search query at ~10 news items regardless of newsCount, so
# we aggregate across several broad-market queries and dedupe by article link.
# In practice this yields 20-30 unique headlines per refresh.
YAHOO_QUERIES = ("S&P 500", "stock market", "market news", "Wall Street", "Nasdaq")

# Only keep articles published within this window. Yahoo's search endpoint
# doesn't strictly sort by recency, so without this filter we accumulate
# multi-day-old items that make the feed feel stale even after a fresh fetch.
MAX_AGE_SECONDS = 48 * 3600   # 48 hours

# Publishers to exclude — GuruFocus posts high-volume auto-generated earnings
# summaries for global markets (mostly Indian BOM/BSE tickers), which drown
# out actual US market news. Add other spammy sources here as needed.
PUBLISHER_BLOCKLIST = {
    "GuruFocus.com",
    "GuruFocus",
    "Simply Wall St.",   # also mostly quality-of-earnings summaries, not news
}

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "market_news.json")


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch_one(query: str) -> list[dict]:
    """Pull the news[] array for one query. Returns [] on any failure."""
    url = (
        "https://query1.finance.yahoo.com/v1/finance/search"
        "?q=" + urllib.parse.quote(query) +
        "&newsCount=25&quotesCount=0&enableFuzzyQuery=false"
        "&region=US&lang=en-US"   # bias results toward US-focused content
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=25) as r:
            body = r.read().decode("utf-8", errors="ignore")
        return (json.loads(body).get("news") or [])
    except Exception as exc:
        warn(f"Yahoo market-news query {query!r} failed: {exc}")
        return []


def fetch() -> list[dict] | None:
    # Merge results from every query, dedupe by link (fall back to uuid then title).
    # Along the way, drop anything older than MAX_AGE_SECONDS or from a blocked
    # publisher — those two filters together kill the two biggest sources of
    # perceived staleness (leftover days-old items and Indian earnings spam).
    seen_keys: set[str] = set()
    merged: list[dict] = []
    now_ts = int(time.time())
    for q in YAHOO_QUERIES:
        for item in fetch_one(q):
            title = (item.get("title") or "").strip()
            link = (item.get("link") or "").strip()
            publisher = (item.get("publisher") or "").strip()
            published = int(item.get("providerPublishTime") or 0)
            if not title or not link:
                continue
            if publisher in PUBLISHER_BLOCKLIST:
                continue
            if published <= 0 or (now_ts - published) > MAX_AGE_SECONDS:
                continue
            key = link or (item.get("uuid") or title)
            if key in seen_keys:
                continue
            seen_keys.add(key)
            merged.append({
                "title": title,
                "link": link,
                "publisher": publisher,
                "publishedAt": published,
                "id": item.get("uuid") or "",
            })

    if not merged:
        warn("All market-news queries returned no usable items (after age/publisher filters)")
        return None

    # Newest first
    merged.sort(key=lambda it: it["publishedAt"], reverse=True)
    return merged[:60]


def main() -> int:
    items = fetch()
    if items is None:
        return 0
    latest_ts = max((it["publishedAt"] for it in items), default=0)
    out = {
        "source": "Yahoo Finance / query1.finance.yahoo.com search endpoint",
        "query": "S&P 500",
        "fetchedAt": int(__import__("time").time()),
        "latestPublishedAt": latest_ts,
        "items": items,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"Market news updated: {len(items)} items, latest = {latest_ts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
