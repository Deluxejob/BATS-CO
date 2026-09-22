#!/usr/bin/env python3
"""
Build data/market_stats.json — a "total returns" sheet in the style of the
First Trust / Bloomberg one-pager: every major market in one table, with
YTD, 1 Wk, 1 Mo, 3 Mo, 6 Mo, 12 Mo and annualized 3 / 5 / 10 Yr columns.

Where Yahoo carries a total-return index with full history (S&P 500,
Russell 2000, Nasdaq Composite) the row is the index itself. Its other
"TR" symbols are one-bar stubs and the plain ^GSPC-style symbols are
price-only, so every other row is an ETF proxy (iShares wherever one
exists) and the returns are computed from Yahoo's dividend-adjusted daily closes — i.e. total return with distributions
reinvested, net of the fund's expense ratio. The proxy is published next
to each name so nobody mistakes a fund for its index.

Runs nightly from .github/workflows/update-data.yml after the close.
Tolerant by design: a symbol that fails keeps its previous row from the
existing JSON (if any); a total failure leaves the file untouched; the
script always exits 0 so it can never block the commit step.
"""

from __future__ import annotations
import json
import os
import sys
import time
import datetime as dt
import urllib.request
import urllib.error
import urllib.parse

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PATH = os.path.join(REPO_ROOT, "data", "market_stats.json")
UA = {"User-Agent": "Mozilla/5.0 (BATS.CO market-stats)"}
YEARS_BACK = 11          # 10-year column plus a little slack

# (name as printed on the sheet, ETF proxy, note shown in the popup)
GROUPS = [
    ("Major Equity Indices", [
        ("S&P 500",                        "^SP500TR", "S&P 500 Total Return index — the index itself, not a fund"),
        ("S&P MidCap 400",                 "IJH",    "iShares Core S&P Mid-Cap"),
        ("S&P SmallCap 600",               "IJR",    "iShares Core S&P Small-Cap"),
        ("S&P Composite 1500",             "ITOT",   "iShares Core S&P Total US Stock Market"),
        ("S&P/TSX Composite",              "XIC.TO", "iShares Core S&P/TSX Capped Composite — in CAD"),
        ("Russell 1000",                   "IWB",    "iShares Russell 1000"),
        ("Russell 2000",                   "^RUTTR",   "Russell 2000 Total Return index — the index itself, not a fund"),
        ("Russell 3000",                   "IWV",    "iShares Russell 3000"),
        ("Dow Jones Industrial Average",   "DIA",    "SPDR Dow Jones Industrial Average (no iShares Dow fund)"),
        ("Nasdaq Composite",               "^XCMP",    "Nasdaq Composite Total Return index — the index itself, not a fund"),
        ("MSCI ACWI ex USA",               "ACWX",   "iShares MSCI ACWI ex U.S."),
        ("MSCI Europe",                    "IEUR",   "iShares Core MSCI Europe"),
        ("MSCI EAFE",                      "EFA",    "iShares MSCI EAFE"),
        ("MSCI Emerging Markets",          "EEM",    "iShares MSCI Emerging Markets"),
        ("MSCI ACWI",                      "ACWI",   "iShares MSCI ACWI"),
        ("Alerian MLP",                    "AMLP",   "Alerian MLP ETF (no iShares fund)"),
    ]),
    ("Major Bond Indices", [
        ("ICE BofA US High Yield Constrained",                    "HYG",  "iShares iBoxx $ High Yield Corporate"),
        ("Morningstar LSTA US Leveraged Loan",                    "BKLN", "Invesco Senior Loan (no iShares fund)"),
        ("ICE BofA Fixed Rate Preferred Securities",              "PFF",  "iShares Preferred & Income Securities"),
        ("ICE BofA US Mortgage Backed Securities",                "MBB",  "iShares MBS"),
        ("ICE BofA US Investment Grade Institutional Capital Securities", "LQD", "iShares iBoxx $ Investment Grade Corporate"),
        ("ICE BofA US 3-Month Treasury",                          "SGOV", "iShares 0-3 Month Treasury Bond"),
        ("ICE BofA Current 2-Year US Treasury",                   "SHY",  "iShares 1-3 Year Treasury Bond"),
        ("ICE BofA Current 5-Year US Treasury",                   "IEI",  "iShares 3-7 Year Treasury Bond"),
        ("ICE BofA Current 10-Year US Treasury",                  "IEF",  "iShares 7-10 Year Treasury Bond"),
        ("ICE BofA Current 30-Year US Treasury",                  "TLT",  "iShares 20+ Year Treasury Bond"),
        ("Bloomberg Municipal High Yield",                        "HYD",  "VanEck High Yield Muni (no iShares fund)"),
        ("Bloomberg US Aggregate Bond",                           "AGG",  "iShares Core U.S. Aggregate Bond"),
        ("Bloomberg Global Aggregate",                            "BNDW", "Vanguard Total World Bond (no iShares fund)"),
    ]),
    ("Commodities Indices", [
        ("Bloomberg Commodity",  "BCI", "abrdn Bloomberg All Commodity Strategy K-1 Free (no iShares fund)"),
        ("S&P GSCI",             "GSG", "iShares S&P GSCI Commodity-Indexed Trust"),
        ("S&P GSCI Gold",        "IAU", "iShares Gold Trust"),
    ]),
    ("S&P 500 Economic Sectors", [
        ("Energy",                 "IYE", "iShares U.S. Energy"),
        ("Information Technology", "IYW", "iShares U.S. Technology"),
        ("Materials",              "IYM", "iShares U.S. Basic Materials"),
        ("Industrials",            "IYJ", "iShares U.S. Industrials"),
        ("Health Care",            "IYH", "iShares U.S. Healthcare"),
        ("Real Estate",            "IYR", "iShares U.S. Real Estate"),
        ("Consumer Staples",       "IYK", "iShares U.S. Consumer Staples"),
        ("Communication Services", "IYZ", "iShares U.S. Telecommunications"),
        ("Financials",             "IYF", "iShares U.S. Financials"),
        ("Utilities",              "IDU", "iShares U.S. Utilities"),
        ("Consumer Discretionary", "IYC", "iShares U.S. Consumer Discretionary"),
    ]),
    ("S&P Style Indices", [
        ("S&P 500 Growth",                "IVW",  "iShares S&P 500 Growth"),
        ("S&P 500 Value",                 "IVE",  "iShares S&P 500 Value"),
        ("S&P MidCap 400 Growth",         "IJK",  "iShares S&P Mid-Cap 400 Growth"),
        ("S&P MidCap 400 Value",          "IJJ",  "iShares S&P Mid-Cap 400 Value"),
        ("S&P SmallCap 600 Growth",       "IJT",  "iShares S&P Small-Cap 600 Growth"),
        ("S&P SmallCap 600 Value",        "IJS",  "iShares S&P Small-Cap 600 Value"),
        ("S&P 500 Equal Weighted",        "RSP",  "Invesco S&P 500 Equal Weight (no iShares fund)"),
        ("S&P 500 Dividend Aristocrats",  "NOBL", "ProShares S&P 500 Dividend Aristocrats (no iShares fund)"),
        ("MSCI USA Quality",              "QUAL", "iShares MSCI USA Quality Factor"),
        ("MSCI USA Minimum Volatility",   "USMV", "iShares MSCI USA Min Vol Factor"),
        ("MSCI USA Momentum",             "MTUM", "iShares MSCI USA Momentum Factor"),
        ("MSCI USA High Dividend Yield",  "HDV",  "iShares Core High Dividend"),
    ]),
]

COLUMNS = ["ytd", "w1", "m1", "m3", "m6", "m12", "y3", "y5", "y10"]


def log(msg):
    print(msg, flush=True)


def fetch_adjclose(sym):
    """Daily (date, adjusted close) pairs for the last YEARS_BACK years."""
    p2 = int(time.time())
    p1 = p2 - YEARS_BACK * 365 * 86400
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           + urllib.parse.quote(sym) + f"?period1={p1}&period2={p2}&interval=1d")
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        j = json.load(r)
    res = j["chart"]["result"][0]
    ts = res["timestamp"]
    ind = res["indicators"]
    adj = (ind.get("adjclose") or [{}])[0].get("adjclose") or ind["quote"][0]["close"]
    out = []
    for t, v in zip(ts, adj):
        if v is None:
            continue
        d = dt.datetime.fromtimestamp(t, dt.UTC).date()
        if out and out[-1][0] == d:     # fold a same-day live stub
            out[-1] = (d, float(v))
        else:
            out.append((d, float(v)))
    return out


def months_back(d, n):
    y, m = d.year, d.month - n
    while m <= 0:
        m += 12
        y -= 1
    # clamp the day to the target month's length
    last = [31, 29 if (y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)) else 28,
            31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return dt.date(y, m, min(d.day, last))


def value_on_or_before(series, target):
    """Adjusted close on `target`, or the last one before it. None if the
    series starts after the target."""
    if not series or series[0][0] > target:
        return None
    v = None
    for d, c in series:
        if d <= target:
            v = c
        else:
            break
    return v


def compute_row(series):
    d, last = series[-1]
    pct = lambda base: None if not base else (last / base - 1.0) * 100.0
    ann = lambda base, yrs: None if not base else ((last / base) ** (1.0 / yrs) - 1.0) * 100.0
    # YTD off the prior year's final close; first bar of this year if that
    # is all we have (young funds).
    prev_year_close = None
    first_this_year = None
    for dd, c in series:
        if dd.year < d.year:
            prev_year_close = c
        elif first_this_year is None:
            first_this_year = c
    ytd_base = prev_year_close if prev_year_close is not None else first_this_year
    row = {
        "asOf": d.isoformat(),
        "ytd": pct(ytd_base),
        "w1":  pct(value_on_or_before(series, d - dt.timedelta(days=7))),
        "m1":  pct(value_on_or_before(series, months_back(d, 1))),
        "m3":  pct(value_on_or_before(series, months_back(d, 3))),
        "m6":  pct(value_on_or_before(series, months_back(d, 6))),
        "m12": pct(value_on_or_before(series, months_back(d, 12))),
        "y3":  ann(value_on_or_before(series, months_back(d, 36)), 3),
        "y5":  ann(value_on_or_before(series, months_back(d, 60)), 5),
        "y10": ann(value_on_or_before(series, months_back(d, 120)), 10),
    }
    for k in COLUMNS:
        if row[k] is not None:
            row[k] = round(row[k], 2)
    return row


def load_existing():
    try:
        with open(OUT_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def main():
    existing = load_existing()
    prev_rows = {}
    if existing:
        for g in existing.get("groups", []):
            for r in g.get("rows", []):
                prev_rows[r.get("symbol")] = r

    groups_out = []
    ok = fail = kept = 0
    latest_date = None
    for title, rows in GROUPS:
        out_rows = []
        for name, sym, note in rows:
            try:
                series = fetch_adjclose(sym)
                if len(series) < 30:
                    raise ValueError(f"only {len(series)} bars")
                row = compute_row(series)
                row.update({"name": name, "symbol": sym, "note": note})
                out_rows.append(row)
                ok += 1
                rd = dt.date.fromisoformat(row["asOf"])
                if not sym.endswith(".TO") and (latest_date is None or rd > latest_date):
                    latest_date = rd
            except Exception as e:
                if sym in prev_rows:
                    out_rows.append(prev_rows[sym])
                    kept += 1
                    log(f"::warning::{sym}: {e} — kept previous row")
                else:
                    fail += 1
                    log(f"::warning::{sym}: {e} — no previous row, skipped")
            time.sleep(0.25)    # be polite to Yahoo
        groups_out.append({"title": title, "rows": out_rows})

    if ok == 0:
        log("::warning::market stats: nothing fetched; leaving the existing file untouched")
        return 0

    payload = {
        "asOf": latest_date.isoformat() if latest_date else None,
        "generatedAt": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "columns": COLUMNS,
        "columnLabels": ["YTD", "1 Wk", "1 Mo", "3 Mo", "6 Mo", "12 Mo", "3 Yr", "5 Yr", "10 Yr"],
        "annualized": ["y3", "y5", "y10"],
        "method": ("ETF proxies; total return from Yahoo dividend-adjusted daily closes "
                   "(distributions reinvested, net of fund expenses). 3 / 5 / 10 Yr annualized. "
                   "YTD off the prior year's final close."),
        "groups": groups_out,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    tmp = OUT_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=1)
    os.replace(tmp, OUT_PATH)
    log(f"market stats: {ok} fetched, {kept} kept from previous run, {fail} skipped; as of {payload['asOf']}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:      # never block the commit step
        log(f"::warning::market stats failed: {e}")
        sys.exit(0)
