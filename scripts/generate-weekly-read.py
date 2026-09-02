#!/usr/bin/env python3
"""
Generate the "This Week's Read" editorial paragraph via Claude Haiku.

Loads the latest BATS reading + a short menu of grounding facts (trend,
key components, historical anchors) from the same data files the site
renders from, packages them into a compact prompt, asks Claude for a
2-paragraph plain-English take, and writes the result to
data/this_week.md with the current date as the header.

The prompt intentionally keeps the LLM inside a tight lane: it gets the
numbers but is instructed to (a) stick to what those numbers say, (b)
end with the standard italic disclaimer + Signal Testing link, and (c)
write in the same understated voice the site uses everywhere else.

Fired weekly by .github/workflows/generate-weekly-read.yml (Friday
after the close). Requires ANTHROPIC_API_KEY as an environment variable
(set as a GitHub Actions secret).

Cost: single message per week, Haiku 4.5, ~$0.001 per run.
Safe on failure: if the API call fails or the response is empty, the
existing this_week.md is left untouched.
"""
from __future__ import annotations
import csv
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import date, datetime

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR  = os.path.join(REPO_ROOT, "data")
OUT_PATH  = os.path.join(DATA_DIR, "this_week.md")

ANTHROPIC_URL   = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"
ANTHROPIC_VER   = "2023-06-01"


# --------------------------- data loading ---------------------------------
def load_date_close(path: str, close_col: int = 1) -> list[tuple[str, float]]:
    rows: list[tuple[str, float]] = []
    with open(path, encoding="utf-8") as f:
        r = csv.reader(f)
        next(r, None)
        for parts in r:
            if len(parts) <= close_col:
                continue
            try:
                v = float(parts[close_col])
            except ValueError:
                continue
            if parts[0]:
                rows.append((parts[0], v))
    return rows


def load_bats_history() -> dict:
    with open(os.path.join(DATA_DIR, "bats_history.json"), encoding="utf-8") as f:
        return json.load(f)


# --------------------------- bucket lookup --------------------------------
# Keep in sync with BUCKETS in app.js — but for the weekly read we only
# need the label + rough guidance, not colors/subtitles.
BUCKETS = [
    (0,  "Extremely Oversold", "Aggressive Buy"),
    (15, "Very Oversold",      "Strong Buy"),
    (18, "Oversold",           "Consider Buying"),
    (32, "Slightly Bearish",   "Be Careful"),
    (45, "Neutral",            "No Real Trend"),
    (57, "Slightly Bullish",   "Hold"),
    (65, "Bullish",            "Hold, But Be Careful"),
    (72, "Extended",           "Trim / Rebalance Stretched Positions"),
]


def bucket_for(score: float) -> tuple[str, str]:
    s = max(0.0, min(100.0, score))
    for i in range(len(BUCKETS) - 1, -1, -1):
        if s >= BUCKETS[i][0]:
            return BUCKETS[i][1], BUCKETS[i][2]
    return BUCKETS[0][1], BUCKETS[0][2]


# --------------------------- moving averages ------------------------------
def sma(closes: list[float], period: int) -> float | None:
    if len(closes) < period:
        return None
    return sum(closes[-period:]) / period


def pct(a: float, b: float) -> float:
    return (a / b - 1) * 100 if b else 0.0


# --------------------------- context building -----------------------------
def build_context() -> dict:
    hist_wrap = load_bats_history()
    hist = hist_wrap.get("history", [])
    if not hist or len(hist) < 65:
        raise RuntimeError("bats_history.json is too short to build a weekly read")

    def bats_at(back: int) -> tuple[str, float] | None:
        # walk back `back` trading days from the latest row, tolerating a
        # small data gap the same way app.js does for the historical strip
        target = len(hist) - 1 - back
        for extra in range(0, 6):
            i = target - extra
            if i < 0:
                return None
            d, v = hist[i]
            if v is not None:
                return d, v
        return None

    latest = bats_at(0)
    prev   = bats_at(1)
    wk     = bats_at(5)
    mo     = bats_at(21)
    q3     = bats_at(63)

    if not latest:
        raise RuntimeError("no latest BATS row")

    latest_date, latest_score = latest

    # SPX trend context
    spx_rows = load_date_close(os.path.join(DATA_DIR, "spx.csv"))
    spx = [c for _, c in spx_rows]
    spx_latest = spx[-1]
    sma50  = sma(spx, 50)
    sma200 = sma(spx, 200)

    # 20d, 60d, YTD % moves
    ret_5d  = pct(spx[-1], spx[-6])  if len(spx) >= 6  else None
    ret_20d = pct(spx[-1], spx[-21]) if len(spx) >= 21 else None
    ret_60d = pct(spx[-1], spx[-61]) if len(spx) >= 61 else None
    ytd_ref_date = f"{int(latest_date[:4])}-01-01"
    ytd_start = next((c for d, c in spx_rows if d >= ytd_ref_date), spx[0])
    ret_ytd = pct(spx[-1], ytd_start)

    # Simple components: VIX + junk demand + %above200
    def last_close(path: str) -> float | None:
        rows = load_date_close(os.path.join(DATA_DIR, path))
        return rows[-1][1] if rows else None

    vix_now = last_close("vix.csv")
    pct200_now = None
    try:
        rows = load_date_close(os.path.join(DATA_DIR, "pct_above_200ma.csv"))
        pct200_now = rows[-1][1] if rows else None
    except FileNotFoundError:
        pass

    hyg_rows = load_date_close(os.path.join(DATA_DIR, "hyg.csv"))
    lqd_rows = load_date_close(os.path.join(DATA_DIR, "lqd.csv"))
    junk_spread = None
    if len(hyg_rows) >= 21 and len(lqd_rows) >= 21:
        hy = pct(hyg_rows[-1][1], hyg_rows[-21][1])
        lq = pct(lqd_rows[-1][1], lqd_rows[-21][1])
        junk_spread = hy - lq

    def fmt_bats(rec: tuple[str, float] | None) -> str:
        if not rec:
            return "n/a"
        d, v = rec
        label, _ = bucket_for(v)
        return f"{round(v)} ({label})"

    return {
        "latest_date":  latest_date,
        "bats_now":     round(latest_score),
        "bats_bucket":  bucket_for(latest_score)[0],
        "bats_action":  bucket_for(latest_score)[1],
        "bats_prev":    fmt_bats(prev),
        "bats_1w":      fmt_bats(wk),
        "bats_1m":      fmt_bats(mo),
        "bats_3m":      fmt_bats(q3),
        "spx_price":    round(spx_latest, 2),
        "spx_vs_50":    round(pct(spx_latest, sma50),  2) if sma50  else None,
        "spx_vs_200":   round(pct(spx_latest, sma200), 2) if sma200 else None,
        "spx_5d":       round(ret_5d,  2) if ret_5d  is not None else None,
        "spx_20d":      round(ret_20d, 2) if ret_20d is not None else None,
        "spx_60d":      round(ret_60d, 2) if ret_60d is not None else None,
        "spx_ytd":      round(ret_ytd, 2),
        "vix":          round(vix_now, 2) if vix_now else None,
        "pct200":       round(pct200_now, 1) if pct200_now is not None else None,
        "junk_spread":  round(junk_spread, 2) if junk_spread is not None else None,
    }


# --------------------------- prompt ---------------------------------------
SYSTEM_PROMPT = """You are the market editorialist for BATS.CO, a public market-sentiment site.
Every Friday after the US close, you write ONE plain-English take (2 short paragraphs) on
where the BATS gauge sits and what practical posture that implies.

VOICE GUIDELINES — match these exactly:
- Understated, not breathless. Never use words like "brutal," "crash," "surge," "explode."
- No investment advice. This is context, not a call to action.
- Concrete numbers only when they support the point. Never over-cite.
- Speak to a smart individual investor who owns index funds — not a trader, not an institution.
- Do NOT recommend specific securities, sectors, or trades.
- Two paragraphs. First paragraph: where the reading sits + what supports/undercuts it.
  Second paragraph: the practical read (stay-invested / patient / cautious / etc.), grounded
  in historical distribution of forward returns.

FORMAT — must match exactly:
- Use markdown: **bold** for the key claim(s) in each paragraph, *italics* for the disclaimer.
- End with EXACTLY this italic footer, verbatim (paragraph on its own line):
  *This is a plain-English take, not investment advice. See the [Signal Testing](signal-testing.html) page for the full backtest that grounds these numbers.*
- Output ONLY the two body paragraphs + the italic footer. No headers, no "date:" line, no meta commentary.

HISTORICAL ANCHORS you can reference (from our own backtest):
- BATS below 30 has averaged +22% forward 12mo, ~100% positive hit rate.
- BATS between 30-45 averages +12% forward 12mo.
- BATS between 45-65 averages +9% forward 12mo (baseline).
- BATS between 65-72 averages +11% forward 12mo.
- BATS above 72 (Extended) has averaged only +10.5% forward 12mo — extremes are what matter.
"""


USER_PROMPT_TEMPLATE = """Write this Friday's read. Latest close: {latest_date}.

Current BATS: {bats_now}/100 — {bats_bucket} ({bats_action})

BATS trajectory:
- Previous close: {bats_prev}
- 1 week ago:    {bats_1w}
- 1 month ago:   {bats_1m}
- 3 months ago:  {bats_3m}

S&P 500 trend context:
- Price: {spx_price}
- vs 50-day MA: {spx_vs_50}%
- vs 200-day MA: {spx_vs_200}%
- 5-day return: {spx_5d}%
- 20-day return: {spx_20d}%
- 60-day return: {spx_60d}%
- YTD return: {spx_ytd}%

Key components right now:
- VIX: {vix}
- % of large-caps above their 200-day MA: {pct200}%
- 20-day HYG-LQD spread (junk demand): {junk_spread}%

Write the two-paragraph take now."""


# --------------------------- API call -------------------------------------
def call_claude(system: str, user: str, api_key: str) -> str:
    body = json.dumps({
        "model": ANTHROPIC_MODEL,
        "max_tokens": 700,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }).encode("utf-8")
    req = urllib.request.Request(
        ANTHROPIC_URL,
        data=body,
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VER,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        payload = json.loads(r.read().decode("utf-8"))
    # Claude returns { content: [{ type:"text", text:"..." }, ...] }
    parts = payload.get("content", [])
    text = "".join(p.get("text", "") for p in parts if p.get("type") == "text")
    return text.strip()


def main() -> int:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        print("::error::ANTHROPIC_API_KEY not set — skipping weekly read generation.")
        return 1

    try:
        ctx = build_context()
    except Exception as e:
        print(f"::error::Failed to build context: {e}")
        return 1

    user_prompt = USER_PROMPT_TEMPLATE.format(**ctx)

    try:
        body = call_claude(SYSTEM_PROMPT, user_prompt, api_key)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:400]
        print(f"::error::Anthropic HTTP {e.code}: {detail}")
        return 1
    except Exception as e:
        print(f"::error::Anthropic call failed: {e}")
        return 1

    if not body or len(body) < 100:
        print(f"::error::Response too short ({len(body)} chars); leaving file untouched.")
        return 1

    today = date.today().isoformat()
    out = f"date: {today}\n\n{body}\n"
    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)
    print(f"Wrote {OUT_PATH} ({len(body)} body chars, latest_date={ctx['latest_date']}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
