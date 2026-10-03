#!/usr/bin/env python3
"""
Advance/decline lines for the S&P 500, Nasdaq-100 and Dow 30.

For each index: fetch today's member list, pull ~10 years of daily closes
for every member from Yahoo, count how many rose vs fell each day, and
write data/ad_line_<index>.csv with one row per trading day:

    Date,Adv,Dec,Unch,Net,ADLine,Coverage,Index

  Adv/Dec/Unch  members that closed up / down / flat vs the prior session
  Net           Adv - Dec
  ADLine        running total of Net (starts at 0 on the first row)
  Coverage      members with prices on both days (newer listings drop out
                of the early history on their own)
  Index         the index's own close that day, for the chart overlay

Member lists come from three free sources, each cached in
data/constituents.json so one bad fetch never empties an index:
  S&P 500     Wikipedia's constituents table
  Nasdaq-100  Nasdaq's own index-membership API
  Dow 30      the DIA fund's daily holdings spreadsheet (openpyxl)
Today's members are applied to the whole history (survivorship caveat
noted on the page), which is why the series starts in 2016 rather than
reaching back decades.

Fail-safe, like the other updaters: a CSV is rewritten only when at least
85% of the members fetched and the new series is not shorter than the
existing one. Always exits 0 so the nightly workflow's commit step runs.
"""

from __future__ import annotations
import csv
import html
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR = os.path.join(REPO_ROOT, "data")
CACHE_PATH = os.path.join(DATA_DIR, "constituents.json")

INDEXES = {
    "spx": {"label": "S&P 500",    "index_sym": "^GSPC", "expected": 500, "out": "ad_line_spx.csv"},
    "ndx": {"label": "Nasdaq-100", "index_sym": "^NDX",  "expected": 100, "out": "ad_line_ndx.csv"},
    "dow": {"label": "Dow 30",     "index_sym": "^DJI",  "expected": 30,  "out": "ad_line_dow.csv"},
}

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
YAHOO_HEADERS = {"User-Agent": UA, "Accept": "application/json", "Referer": "https://finance.yahoo.com/"}
START = int(datetime(2015, 10, 1, tzinfo=timezone.utc).timestamp())   # ~3 months of runway before 2016
FIRST_ROW = "2016-01-01"
MIN_FETCH_SHARE = 0.85
THROTTLE_S = 0.12


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def http_get(url: str, headers: dict, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- member lists
def yahoo_symbol(sym: str) -> str:
    """Wikipedia writes BRK.B / BF.B; Yahoo wants BRK-B / BF-B."""
    return sym.strip().upper().replace(".", "-")


def members_spx() -> list[str]:
    page = http_get("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
                    {"User-Agent": "BATS.CO research (deluxejob@yahoo.com)"}).decode("utf-8", "replace")
    m = re.search(r'<table[^>]*id="constituents"[^>]*>(.*?)</table>', page, re.S)
    if not m:
        raise RuntimeError("constituents table not found")
    out = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", m.group(1), re.S)[1:]:
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)
        if not cells:
            continue
        txt = html.unescape(re.sub(r"<[^>]+>", "", cells[0])).strip()
        if re.fullmatch(r"[A-Z][A-Z0-9.\-]{0,6}", txt):
            out.append(yahoo_symbol(txt))
    return out


def members_ndx() -> list[str]:
    raw = http_get("https://api.nasdaq.com/api/quote/list-type/nasdaq100",
                   {"User-Agent": UA, "Accept": "application/json"}).decode("utf-8", "replace")
    rows = (((json.loads(raw).get("data") or {}).get("data") or {}).get("rows")) or []
    out = []
    for r in rows:
        s = str(r.get("symbol") or "").strip().upper()
        if re.fullmatch(r"[A-Z][A-Z0-9.\-]{0,6}", s):
            out.append(yahoo_symbol(s))
    return out


def members_dow() -> list[str]:
    import openpyxl  # installed by the workflow; the cache covers a machine without it
    blob = http_get("https://www.ssga.com/us/en/intermediary/library-content/products/"
                    "fund-data/etfs/us/holdings-daily-us-en-dia.xlsx", {"User-Agent": UA})
    wb = openpyxl.load_workbook(io.BytesIO(blob), read_only=True, data_only=True)
    rows = list(wb[wb.sheetnames[0]].iter_rows(values_only=True))
    hdr_i = next(i for i, r in enumerate(rows) if r and any(str(c).strip().lower() == "ticker" for c in r if c))
    col = [str(c).strip().lower() if c else "" for c in rows[hdr_i]].index("ticker")
    out = []
    for r in rows[hdr_i + 1:]:
        s = str(r[col]).strip().upper() if r and r[col] else ""
        if re.fullmatch(r"[A-Z][A-Z0-9.\-]{0,6}", s):
            out.append(yahoo_symbol(s))
    return out


FETCHERS = {"spx": members_spx, "ndx": members_ndx, "dow": members_dow}


def load_cache() -> dict:
    try:
        with open(CACHE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def get_members(key: str, cache: dict) -> list[str]:
    cfg = INDEXES[key]
    cached = (cache.get(key) or {}).get("symbols") or []
    try:
        fresh = FETCHERS[key]()
    except Exception as e:  # noqa: BLE001 — any failure just means "use the cache"
        warn(f"{cfg['label']}: member list fetch failed ({e}); using cached list of {len(cached)}")
        return cached
    fresh = sorted(set(fresh))
    if len(fresh) < 0.9 * cfg["expected"]:
        warn(f"{cfg['label']}: member list looks short ({len(fresh)}); using cached list of {len(cached)}")
        return cached or fresh
    if fresh != sorted(set(cached)):
        added = sorted(set(fresh) - set(cached)); dropped = sorted(set(cached) - set(fresh))
        print(f"{cfg['label']}: members changed (+{len(added)} {added[:8]} / -{len(dropped)} {dropped[:8]})")
    cache[key] = {"asOf": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "symbols": fresh}
    return fresh


# ---------------------------------------------------------------- prices
def fetch_daily(symbol: str):
    """Return {YYYY-MM-DD: close} (dividend-adjusted when Yahoo offers it) or None."""
    end = int(time.time())
    url = (f"https://query2.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}"
           f"?period1={START}&period2={end}&interval=1d&events=div,split")
    for attempt in (1, 2):
        try:
            data = json.loads(http_get(url, YAHOO_HEADERS).decode("utf-8", "replace"))
            break
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            if attempt == 2:
                warn(f"{symbol}: fetch failed ({e})")
                return None
            time.sleep(2)
    try:
        res = data["chart"]["result"][0]
        ts = res["timestamp"]
        ind = res["indicators"]
        adj = (ind.get("adjclose") or [{}])[0].get("adjclose")
        closes = ind["quote"][0]["close"]
        series = adj if adj and len(adj) == len(ts) else closes
    except (KeyError, IndexError, TypeError):
        warn(f"{symbol}: unexpected response shape")
        return None
    out = {}
    for t, c in zip(ts, series):
        if isinstance(c, (int, float)) and c > 0:
            out[datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")] = float(c)
    return out or None


def fetch_all(symbols: list[str], cache: dict) -> dict:
    for i, s in enumerate(symbols):
        if s in cache:
            continue
        cache[s] = fetch_daily(s)
        time.sleep(THROTTLE_S)
        if (i + 1) % 100 == 0:
            print(f"  fetched {i + 1}/{len(symbols)}")
    return cache


# ---------------------------------------------------------------- A/D math
def build_rows(index_closes: dict, member_closes: list[dict]):
    dates = sorted(d for d in index_closes if d >= FIRST_ROW)
    all_dates = sorted(index_closes)
    prev_of = {d: all_dates[i - 1] for i, d in enumerate(all_dates) if i > 0}
    rows, ad = [], 0
    for d in dates:
        p = prev_of.get(d)
        if not p:
            continue
        adv = dec = unch = 0
        for m in member_closes:
            c, c0 = m.get(d), m.get(p)
            if c is None or c0 is None:
                continue
            r = c / c0 - 1
            if r > 1e-6:
                adv += 1
            elif r < -1e-6:
                dec += 1
            else:
                unch += 1
        cov = adv + dec + unch
        if cov == 0:
            continue
        ad += adv - dec
        rows.append([d, adv, dec, unch, adv - dec, ad, cov, f"{index_closes[d]:.2f}"])
    # A session still in progress (or a run before every member has its
    # bar) shows up as a last day with thin coverage. Drop such trailing
    # days rather than publish a count built from a handful of stocks.
    members = len(member_closes)
    while rows and rows[-1][6] < 0.6 * members:
        rows.pop()
    return rows


def existing_len(path: str) -> int:
    try:
        with open(path, encoding="utf-8") as f:
            return max(0, sum(1 for _ in f) - 1)
    except OSError:
        return 0


def main() -> int:
    os.makedirs(DATA_DIR, exist_ok=True)
    cache = load_cache()
    members = {k: get_members(k, cache) for k in INDEXES}
    for k, syms in members.items():
        print(f"{INDEXES[k]['label']}: {len(syms)} members")
    try:
        with open(CACHE_PATH, "w", encoding="utf-8", newline="\n") as f:
            json.dump(cache, f, indent=1, sort_keys=True)
    except OSError as e:
        warn(f"could not write {CACHE_PATH}: {e}")

    wanted = sorted(set(s for syms in members.values() for s in syms) | {c["index_sym"] for c in INDEXES.values()})
    print(f"Fetching {len(wanted)} symbols from Yahoo…")
    prices: dict = {}
    fetch_all(wanted, prices)

    for key, cfg in INDEXES.items():
        syms = members[key]
        got = [prices[s] for s in syms if prices.get(s)]
        idx = prices.get(cfg["index_sym"])
        out_path = os.path.join(DATA_DIR, cfg["out"])
        if not syms or not idx:
            warn(f"{cfg['label']}: no member list or no index prices; leaving {cfg['out']} unchanged")
            continue
        share = len(got) / len(syms)
        if share < MIN_FETCH_SHARE:
            warn(f"{cfg['label']}: only {len(got)}/{len(syms)} members fetched; leaving {cfg['out']} unchanged")
            continue
        rows = build_rows(idx, got)
        if len(rows) < existing_len(out_path):
            warn(f"{cfg['label']}: new series ({len(rows)} rows) shorter than existing; leaving {cfg['out']} unchanged")
            continue
        with open(out_path, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(["Date", "Adv", "Dec", "Unch", "Net", "ADLine", "Coverage", "Index"])
            w.writerows(rows)
        last = rows[-1]
        print(f"Updated {cfg['out']}: {len(rows)} rows, {len(got)}/{len(syms)} members, "
              f"last {last[0]} adv {last[1]} dec {last[2]} A/D {last[5]}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — never fail the nightly workflow
        warn(f"update-ad-line.py crashed: {e}")
        sys.exit(0)
