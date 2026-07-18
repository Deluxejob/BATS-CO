"""Refresh the Nancy Pelosi trades snapshot used by pelosi.html.

Source: insiderfinance.io — their public politician page ships a full
Next.js __NEXT_DATA__ blob with the parsed PTR data (trades, per-trade
P&L, aggregate performance, chart series, sector allocation, top
issuers). We fetch the page, extract the blob, keep only the fields
the page renders, and write everything to data/pelosi.json.

Attribution + polite scraping:
  - We hit their page once per daily run.
  - The page credits insiderfinance.io as the data source.
  - If they ever object we can swap to parsing the House Clerk PDFs
    directly (the pelosi.html stub notes that fallback).

The script is tolerant of "no new trades" — it always overwrites the
JSON with the freshest snapshot regardless of whether anything changed.
"""
import datetime as dt
import json
import os
import re
import sys
import urllib.request

URL     = "https://www.insiderfinance.io/congress-trades/politician/nancy-pelosi"
UA      = "Mozilla/5.0 (BATS.CO daily update; +https://bats.co)"
OUT     = os.path.join(os.path.dirname(__file__), "..", "data", "pelosi.json")
TIMEOUT = 30


def fetch_next_data(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        html = r.read().decode("utf-8", "ignore")
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not m:
        raise RuntimeError("no __NEXT_DATA__ script in response")
    return json.loads(m.group(1))


def main() -> int:
    payload = fetch_next_data(URL)
    pp = payload.get("props", {}).get("pageProps") or {}

    trades      = pp.get("trades") or []
    person      = pp.get("person") or {}
    performance = pp.get("performanceMetrics") or {}
    chart       = pp.get("chartData") or {}

    if not trades or not person:
        raise RuntimeError("pageProps missing trades or person - upstream schema changed?")

    out = {
        "fetched_at":  dt.datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "source_url":  URL,
        "person":      person,
        "performance": performance,
        "trades":      trades,
        "chart":       chart,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, default=str)

    print(
        f"wrote {OUT}: {len(trades)} trades, "
        f"latest={person.get('lastTradeDate')}, netWorth=${person.get('netWorth', 0):,.0f}"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        # Tolerant failure — daily workflow shouldn't abort other steps if
        # insiderfinance temporarily blocks us. Just log and move on.
        print(f"WARN: pelosi refresh failed: {e}", file=sys.stderr)
        sys.exit(0)
