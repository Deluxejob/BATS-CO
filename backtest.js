/* ============================================================
   BATS.CO — Backtest engine
   Backs one indicator (VIX or Breadth) against S&P 500 forward
   returns 6 and 12 months later. Which indicator to run is set
   by window.BATS_BACKTEST_KIND before this script loads.
   ============================================================ */

const TRADING_DAYS_6MO  = 126;
const TRADING_DAYS_12MO = 252;
const BREADTH_LOOKBACK  = 20;

const DATA_BASE = (typeof window !== 'undefined' && window.BATS_DATA_BASE) || 'data/';

async function fetchText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return await res.text();
}

// ---- Parsers ----

// Simple two-column CSV: Date,Close
function parseDateClose(text) {
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const date = parts[0];
    const close = parseFloat(parts[1]);
    if (date && !isNaN(close)) rows.push({ date, close });
  }
  return rows;
}

// datasets/finance-vix: DATE,OPEN,HIGH,LOW,CLOSE
function parseVIX(text) {
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const date = parts[0];
    const close = parseFloat(parts[4]);
    if (date && !isNaN(close)) rows.push({ date, close });
  }
  return rows;
}

function bucketOf(score) {
  return Math.min(6, Math.max(0, Math.floor((score / 100) * 7)));
}
function avg(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }

// ============================================================
// VIX BACKTEST
// ============================================================
async function runVixBacktest() {
  const [vixText, spxText] = await Promise.all([
    fetchText(DATA_BASE + 'vix.csv'),
    fetchText(DATA_BASE + 'spx.csv'),
  ]);
  const vix = parseVIX(vixText);
  const spx = parseDateClose(spxText);
  const spxIdxByDate = new Map();
  spx.forEach((r, i) => spxIdxByDate.set(r.date, i));

  const trades = [];
  for (const v of vix) {
    const idx = spxIdxByDate.get(v.date);
    if (idx == null) continue;
    const score = scoreVIX(v.close);
    if (score == null) continue;
    const spxNow = spx[idx].close;
    const spx6   = spx[idx + TRADING_DAYS_6MO];
    const spx12  = spx[idx + TRADING_DAYS_12MO];
    trades.push({
      date: v.date,
      raw: v.close,
      score,
      bucket: bucketOf(score),
      ret6mo:  spx6  ? (spx6.close  / spxNow - 1) * 100 : null,
      ret12mo: spx12 ? (spx12.close / spxNow - 1) * 100 : null,
    });
  }
  return summarize(trades);
}

// ============================================================
// BREADTH BACKTEST — spread = 20-day return(RSP) − 20-day return(SPY)
// SPX forward returns used as the benchmark (same as VIX backtest).
// ============================================================
async function runBreadthBacktest() {
  const [rspText, spyText, spxText] = await Promise.all([
    fetchText(DATA_BASE + 'rsp.csv'),
    fetchText(DATA_BASE + 'spy.csv'),
    fetchText(DATA_BASE + 'spx.csv'),
  ]);
  const rsp = parseDateClose(rspText);
  const spy = parseDateClose(spyText);
  const spx = parseDateClose(spxText);

  const spyByDate = new Map();
  spy.forEach((r, i) => spyByDate.set(r.date, i));
  const spxByDate = new Map();
  spx.forEach((r, i) => spxByDate.set(r.date, i));

  const trades = [];
  for (let i = BREADTH_LOOKBACK; i < rsp.length; i++) {
    const d = rsp[i].date;
    const si = spyByDate.get(d);
    const xi = spxByDate.get(d);
    if (si == null || si < BREADTH_LOOKBACK || xi == null) continue;

    const rspRet = (rsp[i].close / rsp[i - BREADTH_LOOKBACK].close - 1) * 100;
    const spyRet = (spy[si].close / spy[si - BREADTH_LOOKBACK].close - 1) * 100;
    const spread = rspRet - spyRet;
    const score  = scoreBreadth(spread);
    if (score == null) continue;

    const spxNow = spx[xi].close;
    const spx6   = spx[xi + TRADING_DAYS_6MO];
    const spx12  = spx[xi + TRADING_DAYS_12MO];
    trades.push({
      date: d,
      raw: spread,
      score,
      bucket: bucketOf(score),
      ret6mo:  spx6  ? (spx6.close  / spxNow - 1) * 100 : null,
      ret12mo: spx12 ? (spx12.close / spxNow - 1) * 100 : null,
    });
  }
  return summarize(trades);
}

// Compute a Wilder RSI SERIES aligned with an input closes array. Returns an
// array where element i is the RSI at row i (null for i < period).
const RSI_PERIOD = 14;
function computeRsiSeries(closes) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < RSI_PERIOD + 1) return rsi;
  let sumG = 0, sumL = 0;
  for (let i = 1; i <= RSI_PERIOD; i++) {
    const chg = closes[i] - closes[i - 1];
    if (chg > 0) sumG += chg; else sumL += -chg;
  }
  let avgG = sumG / RSI_PERIOD, avgL = sumL / RSI_PERIOD;
  rsi[RSI_PERIOD] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = RSI_PERIOD + 1; i < closes.length; i++) {
    const chg = closes[i] - closes[i - 1];
    const g = chg > 0 ?  chg : 0;
    const l = chg < 0 ? -chg : 0;
    avgG = (avgG * (RSI_PERIOD - 1) + g) / RSI_PERIOD;
    avgL = (avgL * (RSI_PERIOD - 1) + l) / RSI_PERIOD;
    rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return rsi;
}

// ============================================================
// RSI BACKTEST (SPY 14-day RSI vs SPX forward returns)
// ============================================================
async function runRsiBacktest() {
  const [spyText, spxText] = await Promise.all([
    fetchText(DATA_BASE + 'spy.csv'),
    fetchText(DATA_BASE + 'spx.csv'),
  ]);
  const spy = parseDateClose(spyText);
  const spx = parseDateClose(spxText);
  const rsi = computeRsiSeries(spy.map(r => r.close));

  const spxByDate = new Map();
  spx.forEach((r, i) => spxByDate.set(r.date, i));

  const trades = [];
  for (let i = RSI_PERIOD; i < spy.length; i++) {
    const d = spy[i].date;
    const xi = spxByDate.get(d);
    if (xi == null || rsi[i] == null) continue;
    const score = scoreRSI(rsi[i]);
    if (score == null) continue;
    const spxNow = spx[xi].close;
    const spx6   = spx[xi + TRADING_DAYS_6MO];
    const spx12  = spx[xi + TRADING_DAYS_12MO];
    trades.push({
      date: d,
      raw: rsi[i],
      score,
      bucket: bucketOf(score),
      ret6mo:  spx6  ? (spx6.close  / spxNow - 1) * 100 : null,
      ret12mo: spx12 ? (spx12.close / spxNow - 1) * 100 : null,
    });
  }
  return summarize(trades);
}

// Compute a rolling simple moving average series (element i = SMA over
// closes[i-period+1 .. i]; null for i < period-1).
const SMA_PERIOD = 200;
function computeSmaSeriesBacktest(closes, period = SMA_PERIOD) {
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

// Parser for the weekly AAII CSV (Date,Bullish,Neutral,Bearish,BullBearSpread).
function parseAAII(text) {
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const spread = parseFloat(parts[4]);
    if (parts[0] && !isNaN(spread)) rows.push({ date: parts[0], spread });
  }
  return rows;
}

// Parser for the weekly NAAIM CSV (Date,NAAIM).
function parseNAAIM(text) {
  const lines = text.trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const v = parseFloat(parts[1]);
    if (parts[0] && !isNaN(v)) rows.push({ date: parts[0], value: v });
  }
  return rows;
}

// Given a sorted-by-date AAII array, return the row whose date is the latest
// one ≤ targetDate (i.e. the reading in effect on that day).
function aaiiOnOrBefore(aaiiRows, targetDate) {
  for (let i = aaiiRows.length - 1; i >= 0; i--) {
    if (aaiiRows[i].date <= targetDate) return aaiiRows[i];
  }
  return null;
}

// ============================================================
// NAAIM BACKTEST — weekly manager exposure vs SPX forward returns.
// ============================================================
async function runNaaimBacktest() {
  const [naaimText, spxText] = await Promise.all([
    fetchText(DATA_BASE + 'naaim.csv'),
    fetchText(DATA_BASE + 'spx.csv'),
  ]);
  const naaim = parseNAAIM(naaimText);
  const spx = parseDateClose(spxText);
  const spxByDate = new Map();
  spx.forEach((r, i) => spxByDate.set(r.date, i));

  const trades = [];
  for (const n of naaim) {
    let xi = spxByDate.get(n.date);
    if (xi == null) {
      for (let i = 0; i < spx.length; i++) if (spx[i].date >= n.date) { xi = i; break; }
    }
    if (xi == null) continue;
    const score = scoreNAAIM(n.value);
    if (score == null) continue;
    const spxNow = spx[xi].close;
    const spx6   = spx[xi + TRADING_DAYS_6MO];
    const spx12  = spx[xi + TRADING_DAYS_12MO];
    trades.push({
      date: n.date,
      raw: n.value,
      score,
      bucket: bucketOf(score),
      ret6mo:  spx6  ? (spx6.close  / spxNow - 1) * 100 : null,
      ret12mo: spx12 ? (spx12.close / spxNow - 1) * 100 : null,
    });
  }
  return summarize(trades);
}

// ============================================================
// AAII BACKTEST — weekly Bull-Bear spread vs SPX forward returns.
// Uses each AAII reading date (not carried forward — we sample at the source).
// ============================================================
async function runAaiiBacktest() {
  const [aaiiText, spxText] = await Promise.all([
    fetchText(DATA_BASE + 'aaii.csv'),
    fetchText(DATA_BASE + 'spx.csv'),
  ]);
  const aaii = parseAAII(aaiiText);
  const spx = parseDateClose(spxText);
  const spxByDate = new Map();
  spx.forEach((r, i) => spxByDate.set(r.date, i));

  const trades = [];
  for (const a of aaii) {
    // Find the SPX close on the AAII reading date, or the next trading day.
    let xi = spxByDate.get(a.date);
    if (xi == null) {
      for (let i = 0; i < spx.length; i++) {
        if (spx[i].date >= a.date) { xi = i; break; }
      }
    }
    if (xi == null) continue;
    const score = scoreAAII(a.spread);
    if (score == null) continue;
    const spxNow = spx[xi].close;
    const spx6   = spx[xi + TRADING_DAYS_6MO];
    const spx12  = spx[xi + TRADING_DAYS_12MO];
    trades.push({
      date: a.date,
      raw: a.spread,
      score,
      bucket: bucketOf(score),
      ret6mo:  spx6  ? (spx6.close  / spxNow - 1) * 100 : null,
      ret12mo: spx12 ? (spx12.close / spxNow - 1) * 100 : null,
    });
  }
  return summarize(trades);
}

// ============================================================
// SPX vs 200-day MA BACKTEST — distance from long-term trend
// ============================================================
async function runMa200Backtest() {
  const spxText = await fetchText(DATA_BASE + 'spx.csv');
  const spx = parseDateClose(spxText);
  const sma200 = computeSmaSeriesBacktest(spx.map(r => r.close), SMA_PERIOD);

  const trades = [];
  for (let i = SMA_PERIOD - 1; i < spx.length; i++) {
    if (sma200[i] == null) continue;
    const dist = (spx[i].close / sma200[i] - 1) * 100;
    const score = scoreMA200(dist);
    if (score == null) continue;
    const spxNow = spx[i].close;
    const spx6   = spx[i + TRADING_DAYS_6MO];
    const spx12  = spx[i + TRADING_DAYS_12MO];
    trades.push({
      date: spx[i].date,
      raw: dist,
      score,
      bucket: bucketOf(score),
      ret6mo:  spx6  ? (spx6.close  / spxNow - 1) * 100 : null,
      ret12mo: spx12 ? (spx12.close / spxNow - 1) * 100 : null,
    });
  }
  return summarize(trades);
}

// ============================================================
// JUNK BOND DEMAND BACKTEST — HYG - LQD 20-day return spread
// ============================================================
async function runJunkBacktest() {
  const [hygText, lqdText, spxText] = await Promise.all([
    fetchText(DATA_BASE + 'hyg.csv'),
    fetchText(DATA_BASE + 'lqd.csv'),
    fetchText(DATA_BASE + 'spx.csv'),
  ]);
  const hyg = parseDateClose(hygText);
  const lqd = parseDateClose(lqdText);
  const spx = parseDateClose(spxText);

  const lqdByDate = new Map();
  lqd.forEach((r, i) => lqdByDate.set(r.date, i));
  const spxByDate = new Map();
  spx.forEach((r, i) => spxByDate.set(r.date, i));

  const trades = [];
  for (let i = BREADTH_LOOKBACK; i < hyg.length; i++) {
    const d = hyg[i].date;
    const li = lqdByDate.get(d);
    const xi = spxByDate.get(d);
    if (li == null || li < BREADTH_LOOKBACK || xi == null) continue;

    const hygRet = (hyg[i].close  / hyg[i - BREADTH_LOOKBACK].close  - 1) * 100;
    const lqdRet = (lqd[li].close / lqd[li - BREADTH_LOOKBACK].close - 1) * 100;
    const spread = hygRet - lqdRet;
    const score  = scoreJunkDemand(spread);
    if (score == null) continue;

    const spxNow = spx[xi].close;
    const spx6   = spx[xi + TRADING_DAYS_6MO];
    const spx12  = spx[xi + TRADING_DAYS_12MO];
    trades.push({
      date: d,
      raw: spread,
      score,
      bucket: bucketOf(score),
      ret6mo:  spx6  ? (spx6.close  / spxNow - 1) * 100 : null,
      ret12mo: spx12 ? (spx12.close / spxNow - 1) * 100 : null,
    });
  }
  return summarize(trades);
}

// ============================================================
// BLENDED BATS BACKTEST — weighted average of every LIVE component
// (VIX, Breadth, SPY RSI, Junk Bond Demand) using whatever weights
// are currently set in COMPONENTS (app.js). This is the actual product.
// ============================================================
async function runBlendedBacktest() {
  const [vixText, rspText, spyText, spxText, hygText, lqdText, aaiiText, naaimText] = await Promise.all([
    fetchText(DATA_BASE + 'vix.csv'),
    fetchText(DATA_BASE + 'rsp.csv'),
    fetchText(DATA_BASE + 'spy.csv'),
    fetchText(DATA_BASE + 'spx.csv'),
    fetchText(DATA_BASE + 'hyg.csv'),
    fetchText(DATA_BASE + 'lqd.csv'),
    fetchText(DATA_BASE + 'aaii.csv'),
    fetchText(DATA_BASE + 'naaim.csv'),
  ]);
  const vix = parseVIX(vixText);
  const rsp = parseDateClose(rspText);
  const spy = parseDateClose(spyText);
  const spx = parseDateClose(spxText);
  const hyg = parseDateClose(hygText);
  const lqd = parseDateClose(lqdText);
  const aaii = parseAAII(aaiiText);
  const naaim = parseNAAIM(naaimText);
  const rsi = computeRsiSeries(spy.map(r => r.close));
  const sma200 = computeSmaSeriesBacktest(spx.map(r => r.close), SMA_PERIOD);

  const vixByDate = new Map();
  vix.forEach((r, i) => vixByDate.set(r.date, i));
  const spyByDate = new Map();
  spy.forEach((r, i) => spyByDate.set(r.date, i));
  const spxByDate = new Map();
  spx.forEach((r, i) => spxByDate.set(r.date, i));
  const hygByDate = new Map();
  hyg.forEach((r, i) => hygByDate.set(r.date, i));
  const lqdByDate = new Map();
  lqd.forEach((r, i) => lqdByDate.set(r.date, i));

  const wVix     = (COMPONENTS.find(c => c.key === 'vix')         || {}).weight || 0;
  const wBreadth = (COMPONENTS.find(c => c.key === 'breadth')     || {}).weight || 0;
  const wRSI     = (COMPONENTS.find(c => c.key === 'spy_rsi')     || {}).weight || 0;
  const wMA      = (COMPONENTS.find(c => c.key === 'ma200')       || {}).weight || 0;
  const wJunk    = (COMPONENTS.find(c => c.key === 'junk_demand') || {}).weight || 0;
  const wAAII    = (COMPONENTS.find(c => c.key === 'aaii')        || {}).weight || 0;
  const wNAAIM   = (COMPONENTS.find(c => c.key === 'naaim')       || {}).weight || 0;
  const wTotal   = wVix + wBreadth + wRSI + wMA + wJunk + wAAII + wNAAIM;
  if (wTotal <= 0) throw new Error('No live weights configured');

  // Rolling pointers for the weekly-series carry-forward (O(n) instead of O(n²)).
  let aaiiPtr = -1;
  let naaimPtr = -1;

  const trades = [];
  for (let i = BREADTH_LOOKBACK; i < rsp.length; i++) {
    const d  = rsp[i].date;
    const si = spyByDate.get(d);
    const xi = spxByDate.get(d);
    const vi = vixByDate.get(d);
    const hi = hygByDate.get(d);
    const li = lqdByDate.get(d);
    if (si == null || si < BREADTH_LOOKBACK || xi == null || vi == null) continue;
    if (hi == null || hi < BREADTH_LOOKBACK || li == null || li < BREADTH_LOOKBACK) continue;
    if (rsi[si] == null || sma200[xi] == null) continue;

    // Advance weekly-series pointers to the most recent reading ≤ this trading day.
    while (aaiiPtr + 1 < aaii.length && aaii[aaiiPtr + 1].date <= d) aaiiPtr++;
    while (naaimPtr + 1 < naaim.length && naaim[naaimPtr + 1].date <= d) naaimPtr++;
    if (aaiiPtr < 0 || naaimPtr < 0) continue;

    const rspRet = (rsp[i].close / rsp[i - BREADTH_LOOKBACK].close - 1) * 100;
    const spyRet = (spy[si].close / spy[si - BREADTH_LOOKBACK].close - 1) * 100;
    const spread = rspRet - spyRet;
    const hygRet = (hyg[hi].close / hyg[hi - BREADTH_LOOKBACK].close - 1) * 100;
    const lqdRet = (lqd[li].close / lqd[li - BREADTH_LOOKBACK].close - 1) * 100;
    const junkSpread = hygRet - lqdRet;
    const ma200Dist = (spx[xi].close / sma200[xi] - 1) * 100;
    const aaiiSpread = aaii[aaiiPtr].spread;
    const naaimVal = naaim[naaimPtr].value;

    const vs = scoreVIX(vix[vi].close);
    const bs = scoreBreadth(spread);
    const rs = scoreRSI(rsi[si]);
    const js = scoreJunkDemand(junkSpread);
    const ms = scoreMA200(ma200Dist);
    const as_ = scoreAAII(aaiiSpread);
    const ns = scoreNAAIM(naaimVal);
    if (vs == null || bs == null || rs == null || js == null || ms == null || as_ == null || ns == null) continue;

    const blended = (vs * wVix + bs * wBreadth + rs * wRSI + js * wJunk + ms * wMA + as_ * wAAII + ns * wNAAIM) / wTotal;

    const spxNow = spx[xi].close;
    const spx6   = spx[xi + TRADING_DAYS_6MO];
    const spx12  = spx[xi + TRADING_DAYS_12MO];
    trades.push({
      date: d,
      score: blended,
      bucket: bucketOf(blended),
      ret6mo:  spx6  ? (spx6.close  / spxNow - 1) * 100 : null,
      ret12mo: spx12 ? (spx12.close / spxNow - 1) * 100 : null,
    });
  }
  return summarize(trades);
}

// ============================================================
// Aggregation
// ============================================================
function summarize(trades) {
  const summary = BUCKETS.map((b, i) => {
    const inBucket = trades.filter(t => t.bucket === i);
    const with6  = inBucket.filter(t => t.ret6mo  != null);
    const with12 = inBucket.filter(t => t.ret12mo != null);
    return {
      idx: i,
      bucket: b.label,
      color: b.color,
      n: inBucket.length,
      avg6mo:  with6.length  ? avg(with6.map(t => t.ret6mo))              : null,
      hit6mo:  with6.length  ? (with6.filter(t => t.ret6mo  > 0).length  / with6.length)  * 100 : null,
      avg12mo: with12.length ? avg(with12.map(t => t.ret12mo))            : null,
      hit12mo: with12.length ? (with12.filter(t => t.ret12mo > 0).length / with12.length) * 100 : null,
    };
  });
  const allWith6  = trades.filter(t => t.ret6mo  != null);
  const allWith12 = trades.filter(t => t.ret12mo != null);
  const baseline = {
    n: trades.length,
    avg6mo:  allWith6.length  ? avg(allWith6.map(t => t.ret6mo))                 : null,
    hit6mo:  allWith6.length  ? (allWith6.filter(t => t.ret6mo  > 0).length  / allWith6.length)  * 100 : null,
    avg12mo: allWith12.length ? avg(allWith12.map(t => t.ret12mo))               : null,
    hit12mo: allWith12.length ? (allWith12.filter(t => t.ret12mo > 0).length / allWith12.length) * 100 : null,
  };
  return {
    summary,
    baseline,
    dateFrom: trades[0]?.date,
    dateTo:   trades[trades.length - 1]?.date,
  };
}

// ============================================================
// Rendering (shared)
// ============================================================
function fmtPct(x, digits = 1) {
  if (x == null) return '—';
  const s = x.toFixed(digits) + '%';
  return x > 0 ? '+' + s : s;
}
function fmtHit(x) { return x == null ? '—' : x.toFixed(0) + '%'; }
function returnClass(x) {
  if (x == null) return '';
  if (x > 0) return 'pos';
  if (x < 0) return 'neg';
  return '';
}

function renderBacktest({ summary, baseline, dateFrom, dateTo }) {
  const tableEl = document.getElementById('backtestTable');
  const metaEl  = document.getElementById('backtestMeta');
  const highlightEl = document.getElementById('backtestHighlight');
  if (!tableEl || !metaEl) return;

  const bodyRows = summary.map(r => `
    <tr>
      <td>
        <span class="bucket-dot" style="background:${r.color}"></span>
        <span class="bucket-name">${r.bucket}</span>
      </td>
      <td class="num">${r.n.toLocaleString()}</td>
      <td class="num ${returnClass(r.avg6mo)}">${fmtPct(r.avg6mo)}</td>
      <td class="num">${fmtHit(r.hit6mo)}</td>
      <td class="num ${returnClass(r.avg12mo)}">${fmtPct(r.avg12mo)}</td>
      <td class="num">${fmtHit(r.hit12mo)}</td>
    </tr>
  `).join('');

  const baselineRow = `
    <tr class="baseline-row">
      <td><em>Baseline (any day)</em></td>
      <td class="num">${baseline.n.toLocaleString()}</td>
      <td class="num ${returnClass(baseline.avg6mo)}">${fmtPct(baseline.avg6mo)}</td>
      <td class="num">${fmtHit(baseline.hit6mo)}</td>
      <td class="num ${returnClass(baseline.avg12mo)}">${fmtPct(baseline.avg12mo)}</td>
      <td class="num">${fmtHit(baseline.hit12mo)}</td>
    </tr>
  `;

  tableEl.innerHTML = `
    <thead>
      <tr>
        <th>Sentiment Bucket</th>
        <th class="num">Days (N)</th>
        <th class="num">Avg 6mo return</th>
        <th class="num">Hit rate 6mo</th>
        <th class="num">Avg 12mo return</th>
        <th class="num">Hit rate 12mo</th>
      </tr>
    </thead>
    <tbody>${bodyRows}${baselineRow}</tbody>
  `;

  metaEl.textContent =
    `${baseline.n.toLocaleString()} trading days sampled, ${dateFrom} → ${dateTo}. ` +
    `Forward returns are S&P 500 close-to-close, 6 months (126 trading days) and 12 months (252 trading days) after each date.`;

  // Headline finding — highlight the extremes.
  const veryOversold = summary[0];
  const oversold     = summary[1];
  const veryBullish  = summary[6];
  const parts = [];
  if (veryOversold.n >= 20 && veryOversold.avg12mo != null) {
    parts.push(`<li>When BATS read <strong>${veryOversold.bucket}</strong> (${veryOversold.n} days), the S&P 500 was up an average of <strong class="${returnClass(veryOversold.avg12mo)}">${fmtPct(veryOversold.avg12mo)}</strong> 12 months later — vs ${fmtPct(baseline.avg12mo)} on any random day.</li>`);
  }
  if (oversold.n >= 20 && oversold.avg12mo != null) {
    parts.push(`<li>When BATS read <strong>${oversold.bucket}</strong> (${oversold.n} days), the S&P 500 was up an average of <strong class="${returnClass(oversold.avg12mo)}">${fmtPct(oversold.avg12mo)}</strong> 12 months later.</li>`);
  }
  if (veryBullish.n >= 20 && veryBullish.avg12mo != null) {
    parts.push(`<li>When BATS read <strong>${veryBullish.bucket}</strong> (${veryBullish.n} days), the S&P 500 was up <strong class="${returnClass(veryBullish.avg12mo)}">${fmtPct(veryBullish.avg12mo)}</strong> 12 months later.</li>`);
  }
  if (highlightEl && parts.length) {
    highlightEl.innerHTML = `<ul>${parts.join('')}</ul>`;
  }
}

// ============================================================
// Auto-run based on window.BATS_BACKTEST_KIND ('vix' or 'breadth').
// Defaults to 'vix' for backward compatibility.
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  const kind = (typeof window !== 'undefined' && window.BATS_BACKTEST_KIND) || 'vix';
  const runner = kind === 'breadth' ? runBreadthBacktest
               : kind === 'rsi'     ? runRsiBacktest
               : kind === 'junk'    ? runJunkBacktest
               : kind === 'ma200'   ? runMa200Backtest
               : kind === 'aaii'    ? runAaiiBacktest
               : kind === 'naaim'   ? runNaaimBacktest
               : kind === 'blended' ? runBlendedBacktest
               : runVixBacktest;
  runner()
    .then(renderBacktest)
    .catch(err => {
      console.error('Backtest failed:', err);
      const meta = document.getElementById('backtestMeta');
      if (meta) {
        meta.innerHTML = 'Backtest data could not be loaded. ' +
          'If you opened this file directly (file://), the CSVs will not load — ' +
          'the site needs to be served over http/https (any local server, or when deployed).';
      }
    });
});
