#!/usr/bin/env python3
"""
Fetch the Chicago Fed National Financial Conditions Index (NFCI) and
its adjusted variant (ANFCI) from the St. Louis Fed's public FRED CSV
endpoint. Writes data/nfci.csv with two-column history:

    Date,NFCI,ANFCI

The NFCI is a weekly synthesis of ~105 measures of US financial activity.
Positive values = tighter-than-average conditions (stress). Negative =
looser (accommodative). Published Wednesday afternoons for the previous
Friday's data. Same 1971-to-present history for both series.

The Two-Gate Long/Cash QQQ signal on market-signals.html reads this
CSV client-side. If a run fails, the previous file stays in place —
the signal card degrades gracefully to whatever the last-known NFCI
value was, showing a stale note if the reading is more than 10 days
old.

Runs as part of the daily update workflow. Fast (two HTTP GETs, ~40KB
each) so no need to gate it behind a weekly-only cron.
"""
from __future__ import annotations
import csv
import io
import os
import sys
import urllib.request

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH  = os.path.join(REPO_ROOT, "data", "nfci.csv")

FRED_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv?id="


def fetch_series(series_id: str) -> dict[str, float]:
    """Return {date_str: value} for the given FRED series id."""
    url = FRED_BASE + series_id
    req = urllib.request.Request(url, headers={"User-Agent": "BATS.CO NFCI updater"})
    with urllib.request.urlopen(req, timeout=30) as r:
        text = r.read().decode("utf-8")
    out: dict[str, float] = {}
    reader = csv.reader(io.StringIO(text))
    next(reader, None)  # header
    for row in reader:
        if len(row) < 2:
            continue
        d = (row[0] or "").strip()
        try:
            v = float(row[1])
        except ValueError:
            continue
        if d:
            out[d] = v
    return out


def main() -> int:
    try:
        nfci  = fetch_series("NFCI")
        anfci = fetch_series("ANFCI")
    except Exception as e:
        print(f"::error::NFCI fetch failed: {e}")
        return 1
    if not nfci:
        print("::error::NFCI returned empty; leaving existing file alone.")
        return 1

    dates = sorted(set(nfci) | set(anfci))
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as f:
        w = csv.writer(f)
        w.writerow(["Date", "NFCI", "ANFCI"])
        for d in dates:
            n = nfci.get(d)
            a = anfci.get(d)
            w.writerow([
                d,
                "" if n is None else f"{n:.4f}",
                "" if a is None else f"{a:.4f}",
            ])
    print(f"Wrote {OUT_PATH}: {len(dates):,} weekly readings ({dates[0]} to {dates[-1]}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
