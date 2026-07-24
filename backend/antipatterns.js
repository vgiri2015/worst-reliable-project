'use strict';

/**
 * ============================================================================
 *  THE ANTI-PATTERN MUSEUM
 * ============================================================================
 *  Every exhibit here is a DELIBERATE violation of the 15 supportability
 *  categories. Each is tagged [Cat N] so you can map bug -> ticket. This is
 *  what a "supportability scanner" would light up like a Christmas tree.
 *
 *  (Parody. Localhost only. The "secrets" are fake. Don't ship this. Obviously.)
 * ============================================================================
 */

const express = require('express');
const db = require('./db');
const router = express.Router();

// [Cat 7 / 15] Hardcoded secrets + high-entropy strings sitting in source.
const API_KEY = process.env.PAYMENT_API_KEY || '';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
// [Cat 9] Service URL is externally configured so incidents can be mitigated without a redeploy.
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || '';

// ---------------------------------------------------------------------------
// [Cat 7 / 11] "Log Everything" + "Printf Debugging"
// Middleware that dumps the ENTIRE request body — passwords, tokens, all of it —
// to unstructured console.log. No PII masking. No structured JSON. No levels.
// ---------------------------------------------------------------------------
function logEverything(req, res, next) {
  const redact = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => (
        /password|token|secret|creditcard|authorization|cookie|ssn|email/i.test(key) ? [key, '[REDACTED]'] : [key, entry]
      ))
    );
  };

  const redactedBody = redact(req.body || {});
  console.info(JSON.stringify({
    level: 'info',
    message: '[tomo-id-023] worst-pri-product/backend/antipatterns.js: request received',
    method: req.method,
    url: req.originalUrl || req.url,
    requestId: req.requestId || null,
    bodyKeys: Object.keys(redactedBody),
    bodyPreview: redactedBody,
  }));
  next();
}

// ---------------------------------------------------------------------------
// [Cat 3 / 4] Unbounded in-memory arrays. User input pushed forever. Memory DoS.
// No schema validation ("Blind Writes"). No idempotency. No transaction.
// ---------------------------------------------------------------------------
const NOTES = [];           // grows without limit
const PHANTOM_ORDERS = [];  // filled by the unverified webhook below
const DEAD_LETTERS = [];    // events we "fired and forgot"

router.post('/api/notes', (req, res) => {
  // Raw JSON straight into memory. Whatever you send, however big. Enjoy.
  NOTES.push(req.body);
  res.json({ ok: true, totalNotesInMemory: NOTES.length, warning: 'This array has no upper bound.' });
});
// [Cat 10/13] No pagination. Returns EVERYTHING. SELECT * energy.
router.get('/api/notes', (req, res) => res.json({ data: NOTES }));

// ---------------------------------------------------------------------------
// [Cat 2] The "Silent Cache" Failure.
// A cache that always breaks; the error is swallowed; we fall back to a slow
// path. No log.error, no metric. App "works" but crawls. Users say "it's slow",
// logs say nothing. The perfect invisible ticket generator.
// ---------------------------------------------------------------------------
const fakeCache = {
  get() { throw new Error('redis connection refused'); },
};
router.get('/api/customers/:id/profile', async (req, res) => {
  let profile;
  try {
    profile = fakeCache.get(req.params.id); // always throws
  } catch (e) {
    // SILENTLY swallow. No logging. Just quietly do the slow thing.
    await new Promise((r) => setTimeout(r, 2500)); // "database" fallback, painfully slow
    profile = db.get(req.params.id) || { id: req.params.id, note: 'slow path, no one will ever know' };
  }
  res.json({ data: profile, cached: false });
});

// ---------------------------------------------------------------------------
// [Cat "Timezone Trap"] Subscription expiry computed in LOCAL server time.
// Works on the dev's machine. Locks out Tokyo a day early, London gets reports
// late. New Year's / DST = ticket tsunami.
// ---------------------------------------------------------------------------
router.get('/api/subscription/:id', (req, res) => {
  const now = new Date(); // LOCAL time. Not UTC. The bug.
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const expiresAt = new Date(midnight.getTime() + 24 * 3600 * 1000);
  const lockedOut = now.getHours() >= 22; // arbitrary local-time cutoff
  res.json({
    id: req.params.id,
    expiresAtLocal: expiresAt.toString(),
    lockedOut,
    note: 'Expiry uses new Date() (server local time). Tokyo users, our condolences.',
  });
});

// ---------------------------------------------------------------------------
// [Cat "Webhook Black Hole"] Reads and processes the body BEFORE verifying the
// stripe-signature header. No signature check at all, actually. Anyone can POST
// a "phantom order" and customers will see it.
// ---------------------------------------------------------------------------
router.post('/webhooks/stripe', (req, res) => {
  // Should verify req.headers['stripe-signature'] FIRST. We don't. We just trust.
  const order = req.body || {};
  PHANTOM_ORDERS.push({ ...order, acceptedWithoutVerification: true, at: new Date().toString() });
  res.json({ received: true, phantomOrdersSoFar: PHANTOM_ORDERS.length });
});

// ---------------------------------------------------------------------------
// [Cat "Zombie Feature Flag"] A stale flag last touched "in 2024". It randomly
// flips, reverting the UI for confused users. No one remembers why it exists.
// ---------------------------------------------------------------------------
const FEATURE_FLAGS = {
  enable_new_ui: { value: true, lastModified: '2024-01-15', owner: 'someone who left the company' },
};
router.get('/api/flags', (req, res) => {
  // "glitch": randomly serve the value from 2024 instead of the current one.
  const glitched = Math.random() < 0.4;
  res.json({
    enable_new_ui: glitched ? false : FEATURE_FLAGS.enable_new_ui.value,
    _meta: FEATURE_FLAGS.enable_new_ui,
    glitched,
  });
});

// ---------------------------------------------------------------------------
// [Cat 10/13] N+1 Queries + SELECT * + no pagination.
// Builds a report by querying per-customer inside a loop, each with latency,
// fetching entire records. O(n) round trips. Gets slower as data grows.
// ---------------------------------------------------------------------------
router.get('/api/report', async (req, res) => {
  const customers = db.list();          // 1 query
  const enriched = [];
  for (const c of customers) {          // ...then one MORE query per row. The +1s.
    await new Promise((r) => setTimeout(r, 300)); // simulate a round-trip each
    const full = db.get(c.id);          // SELECT * (all columns, every time)
    enriched.push(full);
  }
  res.json({ data: enriched, note: 'Built with N+1 queries. It only gets slower.' });
});

// ---------------------------------------------------------------------------
// [Cat 12] "Unbounded Concurrency" — fan out over user input with Promise.all
// and no semaphore. A big list = a self-inflicted DoS on your own dependencies.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// [Cat 12] "Infinite Waits" + "Thundering Herd" retries (fixed interval, no
// backoff, no jitter) against a dependency that is always down.
// ---------------------------------------------------------------------------
async function callFlakyDependencyWithRetryStorm() {
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      throw new Error('upstream 503'); // always fails
    } catch (e) {
      // Fixed 100ms interval. Every client retries in lockstep. Thundering herd.
      await new Promise((r) => setTimeout(r, 100));
      if (attempt === 8) return { ok: false, attempts: attempt };
    }
  }
}
router.get('/api/upstream', async (req, res) => {
  const r = await callFlakyDependencyWithRetryStorm();
  // [Cat 8/14] Generic error, no error code, no correlation ID, no cause logged.
  res.status(500).json({ error: 'Internal Server Error' });
});

// ---------------------------------------------------------------------------
// [Cat 5] "Fire and Forget" async messaging. Publish crucial events to a broker
// that silently drops half of them. No ack, no DLQ handling, no callback.
// ---------------------------------------------------------------------------
router.post('/api/events', (req, res) => {
  const event = req.body || {};
  if (Math.random() < 0.5) {
    DEAD_LETTERS.push(event); // "delivered" (it wasn't) — but no one checks this
  }
  // Respond success immediately without awaiting any broker confirmation.
  res.json({ published: true, note: 'Fire and forget. ~50% silently vanish. No DLQ alerting.' });
});

// ---------------------------------------------------------------------------
// [Cat 14] "Magic Numbers" + generic status codes with no catalog.
// ---------------------------------------------------------------------------
router.get('/api/order/:id/status', (req, res) => {
  const status = Math.floor(Math.random() * 5); // 0..4, meaning known only to God
  // if (status == 4) ... but 4 is a magic number. What is 4? Nobody documented it.
  res.json({ status, humanReadable: 'good luck decoding this integer' });
});

// ---------------------------------------------------------------------------
// [Cat 11] "Blind Job" — a background worker that logs neither start nor finish,
// swallows its own errors, and occasionally does nothing at all.
// ---------------------------------------------------------------------------
function startBlindJob() {
  setInterval(() => {
    try {
      // "process" something. Or don't. No start log, no finish log, no metric.
      if (Math.random() < 0.5) {
        NOTES.length = NOTES.length; // pretend work
      } else {
        throw new Error('job blew up');
      }
    } catch (e) {
      // catch (e) {} — the classic. Suppress everything.
    }
  }, 5000);
}

/* ===========================================================================
 * [Cat 14] DEAD CODE — a large block of commented-out logic left to rot.
 * Nobody knows if it's load-bearing. Everyone is afraid to delete it.
 * ---------------------------------------------------------------------------
 * function reconcileLedger(entries) {
 *   const total = entries.reduce((a, e) => a + e.amount, 0);
 *   if (total !== expected) { rollback(); }   // what is expected? unclear.
 *   // TODO(2019-03-01): fix this before launch      <-- [Cat 14] aged TODO
 *   return total * 1.0825; // why 1.0825? a magic number lost to time.
 * }
 * =========================================================================== */

module.exports = { router, logEverything, startBlindJob };
