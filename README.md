# BATS.CO — Benchmark Asset and Trend Scenarios

A single, transparent market sentiment indicator (the **BATS**) that answers a
simple question: **"Is now a good time to buy stocks?"**

The BATS blends widely-used public market indicators into a 0–100 score across
seven buckets — Very Oversold, Oversold, Slightly Bearish, Neutral, Slightly
Bullish, Bullish, Very Bullish. Every component is documented and independently
backtested against S&P 500 forward returns.

Live at **[bats.co](https://bats.co)**.

## Current components

| Component | Weight | Direction | Data source |
|---|---|---|---|
| VIX | 45% | Contrarian: high fear = buying opportunity | datasets/finance-vix |
| Market Breadth (RSP/SPY spread) | 25% | Confirmatory: broad participation is bullish | Yahoo Finance `RSP`, `SPY` |
| SPY 14-day RSI | 20% | Contrarian: extreme momentum reverts | Computed from Yahoo `SPY` closes |
| Junk Bond Demand (HYG/LQD spread) | 10% | Confirmatory: risk-on credit = bullish | Yahoo Finance `HYG`, `LQD` |

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
