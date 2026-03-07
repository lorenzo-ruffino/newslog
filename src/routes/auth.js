'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const {
  generateMagicLinkToken,
  verifyMagicToken,
  createSession,
  revokeSession,
  getOrCreateUser,
  isEmailAllowed,
  sendMagicLink,
  requireAuth,
  INVITE_LINK_EXPIRES_MINUTES,
} = require('../auth');

const { getDb } = require('../db');
const { detectLocale } = require('../utils');

const magicLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: (req) => req.body?.email?.toLowerCase() || req.ip,
  message: { error: 'Too many magic link requests. Please try again later.' },
});

// POST /auth/request
router.post('/request', magicLinkLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const db = getDb();
  const isFirstUser = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt === 0;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  // First user always gets through (becomes admin). After that, only existing users can log in.
  if (!isFirstUser && !user) {
    return res.status(403).json({ error: 'Email not authorized' });
  }
  const locale = user?.locale || detectLocale(req);

  const token = generateMagicLinkToken(email.toLowerCase());
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  try {
    await sendMagicLink(email.toLowerCase(), token, baseUrl, locale);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to send magic link:', err.message);
    // If SMTP is not configured, always return the debug link (useful during initial setup)
    const smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    if (!smtpConfigured) {
      const debugLink = `${baseUrl}/auth/verify/${token}`;
      console.log(`[SETUP] SMTP not configured. Magic link: ${debugLink}`);
      return res.json({ ok: true, debug_link: debugLink, smtp_warning: 'SMTP non configurato. Link di accesso restituito per il setup iniziale.' });
    }
    res.status(500).json({ error: `Invio email fallito: ${err.message}` });
  }
});

// GET /auth/verify/:token
router.get('/verify/:token', async (req, res) => {
  const link = verifyMagicToken(req.params.token);
  if (!link) {
    return res.redirect('/?error=invalid_token');
  }

  const user = getOrCreateUser(link.email);
  const jwtToken = createSession(user.id);

  // If blog invite, add user to blog
  if (link.invite_type === 'blog_invite' && link.blog_id) {
    const db = getDb();
    const { v4: uuidv4 } = require('uuid');
    try {
      db.prepare(`
        INSERT OR IGNORE INTO blog_members (id, blog_id, user_id, added_by)
        VALUES (?, ?, ?, ?)
      `).run(uuidv4(), link.blog_id, user.id, user.id);
    } catch (_) {}
  }

  res.cookie('token', jwtToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  const redirectUrl = link.blog_id
    ? `/?blog=${link.blog_id}`
    : '/';
  res.redirect(redirectUrl);
});

// POST /auth/logout
router.post('/logout', requireAuth, (req, res) => {
  revokeSession(req.token);
  res.clearCookie('token');
  res.json({ ok: true });
});

// GET /auth/me
router.get('/me', requireAuth, (req, res) => {
  const { id, email, name, role, avatar_url, locale } = req.user;
  res.json({ id, email, name, role, avatar_url, locale });
});

module.exports = router;
