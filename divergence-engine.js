// Shared momentum-divergence engine.
//
// Used by divergences.html (the S&P / Dow / Nasdaq scanner) and by the
// on-demand "Momentum divergence" tool on ticker.html. Everything here is
// either pure math over arrays of closes or an SVG string builder — no DOM
// ids are assumed, so both pages render the exact same chart from the exact
// same rules. scripts/backtest-divergences.py mirrors the detection rules;
// keep the two in step if any threshold changes.
//
// Loaded as a classic script; exposes window.DivergenceEngine.
(function (global) {
  'use strict';

  // When previewing on a local static server the /api route doesn't exist,
  // so borrow the live site's proxy (it allows cross-origin reads).
  const API_BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? 'https://bats.co' : '';

  // pivot  = bars on each side needed to confirm a swing high/low
  // show   = bars drawn on the chart
  // recent = a confirmed divergence counts as "active" if its 2nd peak is within this many bars
  // minGap / maxGap = allowed distance between the two peaks being compared
  const TF = {
    '60m': { label: '60-min', range: '3mo', interval: '60m', pivot: 5, show: 140, recent: 12, minGap: 5, maxGap: 70 },
    '1d':  { label: 'Daily',  range: '2y',  interval: '1d',  pivot: 5, show: 130, recent: 10, minGap: 5, maxGap: 60 },
    '1wk': { label: 'Weekly', range: '10y', interval: '1wk', pivot: 3, show: 130, recent: 6,  minGap: 3, maxGap: 52 },
    // Monthly pulls 10y, not max: Yahoo's max-range monthly feed for ^GSPC
    // and ^NDX is riddled with missing months (87 gaps in the last decade
    // alone), which would wreck RSI/MACD. 10y comes back complete. That is
    // 120 bars; the first ~36 warm up the indicators, the rest are drawn.
    '1mo': { label: 'Monthly', range: '10y', interval: '1mo', pivot: 2, show: 84, recent: 3, minGap: 2, maxGap: 24 },
  };
  const TF_KEYS = ['60m', '1d', '1wk', '1mo'];

  // ---------------- Indicator math (on plain arrays of closes) ----------------
  function emaArr(v, n) {
    const out = new Array(v.length).fill(null);
    if (v.length < n) return out;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += v[i];
    let e = sum / n;
    out[n - 1] = e;
    const k = 2 / (n + 1);
    for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
    return out;
  }
  function rsiArr(v, period) {
    period = period || 14;
    const out = new Array(v.length).fill(null);
    if (v.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) { const d = v[i] - v[i - 1]; if (d >= 0) gain += d; else loss -= d; }
    gain /= period; loss /= period;
    out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = period + 1; i < v.length; i++) {
      const d = v[i] - v[i - 1];
      gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
      loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }
  function macdArr(v, fast, slow, sig) {
    fast = fast || 12; slow = slow || 26; sig = sig || 9;
    const eF = emaArr(v, fast), eS = emaArr(v, slow);
    const line = new Array(v.length).fill(null), signal = new Array(v.length).fill(null), hist = new Array(v.length).fill(null);
    for (let i = 0; i < v.length; i++) if (eF[i] != null && eS[i] != null) line[i] = eF[i] - eS[i];
    const first = line.findIndex(x => x != null);
    if (first >= 0 && v.length - first >= sig) {
      let sum = 0;
      for (let i = first; i < first + sig; i++) sum += line[i];
      let s = sum / sig;
      signal[first + sig - 1] = s;
      const k = 2 / (sig + 1);
      for (let i = first + sig; i < v.length; i++) { s = line[i] * k + s * (1 - k); signal[i] = s; }
    }
    for (let i = 0; i < v.length; i++) if (line[i] != null && signal[i] != null) hist[i] = line[i] - signal[i];
    return { line, signal, hist };
  }

  // ---------------- MACD crossover signals ----------------
  // Buy = MACD line crosses above its signal line after at least MACD_MIN_RUN
  // closed bars below it; sell = the mirror image. A cross only counts once
  // the bar it happened on has closed, so the signal is stamped on the NEXT
  // bar. A qualifying cross sitting on the still-open last bar is "pending".
  const MACD_MIN_RUN = 10;
  function macdSignals(macd) {
    const { line, signal } = macd;
    const N = line.length;
    const signals = [];
    let side = null, run = 0, pending = null;
    for (let i = 0; i < N; i++) {
      if (line[i] == null || signal[i] == null) continue;
      const s = line[i] > signal[i] ? 'above' : line[i] < signal[i] ? 'below' : side;
      if (s == null) continue;
      if (side != null && s !== side) {
        if (run >= MACD_MIN_RUN) {
          const kind = s === 'above' ? 'buy' : 'sell';
          if (i + 1 < N) signals.push({ kind, cross: i, at: i + 1, run });
          else pending = { kind, cross: i, run };
        }
        side = s; run = 1;
      } else { side = s; run++; }
    }
    return { signals, pending, side, run };
  }

  // ---------------- Swing points + divergence detection ----------------
  function findPivots(c, n) {
    const highs = [], lows = [];
    for (let i = n; i < c.length - n; i++) {
      let isH = true, isL = true;
      for (let k = i - n; k <= i + n; k++) {
        if (k === i) continue;
        if (c[k] >= c[i]) isH = false;
        if (c[k] <= c[i]) isL = false;
        if (!isH && !isL) break;
      }
      if (isH) highs.push(i);
      if (isL) lows.push(i);
    }
    return { highs, lows };
  }
  // Indicator extreme within +/- tol bars of a price pivot (indicator peaks
  // rarely land on the exact same bar as the price peak).
  function indExtreme(ind, i, wantHigh, tol) {
    let best = null, at = i;
    for (let k = Math.max(0, i - tol); k <= Math.min(ind.length - 1, i + tol); k++) {
      const x = ind[k];
      if (x == null) continue;
      if (best == null || (wantHigh ? x > best : x < best)) { best = x; at = k; }
    }
    return best == null ? null : { v: best, i: at };
  }
  // Walk back from peak `b` looking for the previous swing high to compare
  // against. Bar `b` must be the highest close since that earlier peak
  // (a "higher high") — the moment we hit a bar at or above c[b] we stop,
  // because b is then just a lower high inside a bigger structure. Among
  // qualifying earlier peaks we pick the highest one: the previous
  // meaningful top that price has now cleared. Mirrored for lows.
  function priorPivot(c, pivSet, b, wantHigh, t) {
    let a = -1, best = null;
    for (let k = b - 1; k >= 0 && b - k <= t.maxGap; k--) {
      if (wantHigh ? c[k] >= c[b] : c[k] <= c[b]) break;
      if (b - k < t.minGap) continue;
      if (!pivSet.has(k)) continue;
      if (best == null || (wantHigh ? c[k] > best : c[k] < best)) { best = c[k]; a = k; }
    }
    return a;
  }
  function detect(c, ind, piv, t) {
    const out = [];
    const tol = 2;
    const scan = (list, wantHigh, kind) => {
      const set = new Set(list);
      for (let j = 1; j < list.length; j++) {
        const b = list[j];
        const a = priorPivot(c, set, b, wantHigh, t);
        if (a < 0) continue;
        const ea = indExtreme(ind, a, wantHigh, tol), eb = indExtreme(ind, b, wantHigh, tol);
        if (!ea || !eb) continue;
        const diverges = wantHigh ? eb.v < ea.v : eb.v > ea.v;
        if (diverges) out.push({ kind, a, b, pa: c[a], pb: c[b], ia: ea.v, ib: eb.v, iai: ea.i, ibi: eb.i, forming: false });
      }
    };
    scan(piv.highs, true,  'bearish');
    scan(piv.lows,  false, 'bullish');

    // Forming: the last `pivot` bars can't be confirmed swings yet. If the
    // extreme in that zone beats the previous confirmed peak while the
    // indicator doesn't, flag it as forming.
    const n = t.pivot, last = c.length - 1;
    const zoneStart = Math.max(0, c.length - n);
    const forming = (wantHigh, kind, list) => {
      let m = -1;
      for (let i = zoneStart; i <= last; i++) {
        if (m < 0 || (wantHigh ? c[i] > c[m] : c[i] < c[m])) m = i;
      }
      if (m < 0) return;
      // Must also beat everything in the `n` bars before it (left side of a would-be pivot).
      for (let k = Math.max(0, m - n); k < m; k++) {
        if (wantHigh ? c[k] >= c[m] : c[k] <= c[m]) return;
      }
      const a = priorPivot(c, new Set(list), m, wantHigh, t);
      if (a < 0) return;
      const ea = indExtreme(ind, a, wantHigh, tol), eb = indExtreme(ind, m, wantHigh, Math.min(tol, last - m));
      if (!ea || !eb) return;
      const diverges = wantHigh ? eb.v < ea.v : eb.v > ea.v;
      if (diverges) out.push({ kind, a, b: m, pa: c[a], pb: c[m], ia: ea.v, ib: eb.v, iai: ea.i, ibi: eb.i, forming: true });
    };
    forming(true,  'bearish', piv.highs);
    forming(false, 'bullish', piv.lows);
    out.sort((x, y) => x.b - y.b);
    return out;
  }

  function analyze(bars, tfKey) {
    const t = TF[tfKey];
    const ts = bars.map(b => b[0]);
    const c  = bars.map(b => b[1]);
    const rsi = rsiArr(c, 14);
    const macd = macdArr(c);
    const piv = findPivots(c, t.pivot);
    const divs = { rsi: detect(c, rsi, piv, t), macd: detect(c, macd.line, piv, t) };
    annotate(c, divs.rsi, t);
    annotate(c, divs.macd, t);
    return { tf: tfKey, ts, c, rsi, macd, piv, divs, sig: macdSignals(macd) };
  }

  // A divergence stays "active" until price settles the argument:
  //   bearish — cancelled by a close above the second peak (a new high),
  //             played out by a close below the lowest close between the peaks;
  //   bullish — the mirror image.
  // Anything that just drifts for longer than maxGap bars is dropped as expired.
  function annotate(c, divs, t) {
    const last = c.length - 1;
    for (const d of divs) {
      const between = c.slice(d.a, d.b + 1);
      d.level = d.kind === 'bearish' ? Math.min.apply(null, between) : Math.max.apply(null, between);
      d.state = 'active';
      d.endAt = null;
      if (d.forming) continue;
      for (let i = d.b + 1; i <= last; i++) {
        if (d.kind === 'bearish') {
          if (c[i] > d.pb)    { d.state = 'cancelled'; d.endAt = i; break; }
          if (c[i] < d.level) { d.state = 'played out'; d.endAt = i; break; }
        } else {
          if (c[i] < d.pb)    { d.state = 'cancelled'; d.endAt = i; break; }
          if (c[i] > d.level) { d.state = 'played out'; d.endAt = i; break; }
        }
      }
      if (d.state === 'active' && last - d.b > t.maxGap) { d.state = 'expired'; d.endAt = last; }
    }
  }

  // Which divergences are "live" right now for this series/timeframe?
  function status(an) {
    const t = TF[an.tf], last = an.c.length - 1;
    // Flagged = still in force, or played out recently enough that the
    // breakdown itself is the news (12 hourly / 10 daily / 6 weekly / 3 monthly bars).
    const active = [];
    for (const key of ['rsi', 'macd']) {
      for (const d of an.divs[key]) {
        const playingOut = d.state === 'played out' && d.endAt != null && last - d.endAt <= t.recent;
        if (d.state === 'active' || playingOut) active.push(Object.assign({ ind: key, playingOut }, d));
      }
    }
    if (!active.length) {
      // most recent settled divergence, for context
      let lastOld = null;
      for (const key of ['rsi', 'macd']) for (const d of an.divs[key]) {
        if (!d.forming && (!lastOld || d.b > lastOld.b)) lastOld = Object.assign({ ind: key }, d);
      }
      return { kind: 'none', inds: [], forming: false, primary: null, lastOld };
    }
    const bear = active.filter(d => d.kind === 'bearish');
    const bull = active.filter(d => d.kind === 'bullish');
    let kind, pool;
    if (bear.length && bull.length) {
      // both sides flagged — go with whichever is more recent
      const nb = Math.max(...bear.map(d => d.b)), nu = Math.max(...bull.map(d => d.b));
      kind = nb >= nu ? 'bearish' : 'bullish';
      pool = kind === 'bearish' ? bear : bull;
    } else { kind = bear.length ? 'bearish' : 'bullish'; pool = bear.length ? bear : bull; }
    const inds = Array.from(new Set(pool.map(d => d.ind)));
    const confirmed = pool.filter(d => !d.forming);
    const primary = (confirmed.length ? confirmed : pool).slice().sort((x, y) => y.b - x.b)[0];
    return { kind, inds, forming: confirmed.length === 0, primary, active: pool };
  }

  // ---------------- Formatting ----------------
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function etParts(ts) {
    const d = new Date(ts * 1000);
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: false })
      .formatToParts(d).forEach(x => { p[x.type] = x.value; });
    return { y: +p.year, m: +p.month, d: +p.day, hh: p.hour === '24' ? '00' : p.hour, mm: p.minute };
  }
  function fmtDate(ts, tfKey, withYear) {
    const p = etParts(ts);
    const base = MONTHS[p.m - 1] + ' ' + p.d;
    if (tfKey === '60m') return base + ' ' + p.hh + ':' + p.mm;
    // A monthly bar is stamped on the 1st; showing the day would only mislead.
    if (tfKey === '1mo') return MONTHS[p.m - 1] + " '" + String(p.y).slice(2);
    if (withYear || tfKey === '1wk') return base + " '" + String(p.y).slice(2);
    return base;
  }
  const fmtP = v => v == null || !isFinite(v) ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const fmt1 = v => v == null || !isFinite(v) ? '—' : v.toFixed(1);
  const fmtPct = (a, b) => { const p = (b / a - 1) * 100; return (p >= 0 ? '+' : '') + p.toFixed(1) + '%'; };
  const indName = k => k === 'rsi' ? 'RSI' : 'MACD';

  // ---------------- Data ----------------
  // Yahoo appends a live-quote stub to its series: on weekly a mid-week bar
  // that duplicates the current week, on monthly a mid-month bar that
  // duplicates the current month, on 60-minute a 16:00 closing-print
  // bar. Fold each stub into the bar it belongs to so every bar is one
  // real period (otherwise RSI/MACD and the bar counts are skewed).
  const pad2 = n => (n < 10 ? '0' : '') + n;
  function dayKey(ts) { const p = etParts(ts); return p.y + '-' + pad2(p.m) + '-' + pad2(p.d); }
  function monthKey(ts) { const p = etParts(ts); return p.y + '-' + pad2(p.m); }
  function weekKeyOf(ts) {
    const d = new Date(dayKey(ts) + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    return d.toISOString().slice(0, 10);
  }
  function normalizeBars(bars, tfKey) {
    const out = [];
    for (const b of bars) {
      const prev = out[out.length - 1];
      let same = false;
      if (prev) {
        if (tfKey === '1wk') same = weekKeyOf(prev[0]) === weekKeyOf(b[0]);
        else if (tfKey === '1mo') same = monthKey(prev[0]) === monthKey(b[0]);
        else if (tfKey === '1d') same = dayKey(prev[0]) === dayKey(b[0]);
        else if (tfKey === '60m') {
          const p = etParts(b[0]);
          same = p.hh === '16' && p.mm === '00' && dayKey(prev[0]) === dayKey(b[0]);
        }
      }
      if (same) prev[1] = b[1];          // keep the later close, drop the stub
      else out.push([b[0], b[1]]);
    }
    return out;
  }

  // Raw close series for one or more symbols on a timeframe, keyed by symbol.
  async function fetchSeries(syms, tfKey) {
    const t = TF[tfKey];
    const url = API_BASE + '/api/history?syms=' + encodeURIComponent(syms.join(',')) +
                '&range=' + t.range + '&interval=' + t.interval;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const payload = await r.json();
    return (payload && payload.series) || {};
  }

  // ---------------- Chart ----------------
  // Returns { svg, geom } — the SVG inner markup for an analysis plus the
  // geometry the hover readout needs. Caller mounts it with mountChart().
  function buildChartSVG(an, tfKey, titleSym) {
    const t = TF[tfKey];
    const N = an.c.length, start = Math.max(0, N - t.show), count = N - start;
    const W = 960, L = 10, R = 900;
    // Pane stack: price, RSI, MACD. Height leaves room for the date labels.
    const panes = {
      price: { y0: 22,  y1: 262 },
      rsi:   { y0: 292, y1: 378 },
      macd:  { y0: 408, y1: 494 },
    };
    const bottom = panes.macd.y1;
    const x = i => L + (count === 1 ? 0 : (i - start) / (count - 1) * (R - L));

    // price scale
    let pMin = Infinity, pMax = -Infinity;
    for (let i = start; i < N; i++) { if (an.c[i] < pMin) pMin = an.c[i]; if (an.c[i] > pMax) pMax = an.c[i]; }
    const pPad = (pMax - pMin) * 0.08 || 1;
    pMin -= pPad; pMax += pPad;
    const yP = v => panes.price.y1 - (v - pMin) / (pMax - pMin) * (panes.price.y1 - panes.price.y0);
    // rsi scale (fixed 0-100 gives a familiar look)
    const yR = v => panes.rsi.y1 - v / 100 * (panes.rsi.y1 - panes.rsi.y0);
    // macd scale symmetric around zero
    let mAbs = 0;
    for (let i = start; i < N; i++) {
      for (const v of [an.macd.line[i], an.macd.signal[i], an.macd.hist[i]]) if (v != null && Math.abs(v) > mAbs) mAbs = Math.abs(v);
    }
    mAbs = mAbs * 1.1 || 1;
    const yM = v => panes.macd.y1 - (v + mAbs) / (2 * mAbs) * (panes.macd.y1 - panes.macd.y0);
    const yFor = key => key === 'rsi' ? yR : yM;

    let s = '';
    // pane frames + titles
    for (const [key, p] of Object.entries(panes)) {
      s += '<line class="pane-line" x1="' + L + '" y1="' + p.y1 + '" x2="' + R + '" y2="' + p.y1 + '"/>';
      const title = key === 'price' ? titleSym.replace('^', '') + ' · ' + t.label + ' close' : key === 'rsi' ? 'RSI (14)' : 'MACD (12, 26, 9)';
      s += '<text class="pane-title" x="' + L + '" y="' + (p.y0 - 7) + '">' + title + '</text>';
    }
    // price grid + labels
    for (let g = 0; g <= 4; g++) {
      const v = pMin + (pMax - pMin) * g / 4, yy = yP(v);
      s += '<line class="grid-line" x1="' + L + '" y1="' + yy.toFixed(1) + '" x2="' + R + '" y2="' + yy.toFixed(1) + '"/>';
      s += '<text class="axis-label" x="' + (R + 6) + '" y="' + (yy + 4).toFixed(1) + '">' + fmtP(v) + '</text>';
    }
    // rsi refs
    for (const v of [30, 50, 70]) {
      const yy = yR(v);
      s += '<line class="' + (v === 50 ? 'grid-line' : 'ref-line') + '" x1="' + L + '" y1="' + yy.toFixed(1) + '" x2="' + R + '" y2="' + yy.toFixed(1) + '"/>';
      s += '<text class="axis-label" x="' + (R + 6) + '" y="' + (yy + 4).toFixed(1) + '">' + v + '</text>';
    }
    // macd zero line + labels
    s += '<line class="ref-line" x1="' + L + '" y1="' + yM(0).toFixed(1) + '" x2="' + R + '" y2="' + yM(0).toFixed(1) + '"/>';
    s += '<text class="axis-label" x="' + (R + 6) + '" y="' + (yM(0) + 4).toFixed(1) + '">0</text>';
    s += '<text class="axis-label" x="' + (R + 6) + '" y="' + (panes.macd.y0 + 9) + '">' + fmt1(mAbs) + '</text>';
    s += '<text class="axis-label" x="' + (R + 6) + '" y="' + (panes.macd.y1) + '">-' + fmt1(mAbs) + '</text>';

    // x-axis labels (6 evenly spaced)
    const ticks = Math.min(6, count);
    for (let k = 0; k < ticks; k++) {
      const i = start + Math.round(k * (count - 1) / Math.max(1, ticks - 1));
      const xx = x(i);
      s += '<line class="grid-line" x1="' + xx.toFixed(1) + '" y1="' + panes.price.y0 + '" x2="' + xx.toFixed(1) + '" y2="' + bottom + '"/>';
      s += '<text class="axis-label" x="' + xx.toFixed(1) + '" y="' + (bottom + 14) + '" text-anchor="' + (k === 0 ? 'start' : k === ticks - 1 ? 'end' : 'middle') + '">' + fmtDate(an.ts[i], tfKey, tfKey !== '60m') + '</text>';
    }

    // macd histogram
    const step = count > 1 ? (R - L) / (count - 1) : 10;
    const bw = Math.max(1, step * 0.65);
    for (let i = start; i < N; i++) {
      const h = an.macd.hist[i]; if (h == null) continue;
      const y0 = yM(0), y1 = yM(h);
      s += '<rect class="' + (h >= 0 ? 'hist-pos' : 'hist-neg') + '" x="' + (x(i) - bw / 2).toFixed(1) + '" y="' + Math.min(y0, y1).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.5, Math.abs(y1 - y0)).toFixed(1) + '"/>';
    }
    // lines
    const path = (arr, yf) => {
      let d = '', pen = false;
      for (let i = start; i < N; i++) {
        const v = arr[i];
        if (v == null) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + yf(v).toFixed(1);
        pen = true;
      }
      return d;
    };
    s += '<path class="macd-sig" d="' + path(an.macd.signal, yM) + '"/>';
    s += '<path class="macd-line" d="' + path(an.macd.line, yM) + '"/>';
    s += '<path class="rsi-line" d="' + path(an.rsi, yR) + '"/>';
    s += '<path class="price-line" d="' + path(an.c, yP) + '"/>';

    // divergence overlays
    const drawn = [];
    for (const key of ['rsi', 'macd']) {
      for (const d of an.divs[key]) {
        if (d.a < start) continue;
        const cls = d.kind === 'bearish' ? 'div-bear' : 'div-bull';
        const extra = d.forming ? ' div-forming' : '';
        const dot = d.kind === 'bearish' ? 'div-dot-bear' : 'div-dot-bull';
        // price segment
        s += '<line class="' + cls + extra + '" x1="' + x(d.a).toFixed(1) + '" y1="' + yP(d.pa).toFixed(1) + '" x2="' + x(d.b).toFixed(1) + '" y2="' + yP(d.pb).toFixed(1) + '"/>';
        s += '<circle class="' + dot + '" r="3" cx="' + x(d.a).toFixed(1) + '" cy="' + yP(d.pa).toFixed(1) + '"/>';
        s += '<circle class="' + dot + '" r="3" cx="' + x(d.b).toFixed(1) + '" cy="' + yP(d.pb).toFixed(1) + '"/>';
        // indicator segment
        const yf = yFor(key);
        s += '<line class="' + cls + extra + '" x1="' + x(d.iai).toFixed(1) + '" y1="' + yf(d.ia).toFixed(1) + '" x2="' + x(d.ibi).toFixed(1) + '" y2="' + yf(d.ib).toFixed(1) + '"/>';
        s += '<circle class="' + dot + '" r="3" cx="' + x(d.iai).toFixed(1) + '" cy="' + yf(d.ia).toFixed(1) + '"/>';
        s += '<circle class="' + dot + '" r="3" cx="' + x(d.ibi).toFixed(1) + '" cy="' + yf(d.ib).toFixed(1) + '"/>';
        // label near the second peak (only once per bar so RSI+MACD don't stack)
        const labelKey = d.kind + ':' + d.b;
        if (!drawn.includes(labelKey)) {
          drawn.push(labelKey);
          const ly = d.kind === 'bearish' ? yP(d.pb) - 10 : yP(d.pb) + 16;
          const anchor = x(d.b) > R - 90 ? 'end' : 'middle';
          s += '<text class="' + (d.kind === 'bearish' ? 'div-label-bear' : 'div-label-bull') + '" x="' + x(d.b).toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="' + anchor + '">' +
               (d.kind === 'bearish' ? 'Bearish' : 'Bullish') + (d.forming ? ' (forming)' : '') + '</text>';
        }
      }
    }
    // MACD crossover markers: triangle on the MACD pane at the confirming
    // bar, plus a matching triangle + label on the price pane.
    const tri = (cx, cy, up, cls) => {
      const h = 9, w = 5;
      const pts = up ? [cx, cy, cx - w, cy + h, cx + w, cy + h] : [cx, cy, cx - w, cy - h, cx + w, cy - h];
      return '<polygon class="' + cls + '" points="' + pts.map(v => v.toFixed(1)).join(' ') + '"/>';
    };
    for (const sg of an.sig.signals) {
      if (sg.at < start) continue;
      const up = sg.kind === 'buy', cls = up ? 'sig-buy' : 'sig-sell';
      const xx = x(sg.at);
      const ym = yM(an.macd.line[sg.at]);
      s += tri(xx, up ? ym + 5 : ym - 5, up, cls);
      const yp = yP(an.c[sg.at]);
      s += tri(xx, up ? yp + 6 : yp - 6, up, cls);
      s += '<text class="' + (up ? 'sig-label-buy' : 'sig-label-sell') + '" x="' + xx.toFixed(1) + '" y="' + (up ? yp + 27 : yp - 18).toFixed(1) + '" text-anchor="middle">' + (up ? 'Buy' : 'Sell') + '</text>';
    }
    if (an.sig.pending) {
      const up = an.sig.pending.kind === 'buy', cls = 'sig-pending ' + (up ? 'sig-buy' : 'sig-sell');
      const xx = x(N - 1), ym = yM(an.macd.line[N - 1]);
      s += tri(xx, up ? ym + 5 : ym - 5, up, cls);
    }
    s += '<g data-role="crosshair"></g>';

    return { svg: s, geom: { W, L, R, N, start, count, x, panes, bottom } };
  }

  function mountChart(svgEl, built) {
    svgEl.setAttribute('viewBox', '0 0 ' + built.geom.W + ' ' + (built.geom.bottom + 22));
    svgEl.innerHTML = built.svg;
  }

  function wireHover(svgEl, hoverEl, an, tfKey, geom) {
    const { W, L, R, N, start, count, x, panes, bottom } = geom;
    const cross = svgEl.querySelector('[data-role="crosshair"]');
    const onMove = ev => {
      const rect = svgEl.getBoundingClientRect();
      const px = (ev.clientX - rect.left) / rect.width * W;
      let i = start + Math.round((px - L) / (R - L) * (count - 1));
      i = Math.max(start, Math.min(N - 1, i));
      const xx = x(i).toFixed(1);
      cross.innerHTML = '<line class="crosshair" x1="' + xx + '" y1="' + panes.price.y0 + '" x2="' + xx + '" y2="' + bottom + '"/>';
      hoverEl.textContent = fmtDate(an.ts[i], tfKey, true) + ' ET · close ' + fmtP(an.c[i]) + ' · RSI ' + fmt1(an.rsi[i]) + ' · MACD ' + fmt1(an.macd.line[i]) + ' · signal ' + fmt1(an.macd.signal[i]);
    };
    svgEl.onmousemove = onMove;
    svgEl.onmouseleave = () => { cross.innerHTML = ''; hoverEl.textContent = ''; };
    hoverEl.textContent = '';
  }

  function legendHTML() {
    return '<span><i style="border-color:#e6edf6"></i>Close</span>' +
      '<span><i style="border-color:#ffb658"></i>RSI(14) / MACD signal</span>' +
      '<span><i style="border-color:#6ee7ff"></i>MACD line</span>' +
      '<span><i style="border-color:#ff5374"></i>Bearish divergence</span>' +
      '<span><i style="border-color:#22d39a"></i>Bullish divergence</span>' +
      '<span>&#9650;&#9660; MACD buy / sell</span>';
  }

  function footerText(an, tfKey) {
    const last = an.c.length - 1;
    return 'Last bar ' + fmtDate(an.ts[last], tfKey, true) + ' ET · close ' + fmtP(an.c[last]) + ' · RSI ' + fmt1(an.rsi[last]) + ' · MACD ' + fmt1(an.macd.line[last]);
  }

  function sigListHTML(an, tfKey, start) {
    const sigsInView = an.sig.signals.filter(sg => sg.at >= start);
    let sigHtml = 'MACD crossover signals in view: ';
    if (!sigsInView.length) sigHtml += 'none';
    else sigHtml += sigsInView.map(sg => '<b class="' + sg.kind + '">' + (sg.kind === 'buy' ? 'Buy' : 'Sell') + '</b> ' + fmtDate(an.ts[sg.at], tfKey, true) + ' @ ' + fmtP(an.c[sg.at])).join(' &middot; ');
    if (an.sig.pending) sigHtml += ' &middot; <span style="color:var(--warn)">pending ' + an.sig.pending.kind + ' on the open bar</span>';
    return sigHtml;
  }

  function divListHTML(an, tfKey, start, count) {
    const inView = [];
    for (const key of ['rsi', 'macd']) for (const d of an.divs[key]) if (d.a >= start) inView.push(Object.assign({ ind: key }, d));
    inView.sort((p, q) => q.b - p.b || (p.ind < q.ind ? -1 : 1));
    if (!inView.length) {
      return '<li class="dv-empty">No divergences in the last ' + count + ' bars &mdash; momentum has been tracking price.</li>';
    }
    return inView.slice(0, 6).map(d =>
      '<li><span class="' + (d.kind === 'bearish' ? 'k-bear' : 'k-bull') + '">' + (d.kind === 'bearish' ? 'Bearish' : 'Bullish') + '</span> on ' + indName(d.ind) +
      (d.forming ? ' <span class="dv-tag forming">forming</span>' : '') +
      ' &mdash; price ' + fmtP(d.pa) + ' &rarr; ' + fmtP(d.pb) + ' (' + fmtPct(d.pa, d.pb) + ') while ' + indName(d.ind) + ' ' + fmt1(d.ia) + ' &rarr; ' + fmt1(d.ib) +
      ' <span class="mono">' + fmtDate(an.ts[d.a], tfKey, true) + ' &rarr; ' + fmtDate(an.ts[d.b], tfKey, true) + '</span></li>'
    ).join('');
  }

  // ---------------- RSI overbought / oversold exits ----------------
  // The most recent bar where RSI closed back below 70 after being at or
  // above it (obExit), and back above 30 after being at or below it
  // (osExit), looking back up to 2*win bars. Also the RSI range over the
  // last win bars so the checklist can say how close it came.
  function rsiEvents(an, win) {
    const r = an.rsi, last = r.length - 1;
    const scanFrom = Math.max(1, last - win * 2);
    let obExit = null, osExit = null;
    for (let i = last; i >= scanFrom && (!obExit || !osExit); i--) {
      if (r[i] == null || r[i - 1] == null) continue;
      if (!obExit && r[i - 1] >= 70 && r[i] < 70) {
        let peak = r[i - 1], peakAt = i - 1;
        for (let k = i - 1; k >= scanFrom && r[k] != null && r[k] >= 70; k--) if (r[k] > peak) { peak = r[k]; peakAt = k; }
        obExit = { at: i, peak, peakAt };
      }
      if (!osExit && r[i - 1] <= 30 && r[i] > 30) {
        let trough = r[i - 1], troughAt = i - 1;
        for (let k = i - 1; k >= scanFrom && r[k] != null && r[k] <= 30; k--) if (r[k] < trough) { trough = r[k]; troughAt = k; }
        osExit = { at: i, trough, troughAt };
      }
    }
    let maxR = -Infinity, minR = Infinity;
    for (let i = Math.max(0, last - win); i <= last; i++) if (r[i] != null) { if (r[i] > maxR) maxR = r[i]; if (r[i] < minR) minR = r[i]; }
    return { obExit, osExit, maxR, minR, now: r[last] };
  }

  // ---------------- Buy / Sell / Hold checklist ----------------
  // Four conditions per side, each shown with a plain-English reason:
  //   1. a divergence is in force (bearish for sell, bullish for buy)
  //   2. RSI was overbought (>70) and has rolled back under it / mirror
  //   3. a confirmed MACD sell (buy) cross within the recent window
  //   4. price just made a new high (low) for the lookback
  // 4 of 4 = SELL/BUY, 3 of 4 with the divergence = LEAN, else HOLD.
  // The window is 2x the timeframe's "recent" setting (24 hourly bars,
  // 20 daily, 12 weekly, floor of 10 on monthly), so nothing older than a
  // few weeks — or a few months, on the monthly chart — can qualify.
  function verdict(an, tfKey) {
    const t = TF[tfKey], N = an.c.length, last = N - 1;
    const win = Math.max(10, t.recent * 2);
    const st = status(an);
    const ev = rsiEvents(an, win);
    const sigs = an.sig.signals, lastSig = sigs.length ? sigs[sigs.length - 1] : null;
    const extWin = t.maxGap;
    let hi = -Infinity, hiAt = -1, lo = Infinity, loAt = -1;
    for (let i = Math.max(0, last - extWin); i <= last; i++) {
      if (an.c[i] > hi) { hi = an.c[i]; hiAt = i; }
      if (an.c[i] < lo) { lo = an.c[i]; loAt = i; }
    }
    const ago = i => { const n = last - i; return n === 0 ? 'this bar' : n + ' bar' + (n === 1 ? '' : 's') + ' ago'; };
    const d = i => fmtDate(an.ts[i], tfKey, true);

    const side = kind => {
      const bear = kind === 'bearish';
      const items = [];
      const divOk = st.kind === kind;
      let divTxt;
      if (divOk) {
        const p = st.primary;
        divTxt = (st.forming ? 'Forming ' : p.playingOut ? 'Playing out: ' : 'Active ') + kind + ' divergence on ' + st.inds.map(indName).join(' + ') +
                 ' (peaks ' + d(p.a) + ' &rarr; ' + d(p.b) + ')';
      } else divTxt = 'No ' + kind + ' divergence in force on this timeframe';
      items.push({ key: 'div', label: (bear ? 'Bearish' : 'Bullish') + ' divergence on RSI or MACD', ok: divOk, detail: divTxt });

      const ex = bear ? ev.obExit : ev.osExit;
      const exOk = !!ex && last - ex.at <= win;
      let rsiTxt;
      if (exOk) {
        rsiTxt = bear
          ? 'RSI peaked ' + fmt1(ex.peak) + ' (' + d(ex.peakAt) + '), back below 70 ' + d(ex.at) + ' &mdash; now ' + fmt1(ev.now)
          : 'RSI bottomed ' + fmt1(ex.trough) + ' (' + d(ex.troughAt) + '), back above 30 ' + d(ex.at) + ' &mdash; now ' + fmt1(ev.now);
      } else if (bear ? ev.now >= 70 : ev.now <= 30) {
        rsiTxt = 'RSI ' + fmt1(ev.now) + ' &mdash; still ' + (bear ? 'overbought, has not rolled over yet' : 'oversold, has not recovered yet');
      } else {
        rsiTxt = bear
          ? 'RSI has not been above 70 recently (high ' + fmt1(ev.maxR) + ', now ' + fmt1(ev.now) + ')'
          : 'RSI has not been below 30 recently (low ' + fmt1(ev.minR) + ', now ' + fmt1(ev.now) + ')';
      }
      items.push({ key: 'rsi', label: bear ? 'RSI was overbought (above 70) and has rolled back under 70' : 'RSI was oversold (below 30) and has recovered above 30', ok: exOk, detail: rsiTxt });

      const want = bear ? 'sell' : 'buy';
      const macdOk = !!lastSig && lastSig.kind === want && last - lastSig.at <= win;
      let macdTxt;
      if (macdOk) macdTxt = 'MACD ' + want + ' cross confirmed ' + d(lastSig.at) + ' (' + ago(lastSig.at) + ')';
      else if (an.sig.pending && an.sig.pending.kind === want) macdTxt = 'MACD ' + want + ' cross pending on the open bar &mdash; counts only if the bar closes this way';
      else if (lastSig && lastSig.kind === want) macdTxt = 'Last MACD ' + want + ' cross was ' + d(lastSig.at) + ' (' + ago(lastSig.at) + ') &mdash; too old to count';
      else if (lastSig) macdTxt = 'Latest MACD cross is a ' + lastSig.kind.toUpperCase() + ' (' + d(lastSig.at) + ') &mdash; the wrong direction for this setup';
      else macdTxt = 'No confirmed MACD cross in the data';
      items.push({ key: 'macd', label: 'MACD ' + want + ' cross (line crossed ' + (bear ? 'below' : 'above') + ' its signal line)', ok: macdOk, detail: macdTxt });

      const extAt = bear ? hiAt : loAt, extOk = extAt >= 0 && last - extAt <= win;
      items.push({
        key: 'ext', label: bear ? 'Price just made a new high' : 'Price just made a new low', ok: extOk,
        detail: (bear ? 'Highest close of the last ' + extWin + ' bars' : 'Lowest close of the last ' + extWin + ' bars') +
                ' was ' + fmtP(bear ? hi : lo) + ' on ' + d(extAt) + ' (' + ago(extAt) + ')',
      });
      const score = items.filter(x => x.ok).length;
      return { kind, items, score, divOk };
    };

    const bear = side('bearish'), bull = side('bullish');
    let pick;
    if (st.kind === 'bearish') pick = bear;
    else if (st.kind === 'bullish') pick = bull;
    else if (bear.score !== bull.score) pick = bear.score > bull.score ? bear : bull;
    else pick = (last - hiAt) <= (last - loAt) ? bear : bull;   // nearer the high → show the sell checklist

    let label, tone;
    if (pick.score === 4) { label = pick.kind === 'bearish' ? 'SELL' : 'BUY'; tone = pick.kind === 'bearish' ? 'sell' : 'buy'; }
    else if (pick.score === 3 && pick.divOk) { label = pick.kind === 'bearish' ? 'LEAN SELL' : 'LEAN BUY'; tone = pick.kind === 'bearish' ? 'lean-sell' : 'lean-buy'; }
    else { label = 'HOLD'; tone = 'hold'; }
    return { label, tone, side: pick.kind, score: pick.score, items: pick.items, st, win };
  }

  // Which row of data/divergence_backtest.json best matches this reading.
  // The backtest only covers daily and weekly S&P 500 setups, so 60-minute
  // and monthly readings and setups it never tested return null.
  function backtestCondition(v, tfKey) {
    if (tfKey !== '1d' && tfKey !== '1wk') return null;
    const st = v.st, weekly = tfKey === '1wk';
    const macdOk = v.items.some(x => x.key === 'macd' && x.ok);
    const playingOut = !!(st.primary && st.primary.playingOut);
    let c = null;
    if (st.kind === 'bearish') {
      if (weekly) c = macdOk ? 'SPX weekly bearish + weekly MACD sell' : playingOut ? 'SPX weekly bearish PLAYING OUT' : 'SPX weekly bearish in force';
      else c = playingOut ? 'SPX daily bearish PLAYING OUT (fresh break)' : 'SPX daily bearish in force';
    } else if (st.kind === 'bullish') {
      c = weekly ? 'SPX weekly bullish in force' : 'SPX daily bullish in force';
    } else if (weekly && macdOk) {
      c = v.side === 'bearish' ? 'Weekly MACD sell in place (no divergence needed)' : 'Weekly MACD buy in place';
    }
    return c ? { condition: c, baseline: 'Baseline (any day)' } : null;
  }

  global.DivergenceEngine = {
    TF, TF_KEYS, MACD_MIN_RUN,
    emaArr, rsiArr, macdArr, macdSignals, findPivots, indExtreme, priorPivot, detect, analyze, annotate, status,
    etParts, fmtDate, fmtP, fmt1, fmtPct, indName,
    normalizeBars, fetchSeries,
    buildChartSVG, mountChart, wireHover, legendHTML, footerText, sigListHTML, divListHTML,
    rsiEvents, verdict, backtestCondition,
  };
})(window);
