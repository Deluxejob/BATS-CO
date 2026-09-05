#!/usr/bin/env python3
"""
Backtest the iQuant.pro "RSI < 40 OR NFCI < SMA50" QQQ strategy.

The rule (per iQuant marketing material dated 2026-09-02):
    Be LONG QQQ when EITHER
        RSI(QQQ, 14) < 40                       (tech gate: oversold)
      OR
        NFCI < 50-period SMA of NFCI            (macro gate: credit
                                                 conditions loosening)
    Otherwise sit in CASH (0% return).

Claimed results since QQQ inception (1999-03-10) through Sep 2026:
    Strategy: total return 11,563.48%, CAGR 18.91%, Sharpe 0.89
    Buy&Hold: total return  1,542.47%, CAGR 10.72%, Sharpe 0.51

We test both interpretations of "SMA50":
    (A) 50 trading days of NFCI (forward-filled from weekly to daily).
    (B) 50 weeks of NFCI (~1 year, slower macro filter).

Data sources:
    - QQQ daily closes from data/qqq.csv (already in the repo).
    - NFCI weekly from the St. Louis Fed FRED CSV endpoint (no key
      required): https://fred.stlouisfed.org/graph/fredgraph.csv?id=NFCI
      Weekly, published Wednesday for the previous Friday's data.

Prints a full metrics comparison + a period-by-period breakdown of
each major bear market so we can see whether the strategy actually
side-stepped the drawdowns it claims to.

Read-only. Writes nothing to disk; NFCI is fetched fresh each run
so a re-run picks up new weekly prints. (If we productionize this
we'll add a persistent data/nfci.csv updated by a cron.)
"""
from __future__ import annotations
import csv
import io
import os
import sys
import urllib.request
from statistics import mean, stdev

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR  = os.path.join(REPO_ROOT, "data")

# CLI: --symbol SMH (default QQQ). Uses data/<symbol>.csv.
SYMBOL = "QQQ"
for i, a in enumerate(sys.argv[1:]):
    if a in ("--symbol", "-s") and i + 2 <= len(sys.argv) - 1:
        SYMBOL = sys.argv[i + 2].upper()
    elif a.startswith("--symbol="):
        SYMBOL = a.split("=", 1)[1].upper()
ASSET_PATH = os.path.join(DATA_DIR, f"{SYMBOL.lower()}.csv")

FRED_NFCI = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=NFCI"


# --------------------------- data loading ---------------------------------
def load_date_close(path: str, col: int = 1) -> list[tuple[str, float]]:
    rows: list[tuple[str, float]] = []
    with open(path, encoding="utf-8") as f:
        r = csv.reader(f)
        next(r, None)
        for parts in r:
            if len(parts) <= col:
                continue
            try:
                v = float(parts[col])
            except ValueError:
                continue
            if parts[0]:
                rows.append((parts[0], v))
    return rows


def fetch_nfci() -> list[tuple[str, float]]:
    print("Fetching NFCI from FRED...")
    req = urllib.request.Request(
        FRED_NFCI, headers={"User-Agent": "BATS.CO backtest fetcher"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        text = r.read().decode("utf-8")
    out = []
    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)
    for row in reader:
        if len(row) < 2:
            continue
        d = row[0].strip()
        try:
            v = float(row[1])
        except ValueError:
            continue
        if d:
            out.append((d, v))
    print(f"  {len(out):,} weekly NFCI readings ({out[0][0]} to {out[-1][0]})")
    return out


# --------------------------- indicators -----------------------------------
def compute_rsi_wilder(closes: list[float], period: int = 14) -> list[float | None]:
    n = len(closes)
    rsi: list[float | None] = [None] * n
    if n <= period:
        return rsi
    gains, losses = [], []
    for i in range(1, period + 1):
        chg = closes[i] - closes[i - 1]
        gains.append(max(chg, 0))
        losses.append(max(-chg, 0))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    rsi[period] = 100 - (100 / (1 + avg_gain / avg_loss)) if avg_loss > 0 else 100.0
    for i in range(period + 1, n):
        chg = closes[i] - closes[i - 1]
        g = max(chg, 0)
        l = max(-chg, 0)
        avg_gain = (avg_gain * (period - 1) + g) / period
        avg_loss = (avg_loss * (period - 1) + l) / period
        rsi[i] = 100 - (100 / (1 + avg_gain / avg_loss)) if avg_loss > 0 else 100.0
    return rsi


def compute_sma(vals: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(vals)
    running = 0.0
    for i, v in enumerate(vals):
        running += v
        if i >= period:
            running -= vals[i - period]
        if i >= period - 1:
            out[i] = running / period
    return out


# --------------------------- backtest driver ------------------------------
def run_backtest(qqq_dates: list[str], qqq_close: list[float],
                 invested: list[bool]) -> dict:
    """Given a boolean 'invested?' vector, run the strategy: hold QQQ
    when True, cash (0% return) when False. Returns final equity + a
    daily equity curve keyed to qqq_dates."""
    eq = 1.0  # start with $1 (results scale linearly)
    curve = [eq]
    peak = eq
    max_dd = 0.0
    for i in range(1, len(qqq_dates)):
        if invested[i - 1]:
            eq *= qqq_close[i] / qqq_close[i - 1]
        # else eq unchanged (cash, 0% return)
        curve.append(eq)
        if eq > peak:
            peak = eq
        dd = eq / peak - 1
        if dd < max_dd:
            max_dd = dd
    daily_returns = [(curve[i] / curve[i - 1] - 1) for i in range(1, len(curve))]
    # Sharpe on daily excess-of-zero returns, annualized (~252 trading days).
    if daily_returns:
        m = mean(daily_returns)
        sd = stdev(daily_returns) if len(daily_returns) > 1 else 0.0
        sharpe = (m / sd * (252 ** 0.5)) if sd > 0 else 0.0
    else:
        sharpe = 0.0
    years = (len(qqq_dates) - 1) / 252
    cagr = (eq ** (1 / years) - 1) if years > 0 else 0.0
    return {
        "final_eq":   eq,
        "total_ret":  (eq - 1) * 100,
        "cagr":       cagr * 100,
        "sharpe":     sharpe,
        "max_dd":     max_dd * 100,
        "curve":      curve,
    }


def main() -> int:
    qqq_rows = load_date_close(ASSET_PATH)
    if not qqq_rows:
        print(f"No {SYMBOL} data at {ASSET_PATH}"); return 1
    qqq_dates = [d for d, _ in qqq_rows]
    qqq_close = [c for _, c in qqq_rows]
    print(f"{SYMBOL}: {len(qqq_rows):,} daily closes  ({qqq_dates[0]} to {qqq_dates[-1]})")

    try:
        nfci_rows = fetch_nfci()
    except Exception as e:
        print(f"::error::Failed to fetch NFCI: {e}"); return 1
    if not nfci_rows:
        print("NFCI returned empty"); return 1

    # RSI on QQQ (14-day Wilder).
    rsi = compute_rsi_wilder(qqq_close, 14)

    # Forward-fill NFCI to daily. Weekly readings map to every trading day
    # from that reading's date until the next weekly reading arrives.
    nfci_map = dict(nfci_rows)
    nfci_dates_sorted = sorted(nfci_map)
    nfci_daily: list[float | None] = [None] * len(qqq_dates)
    j = 0
    last_val: float | None = None
    for i, d in enumerate(qqq_dates):
        # Advance the NFCI pointer past every reading whose date <= d.
        while j < len(nfci_dates_sorted) and nfci_dates_sorted[j] <= d:
            last_val = nfci_map[nfci_dates_sorted[j]]
            j += 1
        nfci_daily[i] = last_val
    n_missing = sum(1 for v in nfci_daily if v is None)
    print(f"NFCI: forward-filled to daily, {n_missing:,} days missing (early QQQ history before first NFCI reading)")

    # Interpretation A: SMA50 on the daily forward-filled NFCI (50 trading days = ~10 weeks).
    # Compute over non-None slice only.
    nfci_valid_pairs = [(i, v) for i, v in enumerate(nfci_daily) if v is not None]
    nfci_seq = [v for _, v in nfci_valid_pairs]
    smaA_seq = compute_sma(nfci_seq, 50)
    smaA_daily: list[float | None] = [None] * len(qqq_dates)
    for (i, _), s in zip(nfci_valid_pairs, smaA_seq):
        smaA_daily[i] = s

    # Interpretation B: SMA50 on the WEEKLY NFCI (~1 year), then forward-fill.
    weekly_dates = [d for d, _ in nfci_rows]
    weekly_vals  = [v for _, v in nfci_rows]
    smaB_weekly  = compute_sma(weekly_vals, 50)
    smaB_by_date = {d: s for d, s in zip(weekly_dates, smaB_weekly) if s is not None}
    smaB_dates_sorted = sorted(smaB_by_date)
    smaB_daily: list[float | None] = [None] * len(qqq_dates)
    j2 = 0
    last_smaB: float | None = None
    for i, d in enumerate(qqq_dates):
        while j2 < len(smaB_dates_sorted) and smaB_dates_sorted[j2] <= d:
            last_smaB = smaB_by_date[smaB_dates_sorted[j2]]
            j2 += 1
        smaB_daily[i] = last_smaB

    # Signal generation.
    # invested_today = (RSI < 40)  OR  (NFCI < SMA50)
    def build_invested(sma_daily: list[float | None]) -> tuple[list[bool], int]:
        invested = [False] * len(qqq_dates)
        first = None
        for i in range(len(qqq_dates)):
            r = rsi[i]
            n = nfci_daily[i]
            s = sma_daily[i]
            # Need at least one gate to have data for us to evaluate.
            tech_ok = r is not None and r < 40
            macro_ok = (n is not None and s is not None and n < s)
            if r is None and s is None:
                continue
            if first is None:
                first = i
            invested[i] = tech_ok or macro_ok
        return invested, (first or 0)

    invA, firstA = build_invested(smaA_daily)
    invB, firstB = build_invested(smaB_daily)

    # Trim to whichever start date is later so the two comparisons run on
    # the same aligned window (fairness).
    first = max(firstA, firstB)
    # Buy-and-hold baseline.
    inv_bh = [True] * len(qqq_dates)

    def run_from(inv: list[bool]) -> dict:
        d_slice = qqq_dates[first:]
        c_slice = qqq_close[first:]
        i_slice = inv[first:]
        return run_backtest(d_slice, c_slice, i_slice)

    resA = run_from(invA)
    resB = run_from(invB)
    resBH = run_from(inv_bh)

    def pct_days_invested(inv, first_i):
        s = inv[first_i:]
        return sum(1 for x in s if x) / max(1, len(s)) * 100

    print(f"\nAligned backtest window: {qqq_dates[first]} to {qqq_dates[-1]}")
    print(f"({len(qqq_dates) - first:,} trading days, ~{(len(qqq_dates) - first) / 252:.1f} years)\n")

    def print_result(name, r, pct_invested=None):
        line = f"  {name:<40} final ${r['final_eq']:>10.2f}   total {r['total_ret']:>9,.1f}%   CAGR {r['cagr']:>5.2f}%   Sharpe {r['sharpe']:>5.2f}   max DD {r['max_dd']:>6.1f}%"
        if pct_invested is not None:
            line += f"   invested {pct_invested:>5.1f}% of days"
        print(line)

    print("RESULTS (starting from $1):")
    print_result("Buy & Hold QQQ",                                       resBH)
    print_result("Strategy (SMA50 = 50 trading days)",  resA, pct_days_invested(invA, first))
    print_result("Strategy (SMA50 = 50 weeks)",         resB, pct_days_invested(invB, first))

    # Scaled to $10,000 starting balance so the numbers line up with
    # iQuant's marketing ("$10K → $1.16M").
    print("\nSCALED to $10,000 starting balance:")
    for name, r in [("Buy & Hold QQQ", resBH),
                    ("Strategy (SMA50 = 50 days)", resA),
                    ("Strategy (SMA50 = 50 weeks)", resB)]:
        print(f"  {name:<40} final ${r['final_eq'] * 10_000:>14,.0f}")

    # Bear-market side-step check.
    events = [
        ("Dot-com bust",   "2000-03-10", "2002-10-09"),
        ("GFC",            "2007-10-09", "2009-03-09"),
        ("2011 downgrade", "2011-04-29", "2011-10-03"),
        ("2018 Q4 selloff","2018-09-20", "2018-12-24"),
        ("COVID crash",    "2020-02-19", "2020-03-23"),
        ("2022 rate-hike", "2021-11-19", "2022-10-12"),
    ]
    idx_by_date = {d: i for i, d in enumerate(qqq_dates)}
    print("\nBEAR-MARKET SIDE-STEP CHECK (QQQ change vs strategy A vs strategy B):")
    for label, start, end in events:
        if start not in idx_by_date or end not in idx_by_date:
            continue
        i0, i1 = idx_by_date[start], idx_by_date[end]
        bh = qqq_close[i1] / qqq_close[i0] - 1
        def strat_return(inv):
            eq = 1.0
            for k in range(i0 + 1, i1 + 1):
                if inv[k - 1]:
                    eq *= qqq_close[k] / qqq_close[k - 1]
            return eq - 1
        rA = strat_return(invA)
        rB = strat_return(invB)
        print(f"  {label:<20} {start} -> {end}   QQQ B&H {bh * 100:>+7.1f}%   A {rA * 100:>+7.1f}%   B {rB * 100:>+7.1f}%")

    return 0


if __name__ == "__main__":
    sys.exit(main())
