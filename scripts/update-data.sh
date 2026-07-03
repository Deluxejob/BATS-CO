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

# --- VIX: pull from datasets/finance-vix (curated OHLC, updated daily) ---
fetch_vix() {
  local out="$DATA_DIR/vix.csv"
  local tmp="$(mktemp)"
  if ! curl -sSfL -A "Mozilla/5.0" \
       "https://raw.githubusercontent.com/datasets/finance-vix/main/data/vix-daily.csv" \
       -o "$tmp"; then
    warn "VIX fetch failed; leaving $out unchanged"
    rm -f "$tmp"; return 0
  fi
  # Sanity: header + a reasonable row count
  if ! head -1 "$tmp" | grep -qi "^DATE,"; then
    warn "VIX response doesn't look like the expected CSV; leaving $out unchanged"
    rm -f "$tmp"; return 0
  fi
  if [ "$(wc -l < "$tmp")" -lt 5000 ]; then
    warn "VIX row count suspiciously low; leaving $out unchanged"
    rm -f "$tmp"; return 0
  fi
  mv "$tmp" "$out"
  echo "Updated $out ($(wc -l < "$out") rows)"
}

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
fetch_vix
fetch_treasury_yields
fetch_yahoo_daily "^GSPC"    "$DATA_DIR/spx.csv"     "631152000"    # 1990-01-01
fetch_yahoo_daily "^SP500TR" "$DATA_DIR/sp500tr.csv" "946684800"    # 2000-01-03 (TR series inception)
fetch_yahoo_daily "DX-Y.NYB" "$DATA_DIR/dxy.csv"     "631152000"    # 1990-01-01 (US Dollar Index)
fetch_yahoo_daily "SPY"   "$DATA_DIR/spy.csv" "1051660800"   # 2003-04-30
fetch_yahoo_daily "RSP"   "$DATA_DIR/rsp.csv" "1051660800"   # 2003-04-30
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

echo "Data refresh complete."
