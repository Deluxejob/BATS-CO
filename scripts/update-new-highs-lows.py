#!/usr/bin/env python3
"""
Daily new 52-week highs and new 52-week lows for the S&P 500 and Nasdaq-100.

StockCharts and the Wall Street Journal publish these counts for the whole
NYSE and Nasdaq, but not for an index, and not as a downloadable history.
This script counts them itself from the members' own price bars, so the
series is index-specific and complete from 2016 on the first run.

For each group: take today's member list (the same lists, cache and
fetchers as update-ad-line.py), pull daily high/low/close bars for every
member from Yahoo, and write data/new_highs_lows_<group>.csv with one row
per trading day:

    Date,NewHighs,NewLows,Net,Coverage,Index

  NewHighs   members whose high that day beat their highest high of the
             previous 252 sessions (about one trading year)
  NewLows    members whose low that day undercut their lowest low of the
             previous 252 sessions
  Net        NewHighs - NewLows
  Coverage   members with a full year of bars behind that day, i.e. the
             ones that could have been counted (newer listings join the
             count a year after they start trading)
  Index      the index close that day, for chart overlays

Why intraday high/low and not the close: that is the exchange convention
(a stock that trades through its old high prints as a new high even if it
closes back below it), so the counts read like the NYSE/Nasdaq ones.
Prices are split-adjusted but not dividend-adjusted, again to match how
exchanges count; the dividend-adjusted series the A/D line uses would make
every ex-dividend date look like a slightly fresher high.

Today's members are applied to the whole history (survivorship caveat: a
stock that left the index after a long slide is not here to add to the
old new-low counts), which is why the series start in 2016 rather than
reaching back decades.

Fail-safe, like the other updaters: a CSV is rewritten only when at least
85% of the members fetched and the new series is not shorter than the
existing one. Exits 0 in normal use so a bad night never fails the job;
with --strict (manual runs) it exits 1 if any file was left unchanged.

Nothing on the site reads these files yet.
"""

from __future__ import annotations
import csv
import importlib.util
import json
import os
import sys
import time
import urllib.error
import urllib.parse
from collections import deque
from datetime import datetime, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR = os.path.join(REPO_ROOT, "data")

# Member lists, cache and the Yahoo helpers live in update-ad-line.py.
# A hyphen in the file name rules out a plain import.
_spec = importlib.util.spec_from_file_location(
    "update_ad_line", os.path.join(os.path.dirname(os.path.abspath(__file__)), "update-ad-line.py"))
adl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(adl)
warn, http_get, fetch_all = adl.warn, adl.http_get, adl.fetch_all

OUTPUTS = {
    "spx": {"label": "S&P 500",    "list": "spx", "index_sym": "^GSPC", "out": "new_highs_lows_spx.csv"},
    "ndx": {"label": "Nasdaq-100", "list": "ndx", "index_sym": "^NDX",  "out": "new_highs_lows_ndx.csv"},
}

LOOKBACK = 252                     # sessions in "52 weeks"
FIRST_ROW = "2016-01-01"
# A full lookback window has to sit before the first row, plus slack for
# holidays, so the history starts well over a year earlier.
START = int(datetime(2014, 10, 1, tzinfo=timezone.utc).timestamp())
MIN_FETCH_SHARE = 0.85
HEADER = ["Date", "NewHighs", "NewLows", "Net", "Coverage", "Index"]


# ---------------------------------------------------------------- prices
def fetch_bars(symbol: str):
    """Return [(YYYY-MM-DD, high, low, close), ...] oldest first, or None.

    Raw quote bars: split-adjusted, not dividend-adjusted (see the docstring).
    """
    end = int(time.time())
    url = (f"https://query2.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}"
           f"?period1={START}&period2={end}&interval=1d&events=split")
    for attempt in (1, 2):
        try:
            data = json.loads(http_get(url, adl.YAHOO_HEADERS).decode("utf-8", "replace"))
            break
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            if attempt == 2:
                warn(f"{symbol}: fetch failed ({e})")
                return None
            time.sleep(2)
    try:
        res = data["chart"]["result"][0]
        ts = res["timestamp"]
        q = res["indicators"]["quote"][0]
        highs, lows, closes = q["high"], q["low"], q["close"]
    except (KeyError, IndexError, TypeError):
        warn(f"{symbol}: unexpected response shape")
        return None
    out = []
    for t, h, l, c in zip(ts, highs, lows, closes):
        if all(isinstance(v, (int, float)) and v > 0 for v in (h, l, c)):
            out.append((datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d"), float(h), float(l), float(c)))
    return out or None


# ---------------------------------------------------------------- the count
def member_flags(bars) -> dict:
    """{date: (new_high, new_low)} for every bar with a full LOOKBACK of
    bars before it. Sliding-window max/min with monotonic deques, so a
    member with ten years of bars costs one pass, not 252 per day."""
    out = {}
    hi_q: deque = deque()   # indices, highs descending
    lo_q: deque = deque()   # indices, lows ascending
    for i, (d, h, l, _c) in enumerate(bars):
        while hi_q and hi_q[0] < i - LOOKBACK:
            hi_q.popleft()
        while lo_q and lo_q[0] < i - LOOKBACK:
            lo_q.popleft()
        if i >= LOOKBACK:
            # The window is the LOOKBACK bars before today, today excluded.
            out[d] = (h > bars[hi_q[0]][1], l < bars[lo_q[0]][2])
        while hi_q and bars[hi_q[-1]][1] <= h:
            hi_q.pop()
        hi_q.append(i)
        while lo_q and bars[lo_q[-1]][2] >= l:
            lo_q.pop()
        lo_q.append(i)
    return out


def build_rows(index_bars, member_bars: list) -> list:
    index_close = {d: c for d, _h, _l, c in index_bars}
    flags = [member_flags(b) for b in member_bars]
    rows = []
    for d in sorted(x for x in index_close if x >= FIRST_ROW):
        nh = nl = cov = 0
        for f in flags:
            v = f.get(d)
            if v is None:
                continue
            cov += 1
            nh += v[0]
            nl += v[1]
        if cov == 0:
            continue
        rows.append([d, nh, nl, nh - nl, cov, f"{index_close[d]:.2f}"])
    # A session still in progress (or a run before every member has its
    # bar) shows up as a last day with thin coverage. Drop such trailing
    # days rather than publish a count built from a handful of stocks.
    members = len(member_bars)
    while rows and rows[-1][4] < 0.6 * members:
        rows.pop()
    return rows


def existing_len(path: str) -> int:
    try:
        with open(path, encoding="utf-8") as f:
            return max(0, sum(1 for _ in f) - 1)
    except OSError:
        return 0


# ---------------------------------------------------------------- main
def main(strict: bool) -> int:
    os.makedirs(DATA_DIR, exist_ok=True)
    cache = adl.load_cache()
    # The member lists are the A/D script's; it owns writing the cache.
    lists = {cfg["list"]: adl.get_members(cfg["list"], cache) for cfg in OUTPUTS.values()}
    for k, syms in lists.items():
        print(f"{adl.LISTS[k]['label']}: {len(syms)} members")

    wanted = sorted(set(s for syms in lists.values() for s in syms) | {c["index_sym"] for c in OUTPUTS.values()})
    print(f"Fetching {len(wanted)} symbols from Yahoo…")
    adl.fetch_daily = fetch_bars            # fetch_all calls the module's fetch_daily
    prices = fetch_all(wanted)

    unchanged = []
    for key, cfg in OUTPUTS.items():
        syms = lists[cfg["list"]]
        got = [prices[s] for s in syms if prices.get(s)]
        idx = prices.get(cfg["index_sym"])
        out_path = os.path.join(DATA_DIR, cfg["out"])
        if not syms or not idx:
            warn(f"{cfg['label']}: missing the member list or index prices; leaving {cfg['out']} unchanged")
            unchanged.append(cfg["out"])
            continue
        if len(got) / len(syms) < MIN_FETCH_SHARE:
            warn(f"{cfg['label']}: only {len(got)}/{len(syms)} members fetched; leaving {cfg['out']} unchanged")
            unchanged.append(cfg["out"])
            continue
        rows = build_rows(idx, got)
        if len(rows) < existing_len(out_path):
            warn(f"{cfg['label']}: new series ({len(rows)} rows) shorter than existing; leaving {cfg['out']} unchanged")
            unchanged.append(cfg["out"])
            continue
        with open(out_path, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(HEADER)
            w.writerows(rows)
        last = rows[-1]
        print(f"Updated {cfg['out']}: {len(rows)} rows, {len(got)}/{len(syms)} members, "
              f"last {last[0]} new highs {last[1]} new lows {last[2]} (coverage {last[4]})")
    if strict and unchanged:
        print(f"::error::--strict: left unchanged: {', '.join(unchanged)}")
        return 1
    return 0


if __name__ == "__main__":
    strict = "--strict" in sys.argv[1:]
    try:
        sys.exit(main(strict))
    except Exception as e:  # noqa: BLE001 — never fail the nightly workflow
        warn(f"update-new-highs-lows.py crashed: {e}")
        sys.exit(1 if strict else 0)
