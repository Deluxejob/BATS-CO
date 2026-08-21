#!/usr/bin/env python3
"""
Build data/eps_scan.json — the source data for eps-scan.html.

Iterates a curated universe of ~260 US large-caps (union of top S&P 500
by market cap + full Nasdaq 100), pulls three EPS metrics per name via
the yfinance library (which handles Yahoo's crumb + cookie dance
internally), and writes the pre-sorted rankings the frontend renders:

  1. Latest report EPS growth (YoY): Yahoo's own quarterly EPS growth
     figure (info["earningsQuarterlyGrowth"]) — same fiscal quarter one
     year ago vs the most recent report
  2. Next quarter expected growth (YoY): analyst-consensus growth rate
     for the upcoming quarter (growth_estimates DataFrame, +1q period)
  3. Estimate revisions (positive net): analysts who raised their +1q
     forward-quarter estimate in the last 30 days minus those who
     lowered it (eps_revisions DataFrame)

Runs as part of the daily update workflow. On each run this fetches
fresh data for every ticker in UNIVERSE (~260 calls, ~3-5 minutes with
yfinance's polite rate-limiting). If fewer than MIN_COVERAGE names
parse cleanly, the existing JSON is left untouched so we never publish
a half-baked scan.
"""

from __future__ import annotations

import json
import sys
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path

# yfinance emits a lot of chatter — quiet the noisy warnings so the
# workflow log stays scannable.
warnings.filterwarnings("ignore")

try:
    import yfinance as yf
except ImportError:
    print("::error::yfinance not installed. Run: pip install yfinance", file=sys.stderr)
    sys.exit(1)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT  = ROOT / "data" / "eps_scan.json"

# Union of top S&P 500 by market cap + Nasdaq 100. Deduplicated below.
UNIVERSE = [
    # Mega-caps
    "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "NVDA", "META", "TSLA",
    "BRK-B", "AVGO", "LLY", "JPM", "V", "WMT", "XOM", "UNH", "MA",
    "PG", "COST", "JNJ", "HD", "ORCL", "NFLX", "BAC", "ABBV", "CVX",
    "KO", "PLTR", "AMD", "TMUS", "CRM", "PEP", "MRK", "ADBE", "LIN",
    "CSCO", "ACN", "WFC", "TMO", "MCD", "ABT", "IBM", "DIS", "GE",
    "PM", "AXP", "NOW", "INTU", "ISRG", "CAT", "GS", "MS", "TXN",
    "T", "VZ", "QCOM", "AMGN", "PFE", "RTX", "BKNG", "DHR", "SPGI",
    "NEE", "COP", "PGR", "LOW", "UNP", "HON", "CMCSA", "AMAT", "SYK",
    "SCHW", "TJX", "BLK", "C", "PANW", "ETN", "BSX", "VRTX", "LMT",
    "GILD", "PLD", "ADP", "BMY", "MU", "ANET", "ADI", "MDT", "SBUX",
    "DE", "CB", "MMC", "UPS", "ELV", "REGN", "LRCX", "AMT", "GEV",
    "SO", "KLAC", "ZTS", "MDLZ", "FI", "CI", "APH", "BX", "PNC",
    # Tech / semis / software
    "ORLY", "TT", "CTAS", "SHW", "USB", "DUK", "MRVL", "SNPS", "CDNS",
    "PYPL", "CSX", "WELL", "MO", "APO", "EMR", "AON", "COF", "WM",
    "MCK", "EOG", "APD", "ITW", "TRV", "AJG", "MSI", "NKE", "FDX",
    "MMM", "COR", "GD", "CVS", "PSX", "PH", "NOC", "AZO", "PSA",
    "TGT", "TFC", "CARR", "SLB", "OKE", "MPC", "AFL", "SRE", "AIG",
    # Health, biotech
    "MRNA", "BIIB", "IDXX", "DXCM", "IQV", "GEHC", "ALGN", "HUM",
    "MCO", "ROP", "ICE", "SPG", "F", "GM", "CL", "KMB", "GIS",
    "STZ", "MNST", "KDP", "K", "HSY", "SJM",
    # Semis / Nasdaq 100 tail
    "ASML", "INTC", "ON", "MCHP", "GFS", "NXPI", "ARM", "TER", "SWKS",
    "CDW", "ANSS", "FTNT", "CRWD", "ZS", "DDOG", "TEAM", "MDB",
    "WDAY", "ADSK", "PAYC", "PAYX", "VRSK", "VRSN",
    # Consumer / cyclical / online
    "MELI", "LULU", "ROST", "MAR", "ABNB", "PDD", "JD", "EA", "TTD",
    "DASH", "UBER", "LYFT", "PINS", "SNAP", "RBLX", "SPOT",
    # Industrials + energy
    "CTVA", "CF", "DOW", "LYB", "ALB", "NUE", "STLD", "PPG", "ECL",
    "AWK", "AEP", "EXC", "D", "XEL", "ED", "EIX", "ETR", "WEC",
    # Financials
    "MET", "PRU", "ALL", "HIG", "TROW", "BK", "STT", "NTRS", "MTB",
    # Real estate
    "DLR", "EQIX", "O", "CCI", "EXR",
    # Materials + misc
    "FCX", "NEM", "GOLD",
    # Nasdaq 100 tail we haven't hit yet
    "SMCI", "CEG", "PCAR", "FAST", "ODFL", "CTSH", "BKR", "AZN",
    "WBA", "WBD", "SIRI", "CHTR", "KHC",
    # Additional big-cap tech + comms
    "SNOW", "SHOP", "NET", "TWLO", "DOCU", "ZM", "OKTA",
]
UNIVERSE = list(dict.fromkeys(UNIVERSE))   # dedupe preserving order

MIN_COVERAGE = 100        # need this many parsed rows or bail
REQUEST_DELAY = 0.4       # polite pacing (yfinance also throttles internally)
TOP_N = 25                # rows per ranking


def warn(msg: str) -> None:
    print(f"::warning::{msg}", file=sys.stderr)


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def _num(v):
    """Coerce to float, treat NaN / None / non-numeric as None."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None   # NaN check


def extract_metrics(sym: str) -> dict | None:
    """Return a metrics dict for `sym`, or None on failure."""
    try:
        t = yf.Ticker(sym)
    except Exception:
        return None

    # Guard every call — yfinance sometimes returns None or raises when
    # a symbol is delisted / renamed / newly-listed.
    info = {}
    try:
        info = t.info or {}
    except Exception:
        info = {}
    if not info or not info.get("symbol"):
        return None

    name    = info.get("longName") or info.get("shortName") or sym
    sector  = info.get("sector") or ""
    mkt_cap = _num(info.get("marketCap"))

    # --- Metric 1: latest quarterly EPS YoY growth ---------------------
    # Yahoo pre-computes this as info["earningsQuarterlyGrowth"] — same
    # fiscal quarter one year ago vs the most recent report. Decimal
    # form (0.27 = +27%; 46.594 = +4659%).
    latest_yoy_growth = _num(info.get("earningsQuarterlyGrowth"))

    # Grab the actual EPS from the last reported quarter. yfinance's
    # earnings_history returns 4 rows and its oldest row is only 3
    # quarters before the newest (4 rows = 3 gaps), so it CAN'T give
    # us a true year-ago quarter. Instead, derive the year-ago actual
    # from Yahoo's own YoY growth field, which is computed internally
    # against the true same-quarter-prior-year:
    #   year_ago = latest / (1 + growth)
    # This keeps latest / year-ago / growth internally consistent on the
    # rendered table (a huge growth % will now visibly correspond to a
    # tiny year-ago EPS, so the reader can spot low-denominator noise).
    latest_period = ""
    latest_actual = None
    year_ago_actual = None
    try:
        eh = t.earnings_history
    except Exception:
        eh = None
    if eh is not None and not eh.empty and "epsActual" in eh.columns:
        rows = eh.dropna(subset=["epsActual"]).sort_index()
        if len(rows) >= 1:
            latest_row = rows.iloc[-1]
            latest_period = str(rows.index[-1])[:10]
            latest_actual = _num(latest_row.get("epsActual"))
    # Derive year-ago from Yahoo's growth field (only valid when we have
    # both a latest actual AND a valid growth number, AND the derivation
    # doesn't blow up — guard against growth = -1 which would /0).
    if (latest_actual is not None
        and latest_yoy_growth is not None
        and (1 + latest_yoy_growth) != 0):
        year_ago_actual = latest_actual / (1 + latest_yoy_growth)

    # --- Metric 2: next quarter expected growth (YoY consensus) --------
    next_q_growth = None
    try:
        ge = t.growth_estimates
        if ge is not None and not ge.empty and "+1q" in ge.index:
            next_q_growth = _num(ge.loc["+1q", "stockTrend"])
    except Exception:
        pass

    # Also grab the raw consensus EPS + analyst count for display.
    next_q_est = None
    next_q_analysts = None
    next_q_end_date = ""
    try:
        ee = t.earnings_estimate
        if ee is not None and not ee.empty and "+1q" in ee.index:
            next_q_est      = _num(ee.loc["+1q", "avg"])
            next_q_analysts = _num(ee.loc["+1q", "numberOfAnalysts"])
    except Exception:
        pass

    # Next-earnings-date from info (Yahoo returns a timestamp)
    ts = info.get("earningsTimestamp") or info.get("earningsTimestampStart")
    if ts and isinstance(ts, (int, float)):
        try:
            next_q_end_date = datetime.utcfromtimestamp(ts).date().isoformat()
        except Exception:
            next_q_end_date = ""

    # --- Metric 3: estimate revisions (net upward, last 30 days) -------
    # Prefer +1q (most immediate). Fall back to 0y if +1q is missing.
    up30 = down30 = up7 = down7 = None
    try:
        er = t.eps_revisions
        if er is not None and not er.empty:
            # yfinance sometimes returns 'downLast7Days' (capital D). Handle both.
            def _col(row, base):
                for cand in (base, base[0].lower() + base[1:], base.replace("D", "d")):
                    if cand in er.columns:
                        v = row.get(cand)
                        if v is not None:
                            return _num(v)
                return None
            for period in ("+1q", "0y"):
                if period in er.index:
                    row = er.loc[period]
                    _up30   = _col(row, "upLast30days")
                    _down30 = _col(row, "downLast30days")
                    _up7    = _col(row, "upLast7days")
                    _down7  = _col(row, "downLast7days")
                    if _up30 is not None or _down30 is not None:
                        up30, down30, up7, down7 = _up30, _down30, _up7, _down7
                        break
    except Exception:
        pass

    revisions_net30 = None
    if up30 is not None or down30 is not None:
        revisions_net30 = (up30 or 0) - (down30 or 0)

    return {
        "sym":                sym,
        "name":               name,
        "sector":             sector,
        "marketCap":          mkt_cap,
        # Metric 1
        "latestQuarter":      latest_period,
        "latestActual":       latest_actual,
        "priorYearActual":    year_ago_actual,
        "latestYoYGrowth":    latest_yoy_growth,
        # Metric 2
        "nextQuarterEndDate": next_q_end_date,
        "nextQuarterEst":     next_q_est,
        "nextQuarterAnalysts": next_q_analysts,
        "nextQuarterGrowth":  next_q_growth,
        # Metric 3
        "revisionsUp30":      up30,
        "revisionsDown30":    down30,
        "revisionsUp7":       up7,
        "revisionsDown7":     down7,
        "revisionsNet30":     revisions_net30,
    }


def _pct(v):
    if v is None:
        return "n/a"
    return f"{v*100:+.1f}%"


def main() -> int:
    all_rows = []
    misses  = 0
    for i, sym in enumerate(UNIVERSE, 1):
        if i > 1:
            time.sleep(REQUEST_DELAY)
        row = extract_metrics(sym)
        if row is None:
            misses += 1
            log(f"[{i:>3}/{len(UNIVERSE)}] {sym:<6} MISS")
            continue
        all_rows.append(row)
        m1, m2, m3 = row["latestYoYGrowth"], row["nextQuarterGrowth"], row["revisionsNet30"]
        log(
            f"[{i:>3}/{len(UNIVERSE)}] {sym:<6} "
            f"m1={_pct(m1):>7}  m2={_pct(m2):>7}  m3={m3 if m3 is not None else 'n/a'}"
        )

    if len(all_rows) < MIN_COVERAGE:
        warn(
            f"only {len(all_rows)}/{len(UNIVERSE)} names parsed "
            f"(need {MIN_COVERAGE}) — leaving existing eps_scan.json in place"
        )
        return 1

    def top_by(field: str, reverse: bool = True, floor=None, filter_fn=None):
        pool = [r for r in all_rows if r.get(field) is not None]
        if floor is not None:
            pool = [r for r in pool if r[field] >= floor]
        if filter_fn is not None:
            pool = [r for r in pool if filter_fn(r)]
        pool.sort(key=lambda r: r[field], reverse=reverse)
        return pool[:TOP_N]

    # Best Reports filter: exclude companies whose prior-year quarterly
    # EPS was under $0.10 (in absolute terms). This weeds out the
    # tiny-denominator artifacts (e.g. a swing from $0.01 to $1.00 is
    # a mathematical +9900% but not a "genuinely accelerating profit
    # cycle" — it's noise, not signal). Keeps genuine 3x-5x growth
    # stories intact.
    def _real_growth_row(r):
        y = r.get("priorYearActual")
        return y is not None and abs(y) >= 0.10

    payload = {
        "generatedAt": int(time.time()),
        "generatedAtIso": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "universeSize": len(UNIVERSE),
        "coverage": len(all_rows),
        "misses": misses,
        # Full rows (~260) for debugging / future features
        "rows": all_rows,
        # Pre-sorted top-N lists the frontend renders directly
        "topBestReports":       top_by("latestYoYGrowth", filter_fn=_real_growth_row),
        "topExpectedGrowth":    top_by("nextQuarterGrowth"),
        "topRevisionsHigher":   top_by("revisionsNet30", floor=1),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2))
    log(f"wrote {OUT} — coverage {len(all_rows)}/{len(UNIVERSE)}, {misses} misses")
    return 0


if __name__ == "__main__":
    sys.exit(main())
