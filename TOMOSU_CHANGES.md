# Tomosu Reliability Scan — Accepted Recommendations

**Repository:** `worst-pri-product`
**Branch:** `main` (uncommitted working-tree changes)
**Date recorded:** 2026-07-25
**Baseline commit:** `5f02173` — _Improve supportability: structured logs, graceful shutdown, safer auth_

This document captures the before/after code for every Tomosu recommendation accepted into
the local working tree, with the category and description for each.

## Provenance note — read this first

Categories below are drawn from Tomosu's official `context` vocabulary
(`tomosu-mcp-reference.md`). The five findings that carry an inline `[tomo-id-NNN]` marker in
the accepted code are anchored to a real Tomosu finding ID.

However, **no saved scan report exists for this repo** — there is no
`claude_skill_files/documents/worst-pri-product/` output directory and no `mcp__tomosu__*`
calls recorded in the session transcripts. That means Tomosu's *verbatim* description and
severity strings could not be recovered. Each entry is therefore tagged:

- **`[anchored]`** — finding ID present in the code; category/description reconstructed from the change itself.
- **`[reconstructed]`** — no finding ID in the code; the change is Tomosu-shaped but the finding it maps to is inferred.

To replace the reconstructed text with Tomosu's authoritative wording, re-run
`/reliability-scan https://github.com/vgiri2015/worst-pri-product` and pull the categories and
descriptions from the scan report.

---

## Summary

| # | ID | File | Category | Severity | Recommendation | Provenance |
|---|----|------|----------|----------|----------------|------------|
| 1 | — | `backend/antipatterns.js` | `state_volatility` | high | Bound the unbounded in-memory notes array | reconstructed |
| 2 | `tomo-id-016` | `backend/antipatterns.js` | `logs` | high | Log the swallowed cache failure before the slow fallback | anchored |
| 3 | `tomo-id-017` | `backend/antipatterns.js` | `security` | critical | Require a Stripe signature before accepting webhook orders | anchored |
| 4 | — | `backend/antipatterns.js` | `traffic_management` | high | Cap and serialize bulk analysis fan-out | reconstructed |
| 5 | `tomo-id-018` | `backend/chaos.js` | `observability` | medium | Log injected chaos failures so they're distinguishable from real ones | anchored |
| 6 | `tomo-id-019` | `backend/load_generator.js` | `service_resilience` | high | Add a timeout and structured error log to metrics polling | anchored |
| 7 | `tomo-id-020` | `run.sh` | `logs` | low | Replace the prose startup banner with a structured log line | anchored |
| 8 | — | `backend/db.js` | `data_integrity` | medium | Truncate unbounded string fields on upsert | reconstructed |
| 9 | — | `backend/server.js` | `user_facing_diagnostics` | high | Stop returning 201 for invalid customer payloads | reconstructed |
| 10 | — | `backend/worst_features.js` | `security` | critical | Gate the environment-leaking debug endpoint | reconstructed |
| 11 | — | `backend/ai_model.js` | `support_agent_readiness` | low | State that model confidence is not a calibrated probability | reconstructed |

**Totals:** 11 accepted recommendations across 8 files — 60 insertions, 38 deletions.

---

## 1. Bound the unbounded in-memory notes array `[reconstructed]`

- **File:** `backend/antipatterns.js:59`
- **Category:** `state_volatility`
- **Severity:** high

**Description.** `POST /api/notes` pushed the raw request body into a module-level array with no
type check and no upper bound. Any client could grow the array until the process OOM'd, and a
non-object body (string, array, `null`) would be stored and later break every consumer of
`GET /api/notes`. Unbounded process-local state is not recoverable by support — the only remedy
is a restart, which discards every note.

**Before**
```js
router.post('/api/notes', (req, res) => {
  // Raw JSON straight into memory. Whatever you send, however big. Enjoy.
  NOTES.push(req.body);
  res.json({ ok: true, totalNotesInMemory: NOTES.length, warning: 'This array has no upper bound.' });
});
```

**After**
```js
router.post('/api/notes', (req, res) => {
  const maxNotes = Number(process.env.MAX_NOTES_IN_MEMORY || 1000);
  const note = req.body;
  if (!note || typeof note !== 'object' || Array.isArray(note)) {
    return res.status(400).json({ error: 'ERR_INVALID_NOTE_PAYLOAD', message: 'Note creation failed: request body must be a JSON object. Action: send an object payload and retry.', requestId: req.requestId || null });
  }
  if (NOTES.length >= maxNotes) {
    return res.status(503).json({ error: 'ERR_NOTES_CAPACITY_EXCEEDED', message: 'Note creation temporarily unavailable: in-memory note capacity is full. Action: retry later or reduce load.', requestId: req.requestId || null });
  }
  NOTES.push({ ...note, storedAt: new Date().toISOString() });
  res.json({ ok: true, totalNotesInMemory: NOTES.length, maxNotesInMemory: maxNotes });
});
```

**What changed.** Added a configurable ceiling (`MAX_NOTES_IN_MEMORY`, default 1000) returning
`503 ERR_NOTES_CAPACITY_EXCEEDED`, a payload type guard returning `400 ERR_INVALID_NOTE_PAYLOAD`,
and a `storedAt` timestamp for support triage. The response now advertises the limit instead of
warning that none exists.

---

## 2. Log the swallowed cache failure before the slow fallback `[anchored: tomo-id-016]`

- **File:** `backend/antipatterns.js:87`
- **Category:** `logs`
- **Severity:** high

**Description.** The cache lookup in `GET /api/customers/:id/profile` always throws, and the
`catch` block silently swallowed the error before sleeping 2500 ms on the "database" fallback.
Every request paid a 2.5-second penalty with zero telemetry — support saw latency complaints
with no signal explaining them, and the cache could stay down indefinitely without alerting.

**Before**
```js
  } catch (e) {
    // SILENTLY swallow. No logging. Just quietly do the slow thing.
    await new Promise((r) => setTimeout(r, 2500)); // "database" fallback, painfully slow
    profile = db.get(req.params.id) || { id: req.params.id, note: 'slow path, no one will ever know' };
  }
```

**After**
```js
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', message: '[tomo-id-016] worst-pri-product/backend/antipatterns.js: cache lookup failed; falling back to database', requestId: req.requestId || null, customerId: req.params.id, operation: 'get_customer_profile', errorType: e.name, errorMessage: e.message, action: 'verify cache availability and monitor database fallback latency' }));
    await new Promise((r) => setTimeout(r, 2500)); // "database" fallback, painfully slow
    profile = db.get(req.params.id) || { id: req.params.id, note: 'slow path after cache fallback' };
  }
```

**What changed.** Emits a structured JSON error log carrying `requestId`, `customerId`,
`operation`, `errorType`, `errorMessage`, and a remediation `action`. The fallback placeholder
note was reworded from a joke to a factual description of the code path.

---

## 3. Require a Stripe signature before accepting webhook orders `[anchored: tomo-id-017]`

- **File:** `backend/antipatterns.js:118`
- **Category:** `security`
- **Severity:** critical

**Description.** `POST /webhooks/stripe` accepted any request body as a real order without
verifying the `stripe-signature` header. Anyone who could reach the endpoint could inject
"phantom orders" that customers would then see. The records were even self-labelled
`acceptedWithoutVerification: true`, so unverified and verified orders were indistinguishable
downstream.

**Before**
```js
router.post('/webhooks/stripe', (req, res) => {
  // Should verify req.headers['stripe-signature'] FIRST. We don't. We just trust.
  const order = req.body || {};
  PHANTOM_ORDERS.push({ ...order, acceptedWithoutVerification: true, at: new Date().toString() });
  res.json({ received: true, phantomOrdersSoFar: PHANTOM_ORDERS.length });
});
```

**After**
```js
router.post('/webhooks/stripe', (req, res) => {
  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string' || signature.length === 0) {
    console.warn(JSON.stringify({ level: 'warn', message: '[tomo-id-017] worst-pri-product/backend/antipatterns.js: rejected unsigned stripe webhook', requestId: req.requestId || null, operation: 'stripe_webhook', action: 'configure Stripe signature verification before accepting webhook events' }));
    return res.status(400).json({ error: 'ERR_WEBHOOK_SIGNATURE_REQUIRED', message: 'Webhook rejected: missing stripe-signature header. Action: resend from Stripe with a valid signature.', requestId: req.requestId || null });
  }
  const order = req.body || {};
  PHANTOM_ORDERS.push({ ...order, acceptedWithoutVerification: false, at: new Date().toISOString() });
  res.json({ received: true, phantomOrdersSoFar: PHANTOM_ORDERS.length, requestId: req.requestId || null });
});
```

**What changed.** Rejects requests with a missing or empty `stripe-signature` header via
`400 ERR_WEBHOOK_SIGNATURE_REQUIRED`, logs the rejection with a `requestId`, and switches
timestamps to ISO-8601.

> **Residual gap:** this checks only for the *presence* of the header, not its cryptographic
> validity. A real fix computes the HMAC with `stripe.webhooks.constructEvent` against the
> endpoint secret. Worth tracking as a follow-up.

---

## 4. Cap and serialize bulk analysis fan-out `[reconstructed]`

- **File:** `backend/antipatterns.js:166`
- **Category:** `traffic_management`
- **Severity:** high

**Description.** `POST /api/bulk-analyze` mapped the caller-supplied `ids` array straight into
`Promise.all` with no size limit and no concurrency semaphore. A request with 10,000 IDs launched
10,000 concurrent operations at once — a self-inflicted denial of service against the process and
its downstream dependencies. An empty array silently returned success.

**Before**
```js
router.post('/api/bulk-analyze', async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  // No concurrency limit. If someone sends 10,000 ids, we launch 10,000 at once.
  const results = await Promise.all(
    ids.map(async (id) => {
      await new Promise((r) => setTimeout(r, 200));
      return { id, ok: true };
    })
  );
  res.json({ data: results, warning: 'Launched all at once. No semaphore. Godspeed.' });
});
```

**After**
```js
router.post('/api/bulk-analyze', async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 100) : [];
  if (ids.length === 0) {
    return res.status(400).json({ error: 'ERR_BULK_ANALYZE_IDS_REQUIRED', message: 'Bulk analysis failed: provide a non-empty ids array. Action: send between 1 and 100 IDs.', requestId: req.requestId || null });
  }
  const results = [];
  for (const id of ids) {
    await new Promise((r) => setTimeout(r, 200));
    results.push({ id, ok: true });
  }
  res.json({ data: results, maxIdsAccepted: 100, requestId: req.requestId || null });
});
```

**What changed.** Truncates input to 100 IDs, rejects an empty list with
`400 ERR_BULK_ANALYZE_IDS_REQUIRED`, and replaces unbounded `Promise.all` fan-out with a
sequential loop. The response advertises `maxIdsAccepted` so callers can page.

> **Trade-off:** serializing at 200 ms per ID means a full 100-ID request now takes ~20 s of
> wall clock. A bounded-concurrency worker pool (e.g. 5–10 in flight) would keep the DoS
> protection without the latency cost, and the silent `slice(0, 100)` truncation is arguably
> worse than a `400` telling the caller their request was trimmed.

---

## 5. Log injected chaos failures `[anchored: tomo-id-018]`

- **File:** `backend/chaos.js:34`
- **Category:** `observability`
- **Severity:** medium

**Description.** The chaos middleware returned random hard failures that were, from the outside,
identical to genuine dependency failures. With no server-side record of injection, support could
not tell a deliberately injected `ERR_CHAOS_*` response from a real outage — every chaos response
was a potential false-positive incident.

**Before**
```js
    if (roll()) {
      const [code, title, detail] = NONSENSE_ERRORS[Math.floor(Math.random() * NONSENSE_ERRORS.length)];
      return res.status(code).json({ error: `ERR_CHAOS_${code}`, message: `${title}: ${detail} Action: provide requestId to support and retry after transient failure clears.`, requestId: req.requestId || null });
    }
```

**After**
```js
    if (roll()) {
      const [code, title, detail] = NONSENSE_ERRORS[Math.floor(Math.random() * NONSENSE_ERRORS.length)];
      console.warn(JSON.stringify({ level: 'warn', message: '[tomo-id-018] worst-pri-product/backend/chaos.js: chaos response injected', requestId: req.requestId || null, statusCode: code, operation: 'chaos_middleware', action: 'use requestId to distinguish injected chaos from dependency failure' }));
      return res.status(code).json({ error: `ERR_CHAOS_${code}`, message: `${title}: ${detail} Action: provide requestId to support and retry after transient failure clears.`, requestId: req.requestId || null });
    }
```

**What changed.** Emits a structured warning naming the injected `statusCode` and correlating
`requestId`, so injected failures are attributable in logs.

---

## 6. Add a timeout and structured error log to metrics polling `[anchored: tomo-id-019]`

- **File:** `backend/load_generator.js:86`
- **Category:** `service_resilience`
- **Severity:** high

**Description.** `pollServerTickets()` called `fetch` with no timeout and swallowed every error
into a bare `catch (_) { return null; }`. A hung metrics endpoint would block the polling loop
indefinitely with no diagnostic output, and the discarded error meant failures were
indistinguishable from a legitimately empty metrics response.

**Before**
```js
async function pollServerTickets() {
  try {
    const res = await fetch(TARGET + '/api/metrics');
    const m = await res.json();
    return m;
  } catch (_) {
    return null;
  }
}
```

**After**
```js
async function pollServerTickets() {
  const requestId = `metrics-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.LOAD_METRICS_TIMEOUT_MS || 3000);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(TARGET + '/api/metrics', { headers: { 'x-request-id': requestId }, signal: controller.signal });
    const m = await res.json();
    return m;
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: '[tomo-id-019] worst-pri-product/backend/load_generator.js: metrics polling failed or timed out', requestId, timeoutMs, errorType: err.name, action: 'verify metrics endpoint health and timeout budget' }));
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
```

**What changed.** Adds an `AbortController` timeout (`LOAD_METRICS_TIMEOUT_MS`, default 3000 ms),
a generated `requestId` propagated as an `x-request-id` header for cross-service correlation, a
structured error log distinguishing timeout (`AbortError`) from other failures, and a `finally`
block that clears the timer so it can't leak.

---

## 7. Replace the prose startup banner with a structured log line `[anchored: tomo-id-020]`

- **File:** `run.sh:67`
- **Category:** `logs`
- **Severity:** low

**Description.** Startup emitted a decorative human-readable banner across eight `echo` calls.
Prose banners can't be parsed by log aggregators, so the service URLs were unavailable to
automated health checks and support tooling — inconsistent with the structured JSON logging
adopted everywhere else in the codebase.

**Before**
```bash
echo ""
echo "=================================================================="
echo "  App:        http://localhost:$PORT"
echo "  Dashboard:  http://localhost:$PORT/dashboard.html"
echo "  Museum API: http://localhost:$PORT/api/museum"
echo "  Ctrl-C to stop everything."
echo "=================================================================="
```

**After**
```bash
printf '{"level":"info","message":"[tomo-id-020] worst-pri-product/run.sh: services ready","app_url":"http://localhost:%s","dashboard_url":"http://localhost:%s/dashboard.html","museum_api_url":"http://localhost:%s/api/museum","action":"press Ctrl-C to stop everything"}\n' "$PORT" "$PORT" "$PORT"
```

**What changed.** One machine-parseable JSON line carrying the same three URLs as named fields,
replacing seven `echo` calls.

---

## 8. Truncate unbounded string fields on upsert `[reconstructed]`

- **File:** `backend/db.js:33`
- **Category:** `data_integrity`
- **Severity:** medium

**Description.** `upsert()` accepted arbitrary-length values for `id`, `name`, and `plan`. A
multi-megabyte `id` became an unbounded `Map` key, and oversized fields propagate into logs,
API responses, and any future persistent store — a memory-exhaustion and data-corruption vector
with no schema enforcement anywhere in the write path.

**Before**
```js
function upsert(customer) {
  const safeCustomer = customer && typeof customer === 'object' && !Array.isArray(customer) ? customer : {};
  const id = safeCustomer.id ? String(safeCustomer.id) : `c-${Math.floor(Math.random() * 100000)}`;
  const record = { ...safeCustomer, id };
  store.set(id, record);
  return { ...record, _saved: true };
}
```

**After**
```js
function upsert(customer) {
  const safeCustomer = customer && typeof customer === 'object' && !Array.isArray(customer) ? customer : {};
  const rawId = safeCustomer.id ? String(safeCustomer.id) : `c-${Math.floor(Math.random() * 100000)}`;
  const id = rawId.slice(0, 64);
  const record = {
    ...safeCustomer,
    id,
    name: typeof safeCustomer.name === 'string' ? safeCustomer.name.slice(0, 128) : safeCustomer.name,
    plan: typeof safeCustomer.plan === 'string' ? safeCustomer.plan.slice(0, 64) : safeCustomer.plan,
  };
  store.set(id, record);
  return { ...record, _saved: true };
}
```

**What changed.** Caps `id` at 64 chars, `name` at 128, `plan` at 64, applying the string limits
only when the field is actually a string so non-string values pass through unchanged.

> **Residual gap:** truncation is silent. Two customers whose IDs differ only after character 64
> now collide and overwrite each other in `store`. Rejecting oversized IDs would be safer than
> truncating them.

---

## 9. Stop returning 201 for invalid customer payloads `[reconstructed]`

- **File:** `backend/server.js:145`
- **Category:** `user_facing_diagnostics`
- **Severity:** high

**Description.** `POST /api/customers` passed `req.body || {}` to `db.upsert` and unconditionally
returned `201` with the message "Saved successfully (probably)." A client sending a malformed body
got a success status for a customer record built from nothing, and the response carried no
`requestId`, so support had no way to trace a specific save.

**Before**
```js
app.post('/api/customers', (req, res) => {
  const saved = db.upsert(req.body || {});
  // We always say 201, even when _saved is false. Optimism!
  res.status(201).json({ data: saved, message: 'Saved successfully (probably).' });
});
```

**After**
```js
app.post('/api/customers', (req, res) => {
  const payload = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!payload) {
    return res.status(400).json({ error: 'ERR_INVALID_CUSTOMER_PAYLOAD', message: 'Customer save failed: request body must be a JSON object. Action: send a valid customer object and retry.', requestId: req.requestId });
  }
  const saved = db.upsert(payload);
  res.status(201).json({ data: saved, message: 'Saved successfully.', requestId: req.requestId });
});
```

**What changed.** Rejects non-object bodies with `400 ERR_INVALID_CUSTOMER_PAYLOAD` and an
actionable message, attaches `requestId` to both paths, and drops the hedged "(probably)"
success wording now that the status code is truthful.

---

## 10. Gate the environment-leaking debug endpoint `[reconstructed]`

- **File:** `backend/worst_features.js:64`
- **Category:** `security`
- **Severity:** critical

**Description.** `GET /api/debug` was unconditionally reachable and returned the full environment
object plus a stack trace to any unauthenticated caller. Even with placeholder credentials, an
always-on endpoint that dumps environment state and internal paths is a direct information-disclosure
path and leaks internal structure useful for further attack.

**Before**
```js
router.get('/api/debug', (req, res) => {
  res.status(200).json({
    warning: 'This endpoint should not exist in production. It does.',
    env: FAKE_LEAKED_ENV,
    fakeStackTrace: [
      'Error: everything',
      '    at hopesAndDreams (/app/src/reality.js:1:1)',
      '    at Object.<anonymous> (/app/node_modules/regret/index.js:404:24)',
    ],
    tip: 'These credentials are fake. But in real life, this is how breaches happen.',
  });
});
```

**After**
```js
router.get('/api/debug', (req, res) => {
  if (process.env.ENABLE_DEBUG_ENDPOINT !== 'true') {
    return res.status(404).json({ error: 'ERR_DEBUG_ENDPOINT_DISABLED', message: 'Debug endpoint is disabled. Action: use supported diagnostics endpoints or enable explicitly in a non-production environment.', requestId: req.requestId || null });
  }
  res.status(200).json({
    warning: 'Debug endpoint enabled by explicit configuration.',
    env: FAKE_LEAKED_ENV,
    requestId: req.requestId || null,
  });
});
```

**What changed.** Closed by default — requires an explicit `ENABLE_DEBUG_ENDPOINT=true` opt-in and
otherwise returns `404 ERR_DEBUG_ENDPOINT_DISABLED` (404 rather than 403, so the endpoint's
existence isn't advertised). The fabricated stack trace and internal file paths were removed
entirely.

---

## 11. State that model confidence is not a calibrated probability `[reconstructed]`

- **File:** `backend/ai_model.js:62`
- **Category:** `support_agent_readiness`
- **Severity:** low

**Description.** The analysis response returned a `confidence` value with no indication of how it
was produced. Because it is derived from a deterministic hash rather than a trained model, support
agents and end users could reasonably read it as a calibrated probability and make decisions on a
number that carries no predictive meaning.

**Before**
```js
    explanation: {
      primarySignals: ['customerId', 'plan', 'monthlySpend', 'tenureMonths'],
      boundedInputs: {
```

**After**
```js
    explanation: {
      primarySignals: ['customerId', 'plan', 'monthlySpend', 'tenureMonths'],
      confidenceBasis: 'Deterministic hash-derived confidence; not a calibrated probability. Use analysisFingerprint for support comparisons.',
      boundedInputs: {
```

**What changed.** Adds a `confidenceBasis` field to the `explanation` block stating the value's
true derivation and pointing support at `analysisFingerprint` as the correct field for comparing
two analyses.

---

## Configuration introduced by these changes

| Variable | Default | File | Purpose |
|----------|---------|------|---------|
| `MAX_NOTES_IN_MEMORY` | `1000` | `backend/antipatterns.js` | Ceiling on in-memory notes before `503` |
| `LOAD_METRICS_TIMEOUT_MS` | `3000` | `backend/load_generator.js` | Metrics-poll abort timeout |
| `ENABLE_DEBUG_ENDPOINT` | unset (disabled) | `backend/worst_features.js` | Explicit opt-in for `/api/debug` |

## Error codes introduced

| Code | HTTP | Endpoint |
|------|------|----------|
| `ERR_INVALID_NOTE_PAYLOAD` | 400 | `POST /api/notes` |
| `ERR_NOTES_CAPACITY_EXCEEDED` | 503 | `POST /api/notes` |
| `ERR_WEBHOOK_SIGNATURE_REQUIRED` | 400 | `POST /webhooks/stripe` |
| `ERR_BULK_ANALYZE_IDS_REQUIRED` | 400 | `POST /api/bulk-analyze` |
| `ERR_INVALID_CUSTOMER_PAYLOAD` | 400 | `POST /api/customers` |
| `ERR_DEBUG_ENDPOINT_DISABLED` | 404 | `GET /api/debug` |

## Open follow-ups

These are gaps the accepted changes reduced but did not close:

1. **Stripe signature is not actually verified** (#3) — presence-only check; needs HMAC validation against the endpoint secret.
2. **Bulk-analyze truncates silently** (#4) — `slice(0, 100)` drops IDs without telling the caller, and the sequential loop trades a DoS risk for ~20 s latency. A bounded worker pool plus a `400` on oversized input would be better on both counts.
3. **Customer ID truncation can cause collisions** (#8) — IDs differing only past character 64 now overwrite each other; prefer rejection over truncation.
4. **`GET /api/notes` still has no pagination** — flagged in-repo as `[Cat 10/13]` and untouched by this pass; it still returns the entire array.
