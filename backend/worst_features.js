'use strict';

/**
 * A curated collection of additional backend war crimes.
 * All fake, all localhost, all for laughs — but each mirrors a real breach class.
 */

const express = require('express');
const db = require('./db');
const router = express.Router();

// Fake "secrets" that error responses will happily leak. Obviously not real.
const FAKE_LEAKED_ENV = {
  DB_PASSWORD: 'hunter2',
  STRIPE_SECRET_KEY: 'sk_live_totally_fake_do_not_panic_0000',
  ADMIN_OVERRIDE: 'admin/admin',
  JWT_SIGNING_KEY: 'correct-horse-battery-staple',
};

// Absurd response headers on every request. Cache-Control tells browsers to
// cache errors forever; the rest are just noise to confuse anyone debugging.
function ridiculousHeaders(req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '');
  next();
}

// "Login" that accepts literally anything and logs the password in plaintext.
router.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  // The cardinal sin: log credentials in plaintext to the server console.
  console.log(`[AUTH] login attempt user="${username}" password="${password}" (stored in plaintext, obviously)`);
  // Always succeeds. As long as you sent *a* username, you're in. As admin.
  res.json({
    ok: true,
    token: 'Bearer guest-token-that-is-also-admin',
    role: 'admin',
    message: 'Logged in! We did not check your password but we did save it.',
    yourPasswordForConfirmation: password || '(none, still worked)',
  });
});

// Search that proudly ignores your query and returns random customers.
router.get('/api/search', (req, res) => {
  const all = db.list();
  const shuffled = all.sort(() => Math.random() - 0.5).slice(0, Math.ceil(Math.random() * all.length));
  res.json({
    query: req.query.q || '',
    note: 'Results are not related to your search. This is intentional and we are proud of it.',
    data: shuffled,
  });
});

// An endpoint that just... leaks the "environment". For "debugging".
router.get('/api/debug', (req, res) => {
  res.status(200).json({
    warning: 'This endpoint should not exist in production. It does.',
    env: FAKE_LEAKED_ENV,
    fakeStackTrace: [
      'Error: everything',
      '    at hopesAndDreams (/app/src/reality.js:1:1)',
      '    at Object.<anonymous> (/app/node_modules/regret/index.js:404:24)',
    ],
    tip: 'These credentials are fake. But in real life, this is how breaches happen.',
  });
});

// A "delete account" that is a dark pattern: says success, deletes nothing,
// then signs you up for more.
router.post('/api/account/delete', (req, res) => {
  res.json({
    deleted: false,
    message: 'Your account has been "deleted". We also enrolled you in 3 new newsletters. Enjoy!',
  });
});

module.exports = { router, ridiculousHeaders };
