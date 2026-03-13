'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getDb, normalizePinned } = require('../db');

// Cache-busting version based on widget.js mtime — computed once at startup
let _widgetVersion = Date.now();
try {
  const stat = fs.statSync(path.join(__dirname, '../../public/embed/widget.js'));
  _widgetVersion = stat.mtimeMs;
} catch (_) {}
const WIDGET_VERSION = _widgetVersion;

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

  const pageSize = parseInt(process.env.EMBED_PAGE_SIZE) || 50;
  const totalEntries = db.prepare('SELECT COUNT(*) as cnt FROM entries WHERE blog_id = ?').get(blog.id).cnt;
  normalizePinned(db, blog.id);

  const entries = db.prepare(`
    SELECT e.*, u.name as author_name, u.avatar_url as author_avatar
    FROM entries e
    JOIN users u ON u.id = e.author_id
    WHERE e.blog_id = ?
    ORDER BY e.is_pinned DESC, e.created_at DESC
    LIMIT ?
  `).all(blog.id, pageSize);

  const locale = settings.locale || process.env.DEFAULT_LOCALE || 'it';
  const timezone = process.env.TIMEZONE || 'Europe/Rome';

  res.send(renderWidgetHtml(db, blog, entries, settings, locale, timezone, totalEntries, pageSize));
});

// GET /embed/resize.js — iframe auto-resize script
router.get('/resize.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.send(`(function(){
  var knownIframes = [];
  function findIframeBySource(source) {
    for (var i = 0; i < knownIframes.length; i++) {
      if (knownIframes[i].contentWindow === source) return knownIframes[i];
    }
    var all = document.querySelectorAll('iframe');
    for (var i = 0; i < all.length; i++) {
      try {
        if (all[i].contentWindow === source) {
          knownIframes.push(all[i]);
          return all[i];
        }
      } catch(_) {}
    }
    return null;
  }

  // Deep-link: pass hash fragment to a specific iframe
  var hashPassed = false;
  function passHashToIframe(iframe) {
    var hash = window.location.hash;
    if (hash && hash.indexOf('#nl-entry-') === 0) {
      try {
        iframe.contentWindow.postMessage({
          type: 'newslog-scrollto',
          entryId: hash.replace('#nl-entry-', '')
        }, '*');
      } catch(_) {}
    }
  }
  function passHashToAll() {
    var hash = window.location.hash;
    if (!hash || hash.indexOf('#nl-entry-') !== 0) return;
    knownIframes.forEach(function(iframe) {
      try {
        iframe.contentWindow.postMessage({
          type: 'newslog-scrollto',
          entryId: hash.replace('#nl-entry-', '')
        }, '*');
      } catch(_) {}
    });
  }
  window.addEventListener('hashchange', passHashToAll);

  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.type) return;
    var iframe = findIframeBySource(e.source);
    if (!iframe) return;

    if (e.data.type === 'newslog-resize') {
      iframe.style.height = e.data.height + 'px';
      // First time we hear from this iframe: send parent URL + pass hash if present
      if (!hashPassed) {
        hashPassed = true;
        try {
          iframe.contentWindow.postMessage({
            type: 'newslog-parent-url',
            url: window.location.href.split('#')[0]
          }, '*');
        } catch(_) {}
        passHashToIframe(iframe);
      }
    }
    if (e.data.type === 'newslog-scrolltop') {
      iframe.scrollIntoView({behavior: 'smooth', block: 'start'});
    }
    if (e.data.type === 'newslog-scroll-to-entry') {
      var rect = iframe.getBoundingClientRect();
      var targetY = window.scrollY + rect.top + e.data.offsetTop - 20;
      var behavior = e.data.behavior === 'auto' ? 'auto' : 'smooth';
      window.scrollTo({ top: Math.max(0, targetY), behavior: behavior });
    }
    if (e.data.type === 'newslog-share') {
      var shareUrl = e.data.url;
      if (navigator.share) {
        navigator.share({ url: shareUrl }).catch(function() {
          fallbackShareCopy(iframe, shareUrl);
        });
      } else {
        fallbackShareCopy(iframe, shareUrl);
      }
    }
  });
  function fallbackShareCopy(iframe, url) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function() {
        showCopyToast();
        try { iframe.contentWindow.postMessage({ type: 'newslog-share-copied' }, '*'); } catch(_) {}
      }).catch(function() { execCopy(iframe, url); });
    } else {
      execCopy(iframe, url);
    }
  }
  function execCopy(iframe, url) {
    var ta = document.createElement('textarea');
    ta.value = url;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); } catch(_) {}
    ta.remove();
    showCopyToast();
    try { iframe.contentWindow.postMessage({ type: 'newslog-share-copied' }, '*'); } catch(_) {}
  }
  function showCopyToast() {
    var toast = document.getElementById('nl-copy-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'nl-copy-toast';
      toast.textContent = getCopyLabel();
      toast.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);background:#111827;color:#fff;padding:8px 12px;border-radius:999px;font-size:12px;font-family:system-ui, -apple-system, Segoe UI, sans-serif;z-index:2147483647;opacity:0;transition:opacity 160ms ease';
      document.body.appendChild(toast);
    } else {
      toast.textContent = getCopyLabel();
    }
    toast.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(function() { toast.style.opacity = '0'; }, 1600);
  }
  function getCopyLabel() {
    var lang = (document.documentElement.getAttribute('lang') || navigator.language || '').toLowerCase();
    return lang.indexOf('it') === 0 ? 'Link copiato' : 'Link copied';
  }

  // Send scroll position to iframes so they can show "new updates" banner
  var ticking = false;
  window.addEventListener('scroll', function() {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(function() {
        knownIframes.forEach(function(iframe) {
          try {
            var rect = iframe.getBoundingClientRect();
            iframe.contentWindow.postMessage({
              type: 'newslog-scroll',
              iframeTop: rect.top
            }, '*');
          } catch(_) {}
        });
        ticking = false;
      });
    }
  }, {passive: true});
})();`);
});

function renderWidgetHtml(db, blog, entries, settings, locale, timezone, totalEntries, pageSize) {
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
    enable_notifications: 'Enable notifications',
    notifications_enabled: 'Notifications enabled',
    notification_title: '{{blog_title}} — Breaking',
    share: 'Share', link_copied: 'Link copied', shared_entry: 'Shared entry',
  } : {
    live: 'IN DIRETTA', paused: 'IN PAUSA', ended: 'TERMINATO',
    new_updates: 'Nuovi aggiornamenti', powered_by: 'Powered by NewsLog',
    breaking: 'BREAKING', pinned: 'IN EVIDENZA', summary: 'RIEPILOGO',
    enable_notifications: 'Attiva notifiche',
    notifications_enabled: 'Notifiche attive',
    notification_title: '{{blog_title}} — Breaking',
    share: 'Condividi', link_copied: 'Link copiato', shared_entry: 'Messaggio condiviso',
  };

  const entryStyle = layout.entry_style || 'card';
  const showAvatars = layout.show_avatars !== false;
  const showTimestamps = layout.show_timestamps !== false;
  const showEntryCount = layout.show_entry_count !== false;
  const conversationMode = entryStyle === 'conversation';
  const widgetTitle = settings.widget_title || 'Liveblog';

  // Build author position map from chronological order (oldest first) across ALL entries
  const authorPosMap = new Map();
  if (conversationMode) {
    const authorOrder = db.prepare(`
      SELECT author_id, MIN(created_at) as first_at
      FROM entries WHERE blog_id = ?
      GROUP BY author_id ORDER BY first_at ASC
    `).all(blog.id);
    authorOrder.forEach(r => authorPosMap.set(r.author_id, authorPosMap.size % 2));
  }

  const entriesHtml = entries.map(entry => renderEntry(entry, entryStyle, showAvatars, showTimestamps, labels, locale, timezone, authorPosMap)).join('');

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(blog.title)}</title>
<link rel="stylesheet" href="/embed/widget.css?v=${WIDGET_VERSION}">
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
        ${showEntryCount ? `<span class="nl-entry-count" id="nl-entry-count">${totalEntries}</span>` : ''}
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
  ${totalEntries > entries.length ? `<button id="nl-load-more" class="nl-load-more">${locale === 'en' ? 'Load previous updates' : 'Carica aggiornamenti precedenti'}</button>` : ''}

</div>
<script src="/embed/widget.js?v=${WIDGET_VERSION}"
  data-blog="${blog.slug}"
  data-locale="${locale}"
  data-timezone="${timezone}"
  data-labels='${JSON.stringify(labels)}'
  data-live="${isLive}"
  data-page-size="${pageSize}"
  data-total="${totalEntries}"
></script>
</body>
</html>`;
}

function renderEntry(entry, style, showAvatars, showTimestamps, labels, locale, timezone, authorPosMap) {
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

  const dateStr = showTimestamps ? formatDate(entry.created_at, locale, timezone) : '';

  return `<div class="nl-entry ${typeClass} ${pinnedClass}" id="nl-entry-${entry.id}" data-id="${entry.id}" data-created-at="${entry.created_at}" data-updated-at="${entry.updated_at || entry.created_at}" data-author-id="${entry.author_id}" data-author-pos="${authorPos}">
    <div class="nl-entry-body">
      ${entry.is_pinned ? `<div class="nl-pinned-banner">${labels.pinned}</div>` : ''}
      <div class="nl-entry-header">
        ${showAvatars && entry.author_avatar ? `<img src="${escapeHtml(entry.author_avatar)}" class="nl-avatar" alt="${escapeHtml(entry.author_name)}" loading="lazy">` : ''}
        ${showAvatars && !entry.author_avatar ? `<div class="nl-avatar nl-avatar-placeholder">${(entry.author_name || 'U')[0].toUpperCase()}</div>` : ''}
        <span class="nl-author">${escapeHtml(entry.author_name || 'Unknown')}</span>
        ${typeBadge}
        ${showTimestamps ? `<time class="nl-time" datetime="${entry.created_at}">${dateStr}</time>` : ''}
      </div>
      ${entry.title ? `<div class="nl-entry-title">${escapeHtml(entry.title)}</div>` : ''}
      <div class="nl-entry-content">${entry.content}</div>
      <div class="nl-entry-footer">
        <button class="nl-share-btn" data-entry-id="${entry.id}" aria-label="Share">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        </button>
      </div>
    </div>
  </div>`;
}

function formatDate(dateStr, locale, timezone) {
  // SQLite CURRENT_TIMESTAMP is UTC but without 'Z' suffix — ensure UTC parsing
  const normalized = typeof dateStr === 'string' && !dateStr.endsWith('Z') && !dateStr.includes('+') ? dateStr + 'Z' : dateStr;
  const d = new Date(normalized);
  if (isNaN(d)) return dateStr;
  return d.toLocaleString(locale === 'en' ? 'en-US' : 'it-IT', {
    day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
    timeZone: timezone || 'Europe/Rome',
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = router;
;
