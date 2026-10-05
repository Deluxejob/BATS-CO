#!/usr/bin/env python3
"""
Forward P/E of the whole S&P 500, for the Forward PE card on valuations.html.

What it measures
  Forward P/E = what the index's companies are worth today, divided by what
  analysts expect them to earn over the NEXT 12 MONTHS. It is the number
  people usually mean by "the market's forward P/E".

How it is built (every company, not a sample)
  1. Today's member list comes from data/constituents.json (refreshed by
     update-ad-line.py earlier in the nightly job).
  2. Yahoo gives, for each company: its market value, its price, analysts'
     earnings-per-share estimate for the financial year in progress
     ("this year") and for the one after ("next year").
  3. A second Yahoo call per company gives the date its "this year" ends.
     That matters: about 40% of the index by value does not use a calendar
     year (Apple ends in September, Microsoft in June, Nvidia in January).
  4. For each company, the next 12 months are split between "this year"
     and "next year" by the calendar: if 3 of the next 12 months fall in
     this financial year, the estimate is 3/12 this year + 9/12 next year.
     A company whose "this year" has already ended uses next year alone.
  5. Index forward P/E = total market value / total next-12-month earnings.

  Checked on 2026-10-05: this gave 19.3; FactSet's published figure for
  2026-10-02 was 19.0. An earlier version of the page used only the ten
  largest companies and showed 21.8.

Output: data/spx_forward_pe.csv, one row per day (history builds up):

    Date,ForwardPE,ThisYearPE,NextYearPE,GrowthNextYear,Companies,Coverage,Dated

  ForwardPE       next-12-month figure described above (the card's number)
  ThisYearPE      same total value / total "this year" estimates
  NextYearPE      same total value / total "next year" estimates
  GrowthNextYear  how much higher "next year" estimates are than "this year"
  Companies       companies counted (a company with two share classes once)
  Coverage        share of the index's value that had usable estimates
  Dated           companies whose financial-year end date was found

Fail-safe, like the other updaters: the file is only touched when at
least 90% of the index's value had estimates and the answer is sane.
Always exits 0 so the nightly workflow's commit step runs.
"""

from __future__ import annotations
import csv
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MEMBERS_PATH = os.path.join(REPO_ROOT, "data", "constituents.json")
OUT_PATH = os.path.join(REPO_ROOT, "data", "spx_forward_pe.csv")
HEADER = ["Date", "ForwardPE", "ThisYearPE", "NextYearPE", "GrowthNextYear", "Companies", "Coverage", "Dated"]

# User-Agent only. Adding "Accept: application/json" makes Yahoo's crumb
# endpoint (which answers in plain text) reject the request with a 406.
UA = {"User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                     "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")}
# The second ticker of a company with two share classes. Yahoo reports the
# whole company's value under both tickers, so only one may be counted.
SECOND_CLASS = {"GOOG": "GOOGL", "FOX": "FOXA", "NWS": "NWSA"}
BATCH = 40           # symbols per quote call
WORKERS = 6          # parallel detail calls (500 companies take about 15 seconds)
MIN_COVERAGE = 0.90


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


class Yahoo:
    """Yahoo needs a cookie and a matching "crumb" token on these endpoints."""

    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        for primer in ("https://fc.yahoo.com/", "https://finance.yahoo.com/"):
            try:
                self.opener.open(urllib.request.Request(primer, headers=UA), timeout=15)
            except Exception:  # noqa: BLE001 — fc.yahoo.com answers 404 but still sets the cookie
                pass
        with self.opener.open(urllib.request.Request("https://query1.finance.yahoo.com/v1/test/getcrumb", headers=UA), timeout=15) as r:
            self.crumb = urllib.parse.quote(r.read().decode("utf-8", "replace").strip(), safe="")
        if not self.crumb:
            raise RuntimeError("Yahoo returned an empty crumb")

    def get(self, url: str):
        sep = "&" if "?" in url else "?"
        with self.opener.open(urllib.request.Request(f"{url}{sep}crumb={self.crumb}", headers=UA), timeout=30) as r:
            return json.loads(r.read().decode("utf-8", "replace"))


def num(d: dict, key: str):
    v = d.get(key)
    return float(v) if isinstance(v, (int, float)) and v == v else None


def fetch_quotes(y: Yahoo, symbols: list[str]) -> dict:
    out = {}
    for i in range(0, len(symbols), BATCH):
        chunk = symbols[i:i + BATCH]
        for attempt in (1, 2):
            try:
                res = y.get("https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + urllib.parse.quote(",".join(chunk)))
                for q in (res.get("quoteResponse") or {}).get("result") or []:
                    out[q.get("symbol")] = q
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    warn(f"quote batch starting {chunk[0]} failed ({e})")
                else:
                    time.sleep(2)
    return out


def fetch_year_end(y: Yahoo, symbol: str):
    """The date the company's "this year" estimate ends (YYYY-MM-DD), or None."""
    url = f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/{urllib.parse.quote(symbol)}?modules=earningsTrend"
    for attempt in (1, 2):
        try:
            res = y.get(url)["quoteSummary"]["result"][0]["earningsTrend"]["trend"]
            for t in res:
                if t.get("period") == "0y" and t.get("endDate"):
                    return date.fromisoformat(t["endDate"])
            return None
        except Exception:  # noqa: BLE001 — one missing date just falls back to the calendar year
            if attempt == 1:
                time.sleep(1.5)
    return None


def next_12_months_eps(this_year, next_year, year_end, today: date) -> float:
    """Blend the two estimates by how much of the next 12 months each covers."""
    if this_year is None:
        return next_year
    if year_end is None:
        year_end = date(today.year, 12, 31)          # no date found: assume a calendar year
    days_left = max(0, min(365, (year_end - today).days))
    return (days_left * this_year + (365 - days_left) * next_year) / 365


def existing_rows() -> dict:
    rows = {}
    try:
        with open(OUT_PATH, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                if r.get("Date"):
                    rows[r["Date"]] = [r.get(h, "") for h in HEADER]
    except OSError:
        pass
    return rows


def main() -> int:
    try:
        with open(MEMBERS_PATH, encoding="utf-8") as f:
            members = (json.load(f).get("spx") or {}).get("symbols") or []
    except (OSError, ValueError) as e:
        warn(f"forward PE: cannot read the member list ({e})")
        return 0
    if len(members) < 450:
        warn(f"forward PE: member list looks short ({len(members)}); leaving the file unchanged")
        return 0

    y = Yahoo()
    quotes = fetch_quotes(y, members)
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        year_ends = dict(zip(members, ex.map(lambda s: fetch_year_end(y, s), members)))

    today = datetime.now(timezone.utc).date()
    total_value = value = e_ntm = e_this = e_next = 0.0
    companies = dated = 0
    latest_trade = 0
    for sym in members:
        q = quotes.get(sym)
        if not q:
            continue
        mcap, price = num(q, "marketCap"), num(q, "regularMarketPrice")
        if not mcap or not price or mcap <= 0 or price <= 0:
            continue
        if sym in SECOND_CLASS and SECOND_CLASS[sym] in quotes:
            continue                                   # the other share class already carries the whole company
        total_value += mcap
        this_year, next_year = num(q, "epsCurrentYear"), num(q, "epsForward")
        if next_year is None:
            continue                                   # no analyst estimate: left out (counts against coverage)
        shares = mcap / price                          # value / price, so every share class is included
        ye = year_ends.get(sym)
        e_ntm += next_12_months_eps(this_year, next_year, ye, today) * shares
        e_this += (this_year if this_year is not None else next_year) * shares
        e_next += next_year * shares
        value += mcap
        companies += 1
        dated += ye is not None
        latest_trade = max(latest_trade, int(num(q, "regularMarketTime") or 0))

    coverage = value / total_value if total_value else 0.0
    if coverage < MIN_COVERAGE or e_ntm <= 0 or e_this <= 0 or e_next <= 0:
        warn(f"forward PE: only {coverage:.0%} of the index's value had estimates; leaving the file unchanged")
        return 0
    fwd = value / e_ntm
    if not 8 <= fwd <= 60:
        warn(f"forward PE: result {fwd:.1f} is outside the sane range; leaving the file unchanged")
        return 0

    as_of = datetime.fromtimestamp(latest_trade, timezone.utc).strftime("%Y-%m-%d") if latest_trade else today.isoformat()
    rows = existing_rows()
    rows[as_of] = [as_of, f"{fwd:.2f}", f"{value / e_this:.2f}", f"{value / e_next:.2f}",
                   f"{e_next / e_this - 1:.4f}", str(companies), f"{coverage:.3f}", str(dated)]
    with open(OUT_PATH, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(HEADER)
        w.writerows(rows[d] for d in sorted(rows))
    print(f"Updated spx_forward_pe.csv: {as_of} forward PE {fwd:.2f} "
          f"(this year {value / e_this:.2f}, next year {value / e_next:.2f}, {companies} companies, "
          f"{coverage:.1%} of value, {dated} with year-end dates)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — never fail the nightly workflow
        warn(f"update-forward-pe.py failed ({e}); keeping the existing file")
        sys.exit(0)
