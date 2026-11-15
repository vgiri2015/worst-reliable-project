'use strict';

/**
 * Load generator — simulates your customer base hammering the app.
 *
 * Each "customer" independently browses: lists customers, analyzes a random
 * one, occasionally saves an edit. Every failed request is a support ticket.
 *
 * Env:
 *   TARGET   base URL           (default http://localhost:3000)
 *   USERS    concurrent users   (default 25)
 *   RPM      requests/min/user  (default 12)
 *   DURATION seconds to run     (default 0 = run forever)
 */

// Telemetry first: instruments global fetch (undici) so every request carries a
// W3C traceparent header and client spans join the server's traces.
const telemetry = require('./telemetry');
telemetry.start({ serviceName: 'worst-pri-load-generator' });

const { SpanKind, SpanStatusCode } = require('@opentelemetry/api');
const { meter, withSpan } = require('./instruments');
const log = require('./log');

const loadgenRequests = meter.createCounter('loadgen.requests', {
  description: 'Requests sent by the simulated customer base, by outcome.',
  unit: '{request}',
});
const loadgenDuration = meter.createHistogram('loadgen.request.duration', {
  description: 'Client-observed latency per simulated customer action.',
  unit: 's',
  advice: { explicitBucketBoundaries: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 4, 5] },
});

const TARGET = process.env.TARGET || 'http://localhost:3000';
const USERS = Number(process.env.USERS || 25);
const RPM = Number(process.env.RPM || 12);
const DURATION = Number(process.env.DURATION || 0);

const IDS = ['c-001', 'c-002', 'c-003', 'c-004'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const stats = { requests: 0, ok: 0, failed: 0, tickets: 0, byCode: {} };

// One INTERNAL span per simulated customer action; the instrumented fetch()
// becomes its CLIENT child and the server's spans continue the same trace.
async function hit(pathAndOpts) {
  const [url, opts] = pathAndOpts;
  const method = (opts && opts.method) || 'GET';
  const action = method === 'POST' ? 'save_customer' : (url.endsWith('/analyze') ? 'analyze_customer' : 'list_customers');
  const started = process.hrtime.bigint();
  const outcome = await withSpan(`loadgen.${action}`, {
    kind: SpanKind.INTERNAL,
    attributes: { 'loadgen.action': action, 'url.path': url },
  }, (span) => hitUntraced(url, opts, span));
  const attrs = { 'loadgen.action': action, 'loadgen.outcome': outcome.result, 'http.response.status_code': outcome.code || 0 };
  loadgenRequests.add(1, attrs);
  loadgenDuration.record(Number(process.hrtime.bigint() - started) / 1e9, attrs);
}

async function hitUntraced(url, opts, span) {
  const requestId = `load-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.LOAD_FETCH_TIMEOUT_MS || 5000);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  stats.requests += 1;
  try {
    const res = await fetch(TARGET + url, {
      ...(opts || {}),
      headers: { ...((opts && opts.headers) || {}), 'x-request-id': requestId },
      signal: controller.signal,
    });
    const code = res.statusCode || res.status;
    stats.byCode[code] = (stats.byCode[code] || 0) + 1;
    span.setAttribute('http.response.status_code', code);
    // read body so corrupted-JSON responses also register as client-side failures
    let body = null;
    try {
      body = await res.json();
    } catch (err) {
      stats.failed += 1;
      stats.tickets += 1; // parse crash = angry customer
      log.error('[tomo-id-025] worst-pri-product/backend/load_generator.js: response JSON parse failed', { requestId, path: url, errorType: err.name, action: 'inspect server response body and content-type' });
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'response JSON parse failed' });
      return { result: 'parse_error', code };
    }
    if (code >= 400 || body === null) {
      stats.failed += 1;
      span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${code}` });
      return { result: 'http_error', code };
    }
    stats.ok += 1;
    return { result: 'success', code };
  } catch (err) {
    stats.failed += 1;
    stats.tickets += 1; // network/connection error
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    log.error('[tomo-id-026] worst-pri-product/backend/load_generator.js: request failed or timed out', { requestId, path: url, timeoutMs, errorType: err.name, action: 'verify target availability and timeout budget' });
    return { result: err.name === 'AbortError' ? 'timeout' : 'network_error', code: 0 };
  } finally {
    clearTimeout(timeoutId);
  }
}

function randomAction() {
  const r = Math.random();
  if (r < 0.5) return ['/api/customers', undefined];
  if (r < 0.9) return [`/api/customers/${pick(IDS)}/analyze`, undefined];
  return [
    '/api/customers',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: pick(IDS), name: 'Edited Name', monthlySpend: 123 }),
    },
  ];
}

async function userLoop(id, stopAt) {
  const interval = 60000 / RPM;
  while (!stopAt || Date.now() < stopAt) {
    await hit(randomAction());
    // jitter so users aren't perfectly synchronized
    await new Promise((r) => setTimeout(r, interval * (0.5 + Math.random())));
  }
}

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
    log.error('[tomo-id-019] worst-pri-product/backend/load_generator.js: metrics polling failed or timed out', { requestId, timeoutMs, errorType: err.name, action: 'verify metrics endpoint health and timeout budget' });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function bar(value, target) {
  const w = 30;
  const filled = Math.min(w, Math.round((value / target) * w));
  return '[' + '#'.repeat(filled) + '-'.repeat(w - filled) + ']';
}

async function report() {
  const m = await pollServerTickets();
  const serverTickets = m ? m.ticketsToday : '?';
  const projected = m ? m.projectedTicketsPerDay : '?';
  const clientFailRate = stats.requests ? ((stats.failed / stats.requests) * 100).toFixed(1) : '0.0';
  process.stdout.write('\x1Bc'); // clear screen
  console.log('  CUSTOMER BASE SIMULATOR  ->  ' + TARGET);
  console.log('  ' + USERS + ' users * ' + RPM + ' req/min each\n');
  console.log('  requests sent : ' + stats.requests);
  console.log('  succeeded     : ' + stats.ok);
  console.log('  FAILED        : ' + stats.failed + '  (' + clientFailRate + '% of requests)');
  console.log('  status codes  : ' + JSON.stringify(stats.byCode));
  console.log('');
  console.log('  SERVER-SIDE TICKETS TODAY : ' + serverTickets);
  console.log('  PROJECTED TICKETS / DAY   : ' + projected + '  (target 100)');
  if (typeof projected === 'number') {
    console.log('  ' + bar(projected, 100) + (projected >= 100 ? '  TARGET SMASHED 🔥' : '  ...climbing'));
  }
  console.log('\n  (Ctrl-C to stop)');
}

async function main() {
  console.log('Warming up ' + USERS + ' simulated customers against ' + TARGET + ' ...');
  const stopAt = DURATION ? Date.now() + DURATION * 1000 : 0;

  const users = [];
  for (let i = 0; i < USERS; i++) users.push(userLoop(i, stopAt));

  const reporter = setInterval(report, 1000);

  if (DURATION) {
    await Promise.all(users);
    clearInterval(reporter);
    await report();
    console.log('\nDone. Ran for ' + DURATION + 's.');
    await telemetry.shutdown();
    process.exit(0);
  }
}

// Flush buffered telemetry when run.sh (or Ctrl-C) stops the swarm.
async function stop() {
  await telemetry.shutdown();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

main();
