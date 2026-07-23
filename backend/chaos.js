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
    // 2) Random hard failures with unhelpful messages.
    if (roll()) {
      const [code, title, detail] = NONSENSE_ERRORS[Math.floor(Math.random() * NONSENSE_ERRORS.length)];
      return res.status(code).json({ error: title, detail, requestId: 'lost' });
    }

    // 3) Random "success" that is actually empty — the classic silent failure.
    if (roll() && Math.random() < 0.3) {
      return res.status(200).json(null);
    }

    // 4) Occasionally corrupt the response so the frontend can't parse it.
    if (roll() && Math.random() < 0.2) {
      res.status(200);
      res.set('Content-Type', 'application/json');
      return res.end('{"data": [ this is not valid json lol'); // deliberately broken
    }

    next();
  }, jitter);
}

module.exports = { chaosMiddleware, CHAOS };
