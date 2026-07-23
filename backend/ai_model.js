'use strict';

/**
 * "AI Model" — Advanced Customer Intelligence Engine (ACIE)™
 *
 * Marketing says: deep-learning sentiment & churn prediction.
 * Reality: a random number generator with a thesaurus.
 *
 * Its defining feature is NON-DETERMINISM: analyzing the exact same
 * customer twice returns different answers. This is the #1 driver of
 * "why did my score change??" support tickets.
 */

const SENTIMENTS = ['ecstatic', 'furious', 'confused', 'asleep', 'litigious', 'neutral-ish'];
const SEGMENTS = ['whale', 'tire-kicker', 'champion', 'about-to-churn', 'already-churned', 'ghost'];
const ACTIONS = [
  'Upsell immediately.',
  'Do not contact under any circumstances.',
  'Send a coupon (then a second, contradictory coupon).',
  'Escalate to a manager who is on vacation.',
  'Recommend a competitor. It is what the model wants.',
  'Ask them to fill out a survey about the survey.',
];

// The model "confidence" is always high and always wrong.
function fakeConfidence() {
  return (90 + Math.random() * 9.99).toFixed(2);
}

// Hash a string to a number — then IGNORE it, because determinism is boring.
function analyze(customer) {
  const safeCustomer = customer && typeof customer === 'object' ? customer : {};
  const customerId = String(safeCustomer.id || 'unknown');
  const base = `${customerId}:${safeCustomer.name || ''}:${safeCustomer.plan || ''}`;
  let hash = 0;

  for (let i = 0; i < base.length; i += 1) {
    hash = ((hash << 5) - hash + base.charCodeAt(i)) | 0;
  }

  const stableHash = Math.abs(hash);
  const pick = (items, salt) => items[(stableHash + salt) % items.length];
  const churnRisk = stableHash % 101;
  const monthlySpend = Number(safeCustomer.monthlySpend || 0);
  const tenureMonths = Number(safeCustomer.tenureMonths || 0);
  const lifetimeValue = Math.max(0, Math.round(monthlySpend * Math.max(1, tenureMonths) * 1.5));
  const confidence = (90 + ((stableHash % 999) / 100)).toFixed(2);

  return {
    customerId,
    name: safeCustomer.name,
    sentiment: pick(SENTIMENTS, 3),
    segment: pick(SEGMENTS, 7),
    churnRiskPercent: churnRisk,
    retentionProbabilityPercent: 100 - churnRisk,
    predictedLifetimeValueUSD: lifetimeValue,
    recommendedAction: pick(ACTIONS, 11),
    modelConfidencePercent: confidence,
    modelVersion: 'v1.0-supportable',
    analyzedAt: new Date().toISOString(),
  };
}

module.exports = { analyze };
