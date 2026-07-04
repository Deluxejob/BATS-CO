#!/usr/bin/env python3
"""
Refresh data/spy_news.json with the latest SPY-related headlines from Yahoo
Finance's search endpoint. Runs from the hourly news workflow (and as part
of the daily catch-all).

TradingView's Timeline widget for a specific symbol was returning empty
results for AMEX:SPY, so we pull our own feed. Yahoo's search endpoint
returns 10-15 headlines with publisher, publish time, and article link —
enough for a "what's moving SPY right now" panel.

Safe on failure: if the fetch or parse errors out, the existing JSON is
left alone and a warning is logged.
"""

from __future__ import annotations
import json
import os
import sys
import urllib.request

YAHOO_URL = (
    "https://query1.finance.yahoo.com/v1/finance/search"
    "?q=SPY&newsCount=15&quotesCount=0&enableFuzzyQuery=false"
)
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "spy_news.json")


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch() -> list[dict] | None:
    try:
        req = urllib.request.Request(
            YAHOO_URL,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req, timeout=25) as r:
            body = r.read().decode("utf-8", errors="ignore")
    except Exception as exc:
        warn(f"Yahoo news fetch failed: {exc}")
        return None
    try:
        payload = json.loads(body)
    except Exception as exc:
        warn(f"Yahoo news parse failed: {exc}")
        return None

    raw = payload.get("news", []) or []
    trimmed = []
    for item in raw:
        title = (item.get("title") or "").strip()
        link = (item.get("link") or "").strip()
        if not title or not link:
            continue
        trimmed.append({
            "title": title,
            "link": link,
            "publisher": (item.get("publisher") or "").strip(),
            "publishedAt": int(item.get("providerPublishTime") or 0),
            "id": item.get("uuid") or "",
        })
    if not trimmed:
        warn("Yahoo news response had no usable items")
        return None
    return trimmed[:15]


def main() -> int:
    items = fetch()
    if items is None:
        return 0  # leave file alone; warning already logged

    latest_ts = max((it["publishedAt"] for it in items), default=0)
    out = {
        "source": "Yahoo Finance / query1.finance.yahoo.com search endpoint",
        "symbol": "SPY",
        "fetchedAt": int(__import__("time").time()),
        "latestPublishedAt": latest_ts,
        "items": items,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"SPY news updated: {len(items)} items, latest = {latest_ts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
