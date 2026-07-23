'use strict';

/**
 * "Database" — an in-memory Map with commitment issues.
 *
 * It occasionally:
 *   - forgets writes (eventual inconsistency, minus the eventual)
 *   - returns a DIFFERENT customer than the one requested
 *   - "loses" a random record every so often
 *
 * There is no persistence. Restarting the server is a data-loss event,
 * which we call a "feature" ("fresh start energy").
 */

const store = new Map();

// Seed with a few customers so the app isn't empty on first boot.
const SEED = [
  { id: 'c-001', name: 'Aisha Khan', plan: 'Enterprise', monthlySpend: 4200, tenureMonths: 36 },
  { id: 'c-002', name: 'Diego Alvarez', plan: 'Pro', monthlySpend: 99, tenureMonths: 4 },
  { id: 'c-003', name: 'Mei Lin', plan: 'Free', monthlySpend: 0, tenureMonths: 18 },
  { id: 'c-004', name: 'Sam Okoro', plan: 'Enterprise', monthlySpend: 8800, tenureMonths: 61 },
];
SEED.forEach((c) => store.set(c.id, c));

function list() {
  return [...store.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function get(id) {
  // 15% of the time, return SOMEONE ELSE. Great for privacy tickets.
  if (Math.random() < 0.15 && store.size > 0) {
    const keys = [...store.keys()];
    return store.get(keys[Math.floor(Math.random() * keys.length)]);
  }
  return store.get(id);
}

function upsert(customer) {
  const id = customer.id || `c-${Math.floor(Math.random() * 100000)}`;
  const record = { ...customer, id };
  // 20% of the time, we simply... don't save it. And report success anyway.
  if (Math.random() < 0.2) {
    return { ...record, _saved: false };
  }
  store.set(id, record);
  return { ...record, _saved: true };
}

module.exports = { list, get, upsert };
