#!/usr/bin/env python3
"""Local preview server for BATS.CO pages that need /api/history.

Serves the repo's static files exactly like `python -m http.server`, and
answers GET /api/history?syms=...&range=...&interval=...&fields=ohlc&prepost=1
by proxying Yahoo Finance's chart API with the same response shape as
api/history.js (bars per symbol plus the pre/regular/post `sessions`).
Also answers GET /api/earnings-dates?sym=... like api/earnings-dates.js
(SEC 8-K Item 2.02 filings) and GET /api/quote?syms=... like api/quote.js
(Yahoo v7 quotes). Other /api/* routes return 404 so pages fall back the
same way they do when a Vercel function is unreachable.

Usage:  py -3 scripts/dev-server.py 8766
"""
import datetime
import json
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
RANGES = {'1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max'}
INTERVALS = {'1m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo'}
UA = 'Mozilla/5.0 (BATS.CO dev server)'


def yahoo_chart(sym, rng, interval, want_ohlc, prepost):
    # range=max comes back as quarterly bars whatever the interval; an
    # explicit start/end returns full history at the interval asked for.
    span = f'period1=0&period2={int(time.time())}' if rng == 'max' else 'range=' + rng
    url = ('https://query1.finance.yahoo.com/v8/finance/chart/' + urllib.parse.quote(sym)
           + '?' + span + '&interval=' + interval + ('&includePrePost=true' if prepost else ''))
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
    result = (data.get('chart') or {}).get('result')
    if not result:
        return None
    result = result[0]
    tss = result.get('timestamp') or []
    q = ((result.get('indicators') or {}).get('quote') or [{}])[0]
    closes, opens, highs, lows, vols = (q.get(k) or [None] * len(tss) for k in ('close', 'open', 'high', 'low', 'volume'))
    meta = result.get('meta') or {}
    sessions = None
    ctp = meta.get('currentTradingPeriod') or {}
    if ctp.get('regular'):
        span = lambda p: [p['start'], p['end']] if p and 'start' in p and 'end' in p else None
        sessions = {'pre': span(ctp.get('pre')), 'regular': span(ctp.get('regular')), 'post': span(ctp.get('post')),
                    'gmtoffset': (ctp.get('regular') or {}).get('gmtoffset', meta.get('gmtoffset'))}
    # Patch a null last close from the meta price, as api/history.js does.
    if tss and closes[-1] is None and isinstance(meta.get('regularMarketPrice'), (int, float)) \
            and isinstance(meta.get('regularMarketTime'), (int, float)) and meta['regularMarketTime'] >= tss[-1]:
        c = meta['regularMarketPrice']
        closes[-1] = c
        if opens[-1] is None: opens[-1] = c
        highs[-1] = max(highs[-1], c) if highs[-1] is not None else c
        lows[-1] = min(lows[-1], c) if lows[-1] is not None else c
    out = []
    for i, t in enumerate(tss):
        c = closes[i]
        if not isinstance(c, (int, float)):
            continue
        if want_ohlc:
            o, h, l = opens[i], highs[i], lows[i]
            if not all(isinstance(v, (int, float)) for v in (o, h, l)):
                continue
            v = vols[i]
            out.append([t, round(o, 4), round(h, 4), round(l, 4), round(c, 4), int(round(v)) if isinstance(v, (int, float)) else 0])
        else:
            out.append([t, round(c, 4)])
    return {'bars': out, 'sessions': sessions} if out else None


_crumb = {'opener': None, 'crumb': None}


def yahoo_quotes(syms):
    """Mirror of api/quote.js: Yahoo v7 quote (cookie + crumb) → compact fields."""
    import http.cookiejar
    ua = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'}
    for attempt in (0, 1):
        if not _crumb['crumb'] or attempt:
            op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            try: op.open(urllib.request.Request('https://fc.yahoo.com/', headers=ua), timeout=15)
            except Exception: pass  # noqa: E701 — the 404 still sets the cookie
            _crumb['opener'] = op
            _crumb['crumb'] = op.open(urllib.request.Request('https://query1.finance.yahoo.com/v1/test/getcrumb', headers=ua), timeout=15).read().decode()
        url = ('https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + urllib.parse.quote(','.join(syms))
               + '&crumb=' + urllib.parse.quote(_crumb['crumb']))
        try:
            with _crumb['opener'].open(urllib.request.Request(url, headers=ua), timeout=20) as r:
                res = (json.load(r).get('quoteResponse') or {}).get('result') or []
            break
        except Exception:
            if attempt: raise
    num = lambda q, k: q.get(k) if isinstance(q.get(k), (int, float)) else None
    out = {}
    for q in res:
        out[q.get('symbol')] = {
            'symbol': q.get('symbol'), 'shortName': q.get('shortName') or q.get('longName'),
            'price': num(q, 'regularMarketPrice'), 'prevClose': num(q, 'regularMarketPreviousClose'),
            'dayChange': num(q, 'regularMarketChange'), 'dayChangePct': num(q, 'regularMarketChangePercent'),
            'open': num(q, 'regularMarketOpen'), 'dayHigh': num(q, 'regularMarketDayHigh'), 'dayLow': num(q, 'regularMarketDayLow'),
            'regularMarketTime': num(q, 'regularMarketTime'), 'marketState': q.get('marketState'),
            'marketCap': num(q, 'marketCap'),
            'preMarketPrice': num(q, 'preMarketPrice'), 'preMarketChange': num(q, 'preMarketChange'),
            'preMarketChangePercent': num(q, 'preMarketChangePercent'), 'preMarketTime': num(q, 'preMarketTime'),
            'postMarketPrice': num(q, 'postMarketPrice'), 'postMarketChange': num(q, 'postMarketChange'),
            'postMarketChangePercent': num(q, 'postMarketChangePercent'), 'postMarketTime': num(q, 'postMarketTime'),
        }
    return {'symbols': syms, 'count': len(out), 'quotes': out}


SEC_UA = {'User-Agent': 'BATS.CO research (deluxejob@yahoo.com)'}


def sec_json(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=SEC_UA), timeout=20) as r:
            return json.load(r)
    except Exception:  # noqa: BLE001
        return None


def earnings_dates(raw):
    """Mirror of api/earnings-dates.js: 8-K Item 2.02 filings → release dates."""
    sym = raw.upper().replace('.', '').replace('-', '')
    tick = sec_json('https://www.sec.gov/files/company_tickers.json') or {}
    cik = next((str(v['cik_str']).zfill(10) for v in tick.values()
                if str(v.get('ticker', '')).upper().replace('.', '').replace('-', '') == sym), None)
    if not cik:
        return {'ticker': raw, 'cik': None, 'source': 'sec-8k-2.02', 'count': 0, 'dates': []}
    sub = sec_json(f'https://data.sec.gov/submissions/CIK{cik}.json') or {}
    blocks = [(sub.get('filings') or {}).get('recent') or {}]
    for f in ((sub.get('filings') or {}).get('files') or [])[:2]:
        blocks.append(sec_json(f"https://data.sec.gov/submissions/{f['name']}") or {})
    et = ZoneInfo('America/New_York')
    by_date = {}
    for b in blocks:
        for i, form in enumerate(b.get('form') or []):
            if form != '8-K' or '2.02' not in [s.strip() for s in str((b.get('items') or [''])[i] or '').split(',')]:
                continue
            acc = (b.get('acceptanceDateTime') or [None])[i]
            if not acc:
                continue
            t = datetime.datetime.fromisoformat(acc.replace('Z', '+00:00')).astimezone(et)
            mins = t.hour * 60 + t.minute
            rec = {'date': t.strftime('%Y-%m-%d'), 'time': 'bmo' if mins < 570 else 'amc' if mins >= 960 else 'dmh',
                   'accepted': datetime.datetime.fromisoformat(acc.replace('Z', '+00:00')).strftime('%Y-%m-%dT%H:%M:%S.000Z')}
            if rec['date'] not in by_date or rec['accepted'] < by_date[rec['date']]['accepted']:
                by_date[rec['date']] = rec
    dates = sorted(by_date.values(), key=lambda d: d['date'])
    return {'ticker': raw, 'cik': cik, 'source': 'sec-8k-2.02', 'count': len(dates), 'dates': dates}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):  # quieter console: only API hits and errors
        if not args or '/api/' in str(args[0]) or 'code' in fmt:
            super().log_message(fmt, *args)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/history':
            return self.history(urllib.parse.parse_qs(parsed.query))
        if parsed.path == '/api/earnings-dates':
            sym = (urllib.parse.parse_qs(parsed.query).get('sym') or [''])[0]
            return self.send_json(200, earnings_dates(sym))
        if parsed.path == '/api/quote':
            raw = (urllib.parse.parse_qs(parsed.query).get('syms') or [''])[0].upper()
            syms = list(dict.fromkeys(s.strip() for s in raw.split(',') if s.strip()))[:20]
            if not syms:
                return self.send_json(400, {'error': 'no valid symbols'})
            try:
                return self.send_json(200, yahoo_quotes(syms))
            except Exception as e:  # noqa: BLE001
                return self.send_json(502, {'error': str(e)})
        if parsed.path == '/api/earnings-calendar':
            # Needs the Finnhub key, which only lives on Vercel — pass the
            # request through to the live site's copy of the same endpoint.
            try:
                req = urllib.request.Request('https://bats.co' + self.path, headers={'User-Agent': UA})
                with urllib.request.urlopen(req, timeout=15) as resp:
                    return self.send_json(200, json.loads(resp.read().decode('utf-8')))
            except Exception as e:  # noqa: BLE001
                return self.send_json(502, {'error': str(e)})
        if parsed.path.startswith('/api/'):
            self.send_response(404); self.end_headers(); return
        return super().do_GET()

    def send_json(self, status, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def history(self, qs):
        raw = (qs.get('syms') or [''])[0].upper()
        rng = (qs.get('range') or ['6mo'])[0].lower()
        interval = (qs.get('interval') or ['1d'])[0].lower()
        want_ohlc = (qs.get('fields') or [''])[0].lower() == 'ohlc'
        prepost = (qs.get('prepost') or [''])[0] == '1'
        if rng not in RANGES:
            return self.send_json(400, {'error': 'invalid range'})
        if interval not in INTERVALS:
            return self.send_json(400, {'error': 'invalid interval'})
        syms = [s.strip() for s in raw.split(',') if s.strip()][:6]
        series, sessions = {}, {}
        for s in syms:
            try:
                r = yahoo_chart(s, rng, interval, want_ohlc, prepost)
            except Exception as e:  # noqa: BLE001 — one dead ticker must not break the response
                sys.stderr.write(f'history {s}: {e}\n'); r = None
            if r:
                series[s] = r['bars']
                if r['sessions']:
                    sessions[s] = r['sessions']
        self.send_json(200, {'range': rng, 'interval': interval, 'count': len(series), 'series': series, 'sessions': sessions})


class _V6Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    # Listen on both loopback addresses (127.0.0.1 and ::1) so
    # http://localhost:<port> works whichever one the browser picks.
    # Loopback only — nothing is exposed to the local network.
    servers = [ThreadingHTTPServer(('127.0.0.1', port), Handler)]
    try:
        servers.append(_V6Server(('::1', port), Handler))
    except OSError:
        pass
    for extra in servers[1:]:
        threading.Thread(target=extra.serve_forever, daemon=True).start()
    print(f'BATS.CO dev server on http://localhost:{port}  (static + /api/history + /api/earnings-dates)')
    servers[0].serve_forever()
