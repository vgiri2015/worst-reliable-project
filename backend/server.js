'use strict';

// OpenTelemetry must start before express/http are loaded so they get instrumented.
const telemetry = require('./telemetry');
telemetry.start({ serviceName: 'worst-pri-product', attributes: { 'app.chaos.level': Number(process.env.CHAOS_LEVEL ?? 5) } });

const path = require('path');
const { trace } = require('@opentelemetry/api');
const express = require('express');
const db = require('./db');
const aiModel = require('./ai_model');
const { chaosMiddleware, CHAOS } = require('./chaos');
const { router: worstRouter, ridiculousHeaders } = require('./worst_features');
const { router: museumRouter, logEverything, startBlindJob } = require('./antipatterns');
const { meter, instruments, withSpan } = require('./instruments');
const log = require('./log');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '256kb' }));

// requestId = caller's x-request-id, else the OpenTelemetry trace id, so the ID a
// customer quotes to support is the same ID you search for in the tracing backend.
// Incoming W3C traceparent headers are honored by the http instrumentation.
app.use((req, res, next) => {
  const span = trace.getActiveSpan();
  const traceId = span ? span.spanContext().traceId : null;
  const requestId = String(req.headers['x-request-id'] || traceId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  req.requestId = requestId;
  res.set('x-request-id', requestId);
  if (span) {
    span.setAttribute('app.request_id', requestId);
    res.set('x-trace-id', traceId);
  }
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
    instruments.rateLimitRejections.add(1);
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

// Gauges sampled at each metric export.
meter.createObservableGauge('app.support_tickets.projected_daily', {
  description: 'Projected support tickets per day at the current failure rate.',
  unit: '{ticket}',
}).addCallback((result) => result.observe(projectedDailyTickets()));
meter.createObservableGauge('app.db.customers', {
  description: 'Customers currently held in the in-memory store.',
  unit: '{customer}',
}).addCallback((result) => result.observe(db.size()));

// Count a "ticket" whenever we send a 4xx/5xx. Hook into res.
// Low-cardinality attributes only: route template (not raw URL), status, source.
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 400) {
      ticketsToday += 1;
      instruments.supportTickets.add(1, {
        'http.request.method': req.method,
        'http.route': req.route ? `${req.baseUrl || ''}${req.route.path}` : '(unmatched)',
        'http.response.status_code': res.statusCode,
        'app.ticket.source': req.chaosInjected ? 'chaos' : 'application',
      });
    }
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
    return res.status(404).json({ error: 'ERR_CUSTOMER_NOT_FOUND', message: 'Customer analysis failed: customer was not found. Action: verify the customer ID and retry.', requestId: req.requestId });
  }
  const started = process.hrtime.bigint();
  const plan = typeof customer.plan === 'string' ? customer.plan : 'unknown';
  try {
    const result = withSpan('ai_model.analyze', {
      attributes: { 'app.customer.id': String(customer.id), 'app.customer.plan': plan },
    }, (span) => {
      const analysis = aiModel.analyze(customer);
      span.setAttributes({
        'app.ai.model_version': analysis.modelVersion,
        'app.ai.segment': analysis.segment,
        'app.ai.sentiment': analysis.sentiment,
        'app.ai.churn_risk': analysis.churnRiskPercent,
        'app.ai.confidence': Number(analysis.modelConfidencePercent),
        'app.ai.fingerprint': analysis.analysisFingerprint,
      });
      return analysis;
    });
    instruments.aiAnalysisDuration.record(Number(process.hrtime.bigint() - started) / 1e9, { 'app.ai.outcome': 'success' });
    instruments.aiAnalyses.add(1, { 'app.ai.outcome': 'success', 'app.ai.segment': result.segment, 'app.customer.plan': plan });
    instruments.aiChurnRisk.record(result.churnRiskPercent, { 'app.customer.plan': plan });
    res.json({ data: result, requestId: req.requestId });
  } catch (err) {
    instruments.aiAnalysisDuration.record(Number(process.hrtime.bigint() - started) / 1e9, { 'app.ai.outcome': 'error' });
    instruments.aiAnalyses.add(1, { 'app.ai.outcome': 'error', 'app.customer.plan': plan });
    log.error('[tomo-id-017] worst-pri-product/backend/server.js: customer analysis failed', { requestId: req.requestId, customerId: req.params.id, operation: 'analyze_customer', errorType: err.name, errorMessage: err.message, error: err, action: 'verify customer payload fields before retrying analysis' });
    res.status(500).json({ error: 'ERR_MODEL_ANALYSIS_FAILED', message: 'Customer analysis failed due to a model processing error. Action: provide this requestId to support.', requestId: req.requestId });
  }
});

// Create/update a customer (may silently fail to save — see db.js).
app.post('/api/customers', (req, res) => {
  const payload = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!payload) {
    return res.status(400).json({ error: 'ERR_INVALID_CUSTOMER_PAYLOAD', message: 'Customer save failed: request body must be a JSON object. Action: send a valid customer object and retry.', requestId: req.requestId });
  }
  const saved = db.upsert(payload);
  res.status(201).json({ data: saved, message: 'Saved successfully.', requestId: req.requestId });
});

// [Cat 11] Blind background job with no start/finish logging and swallowed errors.
startBlindJob();

// [Cat 12] NO graceful shutdown handler. SIGTERM just yanks the plug mid-write.
// (We deliberately do NOT register process.on('SIGTERM', ...). Data loss on deploy.)

const server = app.listen(PORT, () => {
  log.info('[tomo-id-027] worst-pri-product/backend/server.js: server started', {
    port: Number(PORT),
    chaosLevel: CHAOS,
    museumPath: '/api/museum',
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318',
    telemetryEnabled: String(process.env.OTEL_SDK_DISABLED).toLowerCase() !== 'true',
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('[tomo-id-028] worst-pri-product/backend/server.js: graceful shutdown started', { signal });
  setTimeout(() => process.exit(1), 10000).unref();
  server.close(async (err) => {
    if (err) {
      log.error('[tomo-id-029] worst-pri-product/backend/server.js: graceful shutdown failed', { errorType: err.name, errorMessage: err.message, error: err, action: 'inspect open connections and retry termination' });
    }
    // Flush buffered spans/metrics/logs (including the lines above) before exiting.
    await telemetry.shutdown();
    process.exit(err ? 1 : 0);
  });
  // Let in-flight requests finish, but drop idle keep-alive sockets so close() completes.
  server.closeIdleConnections();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
