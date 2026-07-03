#!/usr/bin/env python3
"""
Refresh the current-month PE ratio for the S&P 500 from multpl.com.

The bulk of data/spx_pe.csv is Robert Shiller's monthly series (1871 through
mid-2023, with Real Total Return Price used for our forward-return backtest).
multpl.com carries the same series but keeps it current — we scrape the most
recent months here and append them if they aren't already in the CSV.

If the fetch or parse fails, the existing CSV is left unchanged.
"""

from __future__ import annotations
import csv
import os
import re
import sys
import urllib.request

MULTPL_URL = "https://www.multpl.com/s-p-500-pe-ratio/table/by-month"
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "spx_pe.csv")

MONTHS = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'sept': 9, 'oct': 10, 'nov': 11, 'dec': 12,
}


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch_multpl() -> dict[str, float]:
    """Return {YYYY-MM-01: pe} scraped from multpl.com. Empty dict on failure."""
    try:
        req = urllib.request.Request(
            MULTPL_URL,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            html = r.read().decode('utf-8', errors='ignore')
    except Exception as exc:
        warn(f"multpl fetch failed: {exc}")
        return {}

    tm = re.search(r'<table[^>]*id="datatable"[^>]*>(.*?)</table>', html, re.S)
    if not tm:
        warn("multpl: could not locate #datatable")
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


def load_existing() -> tuple[list[str], dict[str, tuple[str, str]]]:
    """Return (header, {date: (pe_str, rtr_str)}) from the current CSV."""
    rows: dict[str, tuple[str, str]] = {}
    if not os.path.exists(OUT_PATH):
        return (["Date", "PE", "RealTRPrice"], rows)
    with open(OUT_PATH, encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        header = next(reader, ["Date", "PE", "RealTRPrice"])
        for row in reader:
            if len(row) < 3:
                continue
            rows[row[0]] = (row[1], row[2])
    return (header, rows)


def main() -> int:
    fresh = fetch_multpl()
    if not fresh:
        return 0  # leave file unchanged (warning already printed)

    header, existing = load_existing()
    added = 0
    updated = 0
    for date, pe in fresh.items():
        pe_str = f"{pe:.4f}"
        if date not in existing:
            existing[date] = (pe_str, "")
            added += 1
        else:
            prev_pe, rtr = existing[date]
            # Only overwrite the PE value if it changed and we don't have TR price
            # locked in (Shiller-provided months have TR price and are authoritative).
            if not rtr and prev_pe != pe_str:
                existing[date] = (pe_str, rtr)
                updated += 1

    if added == 0 and updated == 0:
        print(f"PE ratio already current ({len(existing)} rows, latest {max(existing)})")
        return 0

    with open(OUT_PATH, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for date in sorted(existing):
            pe_s, rtr_s = existing[date]
            w.writerow([date, pe_s, rtr_s])

    print(f"PE ratio updated: +{added} new months, {updated} revised (now {len(existing)} rows)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
