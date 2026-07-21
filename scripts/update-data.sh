#!/usr/bin/env bash
# ============================================================
# BATS.CO — Daily data update
# Fetches fresh daily closes for VIX, S&P 500 (SPX), SPY, RSP and
# overwrites data/*.csv. Called by .github/workflows/update-data.yml.
#
# Runs safely: if a fetch fails or looks broken, the corresponding
# CSV is left unchanged and a warning is logged instead of writing
# garbage.
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$REPO_ROOT/data"
mkdir -p "$DATA_DIR"

END_TS=$(date +%s)

warn() { echo "::warning::$*"; }

# --- VIX: pull ^VIX from Yahoo (same intraday-updated source as SPY/QQQ) ---
# Previously used datasets/finance-vix on GitHub, but that mirror lagged ~1 day.
# Yahoo publishes VIX closes on the same schedule as the other daily quotes.
# Output format is Date,Close (parseDateCloseLive downstream, matches VXN).

# --- Treasury.gov daily yield curve CSV (all maturities) ---
fetch_treasury_yields() {
  local out="$DATA_DIR/treasury_yields.csv"
  local tmp
  tmp="$(mktemp)"
  local year
  year="$(date -u +%Y)"
  local url="https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv"
  if ! curl -sSfL -A "Mozilla/5.0" --max-time 30 "$url" -o "$tmp"; then
    warn "Treasury yield fetch failed; leaving $out unchanged"
    rm -f "$tmp"; return 0
  fi
  if ! head -1 "$tmp" | grep -qi "Date"; then
    warn "Treasury response doesn't look like the expected CSV; leaving $out unchanged"
    rm -f "$tmp"; return 0
  fi
  # Sanity: at least a header + a few rows
  if [ "$(wc -l < "$tmp")" -lt 5 ]; then
    warn "Treasury row count suspiciously low; leaving $out unchanged"
    rm -f "$tmp"; return 0
  fi
  mv "$tmp" "$out"
  echo "Updated $out ($(wc -l < "$out") rows for $year)"
}

# --- Yahoo Finance chart API -> Date,Close CSV ---
fetch_yahoo_daily() {
  local symbol="$1" out="$2" start_ts="$3"
  local encoded="${symbol//^/%5E}"
  local url="https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?period1=${start_ts}&period2=${END_TS}&interval=1d"
  local json="$(mktemp --suffix=.json)"
  local tmp_ts="$(mktemp)"
  local tmp_cl="$(mktemp)"
  local tmp_out="$(mktemp)"

  if ! curl -sSfL -A "Mozilla/5.0" "$url" -o "$json"; then
    warn "Fetch failed for $symbol; leaving $out unchanged"
    rm -f "$json" "$tmp_ts" "$tmp_cl" "$tmp_out"; return 0
  fi
  if ! grep -q '"timestamp":' "$json"; then
    warn "Bad response for $symbol; leaving $out unchanged"
    rm -f "$json" "$tmp_ts" "$tmp_cl" "$tmp_out"; return 0
  fi

  grep -oE '"timestamp":\[[^]]+\]' "$json" \
    | sed -e 's/"timestamp":\[//' -e 's/\]//' \
    | tr ',' '\n' > "$tmp_ts"
  grep -oE '"close":\[[^]]+\]' "$json" \
    | head -1 \
    | sed -e 's/"close":\[//' -e 's/\]//' \
    | tr ',' '\n' > "$tmp_cl"

  paste "$tmp_ts" "$tmp_cl" \
    | awk -F'\t' 'BEGIN{print "Date,Close"} $1!="" && $2!="" && $2!="null" {
        printf "%s,%.4f\n", strftime("%Y-%m-%d", $1+0, 1), $2+0
      }' > "$tmp_out"

  # Sanity: at least 100 rows (data files always have thousands)
  if [ "$(wc -l < "$tmp_out")" -lt 100 ]; then
    warn "Suspiciously few rows for $symbol; leaving $out unchanged"
    rm -f "$json" "$tmp_ts" "$tmp_cl" "$tmp_out"; return 0
  fi

  mv "$tmp_out" "$out"
  rm -f "$json" "$tmp_ts" "$tmp_cl"
  echo "Updated $out ($(wc -l < "$out") rows)"
}

# ---- Fetch each dataset ----
fetch_yahoo_daily "^VIX"  "$DATA_DIR/vix.csv" "631152000"    # 1990-01-02 (VIX inception)
fetch_treasury_yields
fetch_yahoo_daily "^GSPC"    "$DATA_DIR/spx.csv"     "631152000"    # 1990-01-01
fetch_yahoo_daily "^SP500TR" "$DATA_DIR/sp500tr.csv" "946684800"    # 2000-01-03 (TR series inception)
fetch_yahoo_daily "DX-Y.NYB" "$DATA_DIR/dxy.csv"     "631152000"    # 1990-01-01 (US Dollar Index)
fetch_yahoo_daily "GC=F"     "$DATA_DIR/gold.csv"    "967593600"    # 2000-08-30 (Gold futures)
fetch_yahoo_daily "SI=F"     "$DATA_DIR/silver.csv"  "967593600"    # 2000-08-30 (Silver futures)
fetch_yahoo_daily "CL=F"     "$DATA_DIR/oil.csv"     "967593600"    # 2000-08-30 (WTI Crude Oil futures)
fetch_yahoo_daily "SPY"   "$DATA_DIR/spy.csv" "1051660800"   # 2003-04-30
fetch_yahoo_daily "RSP"   "$DATA_DIR/rsp.csv" "1051660800"   # 2003-04-30
fetch_yahoo_daily "MDY"   "$DATA_DIR/mdy.csv" "799545600"    # 1995-05-04 (MDY inception)
fetch_yahoo_daily "IWM"   "$DATA_DIR/iwm.csv" "959299200"    # 2000-05-26 (IWM inception)
# US vs international breadth: VTI = Total US, VEU = All-World ex-US.
# Ratio VTI/VEU used by the Market Ratios page.
fetch_yahoo_daily "VTI"   "$DATA_DIR/vti.csv" "990662400"    # 2001-05-24 (VTI inception)
fetch_yahoo_daily "VEU"   "$DATA_DIR/veu.csv" "1172793600"   # 2007-03-02 (VEU inception)
# Equity-leadership ratio pairs on the Market Ratios page:
#   SPY/KRE  — S&P 500 vs regional banks (stress spikes 2020, 2023 SVB era)
#   SPY/EEM  — US vs emerging markets
#   SPY/MCHI — US vs China
fetch_yahoo_daily "KRE"   "$DATA_DIR/kre.csv"  "1150675200"  # 2006-06-19 (KRE inception)
fetch_yahoo_daily "EEM"   "$DATA_DIR/eem.csv"  "1049673600"  # 2003-04-07 (EEM inception)
fetch_yahoo_daily "MCHI"  "$DATA_DIR/mchi.csv" "1301356800"  # 2011-03-29 (MCHI inception)

# --- State Street Select SPDR sector ETFs (for the sector heatmap) ---
mkdir -p "$DATA_DIR/sectors"
# Original 9 SPDR sectors launched 1998-12-16
for sym in XLK XLF XLE XLV XLI XLY XLP XLU XLB; do
  fname="$(echo "$sym" | tr 'A-Z' 'a-z').csv"
  fetch_yahoo_daily "$sym" "$DATA_DIR/sectors/$fname" "913766400"  # 1998-12-16
done
fetch_yahoo_daily "XLRE" "$DATA_DIR/sectors/xlre.csv" "1444176000" # 2015-10-07 (Real Estate inception)
fetch_yahoo_daily "XLC"  "$DATA_DIR/sectors/xlc.csv"  "1529280000" # 2018-06-18 (Comm Services inception)
fetch_yahoo_daily "HYG"   "$DATA_DIR/hyg.csv" "1176249600"   # 2007-04-11
fetch_yahoo_daily "LQD"   "$DATA_DIR/lqd.csv" "1176249600"   # 2007-04-11 (aligned with HYG)
fetch_yahoo_daily "TLT"   "$DATA_DIR/tlt.csv" "1027296000"   # 2002-07-22 (TLT inception)
# Nasdaq-side equity/volatility data (parallel to VIX/SPX/SPY/RSP)
fetch_yahoo_daily "^VXN"  "$DATA_DIR/vxn.csv" "979171200"    # 2001-01-11 (VXN inception)
fetch_yahoo_daily "^NDX"  "$DATA_DIR/ndx.csv" "631152000"    # 1990-01-01
fetch_yahoo_daily "QQQ"   "$DATA_DIR/qqq.csv" "920851200"    # 1999-03-10 (QQQ inception)
fetch_yahoo_daily "QQEW"  "$DATA_DIR/qqew.csv" "1145404800"  # 2006-04-19 (QQEW inception)

# Top-10 constituent tickers used on the Concentration page.
mkdir -p "$DATA_DIR/top10"
for sym in AAPL MSFT NVDA AMZN GOOGL META BRK-B TSLA LLY JPM AVGO COST NFLX; do
  fname="$(echo "$sym" | tr 'A-Z' 'a-z').csv"
  fetch_yahoo_daily "$sym" "$DATA_DIR/top10/$fname" "946684800"  # 2000-01-01
done

# --- Market Ratios page — every symbol used by a card on market-ratios.html ---
mkdir -p "$DATA_DIR/ratios"
# Breadth & Strength
fetch_yahoo_daily "MAGS" "$DATA_DIR/ratios/mags.csv" "1681171200"  # 2023-04-11 (MAGS inception)
fetch_yahoo_daily "RSPD" "$DATA_DIR/ratios/rspd.csv" "1162857600"  # 2006-11-07
fetch_yahoo_daily "RSPT" "$DATA_DIR/ratios/rspt.csv" "1162857600"  # 2006-11-07
fetch_yahoo_daily "RSPS" "$DATA_DIR/ratios/rsps.csv" "1162857600"  # 2006-11-07
fetch_yahoo_daily "VUG"  "$DATA_DIR/ratios/vug.csv"  "1075420800"  # 2004-01-30
fetch_yahoo_daily "VTV"  "$DATA_DIR/ratios/vtv.csv"  "1075420800"  # 2004-01-30
fetch_yahoo_daily "IWB"  "$DATA_DIR/ratios/iwb.csv"  "958953600"   # 2000-05-19
fetch_yahoo_daily "DIA"  "$DATA_DIR/ratios/dia.csv"  "946857600"   # 2000-01-03
fetch_yahoo_daily "VNQ"  "$DATA_DIR/ratios/vnq.csv"  "1095897600"  # 2004-09-23 (VNQ inception)
fetch_yahoo_daily "AIQ"  "$DATA_DIR/ratios/aiq.csv"  "1526000000"  # 2018-05-11 (AIQ inception)
# Risk-on / Risk-off
fetch_yahoo_daily "SHY"  "$DATA_DIR/ratios/shy.csv"  "1027987200"  # 2002-07-30
fetch_yahoo_daily "IEF"  "$DATA_DIR/ratios/ief.csv"  "1027987200"  # 2002-07-30
# Sector relative strength
fetch_yahoo_daily "SPHB" "$DATA_DIR/ratios/sphb.csv" "1304553600"  # 2011-05-05
fetch_yahoo_daily "SPLV" "$DATA_DIR/ratios/splv.csv" "1304553600"  # 2011-05-05
fetch_yahoo_daily "MTUM" "$DATA_DIR/ratios/mtum.csv" "1366243200"  # 2013-04-18
fetch_yahoo_daily "SPHD" "$DATA_DIR/ratios/sphd.csv" "1351209600"  # 2012-10-26
# Commodities & inflation
fetch_yahoo_daily "DBC"  "$DATA_DIR/ratios/dbc.csv"  "1139184000"  # 2006-02-06
fetch_yahoo_daily "GDX"  "$DATA_DIR/ratios/gdx.csv"  "1148256000"  # 2006-05-22
fetch_yahoo_daily "TIP"  "$DATA_DIR/ratios/tip.csv"  "1070582400"  # 2003-12-05
fetch_yahoo_daily "HG=F" "$DATA_DIR/ratios/copper.csv" "967593600" # 2000-08-30 (Copper futures)
fetch_yahoo_daily "XME"  "$DATA_DIR/ratios/xme.csv"  "1150934400"  # 2006-06-22
# Global vs US
fetch_yahoo_daily "VEA"  "$DATA_DIR/ratios/vea.csv"  "1185408000"  # 2007-07-26
fetch_yahoo_daily "FXI"  "$DATA_DIR/ratios/fxi.csv"  "1097193600"  # 2004-10-08
# Crypto (Crypto section of market-ratios.html)
fetch_yahoo_daily "MSTR" "$DATA_DIR/ratios/mstr.csv" "946857600"   # 2000-01-03
fetch_yahoo_daily "IBIT" "$DATA_DIR/ratios/ibit.csv" "1704931200"  # 2024-01-11 (spot BTC ETF)
fetch_yahoo_daily "ETHA" "$DATA_DIR/ratios/etha.csv" "1721692800"  # 2024-07-23 (spot ETH ETF)
fetch_yahoo_daily "GSOL" "$DATA_DIR/ratios/gsol.csv" "1704153600"  # 2024-01-02 (Grayscale Solana Trust)
fetch_yahoo_daily "BMNR" "$DATA_DIR/ratios/bmnr.csv" "1748995200"  # 2025-06-05

echo "Data refresh complete."
