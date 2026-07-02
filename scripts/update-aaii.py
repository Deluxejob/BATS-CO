#!/usr/bin/env python3
"""
Fetch the latest AAII Investor Sentiment Survey via the Wayback Machine
(since aaii.com blocks direct scraping) and refresh data/aaii.csv.

Runs as part of the daily update workflow. AAII publishes weekly on Thursdays,
so most daily runs won't find anything new — that's expected. If the fetch or
parse fails, the existing CSV is left unchanged.
"""

from __future__ import annotations
import csv
import os
import sys
import tempfile
import urllib.request
import urllib.error

try:
    import xlrd  # type: ignore
except ImportError:
    print("::warning::xlrd not installed; skipping AAII refresh")
    sys.exit(0)

AAII_URL = "https://www.aaii.com/files/surveys/sentiment.xls"
WAYBACK_AVAILABLE = (
    "https://archive.org/wayback/available?"
    "url=aaii.com/files/surveys/sentiment.xls"
)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "aaii.csv")


def latest_snapshot_url() -> str | None:
    """Ask the Wayback Machine for the most recent snapshot URL, if any."""
    try:
        with urllib.request.urlopen(WAYBACK_AVAILABLE, timeout=30) as r:
            data = r.read().decode()
        import json
        j = json.loads(data)
        snap = j.get("archived_snapshots", {}).get("closest", {})
        if snap.get("available") and snap.get("status") == "200":
            # `if_/` in the path returns the raw file, not the Wayback UI wrapper.
            u = snap["url"].replace("/web/", "/web/", 1)
            u = u.replace(snap["timestamp"] + "/", snap["timestamp"] + "if_/")
            return u
    except (urllib.error.URLError, KeyError, ValueError) as e:
        print(f"::warning::Wayback lookup failed: {e}")
    return None


def fetch_xls(url: str) -> str | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        if len(data) < 100_000:
            print(f"::warning::AAII XLS suspiciously small ({len(data)} bytes)")
            return None
        f = tempfile.NamedTemporaryFile(delete=False, suffix=".xls")
        f.write(data)
        f.close()
        return f.name
    except urllib.error.URLError as e:
        print(f"::warning::Failed to fetch AAII XLS: {e}")
        return None


def parse_xls(path: str) -> list[list[str]] | None:
    """Return [(date, bullish, neutral, bearish, spread), ...] as strings."""
    try:
        wb = xlrd.open_workbook(path)
        sh = wb.sheet_by_index(0)
    except Exception as e:  # noqa: BLE001
        print(f"::warning::xlrd could not open the AAII XLS: {e}")
        return None

    rows: list[list[str]] = []
    for r in range(sh.nrows):
        v = sh.cell(r, 0).value
        if not isinstance(v, float) or v <= 10000:
            continue
        try:
            dt = xlrd.xldate_as_datetime(v, wb.datemode).strftime("%Y-%m-%d")
        except Exception:  # noqa: BLE001
            continue
        b = sh.cell(r, 1).value
        n = sh.cell(r, 2).value
        e = sh.cell(r, 3).value
        if not (isinstance(b, float) and isinstance(n, float) and isinstance(e, float)):
            continue
        if not (0 <= b <= 1 and 0 <= n <= 1 and 0 <= e <= 1):
            continue
        total = b + n + e
        if not (0.98 < total < 1.02):
            continue
        rows.append([
            dt,
            f"{b*100:.4f}",
            f"{n*100:.4f}",
            f"{e*100:.4f}",
            f"{(b - e)*100:.4f}",
        ])
    return rows or None


def main() -> int:
    url = latest_snapshot_url()
    if not url:
        print("::warning::No Wayback snapshot available; leaving aaii.csv unchanged")
        return 0

    xls_path = fetch_xls(url)
    if not xls_path:
        return 0

    rows = parse_xls(xls_path)
    try:
        os.unlink(xls_path)
    except OSError:
        pass
    if not rows:
        print("::warning::AAII parse produced no rows; leaving aaii.csv unchanged")
        return 0
    if len(rows) < 100:
        print(f"::warning::Suspiciously few AAII rows ({len(rows)}); leaving unchanged")
        return 0

    with open(OUT_PATH, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date", "Bullish", "Neutral", "Bearish", "BullBearSpread"])
        w.writerows(rows)
    print(f"Updated {OUT_PATH} ({len(rows)} rows, latest {rows[-1][0]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
