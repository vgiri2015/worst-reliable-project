'use strict';

/**
 * Shared tracer, meter, custom metric instruments and a span helper.
 *
 * All custom metrics live under the `app.` prefix. The full telemetry contract
 * (names, units, attributes) is documented in ../worst-pri-otel/README.md. Change both
 * together: downstream consumers depend on it.
 */

const { trace, metrics, SpanStatusCode, ValueType } = require('@opentelemetry/api');
const { SERVICE_VERSION } = require('./telemetry');

const SCOPE = 'worst-pri-product';
const tracer = trace.getTracer(SCOPE, SERVICE_VERSION);
const meter = metrics.getMeter(SCOPE, SERVICE_VERSION);

const LATENCY_BUCKETS_S = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const DELAY_BUCKETS_MS = [5, 25, 50, 100, 250, 500, 1000, 2000, 3000, 4000];

const instruments = {
  supportTickets: meter.createCounter('app.support_tickets', {
    description: 'Responses with HTTP status >= 400. The app\'s "support ticket" KPI.',
    unit: '{ticket}',
    valueType: ValueType.INT,
  }),
  rateLimitRejections: meter.createCounter('app.rate_limit.rejections', {
    description: 'Requests rejected with 429 by the per-client rate limiter.',
    unit: '{request}',
    valueType: ValueType.INT,
  }),
  chaosInjections: meter.createCounter('app.chaos.injections', {
    description: 'Failures deliberately injected by the chaos middleware.',
    unit: '{injection}',
    valueType: ValueType.INT,
  }),
  chaosDelay: meter.createHistogram('app.chaos.delay', {
    description: 'Artificial latency added by the chaos middleware.',
    unit: 'ms',
    advice: { explicitBucketBoundaries: DELAY_BUCKETS_MS },
  }),
  aiAnalyses: meter.createCounter('app.ai.analyses', {
    description: 'Customer analyses performed by the AI model.',
    unit: '{analysis}',
    valueType: ValueType.INT,
  }),
  aiAnalysisDuration: meter.createHistogram('app.ai.analysis.duration', {
    description: 'Time spent inside aiModel.analyze().',
    unit: 's',
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS_S },
  }),
  aiChurnRisk: meter.createHistogram('app.ai.churn_risk', {
    description: 'Distribution of predicted churn risk.',
    unit: '%',
    advice: { explicitBucketBoundaries: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] },
  }),
  dbOperations: meter.createCounter('app.db.operations', {
    description: 'Operations against the in-memory customer store.',
    unit: '{operation}',
    valueType: ValueType.INT,
  }),
  cacheFallbacks: meter.createCounter('app.cache.fallbacks', {
    description: 'Cache lookups that failed and fell back to the slow database path.',
    unit: '{fallback}',
    valueType: ValueType.INT,
  }),
  loginAttempts: meter.createCounter('app.login.attempts', {
    description: 'Login attempts by outcome.',
    unit: '{attempt}',
    valueType: ValueType.INT,
  }),
  webhookEvents: meter.createCounter('app.webhook.events', {
    description: 'Incoming Stripe webhook events by outcome.',
    unit: '{event}',
    valueType: ValueType.INT,
  }),
  upstreamAttempts: meter.createCounter('app.upstream.attempts', {
    description: 'Attempts made against the flaky upstream dependency (including retries).',
    unit: '{attempt}',
    valueType: ValueType.INT,
  }),
};

/**
 * Run fn inside a new active span. Works for sync and async functions:
 * exceptions are recorded, status set to ERROR, and the span always ends.
 */
function withSpan(name, options, fn) {
  return tracer.startActiveSpan(name, options || {}, (span) => {
    const fail = (err) => {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err && err.message });
      span.end();
      throw err;
    };
    try {
      const result = fn(span);
      if (result && typeof result.then === 'function') {
        return result.then((value) => { span.end(); return value; }, fail);
      }
      span.end();
      return result;
    } catch (err) {
      return fail(err);
    }
  });
}

module.exports = { tracer, meter, instruments, withSpan, SpanStatusCode };
