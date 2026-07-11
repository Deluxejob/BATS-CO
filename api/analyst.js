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
  if (!field) return null;
  const v = field.raw;
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

export default async function handler(req, res) {
  const raw = String(req.query.sym || '').toUpperCase().trim();
  if (!/^[A-Z0-9.\-]{1,10}$/.test(raw)) {
    return res.status(400).json({ error: 'invalid symbol' });
  }

  try {
    const { crumb, cookieHeader } = await getCrumb();

    const modules = 'financialData,recommendationTrend,upgradeDowngradeHistory,' +
                    'defaultKeyStatistics,majorHoldersBreakdown,calendarEvents,summaryDetail,' +
                    'assetProfile,earnings,earningsTrend';
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

    const earnings = {
      // Recent quarterly EPS: actual + prior estimate at reporting time
      quarterly: (Array.isArray(eChart.quarterly) ? eChart.quarterly : []).map(q => ({
        period:   String(q.date || ''),   // e.g. "2Q2024"
        actual:   toNum(q.actual),
        estimate: toNum(q.estimate),
      })).filter(q => q.period),
      // Current quarter estimate (what analysts expect for the upcoming report)
      currentQuarterEst: {
        period:   String(eChart.currentQuarterEstimateDate || ''),  // e.g. "2Q"
        year:     toNum(eChart.currentQuarterEstimateYear),
        estimate: toNum(eChart.currentQuarterEstimate),
      },
      // Next-quarter estimate (looking further ahead)
      nextQuarterEst: trendPt('+1q'),
      // Annual EPS timeline: prior year, current year, next two years
      annual: ['-1y', '0y', '+1y', '+2y'].map(trendPt).filter(Boolean),
    };

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
    };

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=300');
    return res.status(200).json(payload);
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
}
