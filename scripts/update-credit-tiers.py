#!/usr/bin/env python3
"""
Corporate bond spreads by credit rating, for the Junk Bond Quality Gap
card on signals.html.

A bond's spread is the extra yield investors demand over Treasuries for
the risk of not being paid back. This script keeps one daily series per
rating tier so the page can show the weakest companies (CCC) against the
strongest junk (BB) and against investment-grade debt:

  BAMLH0A3HYC   CCC and lower       (weakest junk)
  BAMLH0A2HYB   single B
  BAMLH0A1HYBB  BB                  (strongest junk)
  BAMLH0A0HYM2  all high yield
  BAMLC0A0CM    investment grade    (all)
  BAMLC0A4CBBB  BBB                 (lowest investment grade)

All are ICE BofA option-adjusted spreads published on FRED, in
percentage points (4.33 means 4.33% over Treasuries).

FRED only hands out the LAST THREE YEARS of these series, even with an
API key (an ICE licensing rule), and the window rolls forward every day.
So this script MERGES: rows already in the file are kept, new days are
added, and a day FRED has revised is replaced. Every day we have ever
seen stays on file, and the record grows past three years from here on.

Output: data/credit_tiers.csv

    Date,CCC,B,BB,HY,IG,BBB

Fail-safe, like the other updaters: a tier that fails to download is
left as it was; the file is only rewritten when the CCC and BB series
(the card's two essentials) came through. Always exits 0.
"""

from __future__ import annotations
import csv
import json
import os
import sys
import urllib.parse
import urllib.request

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "credit_tiers.csv")
SERIES = [("CCC", "BAMLH0A3HYC"), ("B", "BAMLH0A2HYB"), ("BB", "BAMLH0A1HYBB"),
          ("HY", "BAMLH0A0HYM2"), ("IG", "BAMLC0A0CM"), ("BBB", "BAMLC0A4CBBB")]
HEADER = ["Date"] + [name for name, _ in SERIES]
ESSENTIAL = {"CCC", "BB"}

FRED_API_KEY = os.environ.get("FRED_API_KEY", "").strip()
FRED_API_URL = "https://api.stlouisfed.org/fred/series/observations"
FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={}&cosd=1900-01-01"
UA = {"User-Agent": "curl/8.0"}


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch(series_id: str) -> dict:
    """{YYYY-MM-DD: value} for one FRED series; empty on failure."""
    out = {}
    try:
        if FRED_API_KEY:
            params = {"series_id": series_id, "api_key": FRED_API_KEY, "file_type": "json",
                      "observation_start": "1900-01-01", "limit": "100000"}
            req = urllib.request.Request(FRED_API_URL + "?" + urllib.parse.urlencode(params), headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                obs = json.loads(r.read().decode("utf-8", "ignore")).get("observations") or []
            pairs = [(o.get("date", ""), o.get("value", "")) for o in obs]
        else:
            req = urllib.request.Request(FRED_CSV_URL.format(series_id), headers=UA)
            with urllib.request.urlopen(req, timeout=45) as r:
                lines = r.read().decode("utf-8", "ignore").strip().splitlines()[1:]
            pairs = [(ln.split(",")[0], ln.split(",")[1]) for ln in lines if ln.count(",") >= 1]
    except Exception as e:  # noqa: BLE001
        warn(f"{series_id}: fetch failed ({e})")
        return out
    for date, val in pairs:
        date, val = date.strip(), val.strip()
        if len(date) == 10 and val not in ("", ".", "NA"):
            try:
                out[date] = f"{float(val):.2f}"
            except ValueError:
                pass
    return out


def main() -> int:
    fresh = {name: fetch(sid) for name, sid in SERIES}
    for name, _ in SERIES:
        print(f"  {name:4} {len(fresh[name])} days" + (f", {min(fresh[name])} to {max(fresh[name])}" if fresh[name] else ""))
    if any(not fresh[name] for name in ESSENTIAL):
        warn("credit tiers: CCC or BB did not download; leaving the file unchanged")
        return 0

    rows = {}
    try:
        with open(OUT_PATH, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                if r.get("Date"):
                    rows[r["Date"]] = {h: r.get(h, "") for h in HEADER}
    except OSError:
        pass
    before = len(rows)
    for name, _ in SERIES:
        for date, val in fresh[name].items():
            rows.setdefault(date, {h: "" for h in HEADER})
            rows[date]["Date"] = date
            rows[date][name] = val
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=HEADER, lineterminator="\n")
        w.writeheader()
        for date in sorted(rows):
            w.writerow(rows[date])
    last = max(rows)
    print(f"Updated credit_tiers.csv: {len(rows)} days ({len(rows) - before} new), latest {last}: "
          f"CCC {rows[last].get('CCC')} BB {rows[last].get('BB')} IG {rows[last].get('IG')}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — never fail the nightly workflow
        warn(f"update-credit-tiers.py failed ({e}); keeping the existing file")
        sys.exit(0)
