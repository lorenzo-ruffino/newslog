'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const { getDb } = require('../db');

// GET /embed/:idOrSlug — serve the embeddable widget page
// Accepts numeric rowid (stable even if blog is renamed) or slug (legacy)
router.get('/:idOrSlug', (req, res) => {
  const db = getDb();
  const param = req.params.idOrSlug;
  const isNumeric = /^\d+$/.test(param);
  const blog = isNumeric
    ? db.prepare('SELECT rowid as numeric_id, * FROM blogs WHERE rowid = ?').get(Number(param))
    : db.prepare('SELECT rowid as numeric_id, * FROM blogs WHERE slug = ?').get(param);
  if (!blog) return res.status(404).send('Blog not found');

  let settings = {};
  try { settings = JSON.parse(blog.settings || '{}'); } catch {}

  const entries = db.prepare(`
    SELECT e.*, u.name as author_name, u.avatar_url as author_avatar
    FROM entries e
    JOIN users u ON u.id = e.author_id
    WHERE e.blog_id = ?
    ORDER BY e.is_pinned DESC, e.created_at DESC
    LIMIT 50
  `).all(blog.id);

  const locale = settings.locale || process.env.DEFAULT_LOCALE || 'it';

  res.send(renderWidgetHtml(blog, entries, settings, locale));
});

// GET /embed/resize.js — iframe auto-resize script
router.get('/resize.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.send(`(function(){
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'newslog-resize') {
      var iframes = document.querySelectorAll('iframe[src*="newslog"]');
      iframes.forEach(function(iframe) {
        if (iframe.contentWindow === e.source) {
          iframe.style.height = e.data.height + 'px';
        }
      });
    }
  });
})();`);
});

function renderWidgetHtml(blog, entries, settings, locale) {
  const theme = settings.theme || {};
  const colors = theme.colors || {};
  const layout = theme.layout || {};
  const typography = theme.typography || {};

  const fontFamily = typography.font_family === 'serif' ? 'Georgia, Times, serif'
    : typography.font_family === 'mono' ? 'monospace'
    : '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  const cssVars = `
    --nl-primary: ${colors.primary || '#2563EB'};
    --nl-primary-text: ${colors.primary_text || '#FFFFFF'};
    --nl-bg: ${colors.background || '#FFFFFF'};
    --nl-surface: ${colors.surface || '#F8FAFC'};
    --nl-text: ${colors.text || '#1E293B'};
    --nl-text2: ${colors.text_secondary || '#64748B'};
    --nl-border: ${colors.border || '#E2E8F0'};
    --nl-breaking: ${colors.breaking || '#DC2626'};
    --nl-pinned: ${colors.pinned || '#F59E0B'};
    --nl-live: ${colors.live_badge || '#16A34A'};
    --nl-live-bg: ${colors.live_badge_bg ? colors.live_badge_bg + '22' : 'rgba(22,163,74,0.13)'};
    --nl-max-width: ${layout.max_width || '720px'};
    --nl-font: ${fontFamily};
  `;

  const isLive = blog.status === 'live';
  const isPaused = blog.status === 'paused';

  const labels = locale === 'en' ? {
    live: 'LIVE', paused: 'PAUSED', ended: 'ENDED',
    new_updates: 'New updates', powered_by: 'Powered by NewsLog',
    breaking: 'BREAKING', pinned: 'PINNED', summary: 'SUMMARY',
  } : {
    live: 'IN DIRETTA', paused: 'IN PAUSA', ended: 'TERMINATO',
    new_updates: 'Nuovi aggiornamenti', powered_by: 'Powered by NewsLog',
    breaking: 'BREAKING', pinned: 'IN EVIDENZA', summary: 'RIEPILOGO',
  };

  const entryStyle = layout.entry_style || 'card';
  const showAvatars = layout.show_avatars !== false;
  const showTimestamps = layout.show_timestamps !== false;
  const showEntryCount = layout.show_entry_count !== false;
  const conversationMode = entryStyle === 'conversation';
  const widgetTitle = settings.widget_title || 'Liveblog';

  const authorPosMap = new Map();
  const entriesHtml = entries.map(entry => renderEntry(entry, entryStyle, showAvatars, showTimestamps, labels, locale, authorPosMap)).join('');

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(blog.title)}</title>
<link rel="stylesheet" href="/embed/widget.css">
<style>:root { ${cssVars} }</style>
</head>
<body class="nl-widget" data-mode="${theme.mode || 'light'}" data-style="${entryStyle}"${conversationMode ? ' data-conversation="true"' : ''}>
<div class="nl-container" style="max-width: var(--nl-max-width); font-family: var(--nl-font);">
  <div class="nl-header">
    <div class="nl-header-left">
      <h1 class="nl-title">${escapeHtml(widgetTitle)}</h1>
      ${blog.description ? `<p class="nl-description">${escapeHtml(blog.description)}</p>` : ''}
    </div>
    <div class="nl-header-right">
      <div class="nl-header-badges">
        ${isLive ? `<span class="nl-badge nl-badge-live" id="nl-status-badge">${labels.live}</span>` : ''}
        ${isPaused ? `<span class="nl-badge nl-badge-paused" id="nl-status-badge">${labels.paused}</span>` : ''}
        ${blog.status === 'ended' ? `<span class="nl-badge nl-badge-ended" id="nl-status-badge">${labels.ended}</span>` : ''}
        ${showEntryCount ? `<span class="nl-entry-count" id="nl-entry-count">${entries.length}</span>` : ''}
      </div>
    </div>
  </div>

  <div id="nl-new-updates-bar" class="nl-new-updates-bar" style="display:none;" onclick="nlScrollToTop()">
    <span>${labels.new_updates}</span>
  </div>

  <div class="nl-search-wrap">
    <input id="nl-search" class="nl-search" type="search" placeholder="${locale === 'en' ? 'Search updates…' : 'Cerca aggiornamenti…'}" autocomplete="off">
  </div>

  <div id="nl-feed" class="nl-feed">
    ${entriesHtml || '<div class="nl-empty">No updates yet.</div>'}
  </div>

</div>
<script src="/embed/widget.js"
  data-blog="${blog.slug}"
  data-locale="${locale}"
  data-labels='${JSON.stringify(labels)}'
  data-live="${isLive}"
></script>
<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>
</body>
</html>`;
}

function renderEntry(entry, style, showAvatars, showTimestamps, labels, locale, authorPosMap) {
  const typeClass = entry.entry_type !== 'update' ? `nl-entry-${entry.entry_type}` : '';
  const pinnedClass = entry.is_pinned ? 'nl-entry-pinned-top' : '';
  if (!authorPosMap.has(entry.author_id)) authorPosMap.set(entry.author_id, authorPosMap.size % 2);
  const authorPos = authorPosMap.get(entry.author_id);
  const typeBadge = entry.entry_type === 'breaking'
    ? `<span class="nl-type-badge nl-type-breaking">${labels.breaking}</span>`
    : entry.entry_type === 'pinned'
    ? `<span class="nl-type-badge nl-type-pinned">${labels.pinned}</span>`
    : entry.entry_type === 'summary'
    ? `<span class="nl-type-badge nl-type-summary">${labels.summary}</span>`
    : '';

  const dateStr = showTimestamps ? formatDate(entry.created_at, locale) : '';

  return `<div class="nl-entry ${typeClass} ${pinnedClass}" id="nl-entry-${entry.id}" data-id="${entry.id}" data-author-pos="${authorPos}">
    ${entry.is_pinned ? `<div class="nl-pinned-banner">${labels.pinned}</div>` : ''}
    <div class="nl-entry-header">
      ${showAvatars && entry.author_avatar ? `<img src="${escapeHtml(entry.author_avatar)}" class="nl-avatar" alt="${escapeHtml(entry.author_name)}" loading="lazy">` : ''}
      ${showAvatars && !entry.author_avatar ? `<div class="nl-avatar nl-avatar-placeholder">${(entry.author_name || 'U')[0].toUpperCase()}</div>` : ''}
      <span class="nl-author">${escapeHtml(entry.author_name || 'Unknown')}</span>
      ${typeBadge}
      ${showTimestamps ? `<time class="nl-time" datetime="${entry.created_at}">${dateStr}</time>` : ''}
    </div>
    <div class="nl-entry-content">${entry.content}</div>
  </div>`;
}

function formatDate(dateStr, locale) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleString(locale === 'en' ? 'en-US' : 'it-IT', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = router;
