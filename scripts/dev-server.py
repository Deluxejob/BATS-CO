#!/usr/bin/env python3
"""Local preview server for BATS.CO pages that need /api/history.

Serves the repo's static files exactly like `python -m http.server`, and
answers GET /api/history?syms=...&range=...&interval=...&fields=ohlc&prepost=1
by proxying Yahoo Finance's chart API with the same response shape as
api/history.js (bars per symbol plus the pre/regular/post `sessions`).
Other /api/* routes return 404 so pages fall back the same way they do
when a Vercel function is unreachable.

Usage:  py -3 scripts/dev-server.py 8766
"""
import json
import sys
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RANGES = {'1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max'}
INTERVALS = {'1m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo'}
UA = 'Mozilla/5.0 (BATS.CO dev server)'


def yahoo_chart(sym, rng, interval, want_ohlc, prepost):
    url = ('https://query1.finance.yahoo.com/v8/finance/chart/' + urllib.parse.quote(sym)
           + '?range=' + rng + '&interval=' + interval + ('&includePrePost=true' if prepost else ''))
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


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    print(f'BATS.CO dev server on http://localhost:{port}  (static + /api/history)')
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
