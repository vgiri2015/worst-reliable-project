'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const aiModel = require('./ai_model');
const { chaosMiddleware, CHAOS } = require('./chaos');
const { router: worstRouter, ridiculousHeaders } = require('./worst_features');
const { router: museumRouter, logEverything, startBlindJob } = require('./antipatterns');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '256kb' }));

app.use((req, res, next) => {
  const requestId = String(req.headers['x-request-id'] || req.headers.traceparent || `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  req.requestId = requestId;
  res.set('x-request-id', requestId);
  next();
});

app.use((req, res, next) => {
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
  const maxRequests = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 120);
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  app.locals.rateLimitBuckets = app.locals.rateLimitBuckets || new Map();
  const bucket = app.locals.rateLimitBuckets.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }

  bucket.count += 1;
  app.locals.rateLimitBuckets.set(key, bucket);
  res.set('x-ratelimit-limit', String(maxRequests));
  res.set('x-ratelimit-remaining', String(Math.max(0, maxRequests - bucket.count)));

  if (bucket.count > maxRequests) {
    return res.status(429).json({ error: 'ERR_RATE_LIMITED', message: 'Too many requests from this client. Action: retry after the rate-limit window resets.', requestId: req.requestId });
  }

  next();
});
app.use(ridiculousHeaders);
// [Cat 7/11] Dump every request body (passwords included) to unstructured stdout.
app.use(logEverything);

// Serve the (equally unreliable) frontend.
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---------------------------------------------------------------------------
// Ticket-o-meter: tracks how many "support tickets" this app has earned today.
// Every server-side failure increments it. This is the app's true KPI.
// ---------------------------------------------------------------------------
let ticketsToday = 0;
const bootTime = Date.now();

function projectedDailyTickets() {
  const hours = (Date.now() - bootTime) / 3.6e6;
  if (hours < 0.001) return ticketsToday;
  return Math.round((ticketsToday / hours) * 24);
}

// Count a "ticket" whenever we send a 4xx/5xx. Hook into res.
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 400) ticketsToday += 1;
  });
  next();
});

// Health endpoint that lies. Reports "healthy" while everything burns.
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', uptime: 'trust me', chaosLevel: CHAOS });
});

// The honest metrics endpoint. Not affected by chaos so you can watch the carnage.
app.get('/api/metrics', (req, res) => {
  res.json({
    ticketsToday,
    projectedTicketsPerDay: projectedDailyTickets(),
    target: 100,
    chaosLevel: CHAOS,
    onTrackForDisaster: projectedDailyTickets() >= 100,
  });
});

// Everything below is subject to chaos.
app.use(chaosMiddleware);

// Bonus war crimes: /api/login, /api/search, /api/debug, /api/account/delete
app.use(worstRouter);

// The Anti-Pattern Museum: /api/notes, /api/report, /webhooks/stripe, /api/flags, ...
app.use(museumRouter);

// [Cat 8/14] Self-"documenting" catalog of every supportability violation.
// (The only observability in the whole app, and even this is done ironically.)
const MUSEUM = [
  ['API Observability', 'Blind logging + swallowed errors; every error omits a Reference/Correlation ID (requestId: "lost")'],
  ['Service Resilience', 'Silent cache fallback with no log/metric (/api/customers/:id/profile crawls); no circuit breaker'],
  ['Data Integrity', 'Blind writes: raw JSON pushed to storage, no Zod/Joi, no idempotency key, no transaction'],
  ['Traffic Management', 'Unbounded in-memory arrays (/api/notes) — memory DoS; no rate limiting'],
  ['Async Messaging', 'Fire-and-forget events (/api/events) drop ~50% silently; no DLQ, no ack'],
  ['FinOps / IaC', 'Docker "latest" tag, no CPU/memory limits, 0.0.0.0 SSH — see k8s/ and Dockerfile'],
  ['Security Supportability', 'Logs entire request body incl. passwords; hardcoded secrets; no PII masking; no audit trail'],
  ['KnowledgeOps', 'Generic 500s with no internal code; magic numbers (/api/order/:id/status); aged TODOs; dead code'],
  ['Config Hygiene', 'Hardcoded URLs (http://localhost:8080) instead of env/config'],
  ['Database Performance', 'N+1 queries + SELECT * + no pagination (/api/report, /api/notes)'],
  ['Reliability', 'Infinite waits, thundering-herd retries (fixed 100ms, no backoff), unbounded concurrency (/api/bulk-analyze)'],
  ['Timezone Trap', 'Subscription/expiry uses new Date() local time (/api/subscription/:id) — locks out Tokyo early'],
  ['Webhook Black Hole', '/webhooks/stripe processes body BEFORE (never) verifying stripe-signature'],
  ['Zombie Feature Flag', 'Stale flag from 2024 randomly flips the UI (/api/flags)'],
  ['Blind Jobs', 'Background worker logs neither start nor finish and swallows its own crashes'],
];
app.get('/api/museum', (req, res) => {
  res.json({
    title: 'The Anti-Pattern Museum — 15 categories of supportability, all violated on purpose',
    exhibits: MUSEUM.map(([category, violation], i) => ({ n: i + 1, category, violation })),
  });
});

// List customers.
app.get('/api/customers', (req, res) => {
  res.json({ data: db.list() });
});

// Analyze one customer with the "AI model".
app.get('/api/customers/:id/analyze', (req, res) => {
  const customer = db.get(req.params.id);
  if (!customer) {
    return res.status(404).json({ error: 'Not Found', detail: 'That customer evaporated.' });
  }
  try {
    const result = aiModel.analyze(customer);
    res.json({ data: result });
  } catch (err) {
    res.status(500).json({ error: 'ModelError', detail: err.message });
  }
});

// Create/update a customer (may silently fail to save — see db.js).
app.post('/api/customers', (req, res) => {
  const saved = db.upsert(req.body || {});
  // We always say 201, even when _saved is false. Optimism!
  res.status(201).json({ data: saved, message: 'Saved successfully (probably).' });
});

// [Cat 11] Blind background job with no start/finish logging and swallowed errors.
startBlindJob();

// [Cat 12] NO graceful shutdown handler. SIGTERM just yanks the plug mid-write.
// (We deliberately do NOT register process.on('SIGTERM', ...). Data loss on deploy.)

app.listen(PORT, () => {
  console.log('='.repeat(64));
  console.log('  WORST-PRI-PRODUCT is now degrading service on port ' + PORT);
  console.log('  Open:  http://localhost:' + PORT);
  console.log('  Chaos level: ' + CHAOS + '/10   (set CHAOS_LEVEL to change)');
  console.log('  Anti-Pattern Museum: http://localhost:' + PORT + '/api/museum');
  console.log('='.repeat(64));
});
