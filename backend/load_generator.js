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

const TARGET = process.env.TARGET || 'http://localhost:3000';
const USERS = Number(process.env.USERS || 25);
const RPM = Number(process.env.RPM || 12);
const DURATION = Number(process.env.DURATION || 0);

const IDS = ['c-001', 'c-002', 'c-003', 'c-004'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const stats = { requests: 0, ok: 0, failed: 0, tickets: 0, byCode: {} };

async function hit(pathAndOpts) {
  const [url, opts] = pathAndOpts;
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
    // read body so corrupted-JSON responses also register as client-side failures
    let body = null;
    try {
      body = await res.json();
    } catch (err) {
      stats.failed += 1;
      stats.tickets += 1; // parse crash = angry customer
      console.error(JSON.stringify({ level: 'error', message: '[tomo-id-025] worst-pri-product/backend/load_generator.js: response JSON parse failed', requestId, path: url, errorType: err.name, action: 'inspect server response body and content-type' }));
      return;
    }
    if (code >= 400 || body === null) {
      stats.failed += 1;
    } else {
      stats.ok += 1;
    }
  } catch (err) {
    stats.failed += 1;
    stats.tickets += 1; // network/connection error
    console.error(JSON.stringify({ level: 'error', message: '[tomo-id-026] worst-pri-product/backend/load_generator.js: request failed or timed out', requestId, path: url, timeoutMs, errorType: err.name, action: 'verify target availability and timeout budget' }));
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
  try {
    const res = await fetch(TARGET + '/api/metrics');
    const m = await res.json();
    return m;
  } catch (_) {
    return null;
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
    process.exit(0);
  }
}

main();
