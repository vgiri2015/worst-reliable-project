'use strict';

/**
 * Chaos middleware — the engine of unreliability.
 *
 * CHAOS_LEVEL (env var, 0..10) controls how often things break.
 *   0  = boringly reliable (for debugging / demos to skeptics)
 *   5  = default. plausibly deniable flakiness.
 *   10 = "why is production on fire" mode. ~100 tickets/day territory.
 */

const { context, trace, SpanStatusCode } = require('@opentelemetry/api');
const { tracer, instruments } = require('./instruments');
const log = require('./log');

const rawChaos = Number(process.env.CHAOS_LEVEL ?? 5);
const CHAOS = Number.isFinite(rawChaos) ? Math.min(10, Math.max(0, rawChaos)) : 5;
const p = CHAOS / 10; // probability scalar

function roll() {
  return Math.random() < p;
}

// A grab-bag of real HTTP errors, chosen to maximize confusion.
const NONSENSE_ERRORS = [
  [500, 'Internal Server Error', 'Something went wrong. We are definitely not looking into it.'],
  [503, 'Service Unavailable', 'The backend is taking a mental health day.'],
  [418, "I'm a teapot", 'You asked for customer data. We brewed tea instead.'],
  [402, 'Payment Required', 'Surprise! This endpoint is premium now.'],
  [429, 'Too Many Requests', 'You made 1 request. That was too many.'],
];

function chaosMiddleware(req, res, next) {
  // 1) Random latency — sometimes a blink, sometimes a coffee break.
  const slow = roll();
  const jitter = slow ? Math.floor(Math.random() * 4000) : Math.floor(Math.random() * 120);

  // One span covers the artificial delay and the injection decision, so the
  // waterfall shows exactly how much latency/failure was manufactured here.
  const span = tracer.startSpan('chaos.middleware', {
    attributes: { 'app.chaos.level': CHAOS, 'app.chaos.delay_ms': jitter, 'app.chaos.slow': slow },
  });
  const parentContext = context.active();
  const spanContext = trace.setSpan(parentContext, span);
  instruments.chaosDelay.record(jitter, { 'app.chaos.slow': slow });

  // Marks the request/span and counts the injection; the ticket counter in
  // server.js uses req.chaosInjected to attribute tickets to chaos.
  const inject = (kind, statusCode) => {
    req.chaosInjected = kind;
    instruments.chaosInjections.add(1, { 'app.chaos.kind': kind, 'http.response.status_code': statusCode });
    span.setAttributes({ 'app.chaos.injected': true, 'app.chaos.kind': kind, 'http.response.status_code': statusCode });
    span.setStatus({ code: SpanStatusCode.ERROR, message: `chaos injected: ${kind}` });
    span.end();
  };

  setTimeout(() => context.with(spanContext, () => {
    // 2) Random hard failures with support-actionable messages.
    if (roll()) {
      const [code, title, detail] = NONSENSE_ERRORS[Math.floor(Math.random() * NONSENSE_ERRORS.length)];
      inject('hard_failure', code);
      log.warn('[tomo-id-018] worst-pri-product/backend/chaos.js: chaos response injected', { requestId: req.requestId || null, statusCode: code, operation: 'chaos_middleware', action: 'use requestId to distinguish injected chaos from dependency failure' });
      return res.status(code).json({ error: `ERR_CHAOS_${code}`, message: `${title}: ${detail} Action: provide requestId to support and retry after transient failure clears.`, requestId: req.requestId || null });
    }

    // 3) Random "success" that is actually empty — the classic silent failure.
    if (roll() && Math.random() < 0.3) {
      inject('empty_response', 503);
      return res.status(503).json({ error: 'ERR_EMPTY_CHAOS_RESPONSE', message: 'Chaos middleware produced an empty upstream response. Action: retry with the requestId if the issue persists.', requestId: req.requestId || null });
    }

    // 4) Occasionally corrupt the response so the frontend can't parse it.
    if (roll() && Math.random() < 0.2) {
      inject('corrupt_response', 503);
      return res.status(503).json({ error: 'ERR_CORRUPT_CHAOS_RESPONSE', message: 'Chaos middleware blocked a corrupt response before it reached the client. Action: retry after transient failure clears.', requestId: req.requestId || null });
    }

    span.setAttribute('app.chaos.injected', false);
    span.end();
    // Route handlers are siblings of chaos.middleware, not its children.
    context.with(parentContext, next);
  }), jitter);
}

module.exports = { chaosMiddleware, CHAOS };
