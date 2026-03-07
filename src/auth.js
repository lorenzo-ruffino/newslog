'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const { getDb } = require('./db');

const SECRET_KEY = process.env.SECRET_KEY || 'dev-secret-change-in-production';
const JWT_EXPIRES_IN = '7d';
const MAGIC_LINK_EXPIRES_MINUTES = 15;
const INVITE_LINK_EXPIRES_MINUTES = 60;

function isSmtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: parseInt(process.env.SMTP_PORT || '587') === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { rejectUnauthorized: false }, // allow self-signed certs common in dev/VPS setups
  });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function sendMagicLink(email, token, baseUrl, locale = 'it', inviteContext = null) {
  if (!isSmtpConfigured()) {
    throw new Error('SMTP not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS in .env');
  }
  const transport = createTransport();
  const link = `${baseUrl}/auth/verify/${token}`;

  let subject, text, html;

  if (inviteContext) {
    subject = locale === 'en'
      ? `You've been invited to collaborate on ${inviteContext.blogTitle}`
      : `Sei stato invitato a collaborare su ${inviteContext.blogTitle}`;
    if (locale === 'en') {
      text = `Hi! ${inviteContext.inviterName} has invited you as an editor of the live blog "${inviteContext.blogTitle}" on NewsLog.\n\nClick the link to access:\n${link}\n\nThis link expires in 1 hour.`;
      html = `<p>Hi! <strong>${inviteContext.inviterName}</strong> has invited you as an editor of the live blog "<strong>${inviteContext.blogTitle}</strong>" on NewsLog.</p><p><a href="${link}">Click here to access</a></p><p><small>This link expires in 1 hour.</small></p>`;
    } else {
      text = `Ciao! ${inviteContext.inviterName} ti ha invitato come editor del live blog "${inviteContext.blogTitle}" su NewsLog.\n\nClicca il link per accedere:\n${link}\n\nQuesto link scade tra 1 ora.`;
      html = `<p>Ciao! <strong>${inviteContext.inviterName}</strong> ti ha invitato come editor del live blog "<strong>${inviteContext.blogTitle}</strong>" su NewsLog.</p><p><a href="${link}">Clicca qui per accedere</a></p><p><small>Questo link scade tra 1 ora.</small></p>`;
    }
  } else {
    subject = locale === 'en' ? 'Your NewsLog login link' : 'Il tuo link di accesso a NewsLog';
    if (locale === 'en') {
      text = `Click the link below to log in to NewsLog:\n${link}\n\nThis link expires in 15 minutes.`;
      html = `<p>Click the link below to log in to NewsLog:</p><p><a href="${link}">${link}</a></p><p><small>This link expires in 15 minutes.</small></p>`;
    } else {
      text = `Clicca il link qui sotto per accedere a NewsLog:\n${link}\n\nQuesto link scade tra 15 minuti.`;
      html = `<p>Clicca il link qui sotto per accedere a NewsLog:</p><p><a href="${link}">${link}</a></p><p><small>Questo link scade tra 15 minuti.</small></p>`;
    }
  }

  await transport.sendMail({
    from: process.env.SMTP_FROM || 'NewsLog <noreply@newslog.local>',
    to: email,
    subject,
    text,
    html,
  });
}

function generateMagicLinkToken(email, expiresMinutes = MAGIC_LINK_EXPIRES_MINUTES, inviteType = 'login', blogId = null) {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const id = uuidv4();
  const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO magic_links (id, email, token, expires_at, invite_type, blog_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, email, token, expiresAt, inviteType, blogId);

  return token;
}

function verifyMagicToken(token) {
  const db = getDb();
  const link = db.prepare('SELECT * FROM magic_links WHERE token = ? AND used = 0').get(token);
  if (!link) return null;
  if (new Date(link.expires_at) < new Date()) return null;
  db.prepare('UPDATE magic_links SET used = 1 WHERE id = ?').run(link.id);
  return link;
}

function createSession(userId) {
  const db = getDb();
  const tokenPayload = { userId, jti: uuidv4() };
  const token = jwt.sign(tokenPayload, SECRET_KEY, { expiresIn: JWT_EXPIRES_IN });
  const tokenHash = hashToken(token);
  const decoded = jwt.decode(token);
  const expiresAt = new Date(decoded.exp * 1000).toISOString();

  db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(uuidv4(), userId, tokenHash, expiresAt);

  return token;
}

function verifyJwt(token) {
  try {
    const payload = jwt.verify(token, SECRET_KEY);
    const db = getDb();
    const tokenHash = hashToken(token);
    const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > datetime(\'now\')').get(tokenHash);
    if (!session) return null;
    return payload;
  } catch {
    return null;
  }
}

function revokeSession(token) {
  const db = getDb();
  const tokenHash = hashToken(token);
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

function revokeUserSessions(userId) {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function getOrCreateUser(email) {
  const db = getDb();
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    const id = uuidv4();
    const name = email.split('@')[0];
    const isFirst = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt === 0;
    const role = isFirst ? 'admin' : 'editor';
    db.prepare(`
      INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)
    `).run(id, email, name, role);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  db.prepare('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?').run(user.id);
  return user;
}

function isEmailAllowed(email) {
  const allowed = process.env.ALLOWED_EMAILS;
  if (!allowed) return true; // If no restriction, allow all
  const list = allowed.split(',').map(e => e.trim().toLowerCase());
  return list.includes(email.toLowerCase());
}

// Express middleware
function requireAuth(req, res, next) {
  const token = req.cookies?.token || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const payload = verifyJwt(token);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  req.user = user;
  req.token = token;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

function requireBlogAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const db = getDb();
  const blog = db.prepare('SELECT * FROM blogs WHERE slug = ?').get(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  if (req.user.role === 'admin') { req.blog = blog; return next(); }

  // If blog is restricted, only explicit members can access
  let settings = {};
  try { settings = JSON.parse(blog.settings || '{}'); } catch {}
  if (settings.restricted) {
    const member = db.prepare('SELECT * FROM blog_members WHERE blog_id = ? AND user_id = ?').get(blog.id, req.user.id);
    if (!member) return res.status(403).json({ error: 'Forbidden' });
  }

  req.blog = blog;
  next();
}

module.exports = {
  generateMagicLinkToken,
  verifyMagicToken,
  createSession,
  verifyJwt,
  revokeSession,
  revokeUserSessions,
  getOrCreateUser,
  isEmailAllowed,
  sendMagicLink,
  requireAuth,
  requireAdmin,
  requireBlogAccess,
  INVITE_LINK_EXPIRES_MINUTES,
};
