#!/usr/bin/env python3
"""
Save the day's real NYSE and Nasdaq advance/decline counts.

Why this exists
  Martin Zweig's Breadth Thrust rule was written for every stock on the
  New York Stock Exchange. No free source offers the history of those
  daily counts after February 2020, so the Zweig card on signals.html
  counts the S&P 1500 members as a stand-in. The Wall Street Journal's
  Markets Diary does publish the real counts, but only for three days:
  the latest close, the close before it, and a week ago. A day nobody
  saved cannot be fetched later. This script saves them, one row per
  trading day, so a true NYSE history builds up from October 2026 on.

  Nothing on the site reads these files yet. It is a quiet saver.

Output (one row per trading day, oldest first)
  data/nyse_breadth.csv      every stock on the New York Stock Exchange
  data/nasdaq_breadth.csv    every stock on Nasdaq

    Date,Issues,Adv,Dec,Unch,NewHighs,NewLows,AdvVol,DecVol,TotalVol

  Issues          stocks that traded that day
  Adv/Dec/Unch    how many closed up / down / flat
  NewHighs/Lows   how many set a new 52-week high / low
  AdvVol/DecVol   shares traded in rising / falling stocks (all US venues)
  TotalVol        total shares traded (all US venues)

How dates are decided (a wrong date would quietly poison the history)
  latest close     the feed prints its own date ("Friday, October 02, 2026")
  previous close   the trading day before that, from a trading calendar
  week ago         the same weekday one week earlier, and only when no
                   market holiday fell in between; otherwise it is skipped
  The calendar is recent S&P 500 daily bars from Yahoo plus data/nya.csv.
  If the calendar cannot place the latest date, only the latest row is
  saved, because that one never depends on the calendar.

What gets overwritten
  The latest and previous-close columns replace a saved row for the same
  date, since the Journal's numbers can be revised after the close. The
  week-ago column only fills a hole; it never replaces a saved row.

Exit code
  0 in normal use, including "nothing new today".
  1 when the feed could not be read AND the saved file is already two or
    more trading days behind, i.e. a day is about to be lost for good.
    GitHub then shows the run as failed and e-mails the repo owner.
  With --strict (used for manual runs and when this script is edited), any
  failure to read the feed exits 1, so a broken change is seen at once.
  This script runs in its own small workflow, so a non-zero exit here can
  never hold back the big nightly data job.
"""

from __future__ import annotations
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR = os.path.join(REPO_ROOT, "data")

# The Markets Diary table the Journal's own page loads.
FEED_URL = ("https://www.wsj.com/market-data/stocks/marketsdiaries"
            "?id=%7B%22application%22%3A%22WSJ%22%2C%22marketsDiaryType%22%3A%22diaries%22%7D"
            "&type=mdc_marketsdiary")
CALENDAR_URL = "https://query2.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1mo&interval=1d"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# Section name in the feed -> our file.
EXCHANGES = {"NYSE": "nyse_breadth.csv", "NASDAQ": "nasdaq_breadth.csv"}
# Our column -> the row label in the feed. Volume rows marked with "*" in
# the feed are the exchange's own floor only; the unmarked ones cover all
# US venues, which is what breadth analysts use.
COLUMNS = [
    ("Issues", "Issues traded"), ("Adv", "Advances"), ("Dec", "Declines"), ("Unch", "Unchanged"),
    ("NewHighs", "New highs"), ("NewLows", "New lows"),
    ("AdvVol", "Adv. volume"), ("DecVol", "Decl. volume"), ("TotalVol", "Total volume"),
]
HEADER = ["Date"] + [c for c, _ in COLUMNS]
MONTHS = {m: i + 1 for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"])}


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def notice(msg: str) -> None:
    print(f"::notice::{msg}")


def http_json(url: str, tries: int = 3):
    """GET a URL and parse JSON. Returns None after `tries` failed attempts."""
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
            last = e
            if attempt + 1 < tries:
                time.sleep(5 * (attempt + 1))
    warn(f"could not read {url.split('?')[0]} ({last})")
    return None


def to_int(text):
    try:
        return int(str(text).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def parse_stamp(stamp: str):
    """'Friday, October 02, 2026' -> '2026-10-02' (None if it is not that shape)."""
    try:
        _, month_day, year = [p.strip() for p in str(stamp).split(",")]
        month, day = month_day.split()
        return f"{int(year):04d}-{MONTHS[month]:02d}-{int(day):02d}"
    except (ValueError, KeyError):
        return None


def looks_right(v: dict) -> bool:
    """Reject a column that is empty or does not add up."""
    need = [v.get(k) for k in ("Issues", "Adv", "Dec", "Unch")]
    if any(x is None for x in need):
        return False
    issues, adv, dec, unch = need
    return adv + dec >= 500 and abs(adv + dec + unch - issues) <= max(5, issues // 100)


def parse_feed(feed):
    """Return (latest_date, {exchange: {'latestClose': {...}, 'previousClose': {...}, 'weekAgo': {...}}})."""
    data = (feed or {}).get("data") or {}
    latest = parse_stamp(data.get("timestamp"))
    tables = {}
    for block in data.get("instrumentSets") or []:
        fields = block.get("headerFields") or []
        name = fields[0].get("label") if fields else None
        if name not in EXCHANGES:
            continue
        by_label = {}
        for row in block.get("instruments") or []:
            by_label.setdefault(row.get("name"), row)      # first row with that exact label
        cols = {}
        for when in ("latestClose", "previousClose", "weekAgo"):
            v = {ours: to_int((by_label.get(label) or {}).get(when)) for ours, label in COLUMNS}
            if looks_right(v):
                cols[when] = v
        tables[name] = cols
    return latest, tables


def trading_calendar() -> list[str]:
    """Recent trading days: Yahoo's S&P 500 daily bars plus the dates in data/nya.csv."""
    days = set()
    try:
        with open(os.path.join(DATA_DIR, "nya.csv"), encoding="utf-8") as f:
            for row in list(csv.reader(f))[-60:]:
                if row and len(row[0]) == 10 and row[0][4] == "-":
                    days.add(row[0])
    except OSError:
        pass
    live = http_json(CALENDAR_URL, tries=2)
    try:
        for t in live["chart"]["result"][0]["timestamp"]:
            days.add(datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d"))
    except (KeyError, IndexError, TypeError):
        pass
    return sorted(days)


def read_rows(path: str) -> dict:
    rows = {}
    try:
        with open(path, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                if r.get("Date"):
                    rows[r["Date"]] = [r.get(h, "") for h in HEADER]
    except OSError:
        pass
    return rows


def save(path: str, updates: list) -> tuple[int, int]:
    """updates = [(date, values, may_replace)]. Returns (days added, days corrected)."""
    rows = read_rows(path)
    added = corrected = 0
    for date, v, may_replace in updates:
        line = [date] + ["" if v.get(c) is None else str(v[c]) for c, _ in COLUMNS]
        if date not in rows:
            rows[date] = line
            added += 1
        elif may_replace and rows[date] != line:
            rows[date] = line
            corrected += 1
    if added or corrected:
        with open(path, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, lineterminator="\n")
            w.writerow(HEADER)
            w.writerows(rows[d] for d in sorted(rows))
    return added, corrected


def days_behind(calendar: list[str]) -> int:
    """How many trading days the NYSE file is missing at the end (0 if unknown)."""
    saved = sorted(read_rows(os.path.join(DATA_DIR, EXCHANGES["NYSE"])))
    if not saved or not calendar:
        return 0
    return sum(1 for d in calendar if d > saved[-1])


def main(strict: bool) -> int:
    os.makedirs(DATA_DIR, exist_ok=True)
    latest, tables = parse_feed(http_json(FEED_URL))
    if not latest or not tables.get("NYSE"):
        behind = days_behind(trading_calendar())
        warn(f"Markets Diary feed unreadable; nothing saved (NYSE file is {behind} trading day(s) behind)")
        return 1 if strict or behind >= 2 else 0

    # The feed's date can be today while the market is still open. Only
    # trust the "latest close" column once the close has clearly passed:
    # 21:15 UTC is 5:15pm New York in summer and 4:15pm in winter.
    now = datetime.now(timezone.utc)
    closed_at = datetime.strptime(latest, "%Y-%m-%d").replace(tzinfo=timezone.utc) + timedelta(hours=21, minutes=15)
    latest_is_final = now >= closed_at
    if not latest_is_final:
        notice(f"feed is dated {latest} but that session may still be open; saving only the earlier days")

    calendar = trading_calendar()
    prev_date = week_date = None
    if latest in calendar:
        i = calendar.index(latest)
        if i >= 1:
            prev_date = calendar[i - 1]
        week_guess = (datetime.strptime(latest, "%Y-%m-%d") - timedelta(days=7)).strftime("%Y-%m-%d")
        if i >= 5 and calendar[i - 5] == week_guess:      # five trading days back = same weekday, no holiday between
            week_date = week_guess
    else:
        warn(f"{latest} is not in the trading calendar yet; saving the latest day only")

    for name, filename in EXCHANGES.items():
        cols = tables.get(name) or {}
        updates = []
        if latest_is_final and "latestClose" in cols:
            updates.append((latest, cols["latestClose"], True))
        if prev_date and "previousClose" in cols:
            updates.append((prev_date, cols["previousClose"], True))
        if week_date and "weekAgo" in cols:
            updates.append((week_date, cols["weekAgo"], False))
        if not updates:
            warn(f"{name}: no usable columns in the feed today")
            continue
        added, corrected = save(os.path.join(DATA_DIR, filename), updates)
        top = updates[0]
        notice(f"{name} {top[0]}: {top[1]['Adv']:,} up, {top[1]['Dec']:,} down "
               f"({added} day(s) added, {corrected} corrected, {filename})")
    return 0


if __name__ == "__main__":
    strict = "--strict" in sys.argv[1:]
    try:
        sys.exit(main(strict))
    except Exception as e:  # noqa: BLE001 — an unexpected crash is treated like an unreadable feed
        warn(f"update-nyse-breadth.py crashed: {e}")
        sys.exit(1 if strict else 0)
