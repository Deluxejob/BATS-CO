#!/usr/bin/env python3
"""
Fetch the Shiller CAPE (cyclically-adjusted PE ratio, aka Shiller PE 10)
from multpl.com and write data/spx_cape.csv.

CAPE = current real S&P 500 price / 10-year average of real earnings.
Robert Shiller's canonical long-run valuation measure — smooths out
short-term earnings volatility so the ratio reflects structural
overvaluation instead of the current business cycle. Historical range:
- ~5 at 1921 low (Great Depression bottom)
- ~44 at 1999 peak (dot-com)
- ~28-38 recent years
- >30 typically considered expensive; >40 = danger zone territory

Same scrape pattern as update-pe-ratio.py. multpl.com carries Shiller's
own dataset updated monthly. Safe on failure: if the fetch or parse
breaks, the existing CSV is left alone and a warning is logged.
"""

from __future__ import annotations
import csv
import os
import re
import sys
import urllib.request

MULTPL_URL = "https://www.multpl.com/shiller-pe/table/by-month"
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "spx_cape.csv")

MONTHS = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'sept': 9, 'oct': 10, 'nov': 11, 'dec': 12,
}


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch_multpl() -> dict[str, float]:
    """Return {YYYY-MM-01: cape} scraped from multpl.com. Empty dict on failure."""
    try:
        req = urllib.request.Request(
            MULTPL_URL,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            html = r.read().decode('utf-8', errors='ignore')
    except Exception as exc:
        warn(f"multpl CAPE fetch failed: {exc}")
        return {}

    tm = re.search(r'<table[^>]*id="datatable"[^>]*>(.*?)</table>', html, re.S)
    if not tm:
        warn("multpl CAPE: could not locate #datatable")
        return {}
    tbl = tm.group(1)
    strip_tags = re.compile(r'<[^>]+>').sub

    out: dict[str, float] = {}
    for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', tbl, re.S):
        cells = re.findall(r'<td[^>]*>(.*?)</td>', tr, re.S)
        if len(cells) < 2:
            continue
        date_str = strip_tags('', cells[0]).strip()
        val_str = strip_tags('', cells[1]).replace('\n', ' ')
        vm = re.search(r'(\d+\.\d+)', val_str)
        dm = re.match(r'([A-Za-z]{3,4})\s+\d{1,2},\s+(\d{4})', date_str)
        if not vm or not dm:
            continue
        mo = MONTHS.get(dm.group(1).lower())
        if mo is None:
            continue
        yr = int(dm.group(2))
        out[f"{yr:04d}-{mo:02d}-01"] = float(vm.group(1))

    return out


def load_existing() -> dict[str, str]:
    """Return {date: cape_str} from the current CSV."""
    rows: dict[str, str] = {}
    if not os.path.exists(OUT_PATH):
        return rows
    with open(OUT_PATH, encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        next(reader, None)   # skip header
        for row in reader:
            if len(row) < 2:
                continue
            rows[row[0]] = row[1]
    return rows


def main() -> int:
    fresh = fetch_multpl()
    if not fresh:
        return 0

    existing = load_existing()
    added = 0
    updated = 0
    for date, cape in fresh.items():
        cape_str = f"{cape:.4f}"
        if date not in existing:
            existing[date] = cape_str
            added += 1
        elif existing[date] != cape_str:
            existing[date] = cape_str
            updated += 1

    if added == 0 and updated == 0:
        print(f"Shiller CAPE already current ({len(existing)} rows, latest {max(existing)})")
        return 0

    with open(OUT_PATH, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date", "CAPE"])
        for date in sorted(existing):
            w.writerow([date, existing[date]])

    print(f"Shiller CAPE updated: +{added} new months, {updated} revised (now {len(existing)} rows)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
