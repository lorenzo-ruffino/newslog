'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db');
const { requireAuth, requireBlogAccess } = require('../auth');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');

// Convert a server-hosted /uploads/... URL to a base64 data URI for offline embedding
function inlineUrl(url) {
  if (!url) return null;
  try {
    // Extract path after /uploads/
    const match = url.match(/\/uploads\/(.+?)(\?.*)?$/);
    if (!match) return url;
    const filePath = path.join(UPLOADS_DIR, match[1]);
    if (!fs.existsSync(filePath)) return url;
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
    const mime = mimeMap[ext] || 'image/jpeg';
    const data = fs.readFileSync(filePath).toString('base64');
    return `data:${mime};base64,${data}`;
  } catch (_) {
    return url;
  }
}

// Replace /uploads/... src attributes in HTML content with inline base64 data URIs
function inlineContentImages(html) {
  return html.replace(/src="([^"]*\/uploads\/[^"]+)"/g, (match, url) => {
    const inlined = inlineUrl(url);
    return inlined ? `src="${inlined}"` : match;
  });
}

// GET /api/blogs/:slug/export
router.get('/blogs/:slug/export', requireAuth, requireBlogAccess, async (req, res) => {
  const db = getDb();
  const blog = db.prepare('SELECT * FROM blogs WHERE slug = ?').get(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  const format = req.query.format;

  if (format === 'json') {
    const entries = db.prepare(`
      SELECT e.*, u.name as author_name, u.avatar_url as author_avatar
      FROM entries e JOIN users u ON u.id = e.author_id
      WHERE e.blog_id = ?
      ORDER BY e.is_pinned DESC, e.created_at DESC
    `).all(blog.id);

    let settings = {};
    try { settings = JSON.parse(blog.settings || '{}'); } catch {}

    return res.json({ blog: { ...blog, settings }, entries });
  }

  // HTML export
  const opts = {
    inline_images: req.query.inline_images !== 'false',
    theme: req.query.theme || 'light',
    max_width: req.query.max_width || '720px',
  };

  const html = await generateStaticHtml(blog, opts, db);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${blog.slug}-export.html"`);
  res.send(html);
});

async function generateStaticHtml(blog, opts, db) {
  let settings = {};
  try { settings = JSON.parse(blog.settings || '{}'); } catch {}

  const locale = settings.locale || process.env.DEFAULT_LOCALE || 'it';
  const timezone = process.env.TIMEZONE || 'Europe/Rome';
  const entries = db.prepare(`
    SELECT e.*, u.name as author_name, u.avatar_url as author_avatar
    FROM entries e JOIN users u ON u.id = e.author_id
    WHERE e.blog_id = ?
    ORDER BY e.is_pinned DESC, e.created_at DESC
  `).all(blog.id);

  const baseUrl = process.env.BASE_URL || '';
  const authors = [...new Set(entries.map(e => e.author_name))];
  const lastEntry = entries.find(e => !e.is_pinned);
  const dateStr = lastEntry ? formatDate(lastEntry.created_at, locale, timezone) : formatDate(blog.created_at, locale, timezone);

  const labels = locale === 'en' ? {
    breaking: 'BREAKING', pinned: 'PINNED', summary: 'SUMMARY',
    generated: 'Generated with NewsLog',
    entries_count: `${entries.length} updates`,
    authors_count: `${authors.length} authors`,
  } : {
    breaking: 'BREAKING', pinned: 'IN EVIDENZA', summary: 'RIEPILOGO',
    generated: 'Generato con NewsLog',
    entries_count: `${entries.length} aggiornamenti`,
    authors_count: `${authors.length} autori`,
  };

  const entriesHtml = entries.map(e => renderExportEntry(e, opts, labels, locale, timezone, baseUrl, opts.inline_images)).join('\n');

  return `<!-- Inizio NewsLog Export: "${blog.title}" -->
<div class="newslog-export" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:${opts.max_width};margin:0 auto;color:#1E293B;background:#fff;padding:24px;">
  <div class="newslog-header" style="border-bottom:2px solid #E2E8F0;padding-bottom:16px;margin-bottom:24px;">
    <h2 style="margin:0 0 8px;font-size:1.5rem;">${escapeHtml(blog.title)}</h2>
    ${blog.description ? `<p style="margin:0 0 8px;color:#64748B;">${escapeHtml(blog.description)}</p>` : ''}
    <p class="newslog-meta" style="margin:0;color:#64748B;font-size:0.875rem;">${labels.entries_count} · ${dateStr} · ${labels.authors_count}</p>
  </div>
  <div class="newslog-entries">
    ${entriesHtml}
  </div>
  <div class="newslog-footer" style="border-top:1px solid #E2E8F0;padding-top:16px;margin-top:24px;text-align:center;color:#94A3B8;font-size:0.75rem;">
    <p>${labels.generated}</p>
  </div>
</div>
<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>
<!-- Fine NewsLog Export -->`;
}

function renderExportEntry(entry, opts, labels, locale, timezone, baseUrl = '', inlineImages = true) {
  const borderColor = entry.entry_type === 'breaking' ? '#DC2626'
    : entry.is_pinned ? '#F59E0B'
    : entry.entry_type === 'summary' ? '#0D9488'
    : '#E2E8F0';

  const badge = entry.entry_type === 'breaking'
    ? `<span style="background:#DC2626;color:#fff;font-size:0.7rem;font-weight:700;padding:2px 6px;border-radius:3px;margin-right:8px;">${labels.breaking}</span>`
    : entry.is_pinned
    ? `<span style="background:#F59E0B;color:#fff;font-size:0.7rem;font-weight:700;padding:2px 6px;border-radius:3px;margin-right:8px;">${labels.pinned}</span>`
    : entry.entry_type === 'summary'
    ? `<span style="background:#0D9488;color:#fff;font-size:0.7rem;font-weight:700;padding:2px 6px;border-radius:3px;margin-right:8px;">${labels.summary}</span>`
    : '';

  const timeStr = formatDate(entry.created_at, locale, timezone);
  const initials = (entry.author_name || 'U')[0].toUpperCase();

  return `<div id="nl-export-${entry.id}" style="border-left:3px solid ${borderColor};padding:12px 16px;margin-bottom:16px;background:#F8FAFC;border-radius:0 6px 6px 0;">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
    ${entry.author_avatar
      ? (() => {
          const src = inlineImages ? (inlineUrl(entry.author_avatar) || entry.author_avatar) : entry.author_avatar;
          return `<img src="${escapeHtml(src)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;" alt="">`;
        })()
      : `<div style="width:28px;height:28px;border-radius:50%;background:#2563EB;color:#fff;display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;">${initials}</div>`}
    <strong style="font-size:0.875rem;">${escapeHtml(entry.author_name || 'Unknown')}</strong>
    ${badge}
    <time style="font-size:0.75rem;color:#94A3B8;margin-left:auto;" datetime="${entry.created_at}">${timeStr}</time>
  </div>
  ${entry.title ? `<div style="font-size:1.05rem;font-weight:700;margin-bottom:4px;">${escapeHtml(entry.title)}</div>` : ''}
  <div style="font-size:0.9375rem;line-height:1.6;">${inlineImages ? inlineContentImages(entry.content) : entry.content}</div>
</div>`;
}


function formatDate(dateStr, locale, timezone) {
  const normalized = typeof dateStr === 'string' && !dateStr.endsWith('Z') && !dateStr.includes('+') ? dateStr + 'Z' : dateStr;
  const d = new Date(normalized);
  if (isNaN(d)) return dateStr;
  return d.toLocaleString(locale === 'en' ? 'en-US' : 'it-IT', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: timezone || 'Europe/Rome',
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = router;
