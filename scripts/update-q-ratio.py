#!/usr/bin/env python3
"""
Compute Tobin's Q for US nonfinancial corporations from FRED data and
write data/q_ratio.csv.

Formula: NCBEILQ027S / TNWMVBSNNCB
  NCBEILQ027S  Fed Z.1: Nonfinancial Corporate Business, Corporate Equities
               as a Liability, level, millions of USD (what the stock market
               says the companies are worth)
  TNWMVBSNNCB  Fed Z.1: Nonfinancial Corporate Business, Net Worth at
               Market Value, level, millions of USD (what their assets would
               cost to replace, net of debt)

James Tobin's idea (1969): when Q is well above 1, the market values firms
at far more than it would cost to rebuild them, so capital should flow into
new investment rather than existing shares; when it is well below 1, buying
companies is cheaper than building them. In practice the series has a
long-run average near 0.7 and peaks at the 1929, 2000 and 2021 tops.

Both series are quarterly; the output is quarterly, one row per Z.1
quarter (dated the first day of that quarter, as FRED dates them).

Read by the composite valuation percentile on valuations.html, which
ranks it against its own history alongside the trailing PE, Shiller CAPE
and the Buffett indicator.

Safe on failure: if either fetch or the compute breaks, the existing CSV
is left alone and a warning is logged. Always exits 0.
"""

from __future__ import annotations
import csv
import os
import sys
import urllib.request

FRED_EQUITY   = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=NCBEILQ027S"
FRED_NETWORTH = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=TNWMVBSNNCB"
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH  = os.path.join(REPO_ROOT, "data", "q_ratio.csv")


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


def fetch_fred_series(url: str, label: str) -> list[tuple[str, float]]:
    """Return [(YYYY-MM-DD, value)] sorted by date. Empty on failure."""
    # FRED's fredgraph.csv endpoint rejects browser-style user-agents; a
    # curl-style one passes (same trick as update-buffett-indicator.py).
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
        with urllib.request.urlopen(req, timeout=45) as r:
            text = r.read().decode("utf-8", errors="ignore")
    except Exception as exc:  # noqa: BLE001
        warn(f"FRED {label} fetch failed: {exc}")
        return []
    rows: list[tuple[str, float]] = []
    for line in text.strip().splitlines()[1:]:
        parts = line.split(",")
        if len(parts) < 2:
            continue
        date, val = parts[0].strip(), parts[1].strip()
        if val in ("", ".", "NA"):
            continue
        try:
            rows.append((date, float(val)))
        except ValueError:
            continue
    rows.sort(key=lambda x: x[0])
    return rows


def existing_len(path: str) -> int:
    try:
        with open(path, encoding="utf-8") as f:
            return max(0, sum(1 for _ in f) - 1)
    except OSError:
        return 0


def main() -> int:
    equity = fetch_fred_series(FRED_EQUITY, "NCBEILQ027S (nonfin corp equity)")
    worth  = fetch_fred_series(FRED_NETWORTH, "TNWMVBSNNCB (nonfin corp net worth)")
    if not equity or not worth:
        return 0
    worth_by_date = dict(worth)
    out: list[tuple[str, float]] = []
    for date, eq in equity:
        nw = worth_by_date.get(date)
        if nw is None or nw <= 0:
            continue
        out.append((date, eq / nw))
    if len(out) < 100:
        warn(f"Q ratio: only {len(out)} overlapping quarters; leaving the file unchanged")
        return 0
    if len(out) < existing_len(OUT_PATH):
        warn(f"Q ratio: new series ({len(out)} rows) shorter than existing; leaving the file unchanged")
        return 0
    with open(OUT_PATH, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date", "Q"])
        for date, q in out:
            w.writerow([date, f"{q:.4f}"])
    print(f"Q ratio updated: {len(out)} quarterly rows, {out[0][0]} to {out[-1][0]}, latest = {out[-1][1]:.3f}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — never fail the nightly workflow
        warn(f"update-q-ratio.py crashed: {e}")
        sys.exit(0)
