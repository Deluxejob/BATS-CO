/* ============================================================
   BATS.CO — app.js
   Builds the sentiment gauge, renders the components grid,
   and (later) wires up real data feeds for the BATS.
   ============================================================ */

// --- The 7 sentiment buckets, in order from oversold -> bullish ---
const BUCKETS = [
  { label: 'Very Oversold',     color: 'var(--s0)' },
  { label: 'Oversold',          color: 'var(--s1)' },
  { label: 'Slightly Bearish',  color: 'var(--s2)' },
  { label: 'Neutral',           color: 'var(--s3)' },
  { label: 'Slightly Bullish',  color: 'var(--s4)' },
  { label: 'Bullish',           color: 'var(--s5)' },
  { label: 'Very Bullish',      color: 'var(--s6)' },
];

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
    volIsOHLC: true,   // datasets/finance-vix uses DATE,O,H,L,C — parse col 4
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
// mean is the "NAAIM Number." Institutional sister to AAII, published since 2006.
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
// Unlike AAII, NAAIM's Very Bullish extreme is NOT punished — institutions
// ride trends better than retail. But the "buy when defensive" side matches
// AAII, giving us TWO independent institutional/retail confirmations at oversold.
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

// ---- AAII Investor Sentiment Survey — Bull-Bear Spread ----
//
// AAII (American Association of Individual Investors) has run a weekly survey
// of retail investors since 1987 asking whether they're Bullish, Bearish, or
// Neutral about the next 6 months. The Bull-Bear Spread (Bullish% - Bearish%)
// is a widely-watched CONTRARIAN indicator.
//
// Direction of BATS mapping — CONTRARIAN:
//   Retail extremely BEARISH (very negative spread) -> LOW BATS (buy signal)
//   Retail extremely BULLISH (very positive spread) -> HIGH BATS (careful)
//
// Distribution 1987-2026 (~2,025 weekly readings):
//   min -54, 10th -17, median +7, 90th +28, max +63
//   Note the positive median: retail is slightly bullish on average.
//
// Backtest 1987-2026:
//   Very Oversold (spread ≤ -30):  +13.0% avg 12mo, 77% hit (n=117)
//   Oversold      (spread -30 to -15): +12.4% avg 12mo, 80% hit (n=181)
//   Very Bullish  (spread ≥ +30): +4.5% avg 12mo, 69% hit (n=244)  <- WORST bucket
// The classic contrarian pattern holds: extremes fire on both sides, retail
// is famously wrong at optimism extremes.
//
// Data is WEEKLY — the live dashboard carries the most recent reading forward.
function scoreAAII(bbs) {
  if (bbs == null || isNaN(bbs)) return null;
  let s;
  if (bbs <= -30)      s = 5;
  else if (bbs <= -15) s = 5  + (bbs + 30) * 20 / 15;
  else if (bbs <=   0) s = 25 + (bbs + 15) * 25 / 15;
  else if (bbs <=  15) s = 50 + (bbs)      * 20 / 15;
  else if (bbs <=  30) s = 70 + (bbs - 15) * 20 / 15;
  else                 s = 95;
  return Math.max(2, Math.min(98, s));
}

function aaiiAdvisory(bbs) {
  if (bbs == null || isNaN(bbs)) return null;
  if (bbs <= -30) return { tone: 'opportunity', text: 'Extreme retail bearishness — historically a contrarian buy signal. When AAII spread dropped below -30, S&P 500 was up +13% avg over next 12 months (77% positive).' };
  if (bbs <= -15) return { tone: 'opportunity', text: 'Retail investors are unusually bearish — contrarian bullish. Forward 12mo returns have averaged +12.4% from this zone (80% positive).' };
  if (bbs <=  -5) return { tone: 'info',        text: 'Retail slightly bearish. Sentiment is cautious but not extreme.' };
  if (bbs <=   5) return { tone: 'info',        text: 'Balanced retail sentiment — neither too bullish nor too bearish.' };
  if (bbs <=  15) return { tone: 'info',        text: 'Retail moderately bullish. Within normal range.' };
  if (bbs <=  30) return { tone: 'info',        text: 'Retail solidly bullish. Getting toward the upper end of normal.' };
  return                { tone: 'watch',        text: 'Extreme retail bullishness — historically a contrarian warning. Forward 12mo returns have averaged just +4.5% from this zone (only 69% positive) — the worst bucket we track.' };
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

// ---- Safe Haven Demand — SPY vs TLT 20-day return spread ----
//
// When investors get scared, they rotate out of stocks (SPY) and into
// long-duration Treasuries (TLT — 20+ Year Treasury Bond ETF). When
// they're greedy, they do the opposite. This is the classic CNN Fear &
// Greed "Safe Haven Demand" component: are stocks or bonds winning?
//
// CONFIRMATORY (like Breadth, Junk):
//   Positive spread (stocks beating bonds) -> risk-on -> HIGH BATS
//   Negative spread (bonds beating stocks) -> flight to safety -> LOW BATS
//
// Distribution 2003-2026 (5,811 days): median +1.3%, 90th ±7.5%, extremes ±40%.
// Slightly wider tails than Breadth (stocks and bonds decouple more than
// two stock ETFs do), so we use a gentler slope: score = 50 + spread * 5.
//
// Backtest 2003-2026:
//   Very Oversold (spread ≤ -9%, deep flight to safety): +13.8% avg 12mo, 81% hit (n=485)
//   Very Bullish  (spread ≥ +9%, extreme risk-on):       +13.1% avg 12mo, 84% hit (n=649)
// Clean smile — both extremes above +10% baseline.
function scoreSafeHaven(spread) {
  if (spread == null || isNaN(spread)) return null;
  const score = 50 + spread * 5;
  return Math.max(5, Math.min(95, score));
}

function safeHavenAdvisory(spread) {
  if (spread == null || isNaN(spread)) return null;
  if (spread <= -9)    return { tone: 'opportunity', text: 'Deep flight to safety — bonds crushing stocks. Historically a strong contrarian buy signal (+14% avg forward 12mo, 81% positive).' };
  if (spread <= -3)    return { tone: 'watch',       text: 'Investors rotating into bonds — cautious risk-off tone. Bearish confirmation but forward returns still solid.' };
  if (spread <= -0.5)  return { tone: 'info',        text: 'Mildly risk-off — bonds slightly outperforming stocks.' };
  if (spread <   3)    return { tone: 'info',        text: 'Balanced — stocks and bonds moving in step.' };
  if (spread <   6)    return { tone: 'info',        text: 'Stocks outperforming bonds — healthy risk-on tone.' };
  if (spread <   9)    return { tone: 'info',        text: 'Broad risk-on — stocks clearly beating bonds. Bullish confirmation.' };
  return                      { tone: 'info',        text: 'Extreme risk-on — stocks demolishing bonds. Historically strong bullish confirmation (+13% avg forward 12mo, 84% positive).' };
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
    weight: 25,
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
    key: 'aaii',
    name: 'AAII Retail Sentiment',
    desc: 'Weekly retail investor survey (Bullish% − Bearish%). Contrarian: retail extremes are historically wrong. Very positive = careful; very negative = buy signal.',
    weight: 10,
    status: 'live',
    raw: 0,
    value: '0.00% (loading)',
    signal: scoreAAII(0),
    advisory: aaiiAdvisory(0),
    explainer: 'indicators/aaii.html',
  },
  {
    key: 'naaim',
    name: 'NAAIM Manager Exposure',
    desc: 'Weekly survey of active investment managers — how much equity exposure they hold. Institutional sister to AAII. Low readings = defensive = historically buy zone.',
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
    key: 'safehaven',
    name: 'Safe Haven Demand',
    desc: `Stocks vs 20+ year Treasuries (${MC.stockTicker} − TLT 20-day return). Confirmatory: risk-on = bullish; flight to safety = bearish.`,
    weight: 5,
    status: 'live',
    raw: 0,
    value: '0.00% (loading)',
    signal: scoreSafeHaven(0),
    advisory: safeHavenAdvisory(0),
    explainer: 'indicators/safe-haven.html',
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

  const totalDeg = 180; // semicircle
  const gap = GAUGE.segmentGap;
  const segDeg = (totalDeg - gap * (BUCKETS.length - 1)) / BUCKETS.length;

  // Start at 180° (left side of gauge), sweep down to 0° (right side)
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
  // Major labels at 0/25/50/75/100 (quartiles). Minor tick marks every 10.
  const MAJOR_TICKS = [0, 25, 50, 75, 100];
  const MINOR_TICKS = [10, 20, 30, 40, 60, 70, 80, 90];

  function tickAngle(v) { return 180 - (v / 100) * 180; }

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

// Move needle to a 0-100 value
function setGauge(value) {
  const v = Math.max(0, Math.min(100, value));
  // value 0   -> needle angle straight LEFT (math 180°)
  // value 100 -> needle angle straight RIGHT (math 0°)
  // The needle starts pointing UP (math 90°), so we rotate by (90° - target°).
  const targetMathDeg = 180 - (v / 100) * 180;
  const rotateBy = 90 - targetMathDeg; // CSS rotate: positive = clockwise
  const needle = document.getElementById('gaugeNeedle');
  if (needle) needle.style.transform = `rotate(${rotateBy}deg)`;

  // Update label + value
  const bucketIndex = Math.min(BUCKETS.length - 1, Math.floor((v / 100) * BUCKETS.length));
  document.getElementById('readingLabel').textContent = BUCKETS[bucketIndex].label;
  document.getElementById('readingValue').textContent = Math.round(v);
  document.getElementById('updatedTime').textContent = new Date().toLocaleString();

  // Highlight active legend item
  document.querySelectorAll('.legend-item').forEach((el, i) => {
    el.classList.toggle('active', i === bucketIndex);
  });
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
    el.innerHTML = `<span class="legend-swatch" style="background:${b.color}"></span>${b.label}`;
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

// AAII: Date,Bullish,Neutral,Bearish,BullBearSpread (weekly, since 1987)
function parseAAIILive(text) {
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const spread = parseFloat(parts[4]);
    if (parts[0] && !isNaN(spread)) rows.push({ date: parts[0], spread });
  }
  return rows;
}

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

function findNaaimOnOrBefore(naaimRows, targetDate) {
  for (let i = naaimRows.length - 1; i >= 0; i--) {
    if (naaimRows[i].date <= targetDate) return naaimRows[i];
  }
  return null;
}

// Find the most recent AAII reading on or before `targetDate` (YYYY-MM-DD).
// AAII rows are chronologically sorted, so walk from the end.
function findAaiiOnOrBefore(aaiiRows, targetDate) {
  for (let i = aaiiRows.length - 1; i >= 0; i--) {
    if (aaiiRows[i].date <= targetDate) return aaiiRows[i];
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
  // Universal data files (HYG, LQD, AAII, NAAIM, TLT — apply to both markets)
  const [volText, breadthEqualText, breadthCapText, hygText, lqdText, indexText, aaiiText, naaimText, tltText] = await Promise.all([
    fetchCSVText(APP_DATA_BASE + MC.volCsv),
    fetchCSVText(APP_DATA_BASE + MC.breadthEqualCsv),
    fetchCSVText(APP_DATA_BASE + MC.breadthCapCsv),
    fetchCSVText(APP_DATA_BASE + 'hyg.csv'),
    fetchCSVText(APP_DATA_BASE + 'lqd.csv'),
    fetchCSVText(APP_DATA_BASE + MC.indexCsv),
    fetchCSVText(APP_DATA_BASE + 'aaii.csv'),
    fetchCSVText(APP_DATA_BASE + 'naaim.csv'),
    fetchCSVText(APP_DATA_BASE + 'tlt.csv'),
  ]);
  // VIX ships as OHLC; VXN as Date,Close. Same field name downstream.
  const vix = MC.volIsOHLC ? parseVIXLive(volText) : parseDateCloseLive(volText).map(r => ({ date: r.date, close: r.close }));
  const rsp = parseDateCloseLive(breadthEqualText);
  const spy = parseDateCloseLive(breadthCapText); // "SPY" var name kept for internal continuity; holds QQQ when market=nasdaq
  const hyg = parseDateCloseLive(hygText);
  const lqd = parseDateCloseLive(lqdText);
  const spx = parseDateCloseLive(indexText);      // "SPX" var name kept; holds NDX when market=nasdaq
  const tlt = parseDateCloseLive(tltText);
  const aaii = parseAAIILive(aaiiText);
  const naaim = parseNAAIMLive(naaimText);
  const rsi = computeRsiSeriesLive(spy.map(r => r.close));   // RSI of SPY (or QQQ)
  const sma200 = computeSmaSeries(spx.map(r => r.close), 200); // 200-day MA of index (SPX or NDX)

  const vixByDate = new Map(); vix.forEach((r, i) => vixByDate.set(r.date, i));
  const spyByDate = new Map(); spy.forEach((r, i) => spyByDate.set(r.date, i));
  const hygByDate = new Map(); hyg.forEach((r, i) => hygByDate.set(r.date, i));
  const lqdByDate = new Map(); lqd.forEach((r, i) => lqdByDate.set(r.date, i));
  const spxByDate = new Map(); spx.forEach((r, i) => spxByDate.set(r.date, i));
  const tltByDate = new Map(); tlt.forEach((r, i) => tltByDate.set(r.date, i));

  const wVix     = (COMPONENTS.find(c => c.key === 'vix')         || {}).weight || 0;
  const wBreadth = (COMPONENTS.find(c => c.key === 'breadth')     || {}).weight || 0;
  const wRSI     = (COMPONENTS.find(c => c.key === 'spy_rsi')     || {}).weight || 0;
  const wMA      = (COMPONENTS.find(c => c.key === 'ma200')       || {}).weight || 0;
  const wJunk    = (COMPONENTS.find(c => c.key === 'junk_demand') || {}).weight || 0;
  const wAAII    = (COMPONENTS.find(c => c.key === 'aaii')        || {}).weight || 0;
  const wNAAIM   = (COMPONENTS.find(c => c.key === 'naaim')       || {}).weight || 0;
  const wSafe    = (COMPONENTS.find(c => c.key === 'safehaven')   || {}).weight || 0;
  const wTotal   = wVix + wBreadth + wRSI + wMA + wJunk + wAAII + wNAAIM + wSafe;

  function batsAt(rspRowIdx) {
    if (rspRowIdx < 20) return null;
    const d = rsp[rspRowIdx].date;
    const si = spyByDate.get(d);
    const vi = vixByDate.get(d);
    const hi = hygByDate.get(d);
    const li = lqdByDate.get(d);
    const xi = spxByDate.get(d);
    const ti = tltByDate.get(d);
    if (si == null || si < 20 || vi == null || rsi[si] == null) return null;
    if (hi == null || hi < 20 || li == null || li < 20) return null;
    if (ti == null || ti < 20) return null;
    if (xi == null || sma200[xi] == null) return null;
    const aaiiRec = findAaiiOnOrBefore(aaii, d);
    if (!aaiiRec) return null;
    const naaimRec = findNaaimOnOrBefore(naaim, d);
    if (!naaimRec) return null;
    const rspRet = (rsp[rspRowIdx].close / rsp[rspRowIdx - 20].close - 1) * 100;
    const spyRet = (spy[si].close        / spy[si - 20].close        - 1) * 100;
    const spread = rspRet - spyRet;
    const hygRet = (hyg[hi].close        / hyg[hi - 20].close        - 1) * 100;
    const lqdRet = (lqd[li].close        / lqd[li - 20].close        - 1) * 100;
    const junkSpread = hygRet - lqdRet;
    const tltRet = (tlt[ti].close        / tlt[ti - 20].close        - 1) * 100;
    const safeSpread = spyRet - tltRet;
    const ma200Dist = (spx[xi].close / sma200[xi] - 1) * 100;
    const vs = scoreVIX(vix[vi].close);
    const bs = scoreBreadth(spread);
    const rs = scoreRSI(rsi[si]);
    const js = scoreJunkDemand(junkSpread);
    const ms = scoreMA200(ma200Dist);
    const as_ = scoreAAII(aaiiRec.spread);
    const ns = scoreNAAIM(naaimRec.value);
    const shs = scoreSafeHaven(safeSpread);
    if (vs == null || bs == null || rs == null || js == null || ms == null || as_ == null || ns == null || shs == null || wTotal <= 0) return null;
    return {
      date: d,
      vix: vix[vi].close,
      spread,
      rsiVal: rsi[si],
      junkSpread,
      ma200Dist,
      aaiiSpread: aaiiRec.spread,
      aaiiDate: aaiiRec.date,
      naaimValue: naaimRec.value,
      naaimDate: naaimRec.date,
      safeSpread,
      vs, bs, rs, js, ms, as_, ns, shs,
      blended: (vs * wVix + bs * wBreadth + rs * wRSI + js * wJunk + ms * wMA + as_ * wAAII + ns * wNAAIM + shs * wSafe) / wTotal,
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
  const aaiiComp = COMPONENTS.find(c => c.key === 'aaii');

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
  if (aaiiComp) {
    aaiiComp.raw = current.aaiiSpread;
    const sign = current.aaiiSpread >= 0 ? '+' : '';
    aaiiComp.value = `${sign}${current.aaiiSpread.toFixed(1)}% (${current.aaiiDate})`;
    aaiiComp.signal = current.as_;
    aaiiComp.advisory = aaiiAdvisory(current.aaiiSpread);
  }
  const naaimComp = COMPONENTS.find(c => c.key === 'naaim');
  if (naaimComp) {
    naaimComp.raw = current.naaimValue;
    naaimComp.value = `${current.naaimValue.toFixed(1)} (${current.naaimDate})`;
    naaimComp.signal = current.ns;
    naaimComp.advisory = naaimAdvisory(current.naaimValue);
  }
  const safeComp = COMPONENTS.find(c => c.key === 'safehaven');
  if (safeComp) {
    safeComp.raw = current.safeSpread;
    const sign = current.safeSpread >= 0 ? '+' : '';
    safeComp.value = `${sign}${current.safeSpread.toFixed(2)}%`;
    safeComp.signal = current.shs;
    safeComp.advisory = safeHavenAdvisory(current.safeSpread);
  }
}

function bucketLabelFor(score) {
  const idx = Math.min(BUCKETS.length - 1, Math.floor((score / 100) * BUCKETS.length));
  return BUCKETS[idx].label;
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
const CONC_WINDOWS = [
  { key: 'd1',  days: 1,   label: '1 Day' },
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
    return { label: window.label, topAvg, broadRet, gap };
  });

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

  // Populate the ticker chip list
  const chips = document.getElementById('concentrationTickers');
  if (chips) {
    chips.innerHTML = tickers.map(t =>
      `<span class="ticker-chip">${t}</span>`
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

  // Only build the dashboard machinery if we're on the main page
  // (identified by the presence of the sentiment gauge SVG).
  const svg = document.getElementById('sentimentGauge');
  if (!svg) return;

  buildLegend();
  buildGauge();

  // Try to load real market values from the CSVs; fall back to the demo
  // values already sitting in COMPONENTS if the fetch fails (file://, offline).
  try {
    const { current, history } = await loadLiveData();
    updateComponentsWithLatest(current);
    renderHistoricalContext(history);
    const dateNote = document.getElementById('gaugeDateNote');
    if (dateNote) dateNote.textContent = `Latest close: ${current.date}`;
  } catch (err) {
    console.warn('Live data unavailable — using demo values.', err);
    const dateNote = document.getElementById('gaugeDateNote');
    if (dateNote) dateNote.textContent = 'Using demo values (live data unavailable).';
  }

  buildComponents();
  buildComposition();
  setGauge(computeBatsScore());
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  renderConcentration().catch(err => {
    console.warn('Concentration render failed:', err);
    const meta = document.getElementById('concentrationMeta');
    if (meta) meta.textContent = 'Could not load concentration data.';
  });
});
