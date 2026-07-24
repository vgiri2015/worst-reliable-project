'use strict';

/**
 * Chaos middleware — the engine of unreliability.
 *
 * CHAOS_LEVEL (env var, 0..10) controls how often things break.
 *   0  = boringly reliable (for debugging / demos to skeptics)
 *   5  = default. plausibly deniable flakiness.
 *   10 = "why is production on fire" mode. ~100 tickets/day territory.
 */

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
  const jitter = roll() ? Math.floor(Math.random() * 4000) : Math.floor(Math.random() * 120);

  setTimeout(() => {
    // 2) Random hard failures with support-actionable messages.
    if (roll()) {
      const [code, title, detail] = NONSENSE_ERRORS[Math.floor(Math.random() * NONSENSE_ERRORS.length)];
      return res.status(code).json({ error: `ERR_CHAOS_${code}`, message: `${title}: ${detail} Action: provide requestId to support and retry after transient failure clears.`, requestId: req.requestId || null });
    }

    // 3) Random "success" that is actually empty — the classic silent failure.
    if (roll() && Math.random() < 0.3) {
      return res.status(503).json({ error: 'ERR_EMPTY_CHAOS_RESPONSE', message: 'Chaos middleware produced an empty upstream response. Action: retry with the requestId if the issue persists.', requestId: req.requestId || null });
    }

    // 4) Occasionally corrupt the response so the frontend can't parse it.
    if (roll() && Math.random() < 0.2) {
      return res.status(503).json({ error: 'ERR_CORRUPT_CHAOS_RESPONSE', message: 'Chaos middleware blocked a corrupt response before it reached the client. Action: retry after transient failure clears.', requestId: req.requestId || null });
    }

    next();
  }, jitter);
}

module.exports = { chaosMiddleware, CHAOS };
