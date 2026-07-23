# worst-pri-product 🔥

A deliberately, comedically **unreliable** customer-analytics webapp. It has a
frontend, a backend, and an "AI model" that analyzes customer data — and it is
engineered to fail in the maximum number of confusing ways, so it reliably
generates support tickets.

> This is a parody / teaching demo about reliability anti-patterns. Don't point
> real customers at it — that's the joke.

## Stack
- **Frontend** — `frontend/index.html` (vanilla JS, no error handling, race conditions)
- **Backend** — `backend/server.js` (Express)
- **AI model** — `backend/ai_model.js` (a random number generator with a thesaurus)
- **"Database"** — `backend/db.js` (in-memory Map that loses data on purpose)
- **Chaos engine** — `backend/chaos.js` (random latency, random HTTP errors, corrupted JSON)

## Run it (needs Node 18+)
```bash
npm install
npm start
```
Then open http://localhost:3000

## Crank the chaos
`CHAOS_LEVEL` is 0–10 (default 5):
```bash
CHAOS_LEVEL=0  npm start   # boringly reliable
CHAOS_LEVEL=10 npm start   # production is on fire (~100+ tickets/day)
PORT=4000 CHAOS_LEVEL=8 npm start
```

## The one honest endpoint
`GET /api/metrics` reports the real KPI — how many "tickets" the app has earned
and the projected daily rate. Watch it climb.

## Anti-patterns on display (the actual lesson)
| What it does | Real-world ticket it generates |
|---|---|
| Random 500/503/418/402/429 responses | "The site is broken / down" |
| Random multi-second latency | "It's so slow" |
| Returns `null` on a "200 OK" | "My data disappeared" |
| Returns corrupted JSON | white-screen frontend crash |
| DB silently drops ~20% of writes | "I saved it but it's gone" |
| `get(id)` returns the wrong customer 15% of the time | privacy / data-leak report |
| AI model is non-deterministic | "Why did my score change?!" |
| AI model contradicts itself (churn 90% + retention 90%) | "Which number do I trust?" |
| Health check always says "healthy" | on-call has no idea anything's wrong |
| Frontend has no retry / error boundaries | one blip = broken page |

Flip `CHAOS_LEVEL=0` and read the code to see how each line would be fixed. That's the point.

## The Anti-Pattern Museum (15 supportability categories, all violated)

`GET /api/museum` returns this catalog live. Each exhibit is a deliberate violation
of a supportability-scanner category — a bug-to-ticket map. Source: `backend/antipatterns.js`
(+ `Dockerfile`, `k8s/deployment.yaml`).

| # | Category | Exhibit | Try it |
|---|---|---|---|
| 1 | API Observability | Blind logging, swallowed errors, **no Correlation/Reference ID** (`requestId: "lost"`) | any error response |
| 2 | Service Resilience | **Silent cache** fallback: Redis "fails", swallowed, slow DB path, no log/metric | `GET /api/customers/c-001/profile` (~2.5s, silent) |
| 3 | Data Integrity | **Blind writes** — raw JSON stored, no Zod/Joi, no idempotency key, no transaction | `POST /api/notes` |
| 4 | Traffic Management | **Unbounded in-memory array** (memory DoS), no rate limiting | `POST /api/notes` repeatedly |
| 5 | Async Messaging | **Fire-and-forget** events drop ~50% silently, no DLQ, no ack | `POST /api/events` |
| 6 | FinOps / IaC | `image: latest`, **no CPU/mem limits** ("Infinite Pod"), 50 replicas | `k8s/deployment.yaml` |
| 7 | Security Supportability | **Logs entire body incl. password + SSN**, hardcoded secrets, no PII masking | `POST /api/login` → check server stdout |
| 8 | KnowledgeOps | **Generic 500s** with no internal code; magic numbers; aged TODOs; dead code | `GET /api/order/1/status` |
| 9 | Config Hygiene | **Hardcoded URLs** (`http://localhost:8080`) instead of env | `backend/antipatterns.js` top |
| 10 | Database Performance | **N+1 queries** + `SELECT *` + no pagination | `GET /api/report` (gets slower with data) |
| 11 | Reliability | Infinite waits, **thundering-herd** retries (fixed 100ms, no backoff), **unbounded concurrency** | `POST /api/bulk-analyze {"ids":[...]}` |
| 12 | Timezone Trap | Expiry via `new Date()` **local time** — locks out Tokyo a day early | `GET /api/subscription/c-002` |
| 13 | Webhook Black Hole | `/webhooks/stripe` processes body **before (never) verifying** `stripe-signature` | `POST /webhooks/stripe` (no auth needed) |
| 14 | Zombie Feature Flag | Stale 2024 flag **randomly flips the UI** | `GET /api/flags` |
| 15 | Blind Jobs + No Graceful Shutdown | Background worker logs nothing, swallows crashes; **no SIGTERM handler** | `backend/antipatterns.js` |

Plus earlier bonus breaches: `POST /api/login` (any password = admin), `GET /api/debug`
(leaks fake secrets), `GET /api/search` (ignores your query), absurd response headers
(`Cache-Control: immutable` on errors, `X-Server-Mood: dissociating`).

> Every exhibit is commented with its `[Cat N]` tag in the source, and each maps to a
> real support-ticket class. Read it as a "what NOT to do" tour.
