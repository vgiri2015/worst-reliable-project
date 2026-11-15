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

const { SpanKind } = require('@opentelemetry/api');
const { instruments, withSpan } = require('./instruments');

const store = new Map();

// Every store operation is a CLIENT span + counter, so N+1 patterns and hot
// paths are visible in traces (db.* attributes follow OTel semantic conventions).
function traced(operation, fn) {
  instruments.dbOperations.add(1, { 'db.operation.name': operation });
  return withSpan(`${operation} customers`, {
    kind: SpanKind.CLIENT,
    attributes: {
      'db.system.name': 'in-memory',
      'db.collection.name': 'customers',
      'db.operation.name': operation,
    },
  }, fn);
}

// Seed with a few customers so the app isn't empty on first boot.
const SEED = [
  { id: 'c-001', name: 'Aisha Khan', plan: 'Enterprise', monthlySpend: 4200, tenureMonths: 36 },
  { id: 'c-002', name: 'Diego Alvarez', plan: 'Pro', monthlySpend: 99, tenureMonths: 4 },
  { id: 'c-003', name: 'Mei Lin', plan: 'Free', monthlySpend: 0, tenureMonths: 18 },
  { id: 'c-004', name: 'Sam Okoro', plan: 'Enterprise', monthlySpend: 8800, tenureMonths: 61 },
];
SEED.forEach((c) => store.set(c.id, c));

function list() {
  return traced('list', (span) => {
    const rows = [...store.values()].sort((left, right) => left.id.localeCompare(right.id));
    span.setAttribute('db.response.returned_rows', rows.length);
    return rows;
  });
}

function get(id) {
  return traced('get', (span) => {
    const row = store.get(id);
    span.setAttributes({ 'app.customer.id': String(id), 'db.response.returned_rows': row ? 1 : 0 });
    return row;
  });
}

function size() {
  return store.size;
}

function upsert(customer) {
  return traced('upsert', (span) => upsertUntraced(customer, span));
}

function upsertUntraced(customer, span) {
  const safeCustomer = customer && typeof customer === 'object' && !Array.isArray(customer) ? customer : {};
  const rawId = safeCustomer.id ? String(safeCustomer.id) : `c-${Math.floor(Math.random() * 100000)}`;
  const id = rawId.slice(0, 64);
  const record = {
    ...safeCustomer,
    id,
    name: typeof safeCustomer.name === 'string' ? safeCustomer.name.slice(0, 128) : safeCustomer.name,
    plan: typeof safeCustomer.plan === 'string' ? safeCustomer.plan.slice(0, 64) : safeCustomer.plan,
  };
  const existed = store.has(id);
  store.set(id, record);
  span.setAttributes({ 'app.customer.id': id, 'app.db.upsert.created': !existed });
  return { ...record, _saved: true };
}

module.exports = { list, get, upsert, size };
