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
fetch_yahoo_daily "^GSPC" "$DATA_DIR/spx.csv" "631152000"    # 1990-01-01
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

echo "Data refresh complete."
