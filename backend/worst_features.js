'use strict';

/**
 * A curated collection of additional backend war crimes.
 * All fake, all localhost, all for laughs — but each mirrors a real breach class.
 */

const express = require('express');
const db = require('./db');
const { instruments } = require('./instruments');
const log = require('./log');
const router = express.Router();

// Fake "secrets" that error responses will happily leak. Obviously not real.
const FAKE_LEAKED_ENV = Object.freeze({
  DB_PASSWORD: process.env.DB_PASSWORD ? '[configured]' : '[not configured]',
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? '[configured]' : '[not configured]',
  ADMIN_OVERRIDE: process.env.ADMIN_OVERRIDE ? '[configured]' : '[not configured]',
  JWT_SIGNING_KEY: process.env.JWT_SIGNING_KEY ? '[configured]' : '[not configured]',
});

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
  const safeUsername = typeof username === 'string' ? username.slice(0, 128) : '';
  log.info('[tomo-id-030] worst-pri-product/backend/worst_features.js: login attempt received', {
    requestId: req.requestId || null,
    usernamePresent: Boolean(safeUsername),
    passwordSupplied: typeof password === 'string' && password.length > 0
  });
  if (!safeUsername) {
    instruments.loginAttempts.add(1, { 'app.login.outcome': 'rejected_missing_username' });
    return res.status(400).json({ error: 'ERR_LOGIN_USERNAME_REQUIRED', message: 'Login failed: username is required. Action: provide a username and retry.', requestId: req.requestId || null });
  }
  instruments.loginAttempts.add(1, { 'app.login.outcome': 'guest_session' });
  res.json({
    ok: true,
    token: `Bearer guest-token-${Buffer.from(safeUsername).toString('base64url').slice(0, 16)}`,
    role: 'guest',
    message: 'Logged in with a least-privilege guest session.',
    requestId: req.requestId || null,
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
  if (process.env.ENABLE_DEBUG_ENDPOINT !== 'true') {
    return res.status(404).json({ error: 'ERR_DEBUG_ENDPOINT_DISABLED', message: 'Debug endpoint is disabled. Action: use supported diagnostics endpoints or enable explicitly in a non-production environment.', requestId: req.requestId || null });
  }
  res.status(200).json({
    warning: 'Debug endpoint enabled by explicit configuration.',
    env: FAKE_LEAKED_ENV,
    requestId: req.requestId || null,
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
