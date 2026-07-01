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
    name: 'VIX (Volatility)',
    desc: 'The "fear gauge." Contrarian: high VIX often means a buying opportunity; low VIX means complacency.',
    weight: 50,
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
    desc: 'How many stocks are participating. Confirmatory: broad participation is bullish, narrow rallies are fragile.',
    weight: 30,
    status: 'live',
    raw: -0.8,
    value: '−0.8% (demo)',
    signal: scoreBreadth(-0.8),
    advisory: breadthAdvisory(-0.8),
    explainer: 'indicators/breadth.html',
  },
  {
    key: 'spy_rsi',
    name: 'SPY 14-day RSI',
    desc: 'Momentum. Below 30 = oversold (bullish); above 70 = overbought (bearish). Markets can stay stretched.',
    weight: 20,
    status: 'live',
    raw: 42,
    value: '42 (demo)',
    signal: scoreRSI(42),
    advisory: rsiAdvisory(42),
    explainer: 'indicators/rsi.html',
  },
  {
    key: 'putcall',
    name: 'Put/Call Ratio',
    desc: 'Bets on stocks falling vs rising. High = bearish crowd = contrarian bullish.',
    weight: 0,
    status: 'soon',
    signal: null,
    value: '—',
  },
  {
    key: 'ma_spread',
    name: 'SPY vs 200-day MA',
    desc: 'How far above/below its long-term trend the market is trading.',
    weight: 0,
    status: 'soon',
    signal: null,
    value: '—',
  },
  {
    key: 'junk_demand',
    name: 'Junk Bond Demand (HYG/LQD)',
    desc: 'When investors chase risky bonds, they\'re hungry. Risk-on signal.',
    weight: 0,
    status: 'soon',
    signal: null,
    value: '—',
  },
  {
    key: 'safehaven',
    name: 'Safe Haven Demand',
    desc: 'Stocks vs bonds, last 20 days. Bonds winning = nervous market.',
    weight: 0,
    status: 'soon',
    signal: null,
    value: '—',
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
  const [vixText, rspText, spyText] = await Promise.all([
    fetchCSVText(APP_DATA_BASE + 'vix.csv'),
    fetchCSVText(APP_DATA_BASE + 'rsp.csv'),
    fetchCSVText(APP_DATA_BASE + 'spy.csv'),
  ]);
  const vix = parseVIXLive(vixText);
  const rsp = parseDateCloseLive(rspText);
  const spy = parseDateCloseLive(spyText);
  const rsi = computeRsiSeriesLive(spy.map(r => r.close));

  // Build date -> index maps for cross-alignment
  const vixByDate = new Map(); vix.forEach((r, i) => vixByDate.set(r.date, i));
  const spyByDate = new Map(); spy.forEach((r, i) => spyByDate.set(r.date, i));

  // Compute BATS score for a given RSP row index (needs matching VIX+SPY+RSI on same date)
  const wVix     = (COMPONENTS.find(c => c.key === 'vix')     || {}).weight || 0;
  const wBreadth = (COMPONENTS.find(c => c.key === 'breadth') || {}).weight || 0;
  const wRSI     = (COMPONENTS.find(c => c.key === 'spy_rsi') || {}).weight || 0;
  const wTotal   = wVix + wBreadth + wRSI;

  function batsAt(rspRowIdx) {
    if (rspRowIdx < 20) return null;
    const d = rsp[rspRowIdx].date;
    const si = spyByDate.get(d);
    const vi = vixByDate.get(d);
    if (si == null || si < 20 || vi == null || rsi[si] == null) return null;
    const rspRet = (rsp[rspRowIdx].close / rsp[rspRowIdx - 20].close - 1) * 100;
    const spyRet = (spy[si].close        / spy[si - 20].close        - 1) * 100;
    const spread = rspRet - spyRet;
    const vs = scoreVIX(vix[vi].close);
    const bs = scoreBreadth(spread);
    const rs = scoreRSI(rsi[si]);
    if (vs == null || bs == null || rs == null || wTotal <= 0) return null;
    return {
      date: d,
      vix: vix[vi].close,
      spread,
      rsiVal: rsi[si],
      vs, bs, rs,
      blended: (vs * wVix + bs * wBreadth + rs * wRSI) / wTotal,
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
  const vixComp = COMPONENTS.find(c => c.key === 'vix');
  const brComp  = COMPONENTS.find(c => c.key === 'breadth');
  const rsiComp = COMPONENTS.find(c => c.key === 'spy_rsi');

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
// INIT
// ============================================================
async function init() {
  const yearEl = document.getElementById('footerYear');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

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

document.addEventListener('DOMContentLoaded', init);
