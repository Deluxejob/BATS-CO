# BATS.CO — Benchmark Asset and Trend Scenarios

A single, transparent market sentiment indicator (the **BATS**) that answers a
simple question: **"Is now a good time to buy stocks?"**

The BATS blends widely-used public market indicators into a 0–100 score across
eight buckets — Extremely Oversold, Very Oversold, Oversold, Slightly Bearish, Neutral, Slightly
Bullish, Bullish, Extended. Every component is documented and independently
backtested against S&P 500 forward returns.

Live at **[bats.co](https://bats.co)**.

## Current components

Weights are relative points (the blend divides by their total, 130), as set in `COMPONENTS` in `app.js` and mirrored in the Python builders.

| Component | Points | Direction | Data source |
|---|---|---|---|
| VIX | 25 | Contrarian: high fear = buying opportunity | Yahoo Finance `^VIX` (`^VXN` for the Nasdaq 100) |
| Market Breadth (RSP/SPY 20-day spread) | 10 | Confirmatory: broad participation is bullish | Yahoo Finance `RSP`, `SPY` (`QQEW`, `QQQ`) |
| SPY 14-day RSI | 10 | Contrarian: extreme momentum reverts | Computed from Yahoo `SPY` closes |
| S&P vs 200-day MA | 10 | State: far below = buy zone; far above = strong trend | Computed from Yahoo `^GSPC` |
| S&P vs 50-day MA | 5 | State: shorter-term version of the above | Computed from Yahoo `^GSPC` |
| % of Stocks Above 200 MA | 20 | Breadth: broad participation = bullish; extreme washout = contrarian buy | ~100 large caps via Yahoo Finance (daily) |
| % of Stocks Above 50 MA | 5 | Breadth: shorter-term participation | Same universe (daily) |
| Junk Bond Demand (HYG/LQD spread) | 10 | Confirmatory: risk-on credit = bullish | Yahoo Finance `HYG`, `LQD` |
| 10Y-2Y Yield Spread | 5 | Leading: inverted curve = recession warning; steep = healthy expansion | Treasury.gov daily par yields |
| Sector Oscillator | 10 | Momentum of sector advances vs declines (McClellan-style) | Computed from the 11 SPDR sector ETFs |
| 5-day Rate of Change | 10 | Short-term momentum of the index | Computed from Yahoo `^GSPC` |
| Sector Rotation Regime | 10 | Cyclical vs defensive sector leadership | Computed from the 11 SPDR sector ETFs |

Retired: AAII retail sentiment (2026-08, no free source) and NAAIM manager exposure (2026-11, NAAIM went subscription-only on 2026-08-01 and the public feed froze at 2026-07-29).

## Files

- `index.html` — Main dashboard (BATS gauge + components + backtest)
- `markets.html` — Charts, technical summary, market news
- `indicators/*.html` — Per-component explainer pages
- `app.js` — Component definitions, scoring functions, gauge rendering, live-data loader
- `backtest.js` — Standalone + blended backtest engine
- `styles.css` — All styling
- `data/*.csv` — Historical daily data (auto-updated by GitHub Actions)
- `.github/workflows/update-data.yml` — Daily update robot
- `scripts/update-data.sh` — Fetch + refresh logic used by the workflow

## Run locally

The site fetches CSV files at runtime, so opening `index.html` via `file://`
won't work — use any tiny local server:

```bash
python -m http.server   # any port; opens on http://localhost:8000
```

VS Code's Live Server extension works too.

## Deployment

Auto-deployed to Vercel on every push to `main`. The daily update workflow
runs weekdays at 23:30 UTC (~7:30pm ET during DST), commits fresh market data,
and Vercel redeploys within a minute — bats.co reflects the new close.

## Disclaimer

For informational purposes only. Not investment advice. Historical patterns
are not guarantees.
