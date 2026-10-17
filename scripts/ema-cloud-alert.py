#!/usr/bin/env python3
"""
EMA cloud alert (personal): watches QQQ on 60-minute bars and sends a
message to your phone when the Ripster-style cloud rule flips.

The rule (the indicator author's own guidance, made mechanical):
  * two clouds on regular-session 60-minute closes: the fast 5/12 EMA pair
    and the 34/50 EMA "bias" pair
  * LONG when the close is above the 34/50 cloud (above both of its EMAs)
    and the fast cloud is bullish (EMA 5 above EMA 12)
  * CASH when the fast cloud turns bearish (EMA 5 below EMA 12) or the close
    falls below the 34/50 cloud (below both of its EMAs)
  * otherwise keep the previous state (price inside the bias cloud with the
    fast cloud still up, for example)
Only completed bars count; the bar still in progress is ignored.

Backtested 2026-10-16 on two years of 60-minute bars: about 10%/yr against
23.6% for holding QQQ, worst drop -13% vs -23%, 60 trades a year, one in
three winning. It is a tone, not an edge; this exists because the owner
wants the flips on his phone for his own trading.

State lives in data/ema_cloud_state.json (the workflow commits it) so each
run knows what the last message said. Channels, each used only when its
secrets are set as environment variables:
  NTFY_TOPIC                                  push notification via ntfy.sh (free, no account)
  TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM ALERT_TO_PHONE   a real text message
  SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS ALERT_EMAIL_TO           e-mail (a carrier's e-mail-to-text address works too)

Options: --dry-run (compute and print, send nothing, write nothing)
         --test    (send the current state right now, to check the phone channel)
Always exits 0.
"""

from __future__ import annotations
import base64
import json
import os
import smtplib
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from zoneinfo import ZoneInfo

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
STATE_PATH = os.path.join(REPO_ROOT, "data", "ema_cloud_state.json")
SYMBOLS = [s.strip().upper() for s in os.environ.get("EMA_CLOUD_SYMBOLS", "QQQ").split(",") if s.strip()]
ET = ZoneInfo("America/New_York")
UA = {"User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                     "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")}
FAST, SLOW, BIAS_A, BIAS_B = 5, 12, 34, 50
WARMUP = 150                      # bars before the first state is trusted (the 50 EMA needs ~3x its length)
DRY = "--dry-run" in sys.argv
TEST = "--test" in sys.argv


try:                       # Windows consoles may not be UTF-8; never let a log line crash the run
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------- data ----
def fetch_hourly(sym: str) -> list[dict]:
    """Completed regular-session 60-minute bars: [{t (ET datetime), close}]."""
    url = (f"https://query2.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}"
           f"?interval=60m&range=730d&includePrePost=false")
    last_err = None
    for attempt in (1, 2, 3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                res = json.load(r)["chart"]["result"][0]
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(3 * attempt)
    else:
        raise RuntimeError(f"{sym}: Yahoo fetch failed ({last_err})")
    ts, closes = res["timestamp"], res["indicators"]["quote"][0]["close"]
    now = datetime.now(timezone.utc)
    bars = []
    for t, c in zip(ts, closes):
        if not c:
            continue
        start = datetime.fromtimestamp(t, tz=timezone.utc).astimezone(ET)
        hm = start.hour * 60 + start.minute
        if hm < 9 * 60 + 30 or hm >= 16 * 60:
            continue                                   # regular session only
        bars.append({"t": start, "close": float(c)})
    # drop the bar still in progress: a bar is done once the next one has started
    # or the clock has passed its end (16:00 for the last bar of the day)
    if bars:
        last = bars[-1]
        end = min(last["t"] + timedelta(minutes=60), last["t"].replace(hour=16, minute=0, second=0, microsecond=0))
        if now < end.astimezone(timezone.utc):
            bars.pop()
    return bars


def ema(xs: list[float], n: int) -> list[float]:
    k, out, e = 2 / (n + 1), [], None
    for x in xs:
        e = x if e is None else x * k + e * (1 - k)
        out.append(e)
    return out


def evaluate(bars: list[dict]) -> dict:
    """State at the latest completed bar, with how it got there."""
    closes = [b["close"] for b in bars]
    e5, e12, e34, e50 = ema(closes, FAST), ema(closes, SLOW), ema(closes, BIAS_A), ema(closes, BIAS_B)
    state, since_i, reason = "CASH", 0, ""
    for i in range(len(bars)):
        c = closes[i]
        above = c > max(e34[i], e50[i])
        below = c < min(e34[i], e50[i])
        fast_up = e5[i] > e12[i]
        new, why = None, ""
        if above and fast_up:
            new, why = "LONG", "price above the 34/50 cloud and the 5/12 cloud up"
        elif not fast_up:
            new, why = "CASH", "the 5/12 cloud turned down"
        elif below:
            new, why = "CASH", "price fell below the 34/50 cloud"
        if new is not None and new != state:
            state, since_i, reason = new, i, why
    i = len(bars) - 1
    return {
        "state": state, "reason": reason,
        "since": bars[since_i]["t"].isoformat(), "sincePrice": round(closes[since_i], 2),
        "bar": bars[i]["t"].isoformat(), "close": round(closes[i], 2),
        "ema5": round(e5[i], 2), "ema12": round(e12[i], 2), "ema34": round(e34[i], 2), "ema50": round(e50[i], 2),
        "fastCloudUp": e5[i] > e12[i], "aboveBias": closes[i] > max(e34[i], e50[i]), "belowBias": closes[i] < min(e34[i], e50[i]),
        "bars": len(bars),
    }


# ------------------------------------------------------------ messages ----
def fmt_when(iso: str) -> str:
    d = datetime.fromisoformat(iso).astimezone(ET)
    return d.strftime("%-I:%M %p ET, %a %b %-d") if os.name != "nt" else d.strftime("%I:%M %p ET, %a %b %d").lstrip("0")


def build_message(sym: str, now: dict, prev: dict | None, first: bool) -> tuple[str, str]:
    """(title, body) for a flip (or the first run / --test)."""
    # The title travels as an HTTP header for ntfy, which allows plain ASCII
    # only; the arrow goes in the body, where any character is fine.
    arrow = "▲" if now["state"] == "LONG" else "▼"
    title = f"{sym} 60-min cloud: {now['state']}"
    lines = [f"{arrow} {now['state']} at ${now['close']:,.2f}, {fmt_when(now['bar'])}", now["reason"].capitalize() + "."]
    if prev and prev.get("state") != now["state"] and prev.get("sincePrice"):
        chg = now["close"] / prev["sincePrice"] - 1
        if prev["state"] == "LONG":
            lines.append(f"That long ran from ${prev['sincePrice']:,.2f} ({chg:+.1%}).")
        else:
            lines.append(f"Was in cash since ${prev['sincePrice']:,.2f} ({chg:+.1%} missed).")
    if first:
        lines.append(f"(Alert is live. {now['state']} since {fmt_when(now['since'])}.)")
    return title, "\n".join(lines)


def send_ntfy(title: str, body: str) -> bool:
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    if not topic:
        return False
    safe_title = title.encode("ascii", "ignore").decode()      # headers must be plain ASCII
    tags = "arrow_up,chart_with_upwards_trend" if "LONG" in title else "arrow_down,chart_with_downwards_trend"
    req = urllib.request.Request(f"https://ntfy.sh/{urllib.parse.quote(topic)}", data=body.encode("utf-8"),
                                 headers={"Title": safe_title, "Priority": "high", "Tags": tags})
    with urllib.request.urlopen(req, timeout=30) as r:
        log(f"ntfy: HTTP {r.status}")
    return True


def send_twilio(title: str, body: str) -> bool:
    sid, tok = os.environ.get("TWILIO_ACCOUNT_SID", "").strip(), os.environ.get("TWILIO_AUTH_TOKEN", "").strip()
    frm, to = os.environ.get("TWILIO_FROM", "").strip(), os.environ.get("ALERT_TO_PHONE", "").strip()
    if not (sid and tok and frm and to):
        return False
    data = urllib.parse.urlencode({"To": to, "From": frm, "Body": f"{title}\n{body}"}).encode()
    auth = base64.b64encode(f"{sid}:{tok}".encode()).decode()
    req = urllib.request.Request(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json", data=data,
                                 headers={"Authorization": f"Basic {auth}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        log(f"twilio: HTTP {r.status}")
    return True


def send_email(title: str, body: str) -> bool:
    host, user, pw, to = (os.environ.get(k, "").strip() for k in ("SMTP_HOST", "SMTP_USER", "SMTP_PASS", "ALERT_EMAIL_TO"))
    if not (host and user and pw and to):
        return False
    port = int(os.environ.get("SMTP_PORT", "587"))
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = title, user, to
    msg.set_content(body)
    if port == 465:
        with smtplib.SMTP_SSL(host, port, timeout=30) as s:
            s.login(user, pw); s.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=30) as s:
            s.starttls(); s.login(user, pw); s.send_message(msg)
    log(f"email: sent to {to.split('@')[0][:2]}***")
    return True


def send_all(title: str, body: str) -> int:
    sent = 0
    for fn in (send_ntfy, send_twilio, send_email):
        try:
            sent += bool(fn(title, body))
        except Exception as e:  # noqa: BLE001
            log(f"::warning::{fn.__name__} failed: {e}")
    if not sent:
        log("::warning::no phone channel is configured (set NTFY_TOPIC, the Twilio secrets or the SMTP secrets); message not sent")
    return sent


# ---------------------------------------------------------------- main ----
def main() -> int:
    try:
        stored = json.load(open(STATE_PATH, encoding="utf-8")) if os.path.exists(STATE_PATH) else {}
    except Exception:  # noqa: BLE001
        stored = {}
    changed = False
    for sym in SYMBOLS:
        try:
            bars = fetch_hourly(sym)
        except Exception as e:  # noqa: BLE001
            log(f"::warning::{sym}: {e}; will try again next run")
            continue
        if len(bars) < WARMUP:
            log(f"::warning::{sym}: only {len(bars)} bars; need {WARMUP}")
            continue
        now = evaluate(bars)
        prev = stored.get(sym)
        first = prev is None
        new_bar = first or prev.get("bar") != now["bar"]
        flipped = (not first) and prev.get("state") != now["state"]
        log(f"{sym}: {now['state']} since {fmt_when(now['since'])} (${now['sincePrice']}); latest bar {fmt_when(now['bar'])} "
            f"close ${now['close']} | EMA5 {now['ema5']} EMA12 {now['ema12']} | cloud 34/50 {now['ema34']}-{now['ema50']}"
            f" | {'FLIP' if flipped else 'no change'}{' | first run' if first else ''}{'' if new_bar else ' | no new bar'}")
        if DRY:
            title, body = build_message(sym, now, prev, first)
            log("--- would send ---\n" + title + "\n" + body + "\n------------------")
            continue
        if flipped or first or TEST:
            title, body = build_message(sym, now, prev, first)
            send_all(title, body)
        if new_bar or flipped or first:
            record = dict(now)
            record["lastChecked"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            hist = (prev or {}).get("history", [])
            if flipped or first:
                hist = (hist + [{"state": now["state"], "at": now["since"], "price": now["sincePrice"], "reason": now["reason"]}])[-40:]
            record["history"] = hist
            stored[sym] = record
            changed = True
    if changed and not DRY:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        with open(STATE_PATH, "w", encoding="utf-8", newline="\n") as f:
            json.dump(stored, f, indent=1, sort_keys=True)
        log("state written")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — never fail the workflow
        log(f"::warning::ema-cloud-alert.py failed ({e})")
        sys.exit(0)
