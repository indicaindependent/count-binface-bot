# 🗑️ Count Binface Bot

An autonomous, news-aware, **humanized** Bluesky bot for a UK satirical political campaign persona — built entirely on the free Cloudflare edge.

> This is the open, sanitised reference implementation of a live bot that campaigns in-character as **Count Binface** in a 2026 UK by-election. It reads the news about itself each day, learns from it, and engages the community with human-like rhythm (never instant, never mechanical).

Live account: [@countbinface.osintnet.uk](https://bsky.app/profile/countbinface.osintnet.uk) · character parody / satire tribute.

---

## ✨ What makes it interesting

| Capability | How |
|---|---|
| **Self-learning news brain** | Once a day it web-searches the latest on its own campaign, distils the situation into a structured JSON "brain", and grounds every post in *real, current* facts — inventing nothing. |
| **In-character voice** | A single system prompt encodes the persona's voice, cornerstone pledge, and comedic rules ("punch up, never down"). |
| **Humanized engagement** | Ported anti-detection mechanics: **queue-then-drain**, random jitter between actions, quiet hours, daily caps, probabilistic skips, like-then-reply reciprocity. It behaves like a person, not a cron job. |
| **Self-healing** | If the news fetch fails it keeps the last-known brain and never goes silent; alerts the operator after repeated failures. |
| **Draft / auto modes** | Runs in `draft` (proposes posts to the operator) or `auto` (posts hands-free) with an instant kill switch. |
| **Zero paid infra** | Cloudflare Workers + Workers AI (Llama 3.3) for prose, KV for state, a reasoning endpoint for the daily brain. No servers, no databases to run. |

---

## 🧠 The humanized-engagement philosophy

Most bots are caught because they act **instantly**, on a **fixed interval**, and **reply to everything**. This bot does the opposite — the design principle is **latency + restraint**:

- **Queue-then-drain** — when it finds posts to engage, it *queues* them and drains only 1–2 per wake-up, oldest first (you reply to things you saw earlier).
- **Jitter** — a random 3–15s pause between every action.
- **Quiet hours** — silent overnight in the persona's local timezone. Humans sleep.
- **Probabilistic skips** — it ignores ~40% of eligible wake-ups so there's no detectable rhythm.
- **Daily caps** — a human-ish ceiling on posts/replies/likes per day.
- **Like-then-reply** — often likes a post before replying, like a real person.
- **Self-labelled** — the profile declares it's a parody/bot account (a Bluesky best practice).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full breakdown.

---

## 🚀 Quick start

1. Create a Bluesky account for your persona and generate an **app password**.
2. Create a Cloudflare Worker + a KV namespace.
3. Copy `wrangler.example.toml` → `wrangler.toml` and fill in your KV id.
4. Set the secrets (below) — **never commit them**.
5. `wrangler deploy`.
6. Hit `/refresh-brain` then `/tick?force=1` to smoke-test. Flip to auto with `/mode?v=auto`.

### Required secrets (Worker env)

| Secret | Purpose |
|---|---|
| `BINFACE_APP_PASS` | Bluesky app password |
| `CF_ACCOUNT_ID` | Cloudflare account id (for Workers AI) |
| `CF_WORKERS_AI_TOKEN` | Workers AI API token |
| `FABLE_BRAIN_SECRET` | Bearer for your reasoning/web-search endpoint |
| `ADMIN_SECRET` | Protects the admin endpoints |
| `BUMBOCLAAT_BOT_TOKEN` *(optional)* | Telegram bot token for operator alerts |
| `PETE_CHAT_ID` *(optional)* | Telegram chat id for operator alerts |

> The daily "brain" expects a small HTTP endpoint that accepts `{web_search, effort, system, prompt}` and returns `{text, model_used}`. Any LLM-with-web-search proxy works; swap `FABLE` in `worker.js` for yours.

---

## 🔌 Endpoints

| Route | Auth | Does |
|---|---|---|
| `GET /health` | public | status, mode, quiet-hour, daily counters |
| `GET /brain` | public | current distilled news brain (JSON) |
| `GET /queue` | public | number of queued engagement targets |
| `GET /tick?force=1` | admin | run an engagement cycle now |
| `GET /refresh-brain` | admin | force a news-brain refresh |
| `GET /mode?v=auto\|draft` | admin | switch autonomy mode |
| `GET /kill?v=1` | admin | emergency stop |

Admin routes require `?k=ADMIN_SECRET` or an `x-admin` header.

---

## ⚖️ Ethics & compliance

- **Self-labelled parody.** The account states it is a satire/parody tribute in its bio.
- **Punches up, never down.** The persona prompt forbids targeting vulnerable people.
- **No impersonation.** It's a clearly-labelled tribute to a public satirical character, not a real person's private identity.
- **Respects platform limits.** Runs far under Bluesky's rate limits by design.
- **No fabrication.** Posts are grounded in real, web-searched facts; the bot is instructed to invent nothing.

Use responsibly, and follow the [Bluesky bot guidelines](https://docs.bsky.app/docs/starter-templates/bots).

## License
MIT — see [LICENSE](LICENSE).
