'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const sanitizeHtml = require('sanitize-html');
const router = express.Router();

const { getDb } = require('../db');
const { requireAuth, requireAdmin, requireBlogAccess, getOrCreateUser, generateMagicLinkToken, sendMagicLink, INVITE_LINK_EXPIRES_MINUTES } = require('../auth');
const { broadcastToPublic, broadcastToEditors, addPublicClient, addEditorClient, getOnlineEditors } = require('../sse');
const { slugify } = require('../utils');
const { LRUCache } = require('lru-cache');

const entryCache = new LRUCache({ max: 500, ttl: 1000 * 60 });

const SANITIZE_OPTIONS = {
  allowedTags: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'ul', 'ol', 'li', 'blockquote', 'h2', 'h3', 'img', 'figure', 'figcaption', 'div', 'span', 'iframe', 'video', 'audio', 'source'],
  allowedAttributes: {
    'a': ['href', 'target', 'rel'],
    'img': ['src', 'alt', 'loading', 'style', 'class'],
    'iframe': ['src', 'frameborder', 'allowfullscreen', 'loading', 'style', 'class', 'allow'],
    'video': ['src', 'controls', 'style', 'class', 'poster', 'preload'],
    'audio': ['src', 'controls', 'style', 'class'],
    'source': ['src', 'type'],
    'div': ['class', 'style'],
    'span': ['class', 'style'],
    'figure': ['class'],
    'figcaption': ['class'],
    '*': ['class'],
  },
  allowedIframeHostnames: ['www.youtube-nocookie.com', 'www.youtube.com', 'player.vimeo.com', 'publish.twitter.com'],
};

function sanitize(html) {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

function getBlogBySlug(slug) {
  return getDb().prepare('SELECT rowid as numeric_id, * FROM blogs WHERE slug = ?').get(slug);
}

function parseSettings(blog) {
  try { blog.settings = JSON.parse(blog.settings || '{}'); } catch { blog.settings = {}; }
  return blog;
}

function formatEntry(entry, db) {
  const author = db.prepare('SELECT id, name, avatar_url FROM users WHERE id = ?').get(entry.author_id);
  return { ...entry, author };
}

// ─── BLOGS ────────────────────────────────────────────────────────────────────

// GET /api/blogs
router.get('/blogs', requireAuth, (req, res) => {
  const db = getDb();
  const allBlogs = db.prepare('SELECT rowid as numeric_id, * FROM blogs ORDER BY updated_at DESC').all().map(parseSettings);
  if (req.user.role === 'admin') {
    return res.json(allBlogs);
  }
  // For non-admins: show all non-restricted blogs + restricted blogs where user is a member
  const memberBlogIds = new Set(
    db.prepare('SELECT blog_id FROM blog_members WHERE user_id = ?').all(req.user.id).map(r => r.blog_id)
  );
  const visible = allBlogs.filter(b => !b.settings?.restricted || memberBlogIds.has(b.id));
  res.json(visible);
});

// POST /api/blogs
router.post('/blogs', requireAuth, requireAdmin, (req, res) => {
  const { title, description } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });

  const db = getDb();
  const id = uuidv4();
  let slug = slugify(title);

  // Ensure unique slug
  let slugCandidate = slug;
  let counter = 1;
  while (db.prepare('SELECT id FROM blogs WHERE slug = ?').get(slugCandidate)) {
    slugCandidate = `${slug}-${counter++}`;
  }
  slug = slugCandidate;

  db.prepare(`
    INSERT INTO blogs (id, slug, title, description, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, slug, title.trim(), description?.trim() || null, req.user.id);

  const blog = parseSettings(db.prepare('SELECT * FROM blogs WHERE id = ?').get(id));
  res.status(201).json(blog);
});

// GET /api/blogs/:slug
router.get('/blogs/:slug', requireAuth, (req, res) => {
  const blog = getBlogBySlug(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });
  res.json(parseSettings(blog));
});

// PATCH /api/blogs/:slug
router.patch('/blogs/:slug', requireAuth, requireAdmin, (req, res) => {
  const blog = getBlogBySlug(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  const db = getDb();
  const { title, description, status, settings } = req.body;

  if (title !== undefined) db.prepare('UPDATE blogs SET title = ?, updated_at = datetime(\'now\') WHERE id = ?').run(title, blog.id);
  if (description !== undefined) db.prepare('UPDATE blogs SET description = ?, updated_at = datetime(\'now\') WHERE id = ?').run(description, blog.id);
  if (status !== undefined) {
    if (!['live', 'paused', 'ended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    db.prepare('UPDATE blogs SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, blog.id);
    broadcastToPublic(blog.slug, 'blog_status', { status });
  }
  if (settings !== undefined) {
    db.prepare('UPDATE blogs SET settings = ?, updated_at = datetime(\'now\') WHERE id = ?').run(JSON.stringify(settings), blog.id);
  }

  const updated = parseSettings(db.prepare('SELECT * FROM blogs WHERE id = ?').get(blog.id));
  res.json(updated);
});

// DELETE /api/blogs/:slug
router.delete('/blogs/:slug', requireAuth, requireAdmin, (req, res) => {
  const blog = getBlogBySlug(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  getDb().prepare('DELETE FROM blogs WHERE id = ?').run(blog.id);
  res.json({ ok: true });
});

// ─── ENTRIES ──────────────────────────────────────────────────────────────────

// GET /api/blogs/:slug/entries
router.get('/blogs/:slug/entries', (req, res) => {
  const blog = getBlogBySlug(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20')));
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as cnt FROM entries WHERE blog_id = ?').get(blog.id).cnt;
  const entries = db.prepare(`
    SELECT * FROM entries WHERE blog_id = ?
    ORDER BY is_pinned DESC, created_at DESC
    LIMIT ? OFFSET ?
  `).all(blog.id, limit, offset);

  res.json({
    entries: entries.map(e => formatEntry(e, db)),
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  });
});

// POST /api/blogs/:slug/entries
router.post('/blogs/:slug/entries', requireAuth, requireBlogAccess, (req, res) => {
  const blog = req.blog || getBlogBySlug(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  if (blog.status !== 'live') {
    return res.status(400).json({ error: 'Blog is not accepting new entries' });
  }

  const { content, entry_type = 'update' } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Content is required' });
  if (!['update', 'breaking', 'pinned', 'summary'].includes(entry_type)) {
    return res.status(400).json({ error: 'Invalid entry type' });
  }

  const db = getDb();
  const id = uuidv4();
  const sanitized = sanitize(content);
  const isPinned = entry_type === 'pinned' ? 1 : 0;

  // If new entry is pinned, unpin all previously pinned entries for this blog
  if (isPinned) {
    const prevPinned = db.prepare('SELECT id FROM entries WHERE blog_id = ? AND is_pinned = 1').all(blog.id);
    if (prevPinned.length) {
      db.prepare('UPDATE entries SET is_pinned = 0, entry_type = \'update\', updated_at = datetime(\'now\') WHERE blog_id = ? AND is_pinned = 1').run(blog.id);
      prevPinned.forEach(p => {
        const updated = formatEntry(db.prepare('SELECT * FROM entries WHERE id = ?').get(p.id), db);
        broadcastToPublic(blog.slug, 'update_entry', updated, p.id);
      });
    }
  }

  db.prepare(`
    INSERT INTO entries (id, blog_id, author_id, content, entry_type, is_pinned)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, blog.id, req.user.id, sanitized, entry_type, isPinned);

  const entry = formatEntry(db.prepare('SELECT * FROM entries WHERE id = ?').get(id), db);
  entryCache.delete(blog.slug);

  broadcastToPublic(blog.slug, 'new_entry', entry, id);

  res.status(201).json(entry);
});

// PATCH /api/blogs/:slug/entries/:id
router.patch('/blogs/:slug/entries/:id', requireAuth, requireBlogAccess, (req, res) => {
  const blog = getBlogBySlug(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  const db = getDb();
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND blog_id = ?').get(req.params.id, blog.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  // Only admin or entry author can edit
  if (req.user.role !== 'admin' && entry.author_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { content, entry_type } = req.body;
  if (content !== undefined) {
    db.prepare('UPDATE entries SET content = ?, updated_at = datetime(\'now\') WHERE id = ?').run(sanitize(content), entry.id);
  }
  if (entry_type !== undefined) {
    if (!['update', 'breaking', 'pinned', 'summary'].includes(entry_type)) {
      return res.status(400).json({ error: 'Invalid entry type' });
    }
    const isPinned = entry_type === 'pinned' ? 1 : 0;
    db.prepare('UPDATE entries SET entry_type = ?, is_pinned = ?, updated_at = datetime(\'now\') WHERE id = ?').run(entry_type, isPinned, entry.id);
  }

  const updated = formatEntry(db.prepare('SELECT * FROM entries WHERE id = ?').get(entry.id), db);
  entryCache.delete(blog.slug);
  broadcastToPublic(blog.slug, 'update_entry', updated, entry.id);

  res.json(updated);
});

// DELETE /api/blogs/:slug/entries/:id
router.delete('/blogs/:slug/entries/:id', requireAuth, requireBlogAccess, (req, res) => {
  const blog = getBlogBySlug(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  const db = getDb();
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND blog_id = ?').get(req.params.id, blog.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  if (req.user.role !== 'admin' && entry.author_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  db.prepare('DELETE FROM entries WHERE id = ?').run(entry.id);
  entryCache.delete(blog.slug);
  broadcastToPublic(blog.slug, 'delete_entry', { id: entry.id });

  res.json({ ok: true });
});

// POST /api/blogs/:slug/entries/:id/pin
router.post('/blogs/:slug/entries/:id/pin', requireAuth, requireBlogAccess, (req, res) => {
  const blog = getBlogBySlug(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  const db = getDb();
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND blog_id = ?').get(req.params.id, blog.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  const newPinned = entry.is_pinned ? 0 : 1;
  // When unpinning a 'pinned'-type entry, revert it to 'update'
  const newType = (newPinned === 0 && entry.entry_type === 'pinned') ? 'update' : entry.entry_type;

  // If pinning, first unpin all other pinned entries for this blog
  if (newPinned === 1) {
    const prevPinned = db.prepare('SELECT id FROM entries WHERE blog_id = ? AND is_pinned = 1 AND id != ?').all(blog.id, entry.id);
    if (prevPinned.length) {
      db.prepare('UPDATE entries SET is_pinned = 0, entry_type = \'update\', updated_at = datetime(\'now\') WHERE blog_id = ? AND is_pinned = 1 AND id != ?').run(blog.id, entry.id);
      prevPinned.forEach(p => {
        const updated = formatEntry(db.prepare('SELECT * FROM entries WHERE id = ?').get(p.id), db);
        broadcastToPublic(blog.slug, 'update_entry', updated, p.id);
      });
    }
  }

  db.prepare('UPDATE entries SET is_pinned = ?, entry_type = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newPinned, newType, entry.id);

  const updated = formatEntry(db.prepare('SELECT * FROM entries WHERE id = ?').get(entry.id), db);
  entryCache.delete(blog.slug);
  broadcastToPublic(blog.slug, 'update_entry', updated, entry.id);

  res.json({ id: entry.id, is_pinned: newPinned, entry_type: newType });
});

// ─── SSE STREAMS ──────────────────────────────────────────────────────────────

// GET /api/blogs/:slug/stream (public)
router.get('/blogs/:slug/stream', (req, res) => {
  const blog = getBlogBySlug(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const lastEventId = req.headers['last-event-id'] || req.query.lastEventId || null;
  addPublicClient(blog.slug, res, lastEventId);

  // Send initial data if Last-Event-ID provided (catch-up)
  // NOTE: entry IDs are UUIDs, so we can't use `id > lastEventId` (alphabetical, not chronological).
  // Instead we look up the created_at of the last seen entry and fetch newer entries.
  if (lastEventId) {
    const db = getDb();
    const lastEntry = db.prepare('SELECT created_at FROM entries WHERE id = ?').get(lastEventId);
    if (lastEntry) {
      const missed = db.prepare(`
        SELECT * FROM entries
        WHERE blog_id = ? AND created_at > ? AND id != ?
        ORDER BY created_at ASC LIMIT 50
      `).all(blog.id, lastEntry.created_at, lastEventId);
      for (const e of missed) {
        res.write(`id: ${e.id}\nevent: new_entry\ndata: ${JSON.stringify(formatEntry(e, db))}\n\n`);
      }
    }
  }
});

// GET /api/blogs/:slug/editors-stream (authenticated)
router.get('/blogs/:slug/editors-stream', requireAuth, requireBlogAccess, (req, res) => {
  const blog = req.blog || getBlogBySlug(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Send current online editors
  const online = getOnlineEditors(blog.slug);
  res.write(`event: editors_list\ndata: ${JSON.stringify(online)}\n\n`);

  addEditorClient(blog.slug, res, req.user);
});

// POST /api/blogs/:slug/typing
router.post('/blogs/:slug/typing', requireAuth, requireBlogAccess, (req, res) => {
  const blog = getBlogBySlug(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  broadcastToEditors(blog.slug, 'editor_typing', {
    user_id: req.user.id,
    name: req.user.name,
  }, req.user.id);

  res.json({ ok: true });
});

// ─── MEMBERS ──────────────────────────────────────────────────────────────────

// GET /api/blogs/:slug/members
router.get('/blogs/:slug/members', requireAuth, requireAdmin, (req, res) => {
  const blog = getBlogBySlug(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  const db = getDb();
  const members = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.avatar_url, bm.added_at
    FROM blog_members bm
    JOIN users u ON u.id = bm.user_id
    WHERE bm.blog_id = ?
    ORDER BY bm.added_at ASC
  `).all(blog.id);

  res.json(members);
});

// POST /api/blogs/:slug/members
router.post('/blogs/:slug/members', requireAuth, requireAdmin, async (req, res) => {
  const blog = getBlogBySlug(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const db = getDb();
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  if (!user) {
    // Create user and send invite
    user = getOrCreateUser(email.toLowerCase());
    const token = generateMagicLinkToken(email.toLowerCase(), INVITE_LINK_EXPIRES_MINUTES, 'blog_invite', blog.id);

    try {
      await sendMagicLink(email.toLowerCase(), token, baseUrl, user.locale || 'it', {
        blogTitle: blog.title,
        inviterName: req.user.name,
      });
    } catch (err) {
      console.error('Failed to send invite:', err.message);
    }
  }

  // Add to blog members
  try {
    db.prepare(`
      INSERT OR IGNORE INTO blog_members (id, blog_id, user_id, added_by)
      VALUES (?, ?, ?, ?)
    `).run(uuidv4(), blog.id, user.id, req.user.id);
  } catch (err) {
    return res.status(400).json({ error: 'User is already a member' });
  }

  res.status(201).json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
});

// DELETE /api/blogs/:slug/members/:userId
router.delete('/blogs/:slug/members/:userId', requireAuth, requireAdmin, (req, res) => {
  const blog = getBlogBySlug(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  getDb().prepare('DELETE FROM blog_members WHERE blog_id = ? AND user_id = ?').run(blog.id, req.params.userId);
  res.json({ ok: true });
});

// ─── USERS (ADMIN) ────────────────────────────────────────────────────────────

// GET /api/users
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  const users = getDb().prepare('SELECT id, email, name, role, avatar_url, locale, created_at, last_login FROM users ORDER BY created_at ASC').all();
  res.json(users);
});

// POST /api/users/invite
router.post('/users/invite', requireAuth, requireAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const db = getDb();
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) user = getOrCreateUser(email.toLowerCase());

  const token = generateMagicLinkToken(email.toLowerCase());
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  try {
    await sendMagicLink(email.toLowerCase(), token, baseUrl, user.locale || 'it');
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to send invite:', err.message);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// PATCH /api/users/:id/role
router.patch('/users/:id/role', requireAuth, requireAdmin, (req, res) => {
  const { role } = req.body;
  if (!['admin', 'editor'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
  res.json({ ok: true });
});

// DELETE /api/users/:id
router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });

  getDb().prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// PATCH /api/users/me (update own profile)
router.patch('/users/me', requireAuth, (req, res) => {
  const { name, locale, avatar_url } = req.body;
  const db = getDb();

  if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  if (locale && ['it', 'en'].includes(locale)) db.prepare('UPDATE users SET locale = ? WHERE id = ?').run(locale, req.user.id);
  if (avatar_url !== undefined) db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatar_url, req.user.id);

  const user = db.prepare('SELECT id, email, name, role, avatar_url, locale FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

module.exports = router;
