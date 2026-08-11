#!/usr/bin/env python3
"""
Refresh data/fear_greed.csv — the historical CNN Fear & Greed Index
series that powers the Signal Testing backtest.

Primary source: whit3rabbit/fear-greed-data on GitHub. That repo is
auto-updated Mon-Fri after US market close by a bot, back-fills all
weekday trading days since 2011-01-03, and matches CNN's live API
values exactly on the recent overlap (validated 2026-08-11).

Fallback: CNN's own live graphdata endpoint. If whit3rabbit's CSV
is unreachable we keep whatever we already have and append CNN's
latest single value if that's newer than the last row we have.

Runs safely: any failure leaves the existing CSV unchanged.
"""

from __future__ import annotations

import csv
import io
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

WHITE_URL = "https://raw.githubusercontent.com/whit3rabbit/fear-greed-data/main/fear-greed.csv"
CNN_URL   = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH  = os.path.join(REPO_ROOT, "data", "fear_greed.csv")


def rating_bucket(score: float) -> str:
    """CNN's 5-bucket rating labels (same thresholds CNN uses)."""
    if score < 25:  return "extreme fear"
    if score < 45:  return "fear"
    if score < 55:  return "neutral"
    if score < 75:  return "greed"
    return "extreme greed"


def fetch_whit3rabbit() -> list[tuple[str, float, str]] | None:
    """Download the whit3rabbit CSV whole. Returns parsed rows or None."""
    try:
        req = urllib.request.Request(WHITE_URL, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read().decode("utf-8", errors="ignore")
    except urllib.error.URLError as e:
        print(f"::warning::Couldn't fetch whit3rabbit CSV: {e}")
        return None
    rows: list[tuple[str, float, str]] = []
    reader = csv.DictReader(io.StringIO(data))
    for row in reader:
        d = (row.get("Date") or row.get("date") or "").strip()
        v = (row.get("Fear Greed") or row.get("fear_greed") or "").strip()
        g = (row.get("Rating") or row.get("rating") or "").strip().lower()
        try:
            datetime.strptime(d, "%Y-%m-%d")
            fv = float(v)
        except (ValueError, TypeError):
            continue
        if not 0.0 <= fv <= 100.0:
            continue
        if not g:
            g = rating_bucket(fv)
        rows.append((d, fv, g))
    if len(rows) < 2000:
        print(f"::warning::whit3rabbit CSV had only {len(rows)} rows; suspicious")
        return None
    rows.sort(key=lambda r: r[0])
    return rows


def fetch_cnn_latest() -> tuple[str, float, str] | None:
    """Try CNN's live API for today's score — fallback path only."""
    try:
        req = urllib.request.Request(CNN_URL, headers={
            "User-Agent": UA,
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://www.cnn.com",
            "Referer": "https://www.cnn.com/",
        })
        with urllib.request.urlopen(req, timeout=15) as r:
            payload = json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError) as e:
        print(f"::warning::CNN live API unavailable: {e}")
        return None
    fg = payload.get("fear_and_greed") or {}
    score = fg.get("score")
    ts    = fg.get("timestamp") or ""
    try:
        # timestamp shape: "2026-08-11T22:53:42+00:00"
        d = datetime.fromisoformat(ts).astimezone(timezone.utc).strftime("%Y-%m-%d")
        fv = float(score)
    except (TypeError, ValueError):
        return None
    if not 0.0 <= fv <= 100.0:
        return None
    return (d, fv, rating_bucket(fv))


def load_existing() -> list[tuple[str, float, str]]:
    if not os.path.exists(OUT_PATH):
        return []
    out: list[tuple[str, float, str]] = []
    with open(OUT_PATH, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                out.append((row["Date"], float(row["FearGreed"]), row.get("Rating", "").strip()))
            except (KeyError, ValueError):
                continue
    return out


def write_csv(rows: list[tuple[str, float, str]]) -> None:
    with open(OUT_PATH, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date", "FearGreed", "Rating"])
        for d, v, g in rows:
            # 4 decimals — whit3rabbit source stores up to ~14 which is noise.
            w.writerow([d, f"{v:.4f}", g])


def main() -> int:
    rows = fetch_whit3rabbit()
    if rows:
        write_csv(rows)
        print(f"Updated {OUT_PATH} from whit3rabbit ({len(rows)} rows, latest {rows[-1][0]})")
        return 0

    # Whit3rabbit failed — try CNN live API as a minimal top-up.
    existing = load_existing()
    if not existing:
        print("::error::Primary source failed AND no existing CSV; giving up")
        return 1
    latest = fetch_cnn_latest()
    if not latest:
        print("::warning::CNN live API also failed; leaving existing CSV unchanged")
        return 0
    last_date = existing[-1][0]
    if latest[0] <= last_date:
        print(f"CNN latest ({latest[0]}) not newer than last row ({last_date}); no change")
        return 0
    # Append the one new day, keeping existing series intact.
    existing.append(latest)
    write_csv(existing)
    print(f"Appended {latest[0]} from CNN live API; {len(existing)} rows total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
