# Architecture

## Overview

```
        ┌──────────────────────────────────────────────┐
        │  Cloudflare Worker (binface-bot)             │
        │                                              │
  cron ─┤  scheduled() ──► runTick()                   │
  6×/day│                    │                          │
        │      ┌─────────────┼───────────────┐         │
        │      ▼             ▼               ▼          │
        │  refreshBrain   maybeFeedPost   harvest+      │
        │  (1×/day)       (in AM window)  drainQueue    │
        │      │             │               │          │
        │      ▼             ▼               ▼          │
        │   KV brain      Bluesky post    Bluesky       │
        │                                 like+reply    │
        └───────┬───────────────┬──────────────┬───────┘
                │               │              │
                ▼               ▼              ▼
        Reasoning endpoint  Workers AI     Bluesky XRPC
        (web-search brain)  (Llama 3.3)    (atproto)
```

## The daily "news brain"

Once per day the worker calls a reasoning endpoint with web search enabled and a strict JSON contract:

```json
{
  "phase": "campaign",
  "election_date": "2026-08-13",
  "days_to_election": "35",
  "winner": null,
  "binface_update": "one crisp sentence about the persona today",
  "farage_update": "one crisp sentence about the opponent today",
  "hot_topics": ["3-5 live storylines"],
  "sentiment_on_binface": "one sentence",
  "safe_facts": ["4-6 VERIFIED facts"],
  "suggested_angle": "sharpest in-character angle today"
}
```

That object is cached in KV (`brain:latest` + a 90-day dated snapshot). Every post and reply is generated with this context injected, so the bot is always grounded in *today's* reality and instructed to invent nothing beyond it.

**Winner recognition:** when `winner` is populated, the bot reacts in-character to the declared result.

## Humanized engagement (queue-then-drain)

The core anti-detection idea is that a real person acts with **latency and restraint**.

1. **Harvest** — each wake-up, search for relevant posts (persona name, race, key phrases).
2. **Enqueue** — new targets are stored in KV (`q:<uri>`) with an 8h TTL. Nothing is acted on immediately.
3. **Drain** — a *separate* step fires only 1–2 replies per wake-up, oldest-first, and only on ~60% of wake-ups (probabilistic skip).
4. **Jitter** — `humanPause(3–15s)` between every network action.
5. **Reciprocity** — ~80% of the time it likes a post before replying.
6. **Caps** — daily ceilings on replies and likes; a hard per-tick cap prevents bursts.
7. **Quiet hours** — no engagement overnight in the persona's timezone.

Dedup keys (`re:<uri>`) guarantee it never replies to the same post twice.

## Facets (clickable hashtags)

Bluesky requires **richtext facets** with **UTF-8 byte offsets** for hashtags to be clickable.

A common bug: a naive regex like `/#([A-Za-z]\w*)/` requires the first character after `#` to be a letter, so a tag like `#99pFlake` (digit-leading) silently never faceted. The correct pattern allows digits as long as there's at least one letter:

```js
/#([0-9A-Za-z_]*[A-Za-z][0-9A-Za-z_]*)/g
```

(Bluesky rejects all-numeric tags, so requiring ≥1 letter is correct.) Byte offsets are computed with `TextEncoder`, not string indices.

## Modes & safety

- `draft` — proposes a feed post + reply drafts to the operator (e.g. via Telegram); posts nothing.
- `auto` — posts hands-free, sending the operator a receipt after each action.
- `kill` — an emergency KV flag that halts all activity instantly.

## Why the edge

Everything runs on Cloudflare Workers + KV + Workers AI. No servers to patch, no database to run, and it stays comfortably within free/cheap tiers. The only external dependency is a small LLM-with-web-search endpoint for the daily brain, which can be any provider.
