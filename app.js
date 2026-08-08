/* ============================================================
   BATS.CO — app.js
   Builds the sentiment gauge, renders the components grid,
   and (later) wires up real data feeds for the BATS.
   ============================================================ */

// --- The 8 BATS buckets, from extremely oversold (low score) to extended (high score) ---
// Boundaries are calibrated to the empirical BATS distribution so each bucket
// gets meaningful population, including the two extremes at the edges.
// Every bucket carries three descriptions:
//   label:    the state name (what the market is doing)
//   action:   a short "what to consider" hint
//   subtitle: what our own backtest actually shows for this bucket
// The `min` field is the LOWER bound (inclusive). Upper bound = next bucket's min.
const BUCKETS = [
  {
    label: 'Extremely Oversold',
    action: 'Aggressive Buy',
    subtitle: 'The rarest signal — only ~17 days in 20 years. Historically +54% avg 12mo, every single instance positive. Includes the 2020 COVID bottom.',
    color: 'var(--s-ext)',
    min: 0,
  },
  {
    label: 'Very Oversold',
    action: 'Strong Buy',
    subtitle: 'Historically +32% avg 12mo, every single instance positive (~34 days in 20 years). Includes the 2008 GFC bottom and 2011 US downgrade.',
    color: 'var(--s0)',
    min: 15,
  },
  {
    label: 'Oversold',
    action: 'Consider Buying',
    subtitle: 'Historically +21% avg 12mo, 86% positive — well above the +9% baseline. Includes the 2018 Powell put and 2025 Liberation Day.',
    color: 'var(--s1)',
    min: 18,
  },
  {
    label: 'Slightly Bearish',
    action: 'Be Careful',
    subtitle: 'Forward 12mo returns average +9.4%, hit rate 74%. Not a crash zone, just weaker odds.',
    color: 'var(--s2)',
    min: 32,
  },
  {
    label: 'Neutral',
    action: 'No Real Trend',
    subtitle: 'Baseline forward returns (+9.3% avg 12mo, 78% positive). The market is not making a strong statement in either direction.',
    color: 'var(--s3)',
    min: 45,
  },
  {
    label: 'Slightly Bullish',
    action: 'Hold',
    subtitle: 'Baseline forward returns (+9.0% avg 12mo, 82% positive). Normal bull-market territory.',
    color: 'var(--s4)',
    min: 57,
  },
  {
    label: 'Bullish',
    action: 'Hold, But Be Careful',
    subtitle: 'Above baseline: +11.1% avg 12mo, 86% positive. Trend has been strong.',
    color: 'var(--s5)',
    min: 65,
  },
  {
    label: 'Extended',
    action: 'Trim / Rebalance Stretched Positions',
    subtitle: 'Rare — only ~1% of the time. Historically +13.4% avg 12mo (84% positive). The market can keep going, but individual tickers may be stretched.',
    color: 'var(--s6)',
    min: 72,
  },
];

// Returns the bucket index for a given BATS score using the boundaries above.
function bucketIndexFor(score) {
  const s = Math.max(0, Math.min(100, score));
  for (let i = BUCKETS.length - 1; i >= 0; i--) {
    if (s >= BUCKETS[i].min) return i;
  }
  return 0;
}

// ============================================================
// MARKET CONFIG — the same BATS logic can be applied to either the S&P 500
// or the Nasdaq 100. Everything upstream (scoring functions, gauge, backtest
// engine) is identical; we just swap which CSV files feed each component.
// Defined near the top of the file so COMPONENTS and everything else can
// reference MC without hitting the temporal dead zone.
// ============================================================
const MARKET = (typeof window !== 'undefined'
  ? new URLSearchParams(window.location.search).get('market')
  : null) === 'nasdaq' ? 'nasdaq' : 'sp500';

const MARKET_CONFIG = {
  sp500: {
    label: 'S&P 500',
    shortLabel: 'S&P 500',
    ticker: '^GSPC',
    volCsv: 'vix.csv',
    volTicker: 'VIX',
    volIsOHLC: false,  // Yahoo ^VIX: Date,Close (same shape as VXN)
    breadthEqualCsv: 'rsp.csv',
    breadthCapCsv: 'spy.csv',
    breadthLabel: 'RSP / SPY',
    rsiCsv: 'spy.csv',
    rsiTicker: 'SPY',
    indexCsv: 'spx.csv',
    indexTicker: 'S&P 500',
    stockCsv: 'spy.csv',
    stockTicker: 'SPY',
  },
  nasdaq: {
    label: 'Nasdaq 100',
    shortLabel: 'Nasdaq 100',
    ticker: '^NDX',
    volCsv: 'vxn.csv',
    volTicker: 'VXN',
    volIsOHLC: false,  // Yahoo Date,Close
    breadthEqualCsv: 'qqew.csv',
    breadthCapCsv: 'qqq.csv',
    breadthLabel: 'QQEW / QQQ',
    rsiCsv: 'qqq.csv',
    rsiTicker: 'QQQ',
    indexCsv: 'ndx.csv',
    indexTicker: 'Nasdaq 100',
    stockCsv: 'qqq.csv',
    stockTicker: 'QQQ',
  },
};

const MC = MARKET_CONFIG[MARKET];

// Top 10 constituents by market cap (as of 2026). We use today's top 10 for
// the whole historical window — introduces mild look-ahead bias at long
// lookbacks but is accurate for what matters most (recent concentration).
const TOP10_TICKERS = {
  sp500:  ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'BRK-B', 'TSLA', 'LLY',  'JPM'],
  nasdaq: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA',  'AVGO', 'COST', 'NFLX'],
};

// ============================================================
// INDICATOR SCORING
// Each function below takes a raw market reading and returns a
// BATS sentiment score from 0 (very oversold) to 100 (very bullish).
// Pure math: same input -> same output.
// Returns null if the input is missing/invalid.
// ============================================================

// ---- VIX (Volatility Index) — the "fear gauge" ----
//
// VIX measures expected 30-day S&P 500 volatility from options prices.
// We treat it as a CONTRARIAN indicator. High VIX = the crowd is scared =
// historically a buying opportunity. Low VIX = complacency = market is
// confident but may be a time to take profits.
//
// User-calibrated thresholds:
//      < 12   extreme calm / complacency  (very bullish on surface,
//             flag "consider taking profits")
//    12-15    calm, confident bull market zone
//    15-20    HISTORIC BASELINE — the market's long-term average
//    20-25    slightly elevated, cautious
//    25-35    nervous, bargain territory forming
//    35-45    fearful, strong contrarian buy zone
//      > 45   panic, very strong contrarian buy signal
//
// Piecewise linear so each zone's slope matches its real-world meaning,
// and the gauge moves smoothly as the VIX moves.
function scoreVIX(vix) {
  if (vix == null || isNaN(vix)) return null;

  let score;
  if (vix <= 12)      score = 92 - (vix - 8)  * 1.5;       //  8 -> 92,  12 -> 86
  else if (vix <= 15) score = 86 - (vix - 12) * 6.33;      // 12 -> 86,  15 -> 67
  else if (vix <= 20) score = 67 - (vix - 15) * 4.8;       // 15 -> 67,  20 -> 43
  else if (vix <= 25) score = 43 - (vix - 20) * 3.0;       // 20 -> 43,  25 -> 28
  else if (vix <= 35) score = 28 - (vix - 25) * 1.4;       // 25 -> 28,  35 -> 14
  else if (vix <= 45) score = 14 - (vix - 35) * 0.9;       // 35 -> 14,  45 -> 5
  else                score = 5  - (vix - 45) * 0.1;       // > 45 panic, asymptote ~ 2

  return Math.max(2, Math.min(98, score));
}

// ---- SPY 14-day RSI (Relative Strength Index) ----
//
// RSI measures short-term price momentum, oscillating between 0 and 100.
// Well-known thresholds:
//     RSI < 30  oversold (market has sold off hard, potential bounce)
//     RSI < 20  extremely oversold (strong contrarian bullish setup)
//     RSI > 70  overbought (rally is stretched)
//     RSI > 80  extremely overbought (bearish setup, but can persist)
//
// Direction of BATS mapping — SAME as market state:
//   Low RSI  = market is oversold  -> LOW BATS score  (buy signal)
//   High RSI = market is overbought -> HIGH BATS score (careful)
//
// Backtest 2003-2026: extremes matter, middle is noise.
//   RSI Very Oversold  (≤15): +24.6% avg 12mo, 100% hit (n=11)
//   RSI Very Bullish   (≥85): +7.1%  avg 12mo,  62% hit (n=35)   <- meaningfully WORSE
// Middle buckets track baseline (+10%). Warning at extreme overbought is
// the unique thing RSI adds that VIX and Breadth do not.
function scoreRSI(rsi) {
  if (rsi == null || isNaN(rsi)) return null;
  let s;
  if (rsi <= 15)      s = 5;
  else if (rsi <= 30) s = 5  + (rsi - 15) * (25 - 5)  / 15;   // 15->5,  30->25
  else if (rsi <= 50) s = 25 + (rsi - 30) * (50 - 25) / 20;   // 30->25, 50->50
  else if (rsi <= 70) s = 50 + (rsi - 50) * (75 - 50) / 20;   // 50->50, 70->75
  else if (rsi <= 85) s = 75 + (rsi - 70) * (95 - 75) / 15;   // 70->75, 85->95
  else                s = 95;
  return Math.max(2, Math.min(98, s));
}

function rsiAdvisory(rsi) {
  if (rsi == null || isNaN(rsi)) return null;
  if (rsi >= 85) return { tone: 'watch',       text: 'Extremely overbought. Historically forward 12mo returns from here averaged only +7% (vs +10% baseline), and hit rate dropped to 62%. Markets CAN stay stretched — but risk/reward has weakened.' };
  if (rsi >= 70) return { tone: 'info',        text: 'Overbought. Momentum is stretched to the upside. Not a sell signal alone, but worth watching.' };
  if (rsi >= 55) return { tone: 'info',        text: 'Rising momentum — healthy trend.' };
  if (rsi >= 45) return { tone: 'info',        text: 'Balanced momentum — neither stretched.' };
  if (rsi >= 30) return { tone: 'info',        text: 'Weakening momentum — mildly negative but not yet oversold.' };
  if (rsi >= 15) return { tone: 'opportunity', text: 'Oversold. Historically a bullish setup — forward 12mo returns from here averaged ~+14%, above baseline.' };
  return                { tone: 'opportunity', text: 'Extremely oversold. Very strong contrarian buy signal historically (+25% avg forward 12mo, 100% positive in 11 historical instances). Rare but potent.' };
}

// ---- NAAIM Exposure Index — professional active-manager positioning ----
//
// The National Association of Active Investment Managers polls its members
// each Wednesday: what's your current equity exposure? Responses range from
// -200% (fully leveraged short) to +200% (fully leveraged long). The aggregate
// mean is the "NAAIM Number." Published weekly since 2006.
//
// Direction of BATS mapping — same as market state:
//   Managers heavily long (high NAAIM)  -> HIGH BATS (market in confident state)
//   Managers defensive  (low NAAIM)    -> LOW BATS (oversold state, historically buy zone)
//
// Distribution 2006-2026 (1,043 weekly readings): min -3.6, 10th 32, median 72,
// mean 67, 90th 94, max 121. Managers typically sit around 70% long — the
// median reflects their structural bullish bias.
//
// Backtest 2006-2026:
//   Very Oversold (NAAIM ≤ 10, managers defensive): +13.6% avg 12mo, 75% hit
//   Oversold      (NAAIM 10-35):                    +13.3% avg 12mo, 83% hit
//   Very Bullish  (NAAIM > 100, leveraged long):    +11.9% avg 12mo, 82% hit
// NAAIM's Very Bullish extreme is NOT punished — institutions ride trends
// well when they're aggressively long, so we score them monotonically.
//
// Weekly data — dashboard carries the most recent reading forward.
function scoreNAAIM(v) {
  if (v == null || isNaN(v)) return null;
  let s;
  if (v <= 10)       s = 5;
  else if (v <= 35)  s = 5  + (v - 10) * (25 - 5)  / 25;
  else if (v <= 60)  s = 25 + (v - 35) * (50 - 25) / 25;
  else if (v <= 85)  s = 50 + (v - 60) * (75 - 50) / 25;
  else if (v <= 100) s = 75 + (v - 85) * (90 - 75) / 15;
  else               s = 95;
  return Math.max(2, Math.min(98, s));
}

function naaimAdvisory(v) {
  if (v == null || isNaN(v)) return null;
  if (v <= 10)  return { tone: 'opportunity', text: 'Active managers deeply defensive — historically a bullish setup. Forward 12mo returns have averaged +13.6% from this rare zone (75% positive).' };
  if (v <= 35)  return { tone: 'opportunity', text: 'Active managers unusually cautious. Historically a contrarian buy zone: +13.3% avg forward 12mo (83% positive).' };
  if (v <= 55)  return { tone: 'info',        text: 'Managers moderately defensive — below their long-term average of ~70%.' };
  if (v <= 80)  return { tone: 'info',        text: 'Manager exposure near its long-term average — neutral positioning.' };
  if (v <= 100) return { tone: 'info',        text: 'Managers solidly long — comfortable but not maxed out.' };
  return                { tone: 'info',        text: 'Managers using leverage on the long side — historically NOT a warning (institutions ride trends better than retail). Forward 12mo returns have averaged +12% from this zone.' };
}

// ---- % of Stocks Above 200-day Moving Average ----
//
// Classic breadth indicator: of the ~100 large-cap S&P constituents we track,
// how many are currently trading above their own 200-day moving average? A
// high reading means broad participation in the uptrend; a low reading means
// most stocks are broken.
//
// Direction of BATS mapping — trend/participation with a CONTRARIAN tail at
// extreme washouts:
//   Very low (<15%)   -> LOW BATS score (crash zone — historically the
//                        strongest contrarian buy signal in our toolkit)
//   Middle (30-60%)   -> mid-range
//   High (>65%)       -> HIGH BATS score (broad, healthy uptrend)
//
// Backtest 2005-2026 (4,980 samples, 102 tickers), baseline SPY 12mo = +12.31%:
//   0-10%  above 200MA:  +37.3% avg 12mo, 100% hit  (n=135)  ← contrarian buy
//   10-20% above 200MA:  +30.1% avg 12mo,  95% hit  (n=58)
//   20-30% above 200MA:  +16.0% avg 12mo,  82% hit
//   30-40% above 200MA:  +8.1%  avg 12mo,  72% hit  ← WEAKEST zone
//   40-70% above 200MA:  ~baseline
//   70-100% above 200MA: ~baseline (NO exhaustion penalty at high extreme)
//
// The 30-40% "recovering but not safe yet" zone is the weakest bucket, same
// phenomenon MA200-distance shows at -6% to -1%. Extreme highs do NOT
// underperform — the trend just continues, so no hockey-stick at the top.
function scorePctAbove200MA(pct) {
  if (pct == null || isNaN(pct)) return null;
  let s;
  if (pct <= 15)       s = 5;                                    // extreme washout → contrarian buy floor
  else if (pct <= 30)  s = 5  + (pct - 15) * (25 - 5)  / 15;    // 15→5,  30→25
  else if (pct <= 45)  s = 25 + (pct - 30) * (45 - 25) / 15;    // 30→25, 45→45
  else if (pct <= 65)  s = 45 + (pct - 45) * (65 - 45) / 20;    // 45→45, 65→65
  else if (pct <= 85)  s = 65 + (pct - 65) * (80 - 65) / 20;    // 65→65, 85→80
  else                 s = 80 + (pct - 85) * (90 - 80) / 15;    // 85→80, 100→90
  return Math.max(2, Math.min(98, s));
}

function pctAbove200MAAdvisory(pct) {
  if (pct == null || isNaN(pct)) return null;
  if (pct <= 15) return { tone: 'opportunity', text: 'Extreme breadth washout — one of the strongest contrarian buy signals in our toolkit. Historically forward 12mo returns from below 15% have averaged +37%, with 100% of instances positive (n=135).' };
  if (pct <= 25) return { tone: 'opportunity', text: 'Very few stocks above their 200-day MA — deeply oversold breadth. Forward 12mo returns from this zone have averaged +30%, 95% positive.' };
  if (pct <= 35) return { tone: 'watch',       text: 'Broad weakness — most stocks below their long-term trend. Recovery zone, still risky. Forward returns from here have historically underperformed baseline (~+8% avg vs +12% baseline).' };
  if (pct <= 50) return { tone: 'info',        text: 'Mixed participation — roughly half the market is above trend, half below. Neutral breadth.' };
  if (pct <= 65) return { tone: 'info',        text: 'Majority of stocks above their 200-day MA — healthy participation. Forward returns near baseline.' };
  if (pct <= 80) return { tone: 'info',        text: 'Broad participation — most stocks are in uptrends. Trend is intact, forward returns near baseline.' };
  if (pct <= 90) return { tone: 'info',        text: 'Very broad participation — trend is strong across the market. Not overbought; forward returns near baseline.' };
  return                { tone: 'info',        text: 'Extreme broad participation — nearly all stocks above their 200-day MA. History does NOT punish this — forward returns from here have run near baseline (~+11% avg 12mo, 83% positive). Not an exhaustion signal.' };
}

// ---- S&P 500 vs 200-day Moving Average ----
//
// Classic trend indicator. Above the 200-day MA = market in uptrend. Below =
// downtrend. Distance from the MA measures how "stretched" the market is.
//
// Direction of BATS mapping — SAME as market state:
//   Far below MA  = market crashed / oversold  -> LOW BATS score (buy signal)
//   Far above MA  = market extended / uptrend  -> HIGH BATS score
//
// Distribution 1990-2026: distance is SKEWED POSITIVE (median ≈ +5%,
// mean ≈ +3.6%) because the S&P spends more time above its 200-day than
// below (long-term uptrend). We center the neutral zone around +5%, not 0.
//
// Backtest 1990-2026 (8,992 days) — TWO surprising findings:
//   Very Oversold (dist ≤ -12%): +18.7% avg 12mo, 81% hit  (n=381)
//   Very Bullish  (dist ≥ +12%): +14.5% avg 12mo, 98% hit  (n=334) — NOT overbought!
//   Oversold zone (dist -12% to -6%): +2%, only 53% hit — historically a DUD.
// Extreme uptrends have historically CONTINUED (98% hit), contradicting the
// "far above = time to sell" narrative. The real warning zone is moderately
// below the MA (falling but not capitulating).
function scoreMA200(distPct) {
  if (distPct == null || isNaN(distPct)) return null;
  let s;
  if (distPct <= -15)      s = 5;
  else if (distPct <= -5)  s = 5  + (distPct + 15) * (30 - 5)  / 10;
  else if (distPct <=  5)  s = 30 + (distPct +  5) * (50 - 30) / 10;
  else if (distPct <= 10)  s = 50 + (distPct -  5) * (70 - 50) / 5;
  else if (distPct <= 15)  s = 70 + (distPct - 10) * (90 - 70) / 5;
  else                     s = 95;
  return Math.max(2, Math.min(98, s));
}

function ma200Advisory(distPct) {
  if (distPct == null || isNaN(distPct)) return null;
  if (distPct <= -15) return { tone: 'opportunity', text: 'Deep below the 200-day MA — historically a strong buy zone (+19% avg forward 12mo, 81% positive). Includes the 2008 and 2020 crash lows.' };
  if (distPct <=  -6) return { tone: 'watch',       text: 'Moderately below the 200-day MA — historically the WEAKEST forward-return zone (only +2% avg 12mo, 53% positive). Not yet capitulation.' };
  if (distPct <=  -1) return { tone: 'info',        text: 'Just below the 200-day MA — market in a shallow downtrend. Mildly bearish.' };
  if (distPct <=   3) return { tone: 'info',        text: 'Right around the 200-day MA — market at trend inflection.' };
  if (distPct <=   7) return { tone: 'info',        text: 'Above the 200-day MA — market in a normal uptrend (this is the median historical zone).' };
  if (distPct <=  12) return { tone: 'info',        text: 'Well above the 200-day MA — strong uptrend. Historically forward returns still solid (~+13% avg 12mo).' };
  return                      { tone: 'info',        text: 'Far above the 200-day MA — but history shows extreme uptrends have CONTINUED (+14.5% avg forward 12mo, 98% positive). Not automatically overbought.' };
}

// ---- S&P 500 vs 50-day Moving Average ----
//
// Faster-moving cousin of the 200-day component. Where MA200 captures the
// long-term trend, MA50 flags shorter-term shifts — the market drops below
// its 50-day much more often than its 200-day, and often WELL BEFORE
// it drops below 200. Golden/death crosses (50 vs 200) are widely watched
// by traders, so this indicator has cultural weight too.
//
// Direction: same as MA200 — high distance = trend intact, negative
// distance = trend faltering.
//
// Distribution — SPX typical range: ±3% around 50MA, with tails hitting
// ±8% during volatility. Thresholds are tighter than MA200 accordingly.
function scoreMA50(distPct) {
  if (distPct == null || isNaN(distPct)) return null;
  let s;
  if (distPct <= -8)      s = 5;
  else if (distPct <= -3) s = 5  + (distPct + 8)  * (30 - 5)  / 5;    // -8→5,  -3→30
  else if (distPct <=  0) s = 30 + (distPct + 3)  * (50 - 30) / 3;    // -3→30,  0→50
  else if (distPct <=  3) s = 50 + (distPct)      * (70 - 50) / 3;    //  0→50, +3→70
  else if (distPct <=  6) s = 70 + (distPct - 3)  * (88 - 70) / 3;    // +3→70, +6→88
  else                    s = 90;
  return Math.max(2, Math.min(98, s));
}

function ma50Advisory(distPct) {
  if (distPct == null || isNaN(distPct)) return null;
  if (distPct <= -8) return { tone: 'watch',       text: 'Well below the 50-day MA — short-term trend is broken. Historically this reading precedes further weakness before recovery.' };
  if (distPct <= -3) return { tone: 'watch',       text: 'Below the 50-day MA — short-term momentum negative. Watch for continuation.' };
  if (distPct <= -1) return { tone: 'info',        text: 'Just below the 50-day MA — mild short-term weakness.' };
  if (distPct <=  1) return { tone: 'info',        text: 'Right around the 50-day MA — short-term inflection.' };
  if (distPct <=  3) return { tone: 'info',        text: 'Above the 50-day MA — healthy short-term uptrend.' };
  if (distPct <=  6) return { tone: 'info',        text: 'Well above the 50-day MA — strong short-term momentum.' };
  return                    { tone: 'info',        text: 'Far above the 50-day MA — very strong short-term rally, but stretched. Watch Pivot Top for signs of exhaustion.' };
}

// ---- % of Stocks Above 50-day Moving Average ----
//
// Faster-moving breadth cousin of the 200-day version. The 50-day breadth
// swings farther and faster than the 200-day (short-term pullbacks pull
// it to 20-30% quickly, then short-term rallies push it back to 80-90%).
//
// Same direction as its slow cousin: extreme low = washout/contrarian buy,
// middle = neutral, high = broad participation. Backtest mapping mirrors
// pct_above_200ma's shape — deep washouts on the 50-day still historically
// resolve bullish, even if they resolve faster.
function scorePctAbove50MA(pct) {
  if (pct == null || isNaN(pct)) return null;
  let s;
  if (pct <= 15)       s = 5;
  else if (pct <= 30)  s = 5  + (pct - 15) * (25 - 5)  / 15;
  else if (pct <= 45)  s = 25 + (pct - 30) * (45 - 25) / 15;
  else if (pct <= 65)  s = 45 + (pct - 45) * (65 - 45) / 20;
  else if (pct <= 85)  s = 65 + (pct - 65) * (80 - 65) / 20;
  else                 s = 80 + (pct - 85) * (90 - 80) / 15;
  return Math.max(2, Math.min(98, s));
}

function pctAbove50MAAdvisory(pct) {
  if (pct == null || isNaN(pct)) return null;
  if (pct <= 15) return { tone: 'opportunity', text: 'Extreme short-term washout — very few stocks above their 50-day MA. Historically a contrarian short-term buy setup.' };
  if (pct <= 30) return { tone: 'opportunity', text: 'Broadly oversold at the short-term horizon. Short-term bounce setups often trigger from here.' };
  if (pct <= 45) return { tone: 'info',        text: 'Weak short-term breadth — most stocks under their 50-day MA. Trend faltering short-term.' };
  if (pct <= 60) return { tone: 'info',        text: 'Mixed short-term participation — split market.' };
  if (pct <= 75) return { tone: 'info',        text: 'Healthy short-term breadth — most stocks above their 50-day MA. Trend intact short-term.' };
  return                { tone: 'info',        text: 'Very broad short-term participation — trend broadly intact at the fast horizon. Not overbought; forward returns near baseline.' };
}

// Compute the simple moving average over a chronological array of closes.
// Returns an array where element i is the trailing period-day SMA (null for i<period-1).
function computeSmaSeries(closes, period = 200) {
  const sma = new Array(closes.length).fill(null);
  if (closes.length < period) return sma;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  sma[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    sum += closes[i] - closes[i - period];
    sma[i] = sum / period;
  }
  return sma;
}

// ---- Bollinger %B on the index (20-day, 2 std dev) ----
//
// Bollinger Bands are a 20-day SMA plus/minus 2 standard deviations of the
// same 20-day close window. %B is the normalized position of price BETWEEN
// the bands:
//     %B = (close - lower band) / (upper band - lower band)
// Values: 0.0 = at lower band, 0.5 = at SMA, 1.0 = at upper band,
//         >1.0 = above upper band ("walking the bands" — strong trend),
//         <0.0 = below lower band (deep oversold).
//
// Classical (contrarian) reading treats >1 as overbought, but Bollinger
// himself noted sustained %B > 1 is TREND CONTINUATION, not reversal. That's
// exactly the flavor Upside Trend wants: reward the "SPX making highs faster
// than volatility can catch up" state.
//
// Score mapping — high %B rewarded, low %B punished, but keep the middle
// zone linear so day-to-day moves register:
//     %B <= 0     -> 5     (below lower band, weakness)
//     0.0 to 0.3  -> 5-25  (bottom third)
//     0.3 to 0.5  -> 25-50 (recovering to mid)
//     0.5 to 0.7  -> 50-70 (upper-middle, healthy)
//     0.7 to 1.0  -> 70-90 (approaching upper band, strong)
//     %B > 1      -> 95    (walking the upper band, very strong trend)
function computeBollingerBSeries(closes, period = 20, sigmas = 2) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  // Rolling sum + sum-of-squares so std dev is O(1) per step, not O(period).
  let sum = 0, sumSq = 0;
  for (let i = 0; i < period; i++) { sum += closes[i]; sumSq += closes[i] * closes[i]; }
  const compute = (i) => {
    const mean = sum / period;
    const variance = Math.max(0, sumSq / period - mean * mean);
    const sd = Math.sqrt(variance);
    if (sd === 0) return 0.5;
    const upper = mean + sigmas * sd;
    const lower = mean - sigmas * sd;
    return (closes[i] - lower) / (upper - lower);
  };
  out[period - 1] = compute(period - 1);
  for (let i = period; i < closes.length; i++) {
    const drop = closes[i - period];
    const add = closes[i];
    sum += add - drop;
    sumSq += add * add - drop * drop;
    out[i] = compute(i);
  }
  return out;
}

function scoreBollingerB(pctB) {
  if (pctB == null || isNaN(pctB)) return null;
  let s;
  if      (pctB <= 0)   s = 5;
  else if (pctB <= 0.3) s = 5  + (pctB - 0)   * (25 - 5)  / 0.3;
  else if (pctB <= 0.5) s = 25 + (pctB - 0.3) * (50 - 25) / 0.2;
  else if (pctB <= 0.7) s = 50 + (pctB - 0.5) * (70 - 50) / 0.2;
  else if (pctB <= 1.0) s = 70 + (pctB - 0.7) * (90 - 70) / 0.3;
  else                  s = 95;
  return Math.max(2, Math.min(98, s));
}

// ---- MACD histogram on the index (12/26 EMA - 9 EMA signal) ----
//
// Classic Gerald Appel MACD. Two things get reported:
//   MACD line = EMA(closes, 12) - EMA(closes, 26)
//   Signal    = EMA(MACD line, 9)
//   Histogram = MACD line - Signal
// Positive & rising histogram = trend accelerating up. Negative & falling =
// accelerating down. Widely used as a momentum confirmation.
//
// We normalize histogram as a PERCENT of the closing price so the same
// scoring thresholds work whether SPX is 3000 or 8000. On a healthy trending
// day the normalized histogram is roughly 0.05% to 0.30%; extreme readings
// can hit +/-0.5%. Score mapping steep near zero to catch inflections early.
function computeEMASeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with SMA of the first `period` values, then apply EMA formula.
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}
function computeMACDHistSeries(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = computeEMASeries(closes, fast);
  const emaSlow = computeEMASeries(closes, slow);
  const macdLine = closes.map((_, i) =>
    (emaFast[i] != null && emaSlow[i] != null) ? (emaFast[i] - emaSlow[i]) : null
  );
  // Signal EMA only after we have `signal` consecutive non-null MACD values,
  // which starts at index `slow - 1`.
  const macdFromStart = macdLine.slice(slow - 1);
  const signalFromStart = computeEMASeries(macdFromStart, signal);
  const signalLine = new Array(closes.length).fill(null);
  for (let i = 0; i < signalFromStart.length; i++) {
    signalLine[slow - 1 + i] = signalFromStart[i];
  }
  const hist = closes.map((c, i) =>
    (macdLine[i] != null && signalLine[i] != null && c != null && c !== 0)
      ? ((macdLine[i] - signalLine[i]) / c) * 100   // percent of price
      : null
  );
  return hist;
}

function scoreMACDHist(histPct) {
  if (histPct == null || isNaN(histPct)) return null;
  // histPct is (MACD - Signal) as percent of price.
  // Steep mapping near zero — cross of zero is the important event.
  //   <= -0.3% -> 5     (strongly bearish acceleration)
  //   -0.3..0  -> 5-50  (bearish weakening / turning up)
  //   0..+0.3  -> 50-90 (bullish accelerating)
  //   >= +0.3% -> 95    (strongly bullish acceleration)
  let s;
  if      (histPct <= -0.3) s = 5;
  else if (histPct <=  0)   s = 5  + (histPct + 0.3) * (50 - 5)  / 0.3;
  else if (histPct <=  0.3) s = 50 + (histPct)       * (90 - 50) / 0.3;
  else                      s = 95;
  return Math.max(2, Math.min(98, s));
}

// ---- 10-day rate of change on the index (bigger-picture cousin of ROC-5) ----
// Simple: (close_today / close_10_days_ago - 1) * 100.
// Clamped +/-8% (10 days at ~0.8% per day daily; extreme moves +/-8% cover
// the vast majority of history). Linear map from -8..+8 -> score 5..95.
function scoreROC10(roc) {
  if (roc == null || isNaN(roc)) return null;
  const CLAMP = 8.0;
  const c = Math.max(-CLAMP, Math.min(CLAMP, roc));
  const s = 50 + (c / CLAMP) * 45;
  return Math.max(5, Math.min(95, s));
}

// ---- 10Y-2Y Treasury Yield Spread ----
//
// The single most-watched recession indicator on Wall Street. It's the
// difference between the yield on the 10-year Treasury and the 2-year
// Treasury, expressed in percentage points. Normally, longer bonds pay
// MORE than shorter ones (positive spread — the "term premium"). When
// the curve inverts (spread < 0), the bond market is signaling that
// short-term rates are too high and a slowdown is on the way.
//
// LEADING indicator — inversions have preceded every US recession since
// 1970 by 6-24 months. That's why we treat a deep inversion as a strong
// BEARISH-leading signal (LOW BATS score), and a steep positive curve
// as HEALTHY expansion (HIGH BATS score).
//
// Piecewise-linear mapping (all values in percentage points):
//   spread ≤ -1.5     → score 5   (deep inversion, recession warning)
//   spread == 0       → ~40       (flat curve)
//   spread ≈ +0.5     → ~55       (mildly normal)
//   spread ≈ +1.5     → ~75       (steepening)
//   spread ≥ +2.5     → 95        (very steep, early-cycle)
//
// Backtest 1990-2018 (7,000+ days), replacing Safe Haven at weight 5:
//   Very Oversold bucket: +56% avg forward 12mo, 100% positive (n=17)
//   Oversold bucket:      +25% avg forward 12mo, 88.5% positive
//   Extended bucket:      +15.6% avg forward 12mo, 84.4% positive
// Meaningful improvement over the SPY-TLT-based Safe Haven at both tails.
function scoreYieldSpread(spread) {
  if (spread == null || isNaN(spread)) return null;
  let s;
  if      (spread <= -1.5) s = 5;
  else if (spread <=  0)   s = 5  + (spread + 1.5) * (40 - 5)  / 1.5;
  else if (spread <=  0.5) s = 40 + spread         * (55 - 40) / 0.5;
  else if (spread <=  1.5) s = 55 + (spread - 0.5) * (75 - 55) / 1.0;
  else if (spread <=  2.5) s = 75 + (spread - 1.5) * (95 - 75) / 1.0;
  else                     s = 95;
  return Math.max(2, Math.min(98, s));
}

function yieldSpreadAdvisory(spread) {
  if (spread == null || isNaN(spread)) return null;
  if (spread <= -1.5) return { tone: 'opportunity', text: 'Deeply inverted yield curve — a classic pre-recession signal. When this coincides with fear across the other components, historically a very strong contrarian buy zone (+56% avg forward 12mo).' };
  if (spread <=  -0.25) return { tone: 'watch',     text: 'Yield curve inverted — the bond market is signaling economic slowdown ahead. Historically leads recessions by 6-24 months.' };
  if (spread <   0.25) return { tone: 'watch',       text: 'Yield curve is flat — late-cycle territory. Not inverted yet, but the term premium has been squeezed out.' };
  if (spread <   1.0)  return { tone: 'info',        text: 'Mildly positive — normal but not steep. Mid-cycle expansion.' };
  if (spread <   2.0)  return { tone: 'info',        text: 'Healthy steepening — normal, well-behaved yield curve. Expansion phase.' };
  return                      { tone: 'info',        text: 'Very steep curve — early-cycle territory or aggressive rate cuts. Bullish confirmation for a growth-friendly environment.' };
}

// ---- Junk Bond Demand — HYG/LQD 20-day spread ----
//
// Measures the credit market's risk appetite. HYG holds high-yield ("junk")
// corporate bonds. LQD holds investment-grade corporates. When investors are
// hungry for yield they chase HYG, and HYG outperforms LQD (positive spread).
// When they get scared they flee to quality (LQD > HYG, negative spread).
//
// CONFIRMATORY, not contrarian (like Breadth):
//   Positive spread -> risk-on -> BULLISH sentiment -> HIGH BATS score
//   Negative spread -> flight to safety -> OVERSOLD -> LOW BATS score
//
// Distribution 2007-2026: median ~0, 90th ±2%, extremes ±14% (2008 crisis).
// Score = 50 + spread * 10, clamped to [5, 95] — same shape as Breadth.
//
// Backtest 2007-2026 (4,816 days):
//   Very Oversold (spread < -4.5%): +18.3% avg 12mo, 87% hit  (n=259)
//   Very Bullish  (spread > +4.5%): +14.8% avg 12mo, 84% hit  (n=131)
// Modest on its own, but adding at 10% weight to the 4-way blend pushes the
// blended Very Oversold bucket to 100% hit rate.
function scoreJunkDemand(spread) {
  if (spread == null || isNaN(spread)) return null;
  const score = 50 + spread * 10;
  return Math.max(5, Math.min(95, score));
}

function junkDemandAdvisory(spread) {
  if (spread == null || isNaN(spread)) return null;
  if (spread <= -5)   return { tone: 'opportunity', text: 'Extreme flight to safety — credit stress. Historically a strong contrarian buy signal (+18% avg forward 12mo returns, 87% positive).' };
  if (spread <= -2)   return { tone: 'watch',       text: 'Investors fleeing risky bonds — credit markets stressed. Bearish confirmation, watch other indicators.' };
  if (spread <= -0.5) return { tone: 'info',        text: 'Mild flight to quality — credit markets slightly cautious.' };
  if (spread <   0.5) return { tone: 'info',        text: 'Balanced — credit markets neutral.' };
  if (spread <   2)   return { tone: 'info',        text: 'Mild risk-on — investors slightly favor high-yield bonds.' };
  if (spread <   5)   return { tone: 'info',        text: 'Broad risk appetite — credit markets healthy. Bullish confirmation.' };
  return                      { tone: 'opportunity', text: 'Extreme risk appetite — investors chasing high-yield bonds aggressively. Strong bullish confirmation historically (+15% avg forward 12mo).' };
}

// ---- Sector Rotation Regime — cyclicals vs defensives 3M spread ----
//
// Measures where the money is flowing at a rotation level: are investors
// bidding up cyclical sectors (tech, financials, industrials, discretionary,
// communication) or hiding in defensives (staples, utilities, health care,
// real estate)? Formula matches the sector-rotation.html page verbatim:
//
//   spread = avg(cyclical 3M returns) - avg(defensive 3M returns)
//
// Same 0-100 piecewise score mapping the live page uses. Direction: high
// score = risk-on, low = defensive.
//
// PURE TREND indicator — NOT contrarian. Backtest 2000-2026 (6,630 samples):
//   Deep defensive (score 0-15):  +4.8% avg 12mo, 58% hit  ← below baseline
//   Rotation stalled (45-55):     +6.5% avg 12mo, 75% hit  ← baseline
//   Deep risk-on (score 85+):     +13.5% avg 12mo, 88% hit ← best bucket
// Baseline: +7.8%, 76%. Unlike VIX or % Above 200MA, deep-defensive does
// NOT bounce back — when cyclicals are getting crushed, forward returns
// stay weak. Extreme risk-on continues trending (no exhaustion penalty).
function scoreSectorRegime(spread) {
  if (spread == null || isNaN(spread)) return null;
  const s = spread;
  let score;
  if (s <= -8)      score = Math.max(0, 15 + (s + 8) * (15 / 4));
  else if (s <= -5) score = 15 + (s + 8) * (15 / 3);
  else if (s <= -1) score = 30 + (s + 5) * (15 / 4);
  else if (s <=  1) score = 45 + (s + 1) * (10 / 2);
  else if (s <=  5) score = 55 + (s - 1) * (15 / 4);
  else if (s <=  8) score = 70 + (s - 5) * (15 / 3);
  else              score = Math.min(100, 85 + (s - 8) * (15 / 4));
  return Math.max(2, Math.min(98, score));
}

function sectorRegimeAdvisory(spread) {
  if (spread == null || isNaN(spread)) return null;
  if (spread <= -8) return { tone: 'watch',       text: 'Deep defensive rotation — cyclicals badly lagging defensives. Historically forward returns from here averaged only +4.8% (58% positive), meaningfully worse than the +7.8% baseline. This is NOT a contrarian buy signal — when the tape rotates this defensively, it has tended to stay defensive.' };
  if (spread <= -5) return { tone: 'watch',       text: 'Defensive rotation — money moving into staples, utilities, health care. Bearish trend signal.' };
  if (spread <= -1) return { tone: 'watch',       text: 'Cautious risk-off — defensives modestly leading. Early warning of a rotation shift.' };
  if (spread <=  1) return { tone: 'info',        text: 'Rotation stalled — cyclicals and defensives roughly tied. Market waiting for a catalyst.' };
  if (spread <=  5) return { tone: 'info',        text: 'Cautious risk-on — cyclicals modestly ahead of defensives. Trend tilted positive.' };
  if (spread <=  8) return { tone: 'info',        text: 'Risk-on expansion — cyclicals clearly beating defensives. Healthy trend confirmation.' };
  return                { tone: 'opportunity', text: 'Deep risk-on rotation — cyclicals dominating defensives. Historically the strongest forward-return bucket: +13.5% avg 12mo (88% positive). Trend is broadly intact and continuing.' };
}

// ---- BATS Sector Oscillator — McClellan-style breadth on the 11 SPDR ETFs ----
//
// Computed nightly by scripts/build-sector-osc.py into data/sector_osc.csv.
// Formula: EMA-5 minus EMA-10 of the daily ratio-adjusted A-D across all
// 11 sector ETFs, so it captures how one-sided each day's move is and
// then smooths it just enough to filter single-day noise.
//
// The daily reading swings roughly plus-or-minus 20; clamp at plus-or-minus
// 25 for a full 0-100 map. Negative reading = broad selling day-after-day
// (fear / capitulation) -> LOW score. Positive = broad accumulation
// (participation / momentum) -> HIGH score.
//
// Backtest 1998-2025 (6,681 days):
//   Strong bearish (score < 25): +9.64% avg 12mo, 79.0% hit (n=1,147)
//   Neutral       (score 40-60): +6.82% avg 12mo, 73.5% hit
//   Strong bullish (score >= 75): +8.76% avg 12mo, 77.9% hit (n=1,098)
// Classic U-shape: both tails beat the 7.82%/75.6% baseline, middle is
// where the market drifts. On the seven biggest historic bottoms the
// score confirmed bearish or strong-bearish on 6 of 7 (2009-03-09 was
// already pivoting to neutral, correctly signaling the turn).
function scoreSectorOsc(o) {
  if (o == null || isNaN(o)) return null;
  const CLAMP = 25;
  const c = Math.max(-CLAMP, Math.min(CLAMP, o));
  const score = 50 + (c / CLAMP) * 50;
  return Math.max(2, Math.min(98, score));
}

function sectorOscAdvisory(o) {
  if (o == null || isNaN(o)) return null;
  if (o <= -15) return { tone: 'opportunity', text: 'Broad, sustained sector selling — capitulation-level breadth. Historically an above-baseline forward return zone (contrarian buy tail).' };
  if (o <=  -8) return { tone: 'watch',       text: 'Sectors declining together — bearish breadth. Watch other indicators for confirmation.' };
  if (o <=  -3) return { tone: 'info',        text: 'Mildly negative sector breadth — some sectors leading down, but not broad.' };
  if (o <    3) return { tone: 'info',        text: 'Balanced sector breadth — no strong lean.' };
  if (o <    8) return { tone: 'info',        text: 'Positive sector breadth — sectors advancing together, healthy participation.' };
  if (o <   15) return { tone: 'opportunity', text: 'Broad sector rally — participation confirmation, bullish momentum.' };
  return                { tone: 'opportunity', text: 'Extremely broad sector advance — trend continuation historically (momentum tail).' };
}

// ---- 5-day Rate of Change on the index (SPX or NDX depending on market) ----
//
// A pure momentum measure. Positive = the index rallied over the last 5
// trading days; negative = it sold off. Extreme readings (~+/- 6%) are
// rare — about 1-2% of days each — and historically both tails predict
// well-above-baseline forward returns.
//
// The formula is dead simple:
//     ROC-5 = (close_today / close_5_days_ago - 1) * 100
// Because the index is loaded live in loadLiveData, we don't need a
// separate CSV — the same array feeds this computation and the
// 200-day MA one.
//
// Backtest 1990-2026 (9,176 days, S&P):
//   ROC-5 < -6%  (extreme crash tail):  +21.2% avg 12M, 80% hit
//   ROC-5 > +6%  (extreme rally tail):  +20.9% avg 12M, 89% hit
//   Baseline (all days):                +10.2% avg 12M, 81% hit
//   1-month bonus: crash tail = +3.8% (4x baseline)
//
// Correlation with SPY 14-day RSI = 0.596 — meaningful overlap, but 59%
// of ROC-5 crash-tail days have RSI still above 30 (not yet oversold),
// so this catches short-term panics faster than RSI.
//
// Score mapping: clamp at +/- 6%, linear from there.
//   ROC-5 = -6% -> score 0  (extreme oversold — big recent drop)
//   ROC-5 =  0% -> score 50 (neutral)
//   ROC-5 = +6% -> score 100 (extended — big recent rally)
function scoreROC5(roc) {
  if (roc == null || isNaN(roc)) return null;
  const CLAMP = 6.0;
  const c = Math.max(-CLAMP, Math.min(CLAMP, roc));
  const score = 50 + (c / CLAMP) * 50;
  return Math.max(2, Math.min(98, score));
}

function roc5Advisory(roc) {
  if (roc == null || isNaN(roc)) return null;
  if (roc <= -6) return { tone: 'opportunity', text: 'Extreme 5-day drop — historically a strong short-term contrarian signal (+21% avg 12M, +3.8% just 1M forward).' };
  if (roc <= -3) return { tone: 'watch',       text: 'Meaningful 5-day pullback — market is under pressure. Watch other indicators for confirmation.' };
  if (roc <= -1) return { tone: 'info',        text: 'Mild 5-day drift lower — nothing dramatic.' };
  if (roc <   1) return { tone: 'info',        text: 'Flat 5-day return — the market is quiet.' };
  if (roc <   3) return { tone: 'info',        text: 'Mild 5-day gain — normal upward drift.' };
  if (roc <   6) return { tone: 'info',        text: 'Meaningful 5-day rally — trend is up.' };
  return                { tone: 'opportunity', text: 'Extreme 5-day rally — momentum tail. Historically strong forward returns (+21% avg 12M, 89% hit).' };
}

// Wilder's 14-day RSI from a chronological array of closes.
// Returns the RSI value for the last close, or null if not enough data.
function computeRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let sumG = 0, sumL = 0;
  for (let i = 1; i <= period; i++) {
    const chg = closes[i] - closes[i - 1];
    if (chg > 0) sumG += chg; else sumL += -chg;
  }
  let avgG = sumG / period, avgL = sumL / period;
  for (let i = period + 1; i < closes.length; i++) {
    const chg = closes[i] - closes[i - 1];
    const g = chg > 0 ?  chg : 0;
    const l = chg < 0 ? -chg : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

// ---- Market Breadth — RSP/SPY 20-day spread ----
//
// "Breadth" measures how many stocks are participating in the market's move.
// Traditionally this is "% of S&P 500 stocks above their 50-day MA," but that
// requires computing from all 500 constituents. As a fast, robust proxy we
// use the 20-day RSP/SPY spread:
//     spread = 20-day return(RSP) − 20-day return(SPY)
// RSP is the equal-weight S&P (tracks the AVERAGE stock). SPY is cap-weighted
// (dominated by mega-caps). When the average stock is outrunning the giants
// (positive spread), participation is broad and healthy — CONFIRMATORY bullish.
// When the giants are dragging the index up while the average stock lags
// (negative spread), the rally is narrow and fragile — bearish for breadth.
//
// Distribution over 2003-2026: median 0, 90th pct ±1.6%, extremes ±5%.
// A simple linear map centered on 0 fits the distribution cleanly:
//     score = 50 + spread * 10   (clamped to [5, 95])
//
// Backtest confirms extremes on BOTH sides predict strong forward returns:
//   Very Oversold breadth (spread < -4.5%): +27.7% avg 12mo, 99% hit rate
//   Very Bullish breadth  (spread > +4.5%): +21.4% avg 12mo, 93% hit rate
function scoreBreadth(spread) {
  if (spread == null || isNaN(spread)) return null;
  const score = 50 + spread * 10;
  return Math.max(5, Math.min(95, score));
}

function breadthAdvisory(spread) {
  if (spread == null || isNaN(spread)) return null;
  if (spread <= -4.5) return { tone: 'opportunity', text: 'Extreme narrow leadership. Historically a very strong contrarian buy signal — narrow markets have delivered ~+28% average forward 12mo returns (99% positive).' };
  if (spread <= -2.5) return { tone: 'opportunity', text: 'Narrow rally — mega-caps carrying the index while the average stock lags. Historically a bullish setup for forward returns.' };
  if (spread <= -0.8) return { tone: 'watch',       text: 'Slightly narrow — the average stock is trailing the index. Not alarming yet, but worth watching.' };
  if (spread <   0.8) return { tone: 'info',        text: 'Balanced participation — average stock and index moving together. Neutral breadth.' };
  if (spread <   2.5) return { tone: 'info',        text: 'Broad participation — average stock is keeping up. Healthy market internals.' };
  if (spread <   4.5) return { tone: 'opportunity', text: 'Very broad rally — average stock is outrunning the index. Strong confirmation of the trend.' };
  return                     { tone: 'opportunity', text: 'Extreme broad participation — average stock is dominating. Historically a strong bullish signal (+21% avg forward 12mo, 93% positive).' };
}

// Plain-English advisory that surfaces on the VIX card next to the reading.
// Language is calibrated to the 1990–2026 backtest (see indicators/vix.html):
//   Very Oversold (VIX ≥ 35) delivered ~+28% avg S&P return over the next 12
//   months, 93% positive — the "buy the panic" contrarian signal is REAL.
//   Slightly-elevated VIX (20–25) is historically the WEAKEST forward-return
//   zone. Low VIX (<12) did NOT underperform — complacency is not, on its
//   own, a sell signal, so we soften the earlier "take profits" language.
function vixAdvisory(vix) {
  if (vix == null || isNaN(vix)) return null;
  if (vix > 45)  return { tone: 'opportunity', text: 'Panic zone. Historically the strongest contrarian BUY signal — extreme readings have preceded ~+28% average S&P 500 returns over the next 12 months (93% positive).' };
  if (vix >= 35) return { tone: 'opportunity', text: 'Heavy fear. A strong contrarian buy signal — extreme oversold readings historically delivered ~+28% average 12-month S&P returns.' };
  if (vix >= 25) return { tone: 'opportunity', text: 'Elevated fear. Historically a buying opportunity — forward 12-month returns here have averaged ~+10% (74% positive).' };
  if (vix >= 20) return { tone: 'watch',       text: 'Slightly elevated — historically this "nervous but not panicked" zone has been the WEAKEST for forward returns (+5% avg 12mo). Not a sell signal, but weaker than typical.' };
  if (vix >= 15) return { tone: 'info',        text: 'Baseline volatility — the market\'s long-term normal range (15–20). Historically neutral to solid forward returns.' };
  if (vix >= 12) return { tone: 'info',        text: 'Calm, confident bull-market zone — historically forward 12mo returns here have averaged ~+11%.' };
  return                  { tone: 'info',       text: 'Extreme calm and complacency. History does NOT support selling on this alone — sustained low VIX has coincided with continued bull markets. Watch for signs of a shift, but respect the trend.' };
}

// --- The components that will feed the BATS ---
//  status: 'live'  = we have real data flowing in
//          'soon'  = placeholder; not yet wired up
//  weight: relative weight in the final score (we'll tune later)
//  signal: 0-100 (oversold -> bullish). null until live.
const COMPONENTS = [
  {
    key: 'vix',
    name: `${MC.volTicker} (Volatility)`,
    desc: 'The "fear gauge." Contrarian: high volatility often means a buying opportunity; low volatility means complacency.',
    weight: 25,
    status: 'live',
    raw: 22.5,
    value: '22.5 (demo)',
    signal: scoreVIX(22.5),
    advisory: vixAdvisory(22.5),
    explainer: 'indicators/vix.html',
  },
  {
    key: 'breadth',
    name: 'Market Breadth',
    desc: `How many stocks are participating (${MC.breadthLabel} 20-day spread). Confirmatory: broad participation is bullish, narrow rallies are fragile.`,
    weight: 10,
    status: 'live',
    raw: -0.8,
    value: '−0.8% (demo)',
    signal: scoreBreadth(-0.8),
    advisory: breadthAdvisory(-0.8),
    explainer: 'indicators/breadth.html',
  },
  {
    key: 'spy_rsi',
    name: `${MC.rsiTicker} 14-day RSI`,
    desc: 'Momentum. Below 30 = oversold (bullish); above 70 = overbought (bearish). Markets can stay stretched.',
    weight: 10,
    status: 'live',
    raw: 42,
    value: '42 (demo)',
    signal: scoreRSI(42),
    advisory: rsiAdvisory(42),
    explainer: 'indicators/rsi.html',
  },
  {
    key: 'ma200',
    name: `${MC.indexTicker} vs 200-day MA`,
    desc: 'How far above or below its long-term trend the market sits. Far below = crash zone (bullish); far above = strong uptrend (also bullish, not overbought).',
    weight: 10,
    status: 'live',
    raw: 0,
    value: '0.00% (loading)',
    signal: scoreMA200(0),
    advisory: ma200Advisory(0),
    explainer: 'indicators/ma200.html',
  },
  {
    key: 'ma50',
    name: `${MC.indexTicker} vs 50-day MA`,
    desc: 'Faster-moving trend cousin of MA200. Captures short-term shifts — market drops below its 50-day well before its 200-day. Above = short-term uptrend; below = short-term weakness.',
    weight: 5,
    status: 'live',
    raw: 0,
    value: '0.00% (loading)',
    signal: scoreMA50(0),
    advisory: ma50Advisory(0),
    explainer: 'indicators/ma200.html',
  },
  {
    key: 'pct_above_200ma',
    name: '% of Stocks Above 200 MA',
    desc: 'Breadth: of ~100 large-cap S&P constituents, how many are trading above their own 200-day MA. High = broad participation (bullish); very low = washout (historically the strongest contrarian buy signal we track).',
    weight: 20,
    status: 'live',
    raw: 0,
    value: '— (loading)',
    signal: scorePctAbove200MA(50),
    advisory: pctAbove200MAAdvisory(50),
    explainer: 'indicators/pct-above-200ma.html',
  },
  {
    key: 'pct_above_50ma',
    name: '% of Stocks Above 50 MA',
    desc: 'Faster-moving breadth cousin of the 200 MA version. Swings farther and faster — captures short-term participation shifts before the long-term measure does.',
    weight: 5,
    status: 'live',
    raw: 0,
    value: '— (loading)',
    signal: scorePctAbove50MA(50),
    advisory: pctAbove50MAAdvisory(50),
    explainer: 'indicators/pct-above-200ma.html',
  },
  {
    key: 'naaim',
    name: 'NAAIM Manager Exposure',
    desc: 'Weekly survey of active investment managers — how much equity exposure they hold. Low readings = defensive = historically buy zone.',
    weight: 5,
    status: 'live',
    raw: 0,
    value: '0 (loading)',
    signal: scoreNAAIM(0),
    advisory: naaimAdvisory(0),
    explainer: 'indicators/naaim.html',
  },
  {
    key: 'junk_demand',
    name: 'Junk Bond Demand',
    desc: 'Credit-market risk appetite: HYG vs LQD 20-day return spread. Confirmatory: positive = investors chasing yield = bullish.',
    weight: 10,
    status: 'live',
    raw: 0,
    value: '0.00% (loading)',
    signal: scoreJunkDemand(0),
    advisory: junkDemandAdvisory(0),
    explainer: 'indicators/junk-bond-demand.html',
  },
  {
    key: 'yield_spread',
    name: '10Y-2Y Yield Spread',
    desc: 'The bond market\'s recession signal. 10-year minus 2-year Treasury yields, in percentage points. Leading: inverted = recession warning; steep = healthy expansion.',
    weight: 5,
    status: 'live',
    raw: 0,
    value: '0.00 pp (loading)',
    signal: scoreYieldSpread(0.5),
    advisory: yieldSpreadAdvisory(0.5),
    explainer: 'indicators/yield-spread.html',
  },
  {
    key: 'sector_osc',
    name: 'Sector Oscillator',
    desc: 'A McClellan-style breadth measure on the 11 SPDR sector ETFs. Short-term: captures whether sectors are moving together (broad participation) or diverging (narrow tape). Proprietary to BATS.',
    weight: 10,
    status: 'live',
    raw: 0,
    value: '0.00 (loading)',
    signal: scoreSectorOsc(0),
    advisory: sectorOscAdvisory(0),
    explainer: 'indicators/sector-oscillator.html',
  },
  {
    key: 'roc5',
    name: `${MC.indexTicker} 5-day ROC`,
    desc: 'Pure short-term momentum: the index\'s percentage change over the last 5 trading days. Extreme moves in either direction (>=6%) historically predict above-baseline forward returns — a genuine U-shape signal.',
    weight: 10,
    status: 'live',
    raw: 0,
    value: '0.00% (loading)',
    signal: scoreROC5(0),
    advisory: roc5Advisory(0),
    explainer: 'indicators/roc5.html',
  },
  {
    key: 'sector_regime',
    name: 'Sector Rotation Regime',
    desc: '3-month cyclical vs defensive spread — where the money is flowing at a rotation level. Trend indicator: positive spread = risk-on (cyclicals leading), negative = risk-off (defensives leading). Historically the deep risk-on tail averaged +13.5% forward 12mo, 88% positive.',
    weight: 10,
    status: 'live',
    raw: 0,
    value: '0.00 pp (loading)',
    signal: scoreSectorRegime(0),
    advisory: sectorRegimeAdvisory(0),
    explainer: 'indicators/sector-regime.html',
  },
];

// ============================================================
// GAUGE
// ============================================================

const GAUGE = {
  cx: 200,
  cy: 200,
  rOuter: 160,
  rInner: 110,
  segmentGap: 1.5, // degrees of empty space between segments
};

// Math angles: 0° = right, 90° = up, 180° = left.
// Our gauge sweeps from 180° (left) through 90° (top) to 0° (right).
function polarToXY(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

// Draw a filled "wedge" arc segment between two angles on the gauge.
function wedgePath(startDeg, endDeg) {
  const { cx, cy, rOuter, rInner } = GAUGE;
  const p1 = polarToXY(cx, cy, rOuter, startDeg);
  const p2 = polarToXY(cx, cy, rOuter, endDeg);
  const p3 = polarToXY(cx, cy, rInner, endDeg);
  const p4 = polarToXY(cx, cy, rInner, startDeg);
  // We're going from a larger angle (start) to a smaller angle (end) on the
  // upper half. In SVG (y flipped), sweep-flag=0 puts the arc on top.
  return [
    `M ${p1.x} ${p1.y}`,
    `A ${rOuter} ${rOuter} 0 0 0 ${p2.x} ${p2.y}`,
    `L ${p3.x} ${p3.y}`,
    `A ${rInner} ${rInner} 0 0 1 ${p4.x} ${p4.y}`,
    'Z',
  ].join(' ');
}

function buildGauge() {
  const svg = document.getElementById('sentimentGauge');
  if (!svg) return;

  const totalDeg = 180;
  const gap = GAUGE.segmentGap;
  const segDeg = (totalDeg - gap * (BUCKETS.length - 1)) / BUCKETS.length;

  // Equal-width arcs — one for each bucket, visually uniform. The needle
  // position math (see scoreToGaugeAngle) uses piecewise interpolation
  // so a score inside a given bucket always lands in that bucket's arc,
  // regardless of the bucket's underlying score range.
  let cursor = 180;
  BUCKETS.forEach((bucket, i) => {
    const segStart = cursor;
    const segEnd = cursor - segDeg;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', wedgePath(segStart, segEnd));
    path.setAttribute('fill', bucket.color);
    path.setAttribute('data-bucket', i);
    svg.appendChild(path);
    cursor = segEnd - gap;
  });

  // Speedometer-style tick marks + numeric labels around the outside.
  // Values chosen to land exactly at the bucket-boundary arc positions under
  // the piecewise score→angle mapping — so ticks always line up with the
  // color-band transitions on the gauge.
  const MAJOR_TICKS = [0, 45, 65, 100];         // start / Neutral / Bullish / max
  const MINOR_TICKS = [15, 18, 30, 57, 72];     // other bucket boundaries

  function tickAngle(v) { return scoreToGaugeAngle(v); }

  function drawTick(v, len, strokeWidth) {
    const a = tickAngle(v);
    const p1 = polarToXY(GAUGE.cx, GAUGE.cy, GAUGE.rOuter + 2,   a);
    const p2 = polarToXY(GAUGE.cx, GAUGE.cy, GAUGE.rOuter + 2 + len, a);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', p1.x);
    line.setAttribute('y1', p1.y);
    line.setAttribute('x2', p2.x);
    line.setAttribute('y2', p2.y);
    line.setAttribute('stroke', '#8b95a8');
    line.setAttribute('stroke-width', strokeWidth);
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);
  }

  MINOR_TICKS.forEach(v => drawTick(v, 4, 1));
  MAJOR_TICKS.forEach(v => drawTick(v, 8, 2));

  MAJOR_TICKS.forEach(v => {
    const a = tickAngle(v);
    const pos = polarToXY(GAUGE.cx, GAUGE.cy, GAUGE.rOuter + 28, a);
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', pos.x);
    text.setAttribute('y', pos.y);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('fill', '#e6edf6');
    text.setAttribute('font-family', "'JetBrains Mono', ui-monospace, monospace");
    text.setAttribute('font-size', '19');
    text.setAttribute('font-weight', '700');
    text.textContent = v;
    svg.appendChild(text);
  });

  // Needle (centered pivot circle + line)
  const needle = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  needle.setAttribute('id', 'gaugeNeedle');
  needle.setAttribute('x1', GAUGE.cx);
  needle.setAttribute('y1', GAUGE.cy);
  needle.setAttribute('x2', GAUGE.cx);
  needle.setAttribute('y2', GAUGE.cy - GAUGE.rOuter + 5);
  needle.setAttribute('stroke', '#ffffff');
  needle.setAttribute('stroke-width', '3.5');
  needle.setAttribute('stroke-linecap', 'round');
  needle.style.transformOrigin = `${GAUGE.cx}px ${GAUGE.cy}px`;
  needle.style.transition = 'transform 1.2s cubic-bezier(.22,1,.36,1)';
  svg.appendChild(needle);

  const pivot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  pivot.setAttribute('cx', GAUGE.cx);
  pivot.setAttribute('cy', GAUGE.cy);
  pivot.setAttribute('r', '12');
  pivot.setAttribute('fill', '#0a0e1a');
  pivot.setAttribute('stroke', '#ffffff');
  pivot.setAttribute('stroke-width', '2.5');
  svg.appendChild(pivot);
}

// Map a BATS score (0-100) to the math angle on the gauge arc.
// PIECEWISE: each bucket owns an equal 1/7 slice of the arc, so a score
// inside bucket N always points somewhere inside that bucket's colored arc.
// Progress within a bucket is linear (score → arc angle) within its slice.
function scoreToGaugeAngle(score) {
  const s = Math.max(0, Math.min(100, score));
  const bIdx = bucketIndexFor(s);
  const b = BUCKETS[bIdx];
  const nextMin = (bIdx < BUCKETS.length - 1) ? BUCKETS[bIdx + 1].min : 100;
  const bucketScoreWidth = nextMin - b.min;
  const progress = bucketScoreWidth > 0 ? (s - b.min) / bucketScoreWidth : 0;
  const arcPerBucket = 180 / BUCKETS.length;
  return 180 - bIdx * arcPerBucket - progress * arcPerBucket;
}

// Move needle to a 0-100 value
function setGauge(value) {
  const v = Math.max(0, Math.min(100, value));
  const targetMathDeg = scoreToGaugeAngle(v);
  const rotateBy = 90 - targetMathDeg;
  const needle = document.getElementById('gaugeNeedle');
  if (needle) needle.style.transform = `rotate(${rotateBy}deg)`;

  const bucketIndex = bucketIndexFor(v);
  const b = BUCKETS[bucketIndex];
  const labelEl = document.getElementById('readingLabel');
  const actionEl = document.getElementById('readingAction');
  const valueEl = document.getElementById('readingValue');
  const subtitleEl = document.getElementById('readingSubtitle');
  const timeEl = document.getElementById('updatedTime');
  if (labelEl) labelEl.textContent = b.label;
  if (actionEl) actionEl.textContent = b.action;
  if (valueEl) valueEl.textContent = Math.round(v);
  if (subtitleEl) subtitleEl.textContent = b.subtitle;
  if (timeEl) timeEl.textContent = new Date().toLocaleString();

  // Highlight active legend item
  document.querySelectorAll('.legend-item').forEach((el, i) => {
    el.classList.toggle('active', i === bucketIndex);
  });
}

// ============================================================
// SUB-SCORES — Upside Trend + Pivot Top
// Both are derived from the same live component signals used in main BATS.
// Upside Trend: 0-100, higher = trend healthier.
// Pivot Top:    0-100, higher = MORE pivot/top risk (inverted direction).
// ============================================================
function computeUpsideTrend(current) {
  if (!current) return null;
  // Weighted average of trend-oriented component scores (all 0-100).
  // Weights concentrate on short-term momentum family (ROC-5, ROC-10, MACD,
  // Bollinger %B together = ~35%) so the gauge responds to day-to-day SPX
  // action rather than sitting still while slow structural signals drift.
  const items = [
    { w: 10, s: current.ms     },   // MA200
    { w:  8, s: current.ms50   },   // MA50 (faster)
    { w: 15, s: current.ps     },   // % Above 200 MA
    { w:  8, s: current.ps50   },   // % Above 50 MA (faster)
    { w: 10, s: current.srs    },   // Sector Regime
    { w:  7, s: current.js     },   // Junk Bond Demand
    { w:  7, s: current.sos    },   // Sector Oscillator
    { w:  8, s: current.roc    },   // ROC-5   (short-term momentum)
    { w:  7, s: current.roc10s },   // ROC-10  (short-term momentum, longer horizon)
    { w: 10, s: current.macds  },   // MACD histogram (momentum inflection)
    { w: 10, s: current.bbs    },   // Bollinger %B  (volatility-adjusted position)
  ];
  let sum = 0, wsum = 0;
  for (const it of items) {
    if (it.s == null) continue;
    sum  += it.s * it.w;
    wsum += it.w;
  }
  if (wsum === 0) return null;
  const score = sum / wsum;
  let state, sentence;
  if      (score >= 75) { state = 'Trend strong';    sentence = 'Broad participation, momentum intact, cyclicals leading.'; }
  else if (score >= 60) { state = 'Trend intact';    sentence = 'Uptrend healthy across most trend measures.'; }
  else if (score >= 45) { state = 'Trend neutral';   sentence = 'Mixed signals — no clear trend direction.'; }
  else if (score >= 30) { state = 'Trend faltering'; sentence = 'Trend signals weakening — watch for continuation.'; }
  else                  { state = 'Trend broken';    sentence = 'Broad breakdown — trend has failed.'; }
  return { score, state, sentence };
}

function computePivotTop(current) {
  if (!current) return null;
  // Each contribution is 0-100 = "how much pivot risk does this indicator add?"
  // Higher final score = more risk of a short-term top forming.
  const contribs = [];
  // RSI overbought — piecewise ramp: gradual 60→70 (linear to 50), then a
  // steep bonus above 70 (linear from 50→100 by RSI 75). Rewards early
  // over-70 readings much more heavily than the 60-70 warm-up zone —
  // matches "RSI > 70 = actually overbought" convention.
  if (current.rsiVal != null) {
    let r;
    if      (current.rsiVal <= 60) r = 0;
    else if (current.rsiVal <= 70) r = (current.rsiVal - 60) * 5;   // 60→0, 70→50
    else                           r = Math.min(100, 50 + (current.rsiVal - 70) * 10);   // 70→50, 75→100
    contribs.push({ w: 40, s: r });
  }
  // NAAIM extreme leverage — 0 at NAAIM 75, 100 at NAAIM 100
  if (current.naaimValue != null) {
    contribs.push({ w: 20, s: Math.max(0, Math.min(100, (current.naaimValue - 75) * 4)) });
  }
  // SPX overextended above 50MA — 0 at +2%, 100 at +7%
  if (current.ma50Dist != null) {
    contribs.push({ w: 25, s: Math.max(0, Math.min(100, (current.ma50Dist - 2) * 20)) });
  }
  // VIX complacency (very low VIX = tail risk mispriced) — 0 at 15, 100 at 10
  if (current.vix != null) {
    contribs.push({ w: 15, s: Math.max(0, Math.min(100, (15 - current.vix) * 20)) });
  }
  // Bollinger %B — SAME raw input as Upside Trend, but scored with OPPOSITE
  // framing here. In Upside Trend, %B > 1 means "trend continues, healthy."
  // In Pivot Top, %B > 1 means "price above upper band = classic overbought
  // pierce-and-reverse warning." Steep ramp past 0.9 so the score really
  // moves when SPX pokes above the upper band (which historically has
  // preceded short-term tops).
  //   %B < 0.5    -> 0
  //   0.5 - 0.7   -> 0-15
  //   0.7 - 0.9   -> 15-45
  //   0.9 - 1.0   -> 45-75  (at the band)
  //   1.0 - 1.1   -> 75-95  (above the band — real warning)
  //   > 1.1       -> 98
  if (current.bbVal != null) {
    const b = current.bbVal;
    let bs;
    if      (b < 0.5) bs = 0;
    else if (b < 0.7) bs = (b - 0.5) * (15  / 0.2);
    else if (b < 0.9) bs = 15 + (b - 0.7) * ((45 - 15) / 0.2);
    else if (b < 1.0) bs = 45 + (b - 0.9) * ((75 - 45) / 0.1);
    else if (b < 1.1) bs = 75 + (b - 1.0) * ((95 - 75) / 0.1);
    else              bs = 98;
    contribs.push({ w: 25, s: Math.max(0, Math.min(100, bs)) });
  }
  let sum = 0, wsum = 0;
  for (const c of contribs) { sum += c.s * c.w; wsum += c.w; }
  if (wsum === 0) return null;
  const raw = sum / wsum;
  // Scale transform: the raw weighted average tops out around 85 historically
  // (22-year backtest max = 85.7 on 2018-01-26). That leaves the top ~15 pts
  // of the 0-100 space dead and no way to communicate "actually extreme."
  // Piecewise stretch: readings <= 30 pass through unchanged (a calm tape
  // still reads calm), readings > 30 stretch by 1.2 so old 80 -> new 90 and
  // the Feb-2018-style max (85.7) reaches ~97. Cap at 100.
  const score = raw <= 30 ? raw : Math.min(100, 30 + (raw - 30) * 1.2);
  let state, sentence;
  if      (score >= 90) { state = 'Extreme top'; sentence = 'All signals pinned near extremes — historically rare and preceded major short-term reversals (Feb 2018, Aug-Sep 2020, July 2024).'; }
  else if (score >= 70) { state = 'Top forming'; sentence = 'Multiple overheated signals firing — high risk of a short-term top.'; }
  else if (score >= 50) { state = 'Watch top';   sentence = 'Some overheated readings — pivot risk elevated.'; }
  else if (score >= 30) { state = 'Warming';     sentence = 'Mild overextension in a few components.'; }
  else                  { state = 'Clean tape';  sentence = 'No significant overheated signals — no top warning.'; }
  return { score, state, sentence };
}

// Draw a cockpit-style sub-gauge that "opens outward" — a 180° arc where the
// FLAT chord side faces the main BATS gauge and the arc CURVES AWAY from it.
// Left sub-gauge: arc bulges left (like a "(" shape). Right sub-gauge: mirror.
// Needle sweeps along the arc; score 0 at bottom, 100 at top.
//
// SVG viewBox is portrait-ish (150 × 200). Arc center is on the inner edge
// (right side for left sub-gauge, left side for right sub-gauge) so the arc
// can bulge outward to fill the box.
//
// side: 'left' means arc opens right (bulges left); 'right' means mirror.
function buildSubGauge(svgId, palette, side) {
  const svg = document.getElementById(svgId);
  if (!svg) return;
  const rOuter = 140, rInner = 100;
  // Anchor arc center to the INNER edge of the viewBox (facing main gauge).
  const cy = 180;
  const cx = side === 'left' ? 198 : 2;   // right edge for left sub, left edge for right sub

  const fillColor  = palette === 'red' ? 'rgba(239,68,68,0.65)'  : 'rgba(34,197,94,0.65)';
  const trackColor = 'rgba(139,149,168,0.32)';

  // Track: 180° arc from top of the flat edge, through the outer bulge, to the bottom of the flat edge.
  // Math angles: for LEFT sub-gauge, from 90° (top) counter-clockwise through 180° (left) to 270° (bottom).
  // For RIGHT sub-gauge, from 90° (top) clockwise through 0° (right) to -90° (bottom).
  const track = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  track.setAttribute('d', subGaugeArcPath(cx, cy, rOuter, rInner, side, 100));  // full-scale track (score=100 sweep)
  track.setAttribute('fill', trackColor);
  svg.appendChild(track);

  // Filled arc — starts at score 0 (empty). Updated by setSubGauge.
  const fill = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  fill.setAttribute('id', svgId + '_fill');
  fill.setAttribute('fill', fillColor);
  svg.appendChild(fill);

  // Tick marks at 0 / 25 / 50 / 75 / 100 INSIDE the ring (safe from viewBox clipping).
  const ticks = [
    { v: 0,   label: '0',   major: true  },
    { v: 25,  label: '',    major: false },
    { v: 50,  label: '50',  major: true  },
    { v: 75,  label: '',    major: false },
    { v: 100, label: '100', major: true  },
  ];
  ticks.forEach(t => {
    const rad = subGaugeAngleRad(t.v, side);
    // Draw tick line across the ring itself (from just outside rInner to just inside rOuter)
    const rTickIn  = rInner + 2;
    const rTickOut = rInner + (t.major ? 14 : 8);
    const p1x = cx + rTickIn  * Math.cos(rad);
    const p1y = cy - rTickIn  * Math.sin(rad);
    const p2x = cx + rTickOut * Math.cos(rad);
    const p2y = cy - rTickOut * Math.sin(rad);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', p1x); line.setAttribute('y1', p1y);
    line.setAttribute('x2', p2x); line.setAttribute('y2', p2y);
    line.setAttribute('stroke', 'rgba(255,255,255,0.7)');
    line.setAttribute('stroke-width', t.major ? 2 : 1.25);
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);
    // Label just OUTSIDE the ring. The 0 and 100 labels sit at the chord edge
    // (top/bottom of the vertical arc, right AT cx), so their text would extend
    // past the viewBox edge with the default middle anchor. Anchor them INWARD
    // (end for left-gauge chord, start for right-gauge chord) so they read as
    // "attached to the tick" and never clip.
    if (t.label) {
      const isAtChord = (t.v === 0 || t.v === 100);
      const anchor = isAtChord
        ? (side === 'left' ? 'end' : 'start')
        : 'middle';
      // Slight horizontal pad away from the chord to keep the label off the tick.
      const padX = isAtChord ? (side === 'left' ? -3 : 3) : 0;
      const lx = cx + (rOuter + 16) * Math.cos(rad) + padX;
      const ly = cy - (rOuter + 16) * Math.sin(rad);
      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', lx); txt.setAttribute('y', ly);
      txt.setAttribute('text-anchor', anchor);
      txt.setAttribute('dominant-baseline', 'middle');
      txt.setAttribute('fill', '#8b95a8');
      txt.setAttribute('font-family', "'JetBrains Mono', ui-monospace, monospace");
      txt.setAttribute('font-size', '13');
      txt.setAttribute('font-weight', '600');
      txt.textContent = t.label;
      svg.appendChild(txt);
    }
  });

  // BIG score number INSIDE the arc bulge — visually anchored inside the curve.
  // Position ~60% into the bulge (so it's clearly inside the arc, not floating at edge).
  const numX = cx + (side === 'left' ? -75 : 75);
  const numY = cy - 4;
  const num = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  num.setAttribute('id', svgId + '_num');
  num.setAttribute('x', numX); num.setAttribute('y', numY);
  num.setAttribute('text-anchor', 'middle');
  num.setAttribute('dominant-baseline', 'middle');
  num.setAttribute('fill', palette === 'red' ? '#f87171' : '#4ade80');
  num.setAttribute('font-family', "'JetBrains Mono', ui-monospace, monospace");
  num.setAttribute('font-size', '52');
  num.setAttribute('font-weight', '700');
  num.textContent = '—';
  svg.appendChild(num);

  // Needle — starts pointing to score 50 (midpoint of arc, outermost). Rotates via CSS transform.
  const needle = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  needle.setAttribute('id', svgId + '_needle');
  const startRad = subGaugeAngleRad(50, side);
  needle.setAttribute('x1', cx);
  needle.setAttribute('y1', cy);
  needle.setAttribute('x2', cx + (rOuter - 8) * Math.cos(startRad));
  needle.setAttribute('y2', cy - (rOuter - 8) * Math.sin(startRad));
  needle.setAttribute('stroke', '#ffffff');
  needle.setAttribute('stroke-width', '3.5');
  needle.setAttribute('stroke-linecap', 'round');
  needle.style.transformOrigin = `${cx}px ${cy}px`;
  needle.style.transition = 'transform 1s cubic-bezier(.22,1,.36,1)';
  svg.appendChild(needle);

  // Pivot cap.
  const pivot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  pivot.setAttribute('cx', cx);
  pivot.setAttribute('cy', cy);
  pivot.setAttribute('r', '10');
  pivot.setAttribute('fill', '#0a0e1a');
  pivot.setAttribute('stroke', '#ffffff');
  pivot.setAttribute('stroke-width', '2.5');
  svg.appendChild(pivot);
}

// Return the math-angle (radians) that a given score maps to on this side's arc.
// For LEFT (arc bulges left): score 0 = bottom (270°/-90°), 50 = left (180°), 100 = top (90°).
// For RIGHT (arc bulges right): score 0 = bottom (-90°), 50 = right (0°), 100 = top (90°).
function subGaugeAngleRad(score, side) {
  const s = Math.max(0, Math.min(100, score));
  const t = s / 100;   // 0..1
  const startDeg = -90;   // bottom
  const endDeg   = 90;    // top
  // LEFT sweeps counter-clockwise (via 180°): angle grows from -90 through -180 to -270 (== 90°)
  // RIGHT sweeps clockwise (via 0°): angle grows from -90 through 0 to 90
  const deg = side === 'left'
    ? startDeg - t * 180    // -90 → -270 (== +90, via left)
    : startDeg + t * 180;   // -90 → +90 (via right)
  return (deg * Math.PI) / 180;
}

// Build the fill/track arc path from score 0 to `score`, honoring the side's sweep direction.
function subGaugeArcPath(cx, cy, rOuter, rInner, side, score) {
  const s = Math.max(0, Math.min(100, score));
  const startRad = subGaugeAngleRad(0, side);
  const endRad   = subGaugeAngleRad(s, side);
  const toXY = (r, rad) => ({ x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) });
  const p1 = toXY(rOuter, startRad);
  const p2 = toXY(rOuter, endRad);
  const p3 = toXY(rInner, endRad);
  const p4 = toXY(rInner, startRad);
  const largeArc = 0;   // never more than 180° sweep for the fill
  // sweep-flag: 1 for LEFT (counter-clockwise in SVG-flipped y), 0 for RIGHT.
  const sweepOuter = side === 'left' ? 1 : 0;
  const sweepInner = side === 'left' ? 0 : 1;
  return [
    `M ${p1.x} ${p1.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} ${sweepOuter} ${p2.x} ${p2.y}`,
    `L ${p3.x} ${p3.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} ${sweepInner} ${p4.x} ${p4.y}`,
    'Z',
  ].join(' ');
}

function setSubGauge(svgId, subScore, valueElId, stateElId, palette, side) {
  const valueEl = document.getElementById(valueElId);
  const stateEl = document.getElementById(stateElId);
  const numEl   = document.getElementById(svgId + '_num');
  if (!subScore) {
    if (valueEl) valueEl.textContent = '—';
    if (stateEl) stateEl.textContent = 'No data';
    if (numEl)   numEl.textContent = '—';
    return;
  }
  const s = Math.max(0, Math.min(100, subScore.score));

  const rOuter = 140, rInner = 100;
  const cy = 180;
  const cx = side === 'left' ? 198 : 2;

  const fill = document.getElementById(svgId + '_fill');
  if (fill) fill.setAttribute('d', subGaugeArcPath(cx, cy, rOuter, rInner, side, s));

  // Needle: default (in SVG) points to score=50 (outermost). Rotate to point to `s`.
  // Compute the needle's target math-angle delta (targetRad - baseRad, in degrees).
  // SVG rotation is CW-positive; our math angles are CCW-positive with y flipped,
  // which means positive math rotation IS positive SVG rotation for our setup.
  // (For LEFT sub-gauge going score 50→69: math goes -180°→-214°, delta = -34°,
  // needle needs to swing CW visually from 9 o'clock toward 11 o'clock → rotate(+34°)
  // matches once we sign-flip the math delta.)
  const targetRad = subGaugeAngleRad(s, side);
  const baseRad   = subGaugeAngleRad(50, side);
  const rotateBy  = (baseRad - targetRad) * 180 / Math.PI;
  const needle = document.getElementById(svgId + '_needle');
  if (needle) needle.style.transform = `rotate(${rotateBy}deg)`;

  if (valueEl) valueEl.textContent = Math.round(s);
  if (stateEl) stateEl.textContent = subScore.state;
  if (numEl)   numEl.textContent = Math.round(s);
}

// ============================================================
// LEGEND
// ============================================================
function buildLegend() {
  const wrap = document.getElementById('scaleLegend');
  if (!wrap) return;
  BUCKETS.forEach((b) => {
    const el = document.createElement('span');
    el.className = 'legend-item';
    el.innerHTML = `
      <span class="legend-swatch" style="background:${b.color}"></span>
      <span class="legend-text">
        <span class="legend-label">${b.label}</span>
        <span class="legend-action">${b.action}</span>
      </span>
    `;
    wrap.appendChild(el);
  });
}

// ============================================================
// COMPONENTS GRID
// ============================================================
function buildComponents() {
  const grid = document.getElementById('componentsGrid');
  if (!grid) return;

  const totalLiveWeight = COMPONENTS
    .filter(c => c.status === 'live' && c.weight > 0)
    .reduce((s, c) => s + c.weight, 0);

  COMPONENTS.forEach((c) => {
    const card = document.createElement('div');
    card.className = 'comp-card';
    const pill = c.status === 'live' ? 'live' : 'soon';
    const pillLabel = c.status === 'live' ? 'Live' : 'Coming Soon';
    const signalPct = c.signal == null ? 50 : c.signal;

    const weightPct = (c.status === 'live' && c.weight > 0 && totalLiveWeight > 0)
      ? Math.round((c.weight / totalLiveWeight) * 100)
      : null;
    const weightHTML = weightPct != null
      ? `<span class="pill weight-pill">${weightPct}% of BATS</span>`
      : '';

    const advisoryHTML = c.advisory
      ? `<div class="advisory advisory-${c.advisory.tone}">${c.advisory.text}</div>`
      : '';
    const explainerHTML = c.explainer
      ? `<a href="${c.explainer}" class="learn-more">How this affects the score &rarr;</a>`
      : '';

    card.innerHTML = `
      <h3>${c.name} <span class="pill ${pill}">${pillLabel}</span> ${weightHTML}</h3>
      <div class="value">${c.value}</div>
      <div class="desc">${c.desc}</div>
      <div class="signal-bar"><span class="marker" style="left:${signalPct}%"></span></div>
      ${advisoryHTML}
      ${explainerHTML}
    `;
    grid.appendChild(card);
  });
}

// ============================================================
// COMPOSITION STRIP — shows which live components blend into the BATS
// ============================================================
function buildComposition() {
  const el = document.getElementById('compositionChips');
  if (!el) return;
  const live = COMPONENTS.filter(c => c.status === 'live' && c.weight > 0);
  const total = live.reduce((s, c) => s + c.weight, 0);
  if (!live.length || total <= 0) {
    el.textContent = 'No live components yet.';
    return;
  }
  el.innerHTML = live.map(c => {
    const pct = Math.round((c.weight / total) * 100);
    const shortName = c.name.replace(/\s+\(.+\)$/, '');
    return `<span class="chip"><strong>${shortName}</strong> ${pct}%</span>`;
  }).join('');
}

// ============================================================
// BATS SCORE — placeholder blender
// (Once we have live signals, this will produce the real score.)
// ============================================================
function computeBatsScore() {
  const live = COMPONENTS.filter((c) => c.status === 'live' && c.signal != null);
  if (live.length === 0) return 50; // neutral default until data flows

  let weighted = 0;
  let totalWeight = 0;
  live.forEach((c) => {
    weighted += c.signal * c.weight;
    totalWeight += c.weight;
  });
  return totalWeight > 0 ? weighted / totalWeight : 50;
}

// ============================================================
// LIVE DATA — replace demo values with actual numbers computed from
// the latest rows in data/vix.csv, data/rsp.csv, data/spy.csv.
// Also compute historical BATS at previous close / week / month / year
// for the Fear-and-Greed-style context strip.
// ============================================================

const APP_DATA_BASE = (typeof window !== 'undefined' && window.BATS_DATA_BASE) || 'data/';
const HIST_OFFSETS = [
  { key: 'prev',  days: 1,   label: 'Previous close' },
  { key: 'week',  days: 5,   label: '1 week ago' },
  { key: 'month', days: 21,  label: '1 month ago' },
  { key: 'year',  days: 252, label: '1 year ago' },
];

async function fetchCSVText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return await res.text();
}

// VIX schema (DATE,OPEN,HIGH,LOW,CLOSE)
function parseVIXLive(text) {
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const close = parseFloat(parts[4]);
    if (parts[0] && !isNaN(close)) rows.push({ date: parts[0], close });
  }
  return rows;
}

// Date,Close schema (spx.csv, rsp.csv, spy.csv)
function parseDateCloseLive(text) {
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const close = parseFloat(parts[1]);
    if (parts[0] && !isNaN(close)) rows.push({ date: parts[0], close });
  }
  return rows;
}

// Sector Regime: Date,Spread,Score (daily, computed nightly from data/sectors/*.csv)
function parseSectorRegimeLive(text) {
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const spread = parseFloat(parts[1]);
    const score = parseFloat(parts[2]);
    if (parts[0] && !isNaN(spread)) rows.push({ date: parts[0], spread, score: isNaN(score) ? null : score });
  }
  return rows;
}

// % Above 200 MA: Date,Pct,Coverage (daily, computed nightly from ~100 large caps)
function parsePctAbove200MALive(text) {
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const pct = parseFloat(parts[1]);
    const cov = parseFloat(parts[2]);
    if (parts[0] && !isNaN(pct)) rows.push({ date: parts[0], pct, coverage: isNaN(cov) ? null : cov });
  }
  return rows;
}

// % Above 50 MA: same CSV shape as the 200-day file.
function parsePctAbove50MALive(text) { return parsePctAbove200MALive(text); }

// NAAIM: Date,NAAIM (weekly, since 2006). Two-column simple CSV.
function parseNAAIMLive(text) {
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const v = parseFloat(parts[1]);
    if (parts[0] && !isNaN(v)) rows.push({ date: parts[0], value: v });
  }
  return rows;
}

// Yields history: Date,Y2,Y10,Spread10Y2Y (daily since 1990-01-02)
// The 4th column is 10Y-2Y in percentage points, pre-computed by the fetcher.
function parseYieldsHistoryLive(text) {
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const sp = parseFloat(parts[3]);
    if (parts[0] && !isNaN(sp)) rows.push({ date: parts[0], spread: sp });
  }
  return rows;
}

function findNaaimOnOrBefore(naaimRows, targetDate) {
  for (let i = naaimRows.length - 1; i >= 0; i--) {
    if (naaimRows[i].date <= targetDate) return naaimRows[i];
  }
  return null;
}

// Find the most recent % Above 200 MA reading on or before `targetDate`.
// Rows are daily and chronologically sorted; walk from the end.
function findPctOnOrBefore(pctRows, targetDate) {
  for (let i = pctRows.length - 1; i >= 0; i--) {
    if (pctRows[i].date <= targetDate) return pctRows[i];
  }
  return null;
}

// Wilder RSI series aligned with input closes (element i = RSI at row i,
// null for i < period).
function computeRsiSeriesLive(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let sumG = 0, sumL = 0;
  for (let i = 1; i <= period; i++) {
    const c = closes[i] - closes[i - 1];
    if (c > 0) sumG += c; else sumL += -c;
  }
  let avgG = sumG / period, avgL = sumL / period;
  rsi[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const c = closes[i] - closes[i - 1];
    const g = c > 0 ?  c : 0;
    const l = c < 0 ? -c : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return rsi;
}

async function loadLiveData() {
  // Market-specific data files (VIX/VXN, RSP/QQEW, SPY/QQQ, SPX/NDX)
  // Universal data files (HYG, LQD, % Above 200 MA, NAAIM, yields_history — apply to both markets)
  const [volText, breadthEqualText, breadthCapText, hygText, lqdText, indexText, pctAboveText, pctAbove50Text, naaimText, yieldsText, sectorOscText, sectorRegimeText] = await Promise.all([
    fetchCSVText(APP_DATA_BASE + MC.volCsv),
    fetchCSVText(APP_DATA_BASE + MC.breadthEqualCsv),
    fetchCSVText(APP_DATA_BASE + MC.breadthCapCsv),
    fetchCSVText(APP_DATA_BASE + 'hyg.csv'),
    fetchCSVText(APP_DATA_BASE + 'lqd.csv'),
    fetchCSVText(APP_DATA_BASE + MC.indexCsv),
    fetchCSVText(APP_DATA_BASE + 'pct_above_200ma.csv'),
    fetchCSVText(APP_DATA_BASE + 'pct_above_50ma.csv'),
    fetchCSVText(APP_DATA_BASE + 'naaim.csv'),
    fetchCSVText(APP_DATA_BASE + 'yields_history.csv'),
    fetchCSVText(APP_DATA_BASE + 'sector_osc.csv'),
    fetchCSVText(APP_DATA_BASE + 'sector_regime.csv'),
  ]);
  // VIX ships as OHLC; VXN as Date,Close. Same field name downstream.
  const vix = MC.volIsOHLC ? parseVIXLive(volText) : parseDateCloseLive(volText).map(r => ({ date: r.date, close: r.close }));
  const rsp = parseDateCloseLive(breadthEqualText);
  const spy = parseDateCloseLive(breadthCapText); // "SPY" var name kept for internal continuity; holds QQQ when market=nasdaq
  const hyg = parseDateCloseLive(hygText);
  const lqd = parseDateCloseLive(lqdText);
  const spx = parseDateCloseLive(indexText);      // "SPX" var name kept; holds NDX when market=nasdaq
  const yields = parseYieldsHistoryLive(yieldsText);
  // Parse data/sector_osc.csv. Format: date,advances,declines,ra_net,ema5,ema10,oscillator
  const sectorOsc = (function parseSectorOsc(txt) {
    const out = [];
    const lines = String(txt || '').trim().split(/\r?\n/).slice(1);
    for (const ln of lines) {
      const parts = ln.split(',');
      if (parts.length < 7) continue;
      const o = parseFloat(parts[6]);
      if (!isFinite(o)) continue;
      out.push({ date: parts[0], oscillator: o });
    }
    return out;
  })(sectorOscText);
  const pctAbove = parsePctAbove200MALive(pctAboveText);
  const pctAbove50 = parsePctAbove50MALive(pctAbove50Text);
  const sectorRegime = parseSectorRegimeLive(sectorRegimeText);
  const naaim = parseNAAIMLive(naaimText);
  const rsi = computeRsiSeriesLive(spy.map(r => r.close));   // RSI of SPY (or QQQ)
  const sma200 = computeSmaSeries(spx.map(r => r.close), 200); // 200-day MA of index (SPX or NDX)
  const sma50  = computeSmaSeries(spx.map(r => r.close), 50);  // 50-day MA of same index
  // Bollinger %B (20-day, 2sd) and MACD histogram (12/26/9, normalized as %
  // of price) — both feed the Upside Trend sub-gauge for faster short-term
  // response. Precomputed once so batsAt() lookups are O(1).
  const bbSeries   = computeBollingerBSeries(spx.map(r => r.close), 20, 2);
  const macdSeries = computeMACDHistSeries(spx.map(r => r.close), 12, 26, 9);

  const vixByDate = new Map(); vix.forEach((r, i) => vixByDate.set(r.date, i));
  const spyByDate = new Map(); spy.forEach((r, i) => spyByDate.set(r.date, i));
  const hygByDate = new Map(); hyg.forEach((r, i) => hygByDate.set(r.date, i));
  const lqdByDate = new Map(); lqd.forEach((r, i) => lqdByDate.set(r.date, i));
  const spxByDate = new Map(); spx.forEach((r, i) => spxByDate.set(r.date, i));

  // Yields is sorted chronologically. Find most-recent spread on or before a date.
  function findYieldsOnOrBefore(target) {
    for (let i = yields.length - 1; i >= 0; i--) {
      if (yields[i].date <= target) return yields[i];
    }
    return null;
  }
  // Sector oscillator is daily so an exact-date lookup usually works, but
  // fall back to most-recent on or before in case of holidays.
  function findSectorOscOnOrBefore(target) {
    for (let i = sectorOsc.length - 1; i >= 0; i--) {
      if (sectorOsc[i].date <= target) return sectorOsc[i];
    }
    return null;
  }

  const wVix       = (COMPONENTS.find(c => c.key === 'vix')              || {}).weight || 0;
  const wBreadth   = (COMPONENTS.find(c => c.key === 'breadth')          || {}).weight || 0;
  const wRSI       = (COMPONENTS.find(c => c.key === 'spy_rsi')          || {}).weight || 0;
  const wMA        = (COMPONENTS.find(c => c.key === 'ma200')            || {}).weight || 0;
  const wMA50      = (COMPONENTS.find(c => c.key === 'ma50')             || {}).weight || 0;
  const wJunk      = (COMPONENTS.find(c => c.key === 'junk_demand')      || {}).weight || 0;
  const wPct       = (COMPONENTS.find(c => c.key === 'pct_above_200ma')  || {}).weight || 0;
  const wPct50     = (COMPONENTS.find(c => c.key === 'pct_above_50ma')   || {}).weight || 0;
  const wNAAIM     = (COMPONENTS.find(c => c.key === 'naaim')            || {}).weight || 0;
  const wSpread    = (COMPONENTS.find(c => c.key === 'yield_spread')     || {}).weight || 0;
  const wSector    = (COMPONENTS.find(c => c.key === 'sector_osc')       || {}).weight || 0;
  const wROC5      = (COMPONENTS.find(c => c.key === 'roc5')             || {}).weight || 0;
  const wSecRegime = (COMPONENTS.find(c => c.key === 'sector_regime')    || {}).weight || 0;
  const wTotal     = wVix + wBreadth + wRSI + wMA + wMA50 + wJunk + wPct + wPct50 + wNAAIM + wSpread + wSector + wROC5 + wSecRegime;

  function batsAt(rspRowIdx) {
    if (rspRowIdx < 20) return null;
    const d = rsp[rspRowIdx].date;
    const si = spyByDate.get(d);
    const vi = vixByDate.get(d);
    const hi = hygByDate.get(d);
    const li = lqdByDate.get(d);
    const xi = spxByDate.get(d);
    if (si == null || si < 20 || vi == null || rsi[si] == null) return null;
    if (hi == null || hi < 20 || li == null || li < 20) return null;
    if (xi == null || sma200[xi] == null) return null;
    if (sma50[xi] == null) return null;
    const pctRec = findPctOnOrBefore(pctAbove, d);
    if (!pctRec) return null;
    const pct50Rec = findPctOnOrBefore(pctAbove50, d);
    if (!pct50Rec) return null;
    const secRegRec = findPctOnOrBefore(sectorRegime, d);   // same lookup shape (daily, on-or-before)
    if (!secRegRec) return null;
    const naaimRec = findNaaimOnOrBefore(naaim, d);
    if (!naaimRec) return null;
    const yieldsRec = findYieldsOnOrBefore(d);
    if (!yieldsRec) return null;
    const sectorRec = findSectorOscOnOrBefore(d);
    if (!sectorRec) return null;
    const rspRet = (rsp[rspRowIdx].close / rsp[rspRowIdx - 20].close - 1) * 100;
    const spyRet = (spy[si].close        / spy[si - 20].close        - 1) * 100;
    const spread = rspRet - spyRet;
    const hygRet = (hyg[hi].close        / hyg[hi - 20].close        - 1) * 100;
    const lqdRet = (lqd[li].close        / lqd[li - 20].close        - 1) * 100;
    const junkSpread = hygRet - lqdRet;
    const yieldSpread = yieldsRec.spread;
    const sectorOscVal = sectorRec.oscillator;
    const ma200Dist = (spx[xi].close / sma200[xi] - 1) * 100;
    const ma50Dist  = (spx[xi].close / sma50[xi]  - 1) * 100;
    // ROC-5: needs at least 5 prior daily closes on the same index series.
    const roc5Val  = (xi >= 5)  ? ((spx[xi].close / spx[xi - 5].close  - 1) * 100) : null;
    // ROC-10: same, longer horizon — feeds Upside Trend, not the main BATS composite.
    const roc10Val = (xi >= 10) ? ((spx[xi].close / spx[xi - 10].close - 1) * 100) : null;
    // Bollinger %B + MACD histogram (as % of price) — precomputed series lookups.
    const bbVal   = bbSeries[xi];
    const macdVal = macdSeries[xi];
    const vs = scoreVIX(vix[vi].close);
    const bs = scoreBreadth(spread);
    const rs = scoreRSI(rsi[si]);
    const js = scoreJunkDemand(junkSpread);
    const ms = scoreMA200(ma200Dist);
    const ms50 = scoreMA50(ma50Dist);
    const ps = scorePctAbove200MA(pctRec.pct);
    const ps50 = scorePctAbove50MA(pct50Rec.pct);
    const ns = scoreNAAIM(naaimRec.value);
    const yss = scoreYieldSpread(yieldSpread);
    const sos = scoreSectorOsc(sectorOscVal);
    const roc = scoreROC5(roc5Val);
    const srs = scoreSectorRegime(secRegRec.spread);
    // New Upside-Trend-only scores. Null-safe — they can be null in early
    // history without breaking the main BATS blend.
    const bbs   = scoreBollingerB(bbVal);
    const macds = scoreMACDHist(macdVal);
    const roc10 = scoreROC10(roc10Val);
    if (vs == null || bs == null || rs == null || js == null || ms == null || ms50 == null || ps == null || ps50 == null || ns == null || yss == null || sos == null || roc == null || srs == null || wTotal <= 0) return null;
    return {
      date: d,
      vix: vix[vi].close,
      spread,
      rsiVal: rsi[si],
      junkSpread,
      ma200Dist,
      ma50Dist,
      pctAboveVal: pctRec.pct,
      pctAboveCoverage: pctRec.coverage,
      pctAboveDate: pctRec.date,
      pctAbove50Val: pct50Rec.pct,
      pctAbove50Coverage: pct50Rec.coverage,
      pctAbove50Date: pct50Rec.date,
      naaimValue: naaimRec.value,
      naaimDate: naaimRec.date,
      yieldSpread,
      yieldsDate: yieldsRec.date,
      sectorOsc: sectorOscVal,
      sectorOscDate: sectorRec.date,
      roc5: roc5Val,
      roc10: roc10Val,
      bbVal,           // raw Bollinger %B
      macdVal,         // raw MACD histogram (percent of price)
      sectorRegimeSpread: secRegRec.spread,
      sectorRegimeDate: secRegRec.date,
      vs, bs, rs, js, ms, ms50, ps, ps50, ns, yss, sos, roc, srs,
      bbs, macds, roc10s: roc10,     // Upside-Trend-only scores
      blended: (vs * wVix + bs * wBreadth + rs * wRSI + js * wJunk + ms * wMA + ms50 * wMA50 + ps * wPct + ps50 * wPct50 + ns * wNAAIM + yss * wSpread + sos * wSector + roc * wROC5 + srs * wSecRegime) / wTotal,
    };
  }

  // Current values = latest RSP row where VIX/SPY also have data.
  // (VIX often lags SPY/RSP by a day since it's published by CBOE separately.)
  let latestIdx = rsp.length - 1;
  let current = batsAt(latestIdx);
  while (!current && latestIdx > 20) {
    latestIdx--;
    current = batsAt(latestIdx);
  }
  if (!current) throw new Error('Could not compute current BATS from latest data');

  // Historical offsets, counted in trading days from `latestIdx`.
  const history = {};
  for (const { key, days, label } of HIST_OFFSETS) {
    const rec = batsAt(latestIdx - days);
    history[key] = rec ? { score: rec.blended, date: rec.date, label } : null;
  }

  return { current, history };
}

function updateComponentsWithLatest(current) {
  const vixComp  = COMPONENTS.find(c => c.key === 'vix');
  const brComp   = COMPONENTS.find(c => c.key === 'breadth');
  const rsiComp  = COMPONENTS.find(c => c.key === 'spy_rsi');
  const maComp   = COMPONENTS.find(c => c.key === 'ma200');
  const junkComp = COMPONENTS.find(c => c.key === 'junk_demand');
  const pctComp  = COMPONENTS.find(c => c.key === 'pct_above_200ma');

  if (vixComp) {
    vixComp.raw = current.vix;
    vixComp.value = current.vix.toFixed(2);
    vixComp.signal = current.vs;
    vixComp.advisory = vixAdvisory(current.vix);
  }
  if (brComp) {
    brComp.raw = current.spread;
    const sign = current.spread >= 0 ? '+' : '';
    brComp.value = `${sign}${current.spread.toFixed(2)}%`;
    brComp.signal = current.bs;
    brComp.advisory = breadthAdvisory(current.spread);
  }
  if (rsiComp) {
    rsiComp.raw = current.rsiVal;
    rsiComp.value = current.rsiVal.toFixed(1);
    rsiComp.signal = current.rs;
    rsiComp.advisory = rsiAdvisory(current.rsiVal);
  }
  if (maComp) {
    maComp.raw = current.ma200Dist;
    const sign = current.ma200Dist >= 0 ? '+' : '';
    maComp.value = `${sign}${current.ma200Dist.toFixed(2)}%`;
    maComp.signal = current.ms;
    maComp.advisory = ma200Advisory(current.ma200Dist);
  }
  if (junkComp) {
    junkComp.raw = current.junkSpread;
    const sign = current.junkSpread >= 0 ? '+' : '';
    junkComp.value = `${sign}${current.junkSpread.toFixed(2)}%`;
    junkComp.signal = current.js;
    junkComp.advisory = junkDemandAdvisory(current.junkSpread);
  }
  if (pctComp) {
    pctComp.raw = current.pctAboveVal;
    pctComp.value = `${current.pctAboveVal.toFixed(1)}%`;
    pctComp.signal = current.ps;
    pctComp.advisory = pctAbove200MAAdvisory(current.pctAboveVal);
  }
  const pct50Comp = COMPONENTS.find(c => c.key === 'pct_above_50ma');
  if (pct50Comp) {
    pct50Comp.raw = current.pctAbove50Val;
    pct50Comp.value = `${current.pctAbove50Val.toFixed(1)}%`;
    pct50Comp.signal = current.ps50;
    pct50Comp.advisory = pctAbove50MAAdvisory(current.pctAbove50Val);
  }
  const ma50Comp = COMPONENTS.find(c => c.key === 'ma50');
  if (ma50Comp) {
    ma50Comp.raw = current.ma50Dist;
    const sign = current.ma50Dist >= 0 ? '+' : '';
    ma50Comp.value = `${sign}${current.ma50Dist.toFixed(2)}%`;
    ma50Comp.signal = current.ms50;
    ma50Comp.advisory = ma50Advisory(current.ma50Dist);
  }
  const naaimComp = COMPONENTS.find(c => c.key === 'naaim');
  if (naaimComp) {
    naaimComp.raw = current.naaimValue;
    naaimComp.value = `${current.naaimValue.toFixed(1)} (${current.naaimDate})`;
    naaimComp.signal = current.ns;
    naaimComp.advisory = naaimAdvisory(current.naaimValue);
  }
  const spreadComp = COMPONENTS.find(c => c.key === 'yield_spread');
  if (spreadComp) {
    spreadComp.raw = current.yieldSpread;
    const sign = current.yieldSpread >= 0 ? '+' : '';
    spreadComp.value = `${sign}${current.yieldSpread.toFixed(2)} pp`;
    spreadComp.signal = current.yss;
    spreadComp.advisory = yieldSpreadAdvisory(current.yieldSpread);
  }
  const sectorComp = COMPONENTS.find(c => c.key === 'sector_osc');
  if (sectorComp) {
    sectorComp.raw = current.sectorOsc;
    const sign = current.sectorOsc >= 0 ? '+' : '';
    sectorComp.value = `${sign}${current.sectorOsc.toFixed(2)}`;
    sectorComp.signal = current.sos;
    sectorComp.advisory = sectorOscAdvisory(current.sectorOsc);
  }
  const rocComp = COMPONENTS.find(c => c.key === 'roc5');
  if (rocComp) {
    rocComp.raw = current.roc5;
    const sign = current.roc5 >= 0 ? '+' : '';
    rocComp.value = `${sign}${current.roc5.toFixed(2)}%`;
    rocComp.signal = current.roc;
    rocComp.advisory = roc5Advisory(current.roc5);
  }
  const secRegimeComp = COMPONENTS.find(c => c.key === 'sector_regime');
  if (secRegimeComp) {
    secRegimeComp.raw = current.sectorRegimeSpread;
    const sign = current.sectorRegimeSpread >= 0 ? '+' : '';
    secRegimeComp.value = `${sign}${current.sectorRegimeSpread.toFixed(2)} pp`;
    secRegimeComp.signal = current.srs;
    secRegimeComp.advisory = sectorRegimeAdvisory(current.sectorRegimeSpread);
  }
}

function bucketLabelFor(score) {
  return BUCKETS[bucketIndexFor(score)].label;
}

function renderHistoricalContext(history) {
  const wrap = document.getElementById('historicalContext');
  if (!wrap) return;
  const items = HIST_OFFSETS.map(({ key, label }) => {
    const rec = history[key];
    if (!rec || rec.score == null) return null;
    const scoreRounded = Math.round(rec.score);
    return `
      <div class="hist-item">
        <div class="hist-label">${label}</div>
        <div class="hist-value">${scoreRounded}</div>
        <div class="hist-bucket">${bucketLabelFor(rec.score)}</div>
      </div>
    `;
  }).filter(Boolean).join('');
  wrap.innerHTML = items || '';
}

// ============================================================
// CONCENTRATION PAGE — Top 10 constituents vs broad market
// Renders only when the concentration.html page is loaded (detected by
// presence of the #concentrationTable element).
// ============================================================

// 7-bucket concentration scale. Left (low score) = megacaps winning
// (narrow, concentrated market — a warning sign). Right (high score) =
// broad participation (healthy). Palette mirrors the BATS gauge colors
// but the semantic direction is different — this is about market shape,
// not sentiment.
const CONC_BUCKETS = [
  { label: 'Very Concentrated',     color: 'var(--s0)' },
  { label: 'Concentrated',          color: 'var(--s1)' },
  { label: 'Slightly Concentrated', color: 'var(--s2)' },
  { label: 'Balanced',              color: 'var(--s3)' },
  { label: 'Slightly Broad',        color: 'var(--s4)' },
  { label: 'Broad',                 color: 'var(--s5)' },
  { label: 'Very Broad',            color: 'var(--s6)' },
];

// Gap = top10 − broad. Positive gap (megacaps winning) → LOW score.
// Negative gap (broad winning) → HIGH score. Full-scale at ±10%.
function scoreConcentration(gap) {
  if (gap == null || isNaN(gap)) return null;
  const score = 50 - gap * 4.5;
  return Math.max(5, Math.min(95, score));
}

function setConcentrationGauge(gap, periodLabel) {
  const marker = document.getElementById('concGaugeMarker');
  const reading = document.getElementById('concGaugeReading');
  const valueEl = document.getElementById('concGaugeValue');
  if (!marker) return;
  if (gap == null) {
    if (reading) reading.textContent = 'Not enough data';
    if (valueEl) valueEl.textContent = periodLabel ? `${periodLabel} Top 10 gap: —` : '';
    marker.style.left = '50%';
    return;
  }
  const score = scoreConcentration(gap);
  marker.style.left = score + '%';
  const bucketIdx = Math.min(CONC_BUCKETS.length - 1, Math.floor((score / 100) * CONC_BUCKETS.length));
  if (reading) reading.textContent = CONC_BUCKETS[bucketIdx].label;
  if (valueEl) {
    const sign = gap >= 0 ? '+' : '';
    const label = periodLabel || '1 Week';
    valueEl.textContent = `${label} Top 10 gap: ${sign}${gap.toFixed(2)}%`;
  }
}

const CONC_WINDOWS = [
  { key: 'd1',  days: 1,   label: 'Today' },
  { key: 'w1',  days: 5,   label: '1 Week' },
  { key: 'm1',  days: 21,  label: '1 Month' },
  { key: 'q1',  days: 63,  label: '1 Quarter' },
  { key: 'ytd', ytd: true, label: 'YTD' },
  { key: 'm6',  days: 126, label: '6 Months' },
  { key: 'y1',  days: 252, label: '1 Year' },
];

// Return over a window for a series of {date, close} rows.
// `window` is either { days: N } (trailing N trading days) or { ytd: true }
// (this year's first trading day, i.e., last close of the prior calendar year).
function returnOver(series, window) {
  if (!series || series.length < 2) return null;
  const last = series[series.length - 1];
  if (window.ytd) {
    const currentYear = last.date.substring(0, 4);
    for (let i = series.length - 2; i >= 0; i--) {
      if (series[i].date.substring(0, 4) !== currentYear) {
        return (last.close / series[i].close - 1) * 100;
      }
    }
    return null;
  }
  const days = window.days;
  if (series.length < days + 1) return null;
  const prior = series[series.length - 1 - days].close;
  return (last.close / prior - 1) * 100;
}

async function renderConcentration() {
  const table = document.getElementById('concentrationTable');
  if (!table) return;

  const tickers = TOP10_TICKERS[MARKET];
  const broadCsv = MC.breadthEqualCsv;  // RSP or QQEW

  // Fetch all 10 top tickers + the broad reference in parallel
  const [broadText, ...topTexts] = await Promise.all([
    fetchCSVText(APP_DATA_BASE + broadCsv),
    ...tickers.map(t => fetchCSVText(APP_DATA_BASE + 'top10/' + t.toLowerCase() + '.csv')),
  ]);
  const broad = parseDateCloseLive(broadText);
  const topSeries = topTexts.map(parseDateCloseLive);

  const latestDate = broad[broad.length - 1].date;
  const meta = document.getElementById('concentrationMeta');
  if (meta) meta.textContent = `Latest close: ${latestDate}. Top 10 tickers used: ${tickers.join(', ')}.`;

  // For each timeframe, compute top-10 equal-weighted avg and broad-market
  const rows = CONC_WINDOWS.map(window => {
    const topReturns = topSeries.map(s => returnOver(s, window)).filter(r => r != null);
    const topAvg = topReturns.length === tickers.length
      ? topReturns.reduce((sum, r) => sum + r, 0) / topReturns.length
      : null;
    const broadRet = returnOver(broad, window);
    const gap = (topAvg != null && broadRet != null) ? topAvg - broadRet : null;
    return { label: window.label, key: window.key, topAvg, broadRet, gap };
  });

  // Point the concentration gauge at the currently-picked period (default 1W).
  // Wire the picker on first render so clicks re-point at a different window
  // without a page reload. Guarded by dataset.wired so re-renders (e.g. the
  // S&P/Nasdaq market toggle) don't stack duplicate listeners.
  const picker = document.getElementById('concGaugePicker');
  const activeBtn = picker && picker.querySelector('button.active');
  const initialKey = (activeBtn && activeBtn.dataset.period) || 'w1';
  const initialRow = rows.find(r => r.key === initialKey) || rows.find(r => r.key === 'w1');
  if (initialRow) setConcentrationGauge(initialRow.gap, initialRow.label);
  if (picker && picker.dataset.wired !== '1') {
    picker.dataset.wired = '1';
    picker.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-period]');
      if (!btn) return;
      const row = rows.find(r => r.key === btn.dataset.period);
      picker.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      if (row) setConcentrationGauge(row.gap, row.label);
    });
  }

  function fmt(x, digits = 2) {
    if (x == null) return '<span class="text-dim">—</span>';
    const s = x.toFixed(digits) + '%';
    return x > 0 ? '+' + s : s;
  }
  function cls(x) {
    if (x == null) return '';
    if (x > 0) return 'pos';
    if (x < 0) return 'neg';
    return '';
  }

  const broadLabel = MARKET === 'nasdaq' ? 'QQEW (equal-weight Nasdaq 100)' : 'RSP (equal-weight S&P 500)';

  table.innerHTML = `
    <thead>
      <tr>
        <th>Timeframe</th>
        <th class="num">Top 10 (equal-weight avg)</th>
        <th class="num">${broadLabel}</th>
        <th class="num">Gap (Top 10 − Broad)</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(r => `
        <tr>
          <td><strong>${r.label}</strong></td>
          <td class="num ${cls(r.topAvg)}">${fmt(r.topAvg)}</td>
          <td class="num ${cls(r.broadRet)}">${fmt(r.broadRet)}</td>
          <td class="num ${cls(r.gap)}"><strong>${fmt(r.gap)}</strong></td>
        </tr>
      `).join('')}
    </tbody>
  `;

  // Populate the ticker chip list. Each chip is a link to that ticker's
  // page — the reader can click straight through to inspect one of the
  // top constituents.
  const chips = document.getElementById('concentrationTickers');
  if (chips) {
    chips.innerHTML = tickers.map(t =>
      `<a class="ticker-chip" href="ticker.html?sym=${encodeURIComponent(t)}">${t}</a>`
    ).join('');
  }
}

// ============================================================
// INIT
// ============================================================
async function init() {
  const yearEl = document.getElementById('footerYear');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Update anywhere on the page that names the market we're tracking.
  document.querySelectorAll('[data-market-label]').forEach(el => {
    el.textContent = MC.label;
  });
  // Highlight the active tab in the market toggle (both dashboard + explainer pages)
  document.querySelectorAll('[data-market-toggle]').forEach(el => {
    el.classList.toggle('active', el.dataset.marketToggle === MARKET);
  });

  // When Nasdaq mode is active, decorate all internal links with ?market=nasdaq
  // so the selection persists as the user navigates around.
  if (MARKET === 'nasdaq') {
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (!href) return;
      if (href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) return;
      if (a.dataset.marketToggle) return;      // toggle links manage their own market param
      if (href.includes('market=')) return;    // already has one
      const sep = href.includes('?') ? '&' : '?';
      a.setAttribute('href', href + sep + 'market=nasdaq');
    });
  }

  // Two contexts run app.js beyond the top-of-page nav machinery:
  //  1. The main dashboard (identified by the sentiment gauge SVG).
  //  2. An individual indicator explainer page (identified by window.BATS_INDICATOR_KEY).
  // Both paths need live data loaded; only the dashboard builds the gauge/grid.
  const svg = document.getElementById('sentimentGauge');
  const indicatorKey = (typeof window !== 'undefined' && window.BATS_INDICATOR_KEY) || null;
  const isMainPage = !!svg;
  const isIndicatorPage = !!indicatorKey;
  if (!isMainPage && !isIndicatorPage) return;

  if (isMainPage) {
    buildLegend();
    buildGauge();
    buildSubGauge('upsideTrendGauge', 'green', 'left');
    buildSubGauge('pivotTopGauge',    'red',   'right');
  }

  // Try to load real market values from the CSVs; fall back to the demo
  // values already sitting in COMPONENTS if the fetch fails (file://, offline).
  let latestDate = null;
  let currentSnapshot = null;
  try {
    const { current, history } = await loadLiveData();
    updateComponentsWithLatest(current);
    latestDate = current.date;
    currentSnapshot = current;
    if (isMainPage) renderHistoricalContext(history);
    const dateNote = document.getElementById('gaugeDateNote');
    if (dateNote) dateNote.textContent = `Latest close: ${current.date}`;
  } catch (err) {
    console.warn('Live data unavailable — using demo values.', err);
    const dateNote = document.getElementById('gaugeDateNote');
    if (dateNote) dateNote.textContent = 'Using demo values (live data unavailable).';
  }

  if (isMainPage) {
    buildComponents();
    buildComposition();
    setGauge(computeBatsScore());
    // Sub-gauges: computed from the live snapshot's component scores.
    const upside = currentSnapshot ? computeUpsideTrend(currentSnapshot) : null;
    const pivot  = currentSnapshot ? computePivotTop(currentSnapshot)   : null;
    setSubGauge('upsideTrendGauge', upside, 'upsideTrendValue', 'upsideTrendState', 'green', 'left');
    setSubGauge('pivotTopGauge',    pivot,  'pivotTopValue',    'pivotTopState',    'red',   'right');
  }

  if (isIndicatorPage) {
    renderCurrentReadingOnIndicator(indicatorKey, latestDate);
  }
}

// ============================================================
// INDICATOR PAGE — current-reading card
// Shows the same component reading that's on the main dashboard card,
// so a visitor landing from "How this affects the score →" sees the
// live value up top before reading the explainer.
// ============================================================
function renderCurrentReadingOnIndicator(key, latestDate) {
  const wrap = document.getElementById('currentReading');
  if (!wrap) return;
  const c = COMPONENTS.find(comp => comp.key === key);
  if (!c) { wrap.innerHTML = ''; return; }

  const signalPct = c.signal == null ? 50 : c.signal;
  const bucket = BUCKETS[bucketIndexFor(signalPct)];
  const advisoryHTML = c.advisory
    ? `<div class="advisory advisory-${c.advisory.tone}">${c.advisory.text}</div>`
    : '';
  const dateHTML = latestDate
    ? `<span class="cr-date">Latest close: ${latestDate}</span>`
    : `<span class="cr-date">Using demo values (live data unavailable)</span>`;

  wrap.innerHTML = `
    <div class="comp-card current-reading-card">
      <h3>${c.name}</h3>
      <div class="value">${c.value}</div>
      <div class="signal-bar"><span class="marker" style="left:${signalPct}%"></span></div>
      <div class="cr-bucket">
        <span class="cr-dot" style="background:${bucket.color}"></span>
        <strong>${bucket.label}</strong>
        <span class="cr-score">BATS component score: <strong>${signalPct.toFixed(1)}</strong> / 100</span>
      </div>
      ${advisoryHTML}
      ${dateHTML}
    </div>
  `;
}

// Cap-weighted vs Equal-weighted — a full-index concentration measure
// that doesn't depend on the top-10 list. SPY vs RSP for S&P 500,
// QQQ vs QQEW for Nasdaq 100. Renders a gauge + table for each market.
// Gap sign: EQUAL − CAP so positive = broad market winning (right side of
// the gauge, matching the "Broad →" label on the top-of-page gauge).
async function renderCapVsEqual() {
  const spTable = document.getElementById('capEqualSpTable');
  const ndxTable = document.getElementById('capEqualNdxTable');
  const meta = document.getElementById('capEqualMeta');
  if (!spTable && !ndxTable) return;

  const [spyText, rspText, qqqText, qqewText] = await Promise.all([
    fetchCSVText(APP_DATA_BASE + 'spy.csv'),
    fetchCSVText(APP_DATA_BASE + 'rsp.csv'),
    fetchCSVText(APP_DATA_BASE + 'qqq.csv'),
    fetchCSVText(APP_DATA_BASE + 'qqew.csv'),
  ]);
  const spy  = parseDateCloseLive(spyText);
  const rsp  = parseDateCloseLive(rspText);
  const qqq  = parseDateCloseLive(qqqText);
  const qqew = parseDateCloseLive(qqewText);

  const latestDate = [spy, rsp, qqq, qqew]
    .map(s => s[s.length - 1]?.date)
    .filter(Boolean)
    .sort()[0]; // earliest of the latest → the join date
  if (meta) meta.textContent = `Latest close: ${latestDate}. Positive gap = equal-weight beating cap-weight = broad market participating.`;

  function fmt(x, digits = 2) {
    if (x == null) return '<span class="text-dim">—</span>';
    const s = x.toFixed(digits) + '%';
    return x > 0 ? '+' + s : s;
  }
  function cls(x) {
    if (x == null) return '';
    if (x > 0) return 'pos';
    if (x < 0) return 'neg';
    return '';
  }

  // Gap sign convention here: gap = equal − cap. Positive gap = broad
  // market winning (right side of the gauge). Score = 50 + gap * 4.5,
  // clamped to [5, 95] — mirror of scoreConcentration()'s formula.
  function scoreEqualMinusCap(gap) {
    if (gap == null || isNaN(gap)) return null;
    const score = 50 + gap * 4.5;
    return Math.max(5, Math.min(95, score));
  }

  function setGauge(prefix, gap, periodLabel) {
    const marker = document.getElementById(prefix + 'Marker');
    const reading = document.getElementById(prefix + 'Reading');
    const valueEl = document.getElementById(prefix + 'Value');
    if (!marker) return;
    if (gap == null) {
      if (reading) reading.textContent = 'Not enough data';
      if (valueEl) valueEl.textContent = periodLabel ? `${periodLabel} gap (Equal − Cap): —` : '';
      marker.style.left = '50%';
      return;
    }
    const score = scoreEqualMinusCap(gap);
    marker.style.left = score + '%';
    const bucketIdx = Math.min(CONC_BUCKETS.length - 1, Math.floor((score / 100) * CONC_BUCKETS.length));
    if (reading) reading.textContent = CONC_BUCKETS[bucketIdx].label;
    if (valueEl) {
      const sign = gap >= 0 ? '+' : '';
      const label = periodLabel || '1 Week';
      valueEl.textContent = `${label} gap (Equal − Cap): ${sign}${gap.toFixed(2)}%`;
    }
  }

  function renderPair(table, gaugePrefix, pickerId, capSeries, eqSeries, capLabel, eqLabel) {
    if (!table) return;
    const rows = CONC_WINDOWS.map(window => {
      const capRet = returnOver(capSeries, window);
      const eqRet  = returnOver(eqSeries,  window);
      const gap = (capRet != null && eqRet != null) ? eqRet - capRet : null;
      return { label: window.label, key: window.key, capRet, eqRet, gap };
    });

    // Point the gauge at the currently-active period (default 1 Week).
    const picker = document.getElementById(pickerId);
    const activeBtn = picker && picker.querySelector('button.active');
    const initialKey = (activeBtn && activeBtn.dataset.period) || 'w1';
    const initialRow = rows.find(r => r.key === initialKey) || rows.find(r => r.key === 'w1');
    if (initialRow) setGauge(gaugePrefix, initialRow.gap, initialRow.label);
    if (picker && picker.dataset.wired !== '1') {
      picker.dataset.wired = '1';
      picker.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-period]');
        if (!btn) return;
        const row = rows.find(r => r.key === btn.dataset.period);
        picker.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
        if (row) setGauge(gaugePrefix, row.gap, row.label);
      });
    }

    table.innerHTML = `
      <thead>
        <tr>
          <th>Timeframe</th>
          <th class="num">${capLabel} (cap-weight)</th>
          <th class="num">${eqLabel} (equal-weight)</th>
          <th class="num">Gap (Equal − Cap)</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td><strong>${r.label}</strong></td>
            <td class="num ${cls(r.capRet)}">${fmt(r.capRet)}</td>
            <td class="num ${cls(r.eqRet)}">${fmt(r.eqRet)}</td>
            <td class="num ${cls(r.gap)}"><strong>${fmt(r.gap)}</strong></td>
          </tr>
        `).join('')}
      </tbody>
    `;
  }

  renderPair(spTable,  'capEqualSp',  'capEqualSpPicker',  spy, rsp,  'SPY', 'RSP');
  renderPair(ndxTable, 'capEqualNdx', 'capEqualNdxPicker', qqq, qqew, 'QQQ', 'QQEW');
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  renderConcentration().catch(err => {
    console.warn('Concentration render failed:', err);
    const meta = document.getElementById('concentrationMeta');
    if (meta) meta.textContent = 'Could not load concentration data.';
  });
  renderCapVsEqual().catch(err => {
    console.warn('Cap-vs-equal render failed:', err);
    const meta = document.getElementById('capEqualMeta');
    if (meta) meta.textContent = 'Could not load cap-vs-equal data.';
  });
});
