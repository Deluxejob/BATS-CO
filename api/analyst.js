// Vercel serverless function — proxies Yahoo Finance's quoteSummary
// endpoint to get analyst recommendations and price targets.
//
// Yahoo's quoteSummary requires a "crumb" (session token) as of mid-2024,
// so we run a 3-step dance server-side:
//   1. GET fc.yahoo.com to seed cookies (A1, A3, etc.)
//   2. GET /v1/test/getcrumb with those cookies to receive a fresh crumb
//   3. GET /v10/finance/quoteSummary/<SYM>?crumb=... with cookies + crumb
//
// Returns a compact JSON payload the ticker page can render as tiles.
// Cached at Vercel's edge for 15 minutes — analyst ratings change slowly
// and this endpoint is the slowest part of the ticker page load.
//
// GET /api/analyst?sym=NVDA
//   → { symbol, recommendation, meanRating, analystCount,
//       ratings: { strongBuy, buy, hold, sell, strongSell },
//       priceTarget: { low, mean, high, current } }

const YAHOO_UA = 'Mozilla/5.0 (BATS.CO analyst proxy)';

async function getCrumb() {
  // 1) Cookie primer. Yahoo's fc.yahoo.com hands back A1/A3 cookies
  //    the crumb endpoint keys off of.
  const primer = await fetch('https://fc.yahoo.com/', {
    headers: { 'User-Agent': YAHOO_UA },
    redirect: 'follow',
  });
  const setCookies = primer.headers.getSetCookie
    ? primer.headers.getSetCookie()
    : (primer.headers.get('set-cookie') || '').split(/,(?=[^;]+=[^;]+;)/);
  const cookieHeader = (setCookies || [])
    .map(c => (c || '').split(';')[0])
    .filter(Boolean)
    .join('; ');

  // 2) Ask for the crumb using those cookies.
  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': YAHOO_UA, 'Cookie': cookieHeader },
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumb) throw new Error('empty crumb');
  return { crumb, cookieHeader };
}

function toNum(field) {
  if (field == null) return null;
  // Yahoo sometimes returns fields as plain numbers (currentQuarterEstimateYear,
  // fullTimeEmployees, etc.) and sometimes wrapped in { raw, fmt } (most others).
  // Handle both.
  if (typeof field === 'number') return Number.isFinite(field) ? field : null;
  const v = field.raw;
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

// Convert a Nasdaq "MMM YYYY" fiscal-end string ("Jul 2026") to a fiscal-
// quarter-end ISO date ("2026-07-31"). We approximate by using the last
// day of that calendar month, which matches how Yahoo and Nasdaq both
// label the end of a fiscal period.
const MONTH_INDEX = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
function fiscalEndToISO(fmt) {
  const m = /^([A-Za-z]{3})\s+(\d{4})$/.exec(String(fmt || '').trim());
  if (!m) return '';
  const mo = MONTH_INDEX[m[1].slice(0,1).toUpperCase() + m[1].slice(1,3).toLowerCase()];
  if (mo == null) return '';
  const yr = parseInt(m[2], 10);
  // Last day of the given month = day 0 of the next month
  const d = new Date(Date.UTC(yr, mo + 1, 0));
  return d.toISOString().slice(0, 10);
}

// Finnhub peers endpoint — returns tickers of companies in the same
// industry as the queried symbol. Free tier, but requires an API key
// stored in the FINNHUB_API_KEY environment variable on Vercel. When
// the key isn't set (or the call fails), we return null and the
// frontend hides the peer companies section gracefully.
// Fetch peers from Finnhub (industry grouping — broader than the default
// sub-industry, so semis + semi equipment come back together) AND Yahoo's
// recommendations-by-symbol endpoint, then merge/dedupe. Two sources
// increase coverage across GICS classification quirks.
async function fetchFinnhubPeers(sym) {
  const key = process.env.FINNHUB_API_KEY;
  const filterOk = (arr, self) => (Array.isArray(arr) ? arr : [])
    .filter(t => typeof t === 'string' && /^[A-Z0-9.\-]{1,10}$/.test(t) && t !== self);
  const self = sym.toUpperCase();

  // --- Finnhub: grouping=industry (broader) ---
  const finnhub = (async () => {
    if (!key) return [];
    // Two Finnhub calls in parallel: sub-industry (tight, high-quality) +
    // industry (broader). Union of both gives more coverage than either
    // alone — some tickers' peers only surface at one level.
    try {
      const [subR, indR] = await Promise.all([
        fetch(`https://finnhub.io/api/v1/stock/peers?symbol=${encodeURIComponent(sym)}&grouping=subIndustry&token=${encodeURIComponent(key)}`,
          { headers: { 'User-Agent': 'BATS.CO peers proxy' } }),
        fetch(`https://finnhub.io/api/v1/stock/peers?symbol=${encodeURIComponent(sym)}&grouping=industry&token=${encodeURIComponent(key)}`,
          { headers: { 'User-Agent': 'BATS.CO peers proxy' } }),
      ]);
      const subArr = subR.ok ? await subR.json() : [];
      const indArr = indR.ok ? await indR.json() : [];
      // Interleave: prioritize sub-industry (closer matches first), then
      // append industry ones that weren't already in the sub-industry list.
      const seen = new Set();
      const out = [];
      for (const list of [subArr, indArr]) {
        for (const t of filterOk(list, self)) {
          if (!seen.has(t)) { seen.add(t); out.push(t); }
        }
      }
      return out;
    } catch (e) {
      return [];
    }
  })();

  // --- Yahoo recommendations-by-symbol (usage-based, sometimes catches
  // adjacencies GICS misses — different signal than Finnhub's classification) ---
  const yahoo = (async () => {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v6/finance/recommendationsbysymbol/${encodeURIComponent(sym)}`,
        { headers: { 'User-Agent': YAHOO_UA } });
      if (!r.ok) return [];
      const d = await r.json();
      const list = (((d && d.finance && d.finance.result) || [])[0] || {}).recommendedSymbols || [];
      return filterOk(list.map(x => x && x.symbol), self);
    } catch (e) {
      return [];
    }
  })();

  const [fh, yh] = await Promise.all([finnhub, yahoo]);
  // Merge: Finnhub first (usually most tickers), then append Yahoo picks
  // not already in the Finnhub list. Cap at 12.
  const seen = new Set();
  const merged = [];
  for (const list of [fh, yh]) {
    for (const t of list) {
      if (!seen.has(t)) { seen.add(t); merged.push(t); }
      if (merged.length >= 12) break;
    }
    if (merged.length >= 12) break;
  }
  return merged.length ? merged : null;
}

// Nasdaq's public analyst-forecast endpoint. Free, no API key, returns
// quarterly and yearly EPS consensus (with low/high/analyst count) going
// out 5 quarters and up to 4 years — the source of the deeper forward
// window this file used to fake with extrapolation.
async function fetchNasdaqForecast(sym) {
  const url = `https://api.nasdaq.com/api/analyst/${encodeURIComponent(sym)}/earnings-forecast`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (BATS.CO forecast proxy)' } });
    if (!r.ok) return null;
    const body = await r.json();
    const data = body && body.data;
    if (!data) return null;
    const qRows = (data.quarterlyForecast && data.quarterlyForecast.rows) || [];
    const yRows = (data.yearlyForecast    && data.yearlyForecast.rows)    || [];
    const mapRow = (row) => {
      const eps = Number(row.consensusEPSForecast);
      if (!Number.isFinite(eps)) return null;
      return {
        fiscalEnd:   String(row.fiscalEnd || ''),
        endDate:     fiscalEndToISO(row.fiscalEnd),
        eps,
        low:         Number.isFinite(Number(row.lowEPSForecast))  ? Number(row.lowEPSForecast)  : null,
        high:        Number.isFinite(Number(row.highEPSForecast)) ? Number(row.highEPSForecast) : null,
        numAnalysts: Number.isFinite(Number(row.noOfEstimates))   ? Number(row.noOfEstimates)   : null,
      };
    };
    return {
      quarterly: qRows.map(mapRow).filter(Boolean),
      yearly:    yRows.map(mapRow).filter(Boolean),
    };
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  const raw = String(req.query.sym || '').toUpperCase().trim();
  if (!/^[A-Z0-9.\-]{1,10}$/.test(raw)) {
    return res.status(400).json({ error: 'invalid symbol' });
  }

  try {
    // Fetch Yahoo quoteSummary (crumb-gated), Nasdaq's public forecast
    // endpoint, and Finnhub peers in parallel — three independent data
    // sources, no reason to serialize them.
    const [{ crumb, cookieHeader }, nasdaqForecast, peers] = await Promise.all([
      getCrumb(),
      fetchNasdaqForecast(raw),
      fetchFinnhubPeers(raw),
    ]);

    const modules = 'financialData,recommendationTrend,upgradeDowngradeHistory,' +
                    'defaultKeyStatistics,majorHoldersBreakdown,calendarEvents,summaryDetail,' +
                    'assetProfile,earnings,earningsTrend,' +
                    // Corporate-insider trades + top institutional holders — feeds
                    // the Insider Transactions + Top Institutional Holders tables.
                    'insiderTransactions,institutionOwnership';
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(raw)}` +
                `?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': YAHOO_UA, 'Cookie': cookieHeader },
    });
    if (!r.ok) throw new Error('quoteSummary status ' + r.status);
    const data = await r.json();
    const result = data && data.quoteSummary && data.quoteSummary.result;
    if (!result || !result.length) {
      // Not an error — probably an ETF or index without analyst coverage.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=300');
      return res.status(200).json({ symbol: raw, hasAnalysts: false });
    }

    const r0 = result[0];
    const fd = r0.financialData || {};
    const trend = (r0.recommendationTrend && r0.recommendationTrend.trend) || [];
    const upgrades = ((r0.upgradeDowngradeHistory && r0.upgradeDowngradeHistory.history) || [])
      .slice(0, 8)
      .map(h => ({
        date: h.epochGradeDate || 0,
        firm: String(h.firm || ''),
        toGrade:   String(h.toGrade || ''),
        fromGrade: String(h.fromGrade || ''),
        action:    String(h.action || ''),
      }));

    // First trend row is current-month aggregate: {period:"0m",strongBuy,buy,hold,sell,strongSell}
    const cur = trend[0] || {};
    const ratings = {
      strongBuy:  Number(cur.strongBuy)  || 0,
      buy:        Number(cur.buy)        || 0,
      hold:       Number(cur.hold)       || 0,
      sell:       Number(cur.sell)       || 0,
      strongSell: Number(cur.strongSell) || 0,
    };
    const totalRatings = ratings.strongBuy + ratings.buy + ratings.hold + ratings.sell + ratings.strongSell;

    // Ownership + upcoming events — supplemental company data for the
    // "OWNERSHIP & EVENTS" panel that sits under Key Statistics.
    const ks   = r0.defaultKeyStatistics   || {};
    const mhb  = r0.majorHoldersBreakdown  || {};
    const cev  = r0.calendarEvents         || {};
    const sdet = r0.summaryDetail          || {};
    const earn = cev.earnings              || {};
    const nextEarn = Array.isArray(earn.earningsDate) && earn.earningsDate[0] || null;

    const overview = {
      insiderOwnership:      toNum(mhb.insidersPercentHeld),      // decimal, e.g. 0.042
      institutionalOwnership: toNum(mhb.institutionsPercentHeld), // decimal
      institutionCount:      toNum(mhb.institutionsCount),
      shortPctOfFloat:       toNum(ks.shortPercentOfFloat),       // decimal
      shortRatio:            toNum(ks.shortRatio),                // days to cover
      sharesShort:           toNum(ks.sharesShort),
      nextEarningsDate:      toNum(nextEarn),                     // unix seconds
      nextEarningsEstimate:  toNum(earn.earningsAverage),
      exDividendDate:        toNum(cev.exDividendDate) || toNum(sdet.exDividendDate),
      dividendYield:         toNum(sdet.dividendYield),           // decimal
      dividendRate:          toNum(sdet.dividendRate),
    };

    // Company profile — sector, industry, HQ, employees, website, and the
    // long business summary. Yahoo bios are usually 500-1500 chars, so the
    // frontend truncates + expands on demand.
    const ap = r0.assetProfile || {};
    const employees = (ap.fullTimeEmployees != null && Number.isFinite(ap.fullTimeEmployees))
      ? ap.fullTimeEmployees : null;
    const profile = {
      description: String(ap.longBusinessSummary || '').trim(),
      sector:   String(ap.sector   || '').trim(),
      industry: String(ap.industry || '').trim(),
      city:     String(ap.city     || '').trim(),
      state:    String(ap.state    || '').trim(),
      country:  String(ap.country  || '').trim(),
      employees,
      website:  String(ap.website  || '').trim(),
    };

    // Earnings — quarterly (recent actuals + upcoming quarter estimate) and
    // annual (prior year actual, current estimate, forward estimates).
    // Yahoo's `earnings` module gives the last ~4 quarters + one current-
    // quarter estimate. `earningsTrend.trend` gives forward-looking EPS
    // estimates keyed by period ("-1y","0y","+1y","+2y","0q","+1q").
    // NB: local name shadows the `trend` var above (recommendationTrend);
    // scoped in this block below so the two never collide.
    const eChart  = (r0.earnings && r0.earnings.earningsChart) || {};
    const eTrend  = (r0.earningsTrend && r0.earningsTrend.trend) || [];
    const findPeriod = (p) => eTrend.find(t => t && t.period === p);
    const trendPt = (p) => {
      const t = findPeriod(p);
      if (!t) return null;
      const ee = t.earningsEstimate || {};
      return {
        period:  p,
        endDate: String(t.endDate || ''),
        eps:     toNum(ee.avg),
        low:     toNum(ee.low),
        high:    toNum(ee.high),
        numAnalysts: toNum(ee.numberOfAnalysts),
      };
    };

    // Past fiscal-year data from earnings.financialsChart.yearly — includes
    // both total revenue and total net income. Two things we do with this:
    //   (1) Derive a rough EPS = netIncome ÷ current sharesOutstanding to
    //       backfill missing prior-year bars on the EPS chart. Approximate
    //       but usually within ~5-10% of Yahoo's reported historical EPS.
    //   (2) Feed the Revenue-vs-Earnings grouped chart directly (raw $).
    const finChart   = (r0.earnings && r0.earnings.financialsChart) || {};
    const finYearly  = Array.isArray(finChart.yearly)    ? finChart.yearly    : [];
    const finQtrRaw  = Array.isArray(finChart.quarterly) ? finChart.quarterly : [];
    const currentShares = toNum(ks.sharesOutstanding);

    const pastAnnualDerived = finYearly.map(y => {
      const yr = toNum(y && y.date);
      const ni = toNum(y && y.earnings);
      const rev = toNum(y && y.revenue);
      if (!Number.isFinite(yr)) return null;
      const epsDerived = (Number.isFinite(ni) && Number.isFinite(currentShares) && currentShares > 0)
        ? ni / currentShares : null;
      return { year: yr, epsDerived, netIncome: ni, revenue: rev };
    }).filter(x => x && (Number.isFinite(x.netIncome) || Number.isFinite(x.revenue)));

    // Quarterly revenue + net income for the Revenue-vs-Earnings chart.
    // Fiscal-quarter labels ("2Q2024") match earnings.earningsChart.quarterly.
    const finQuarterly = finQtrRaw.map(q => ({
      period:    String(q && q.date || ''),
      revenue:   toNum(q && q.revenue),
      netIncome: toNum(q && q.earnings),
    })).filter(q => q.period && (Number.isFinite(q.revenue) || Number.isFinite(q.netIncome)));

    const earnings = {
      // Recent quarterly EPS: actual + prior estimate at reporting time.
      // Uses earnings.earningsChart.quarterly (~4 quarters with clean
      // fiscal-quarter labels like "1Q2026"). We deliberately DON'T merge
      // earningsHistory here — its records use report-date-based calendar
      // quarters, which double-count against fiscal labels for any ticker
      // with an off-calendar fiscal year (NVDA, AAPL, etc.).
      quarterly: (Array.isArray(eChart.quarterly) ? eChart.quarterly : []).map(q => ({
        period:   String(q.date || ''),
        actual:   toNum(q.actual),
        estimate: toNum(q.estimate),
      })).filter(q => q.period),
      // Current quarter estimate (what analysts expect for the upcoming report)
      currentQuarterEst: {
        period:   String(eChart.currentQuarterEstimateDate || ''),  // e.g. "2Q"
        year:     toNum(eChart.currentQuarterEstimateYear),
        estimate: toNum(eChart.currentQuarterEstimate),
      },
      // Next-quarter estimate (looking further ahead — Yahoo caps at +1q)
      nextQuarterEst: trendPt('+1q'),
      // Annual EPS timeline: try to catch as much history + future as
      // Yahoo has. -2y/-1y are prior-year actuals when populated; 0y is
      // this year's *current* consensus (year not yet closed); +1y/+2y/+3y
      // are forward estimates. Yahoo returns null for periods it doesn't
      // have; filter(Boolean) drops them.
      annual: ['-2y', '-1y', '0y', '+1y', '+2y', '+3y'].map(trendPt).filter(Boolean),
      // EPS Trend — how consensus for each near-term period has moved
      // over the last 90 days. Yahoo returns this per-period inside the
      // earningsTrend module.
      epsTrendHistory: ['0q', '+1q', '0y', '+1y'].map(period => {
        const t = eTrend.find(x => x && x.period === period);
        if (!t) return null;
        const et = t.epsTrend || {};
        return {
          period,
          endDate: String(t.endDate || ''),
          current: toNum(et.current),
          d7:      toNum(et['7daysAgo']),
          d30:     toNum(et['30daysAgo']),
          d60:     toNum(et['60daysAgo']),
          d90:     toNum(et['90daysAgo']),
        };
      }).filter(x => x && (Number.isFinite(x.current) || Number.isFinite(x.d90))),
      // EPS Revisions — how many analysts have raised or lowered their
      // estimate for each period over the last 7 / 30 days.
      epsRevisions: ['0q', '+1q', '0y', '+1y'].map(period => {
        const t = eTrend.find(x => x && x.period === period);
        if (!t) return null;
        const er = t.epsRevisions || {};
        return {
          period,
          endDate: String(t.endDate || ''),
          up7:    toNum(er.upLast7days),
          up30:   toNum(er.upLast30days),
          down7:  toNum(er.downLast7days),
          down30: toNum(er.downLast30days),
        };
      }).filter(x => x && [x.up7, x.up30, x.down7, x.down30].some(v => Number.isFinite(v))),
      // Earnings growth estimates — expected YoY EPS growth (decimal
      // fraction, e.g. 0.5695 = +56.95%) for each of the 4 near-term
      // periods. Same source that populates the "Growth Estimates" table
      // on Yahoo's Analysis tab.
      growth: ['0q', '+1q', '0y', '+1y'].map(period => {
        const t = eTrend.find(x => x && x.period === period);
        if (!t) return null;
        return {
          period,
          endDate: String(t.endDate || ''),
          rate: toNum(t.growth),
        };
      }).filter(x => x && Number.isFinite(x.rate)),
      // Prior-year actuals backfill (derived from net income ÷ shares).
      // Frontend uses these to fill any past fiscal year the earningsTrend
      // response left blank.
      pastAnnualDerived,
      // Quarterly revenue + net income (raw $, from financialsChart) — feeds
      // the Revenue-vs-Earnings grouped chart on ticker.html.
      finQuarterly,
      sharesOutstanding: currentShares,
      // Nasdaq's public analyst-forecast endpoint (5 fwd quarters + up to
      // 4 fwd years with low/mean/high + analyst count). Real consensus,
      // no API key required. Null when Nasdaq doesn't cover the ticker
      // (e.g. ETFs, indices).
      forecast: nasdaqForecast,
    };

    // Insider transactions — recent trades by officers, directors, and 10%+
    // owners. Yahoo returns ~30 most recent; we cap at 15 to keep the table
    // readable. "action" is derived from Yahoo's `transactionText` which is
    // freeform ("Sale", "Purchase", "Stock Award", "Sale (Multiple)"), so we
    // classify into buy/sell/award/other for coloring.
    const insiderRaw = (r0.insiderTransactions && r0.insiderTransactions.transactions) || [];
    const classifyInsider = (txt) => {
      const t = String(txt || '').toLowerCase();
      if (t.includes('purchase') || t.includes('buy')) return 'buy';
      if (t.includes('sale') || t.includes('sell')) return 'sell';
      if (t.includes('award') || t.includes('grant') || t.includes('option')) return 'award';
      return 'other';
    };
    const insiders = insiderRaw.slice(0, 15).map(t => ({
      date:      toNum(t && t.startDate),         // unix seconds
      filer:     String((t && t.filerName) || '').trim(),
      title:     String((t && t.filerRelation) || '').trim(),
      text:      String((t && t.transactionText) || '').trim(),
      action:    classifyInsider(t && t.transactionText),
      shares:    toNum(t && t.shares),
      value:     toNum(t && t.value),
      ownership: String((t && t.ownership) || '').trim(),  // "D" (Direct) / "I" (Indirect)
    })).filter(x => x.filer);

    // Top institutional holders — Vanguard, BlackRock, State Street, etc.
    // Cap at 15 (Yahoo returns ~10-20). `pctHeld` and `pctChange` are
    // decimals (0.09 = 9%). `pctChange` is quarter-over-quarter position
    // change (positive = added, negative = trimmed).
    const instRaw = (r0.institutionOwnership && r0.institutionOwnership.ownershipList) || [];
    const institutions = instRaw.slice(0, 15).map(o => ({
      name:       String((o && o.organization) || '').trim(),
      reportDate: toNum(o && o.reportDate),  // unix seconds
      pctHeld:    toNum(o && o.pctHeld),
      shares:     toNum(o && o.position),
      value:      toNum(o && o.value),
      pctChange:  toNum(o && o.pctChange),
    })).filter(x => x.name);

    const payload = {
      symbol: raw,
      hasAnalysts: (Number(fd.numberOfAnalystOpinions && fd.numberOfAnalystOpinions.raw) || totalRatings) > 0,
      recommendation: String(fd.recommendationKey || '').replace(/_/g, ' '),
      meanRating: toNum(fd.recommendationMean),
      analystCount: toNum(fd.numberOfAnalystOpinions) || totalRatings || null,
      ratings,
      priceTarget: {
        low:     toNum(fd.targetLowPrice),
        mean:    toNum(fd.targetMeanPrice),
        median:  toNum(fd.targetMedianPrice),
        high:    toNum(fd.targetHighPrice),
        current: toNum(fd.currentPrice),
      },
      upgrades,
      overview,
      profile,
      earnings,
      // Peer companies (same industry) — from Finnhub. Empty array or
      // null when no FINNHUB_API_KEY env var is set on Vercel.
      peers,
      // Recent insider trades (officers / directors / 10%+ owners).
      insiders,
      // Top institutional holders (Vanguard, BlackRock, etc.).
      institutions,
    };

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=300');
    return res.status(200).json(payload);
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
