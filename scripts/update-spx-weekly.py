#!/usr/bin/env python3
"""
Weekly S&P 500 close and volume, for the Weekly Force Index card on
signals.html.

Writes data/spx_weekly.csv, one row per COMPLETED trading week:

    Date,Close,Volume

  Date     the week's last trading day (usually a Friday)
  Close    the S&P 500 close that day
  Volume   shares traded over the whole week, as Yahoo reports for ^GSPC

The card multiplies each week's price change by that week's volume, so a
half-finished week would give a misleading reading. A week is only
written once its Friday close has passed (21:15 UTC is 5:15pm New York
in summer and 4:15pm in winter). Mid-week the file simply ends at the
previous Friday.

The whole file is rebuilt from Yahoo's daily history (1950 onward) on
every run, so a late or corrected daily bar fixes itself the next night.

Fail-safe, like the other updaters: the file is rewritten only when the
fetch worked and the new series is not shorter than the existing one.
Always exits 0 so the nightly workflow's commit step runs.
"""

from __future__ import annotations
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "spx_weekly.csv")
START = -630000000        # 1950-01-14; Yahoo's ^GSPC history begins that month
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
MIN_WEEKS = 3500          # 1950 to today is about 4,000 weeks; fewer means a bad fetch


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch_daily():
    """Return [(YYYY-MM-DD, close, volume)] for ^GSPC, oldest first, or None."""
    url = (f"https://query2.finance.yahoo.com/v8/finance/chart/%5EGSPC"
           f"?period1={START}&period2={int(time.time())}&interval=1d")
    data = None
    for attempt in (1, 2, 3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
            break
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
            if attempt == 3:
                warn(f"^GSPC fetch failed ({e})")
                return None
            time.sleep(5 * attempt)
    try:
        res = data["chart"]["result"][0]
        q = res["indicators"]["quote"][0]
        stamps, closes, vols = res["timestamp"], q["close"], q["volume"]
    except (KeyError, IndexError, TypeError):
        warn("^GSPC: unexpected response shape")
        return None
    out = []
    epoch = datetime(1970, 1, 1)
    for t, c, v in zip(stamps, closes, vols):
        if isinstance(c, (int, float)) and c > 0:
            # timedelta instead of fromtimestamp: dates before 1970 are negative
            out.append(((epoch + timedelta(seconds=t)).strftime("%Y-%m-%d"), float(c), int(v or 0)))
    return out or None


def to_weeks(daily, now: datetime):
    """Group daily bars into Monday-to-Friday weeks; drop a week that is still in progress."""
    weeks = []
    for d, c, v in daily:
        key = date.fromisoformat(d).isocalendar()[:2]
        if weeks and weeks[-1]["key"] == key:
            weeks[-1]["date"], weeks[-1]["close"] = d, c
            weeks[-1]["vol"] += v
        else:
            weeks.append({"key": key, "date": d, "close": c, "vol": v})
    if weeks:
        last_day = date.fromisoformat(weeks[-1]["date"])
        friday = last_day + timedelta(days=4 - last_day.weekday())
        week_over = datetime(friday.year, friday.month, friday.day, 21, 15, tzinfo=timezone.utc)
        if now < week_over:
            weeks.pop()
    return weeks


def existing_len(path: str) -> int:
    try:
        with open(path, encoding="utf-8") as f:
            return max(0, sum(1 for _ in f) - 1)
    except OSError:
        return 0


def main() -> int:
    daily = fetch_daily()
    if not daily:
        return 0
    weeks = to_weeks(daily, datetime.now(timezone.utc))
    if len(weeks) < MIN_WEEKS:
        warn(f"spx_weekly: only {len(weeks)} weeks built; leaving the file unchanged")
        return 0
    if len(weeks) < existing_len(OUT_PATH):
        warn(f"spx_weekly: new series ({len(weeks)} weeks) is shorter than the existing file; leaving it unchanged")
        return 0
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["Date", "Close", "Volume"])
        for wk in weeks:
            w.writerow([wk["date"], f"{wk['close']:.2f}", wk["vol"]])
    last = weeks[-1]
    print(f"Updated spx_weekly.csv: {len(weeks)} weeks, {weeks[0]['date']} to {last['date']} "
          f"(close {last['close']:.2f}, volume {last['vol']:,})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — never fail the nightly workflow
        warn(f"update-spx-weekly.py crashed: {e}")
        sys.exit(0)
