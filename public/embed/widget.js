/* NewsLog Widget JS — loaded inside the embed iframe */
(function () {
  'use strict';

  const script = document.currentScript;
  const blogSlug = script?.dataset.blog || document.querySelector('[data-blog]')?.dataset.blog;
  const locale = script?.dataset.locale || 'it';
  const timezone = script?.dataset.timezone || 'Europe/Rome';
  const isLive = script?.dataset.live === 'true';
  const pageSize = parseInt(script?.dataset.pageSize) || 50;
  let totalEntries = parseInt(script?.dataset.total) || 0;
  let labels = {};
  try { labels = JSON.parse(script?.dataset.labels || '{}'); } catch {}

  let currentPage = 1;
  let loadingMore = false;
  let lastEntryId = null;
  let eventSource = null;
  let reconnectDelay = 1000;
  let hasScrolledUp = false;
  let notificationsEnabled = false;
  let pendingNewEntries = 0;

  // ─── Auto-resize (postMessage to parent) ──────────────────────────────────
  function notifyResize() {
    const h = document.documentElement.scrollHeight;
    window.parent.postMessage({ type: 'newslog-resize', height: h, slug: blogSlug }, '*');
  }

  const resizeObserver = new ResizeObserver(() => notifyResize());
  resizeObserver.observe(document.body);
  window.addEventListener('load', notifyResize);

  // ─── Scroll detection ─────────────────────────────────────────────────────
  const feed = document.getElementById('nl-feed');
  const newUpdatesBar = document.getElementById('nl-new-updates-bar');

  if (feed) {
    window.addEventListener('scroll', () => {
      hasScrolledUp = window.scrollY > 50;
      if (!hasScrolledUp && newUpdatesBar) {
        newUpdatesBar.style.display = 'none';
        pendingNewEntries = 0;
      }
    });
  }

  window.nlScrollToTop = function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (newUpdatesBar) newUpdatesBar.style.display = 'none';
    pendingNewEntries = 0;
  };

  // ─── Notification button ──────────────────────────────────────────────────
  if (isLive && 'Notification' in window && Notification.permission !== 'granted') {
    const header = document.querySelector('.nl-header-right');
    if (header) {
      const btn = document.createElement('button');
      btn.className = 'nl-notify-btn';
      btn.id = 'nl-notify-btn';
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>${labels.enable_notifications || 'Notifications'}`;
      btn.addEventListener('click', requestNotifications);
      header.appendChild(btn);
    }
  } else if (Notification.permission === 'granted') {
    notificationsEnabled = true;
  }

  async function requestNotifications() {
    if (!('Notification' in window)) return;
    try {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        notificationsEnabled = true;
        const btn = document.getElementById('nl-notify-btn');
        if (btn) btn.style.display = 'none';
      } else if (perm === 'denied') {
        const btn = document.getElementById('nl-notify-btn');
        if (btn) btn.style.display = 'none';
      }
    } catch (_) {
      // Blocked in cross-origin iframe — hide button silently
      const btn = document.getElementById('nl-notify-btn');
      if (btn) btn.style.display = 'none';
    }
  }

  // ─── Audio notification ───────────────────────────────────────────────────
  let audioCtx = null;

  function unlockAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  }
  document.addEventListener('click', unlockAudio, { once: true });
  document.addEventListener('touchstart', unlockAudio, { once: true });

  function playBeep() {
    if (!audioCtx) return;
    const doPlay = () => {
      try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.4);
      } catch (_) {}
    };
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().then(doPlay).catch(() => {});
    } else {
      doPlay();
    }
  }

  // ─── SSE Connection with polling fallback for iOS ────────────────────────
  let heartbeatTimer = null;
  let sseFailCount = 0;
  let usePolling = false;
  let pollTimer = null;
  const HEARTBEAT_TIMEOUT = 45000; // server sends every 30s, allow 45s
  const POLL_INTERVAL = 5000;
  const SSE_MAX_FAILS = 2; // switch to polling after N failures

  function resetHeartbeatTimer() {
    clearTimeout(heartbeatTimer);
    sseFailCount = 0; // SSE is working
    heartbeatTimer = setTimeout(() => {
      // No data received — connection is likely dead (common on iOS)
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      sseFailCount++;
      if (sseFailCount >= SSE_MAX_FAILS) {
        // SSE is unreliable on this device, switch to polling
        usePolling = true;
        startPolling();
      } else {
        reconnectDelay = 1000;
        connect();
      }
    }, HEARTBEAT_TIMEOUT);
  }

  function connect() {
    if (!blogSlug) return;
    if (usePolling) { startPolling(); return; }
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }

    // Use lastEntryId as query param so server can send missed entries
    const url = lastEntryId
      ? `/api/blogs/${blogSlug}/stream?lastEventId=${encodeURIComponent(lastEntryId)}`
      : `/api/blogs/${blogSlug}/stream`;

    eventSource = new EventSource(url);

    eventSource.onopen = () => {
      reconnectDelay = 1000;
      resetHeartbeatTimer();
    };

    eventSource.addEventListener('heartbeat', () => {
      resetHeartbeatTimer();
    });

    eventSource.addEventListener('new_entry', (e) => {
      resetHeartbeatTimer();
      const entry = JSON.parse(e.data);
      lastEntryId = entry.id;
      if (document.getElementById(`nl-entry-${entry.id}`)) return;
      prependEntry(entry);
      notifyResize();
      playBeep();
    });

    eventSource.addEventListener('update_entry', (e) => {
      resetHeartbeatTimer();
      const entry = JSON.parse(e.data);
      updateEntry(entry);
    });

    eventSource.addEventListener('delete_entry', (e) => {
      resetHeartbeatTimer();
      const { id } = JSON.parse(e.data);
      removeEntry(id);
    });

    eventSource.addEventListener('blog_status', (e) => {
      resetHeartbeatTimer();
      const { status } = JSON.parse(e.data);
      updateBadge(status);
    });

    eventSource.onerror = () => {
      clearTimeout(heartbeatTimer);
      if (eventSource) eventSource.close();
      eventSource = null;
      sseFailCount++;
      if (sseFailCount >= SSE_MAX_FAILS) {
        usePolling = true;
        startPolling();
      } else {
        setTimeout(connect, Math.min(reconnectDelay, 30000));
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      }
    };
  }

  // ─── Polling fallback (for iOS Safari where SSE is unreliable) ──────────
  function startPolling() {
    if (pollTimer) return;
    poll(); // immediate first poll
    pollTimer = setInterval(poll, POLL_INTERVAL);
  }

  async function poll() {
    if (!blogSlug) return;
    try {
      const resp = await fetch(`/api/blogs/${blogSlug}/entries?limit=20`);
      if (!resp.ok) return;
      const data = await resp.json();
      const entries = data.entries || [];
      // Process in chronological order (oldest first) so newest ends up on top
      const sorted = entries.slice().reverse();
      for (const entry of sorted) {
        if (document.getElementById(`nl-entry-${entry.id}`)) continue;
        // Only show entries newer than what we already have
        if (lastEntryId) {
          const existing = document.getElementById(`nl-entry-${lastEntryId}`);
          if (!existing) { lastEntryId = entry.id; prependEntry(entry); notifyResize(); playBeep(); continue; }
        }
        lastEntryId = entry.id;
        prependEntry(entry);
        notifyResize();
        playBeep();
      }
      // Update existing entries content (handles edits)
      for (const entry of entries) {
        const el = document.getElementById(`nl-entry-${entry.id}`);
        if (el) {
          const contentEl = el.querySelector('.nl-entry-content');
          if (contentEl && contentEl.innerHTML !== entry.content) {
            updateEntry(entry);
          }
        }
      }
    } catch (_) {}
  }

  // ─── Visibility & pageshow handlers ─────────────────────────────────────
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isLive) {
      if (usePolling) {
        poll(); // immediate poll on visibility restore
      } else {
        reconnectDelay = 1000;
        connect();
      }
    }
  });

  window.addEventListener('pageshow', (e) => {
    if (e.persisted && isLive) {
      reconnectDelay = 1000;
      connect();
    }
  });

  // ─── DOM Manipulation ─────────────────────────────────────────────────────

  // Ensures all pinned entries sit above all non-pinned entries in the feed.
  // Called after every insert/update so ordering is always correct regardless
  // of SSE event order or timing.
  function ensurePinnedOrder(feed) {
    const pinned = Array.from(feed.querySelectorAll('.nl-entry-pinned-top'));
    if (!pinned.length) return;
    // Use feed.prepend() instead of insertBefore(p, firstElementChild) because
    // firstElementChild can be stale on iOS Safari immediately after a DOM mutation.
    // Reverse order preserves mutual ordering when multiple pinned entries exist.
    for (let i = pinned.length - 1; i >= 0; i--) {
      feed.prepend(pinned[i]);
    }
  }

  function prependEntry(entry) {
    const feed = document.getElementById('nl-feed');
    if (!feed) return;

    // Remove empty state
    const empty = feed.querySelector('.nl-empty');
    if (empty) empty.remove();

    const el = buildEntryEl(entry);

    if (hasScrolledUp) {
      // Show "new updates" bar
      pendingNewEntries++;
      if (newUpdatesBar) {
        newUpdatesBar.style.display = '';
        newUpdatesBar.querySelector('span').textContent = `${pendingNewEntries} ${labels.new_updates || 'New updates'}`;
      }
      feed.insertBefore(el, feed.firstElementChild);
      ensurePinnedOrder(feed);
    } else {
      feed.insertBefore(el, feed.firstElementChild);
      ensurePinnedOrder(feed);
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Reload Twitter widgets for new entries
    if (window.twttr?.widgets) window.twttr.widgets.load(el);

    // Breaking notification
    if (entry.entry_type === 'breaking' && notificationsEnabled && document.hidden) {
      new Notification(labels.notification_title?.replace('{{blog_title}}', document.title) || entry.entry_type, {
        body: entry.content.replace(/<[^>]+>/g, '').slice(0, 100),
      });
    }

    // Update count
    updateEntryCount(1);
  }

  function updateEntry(entry) {
    const el = document.getElementById(`nl-entry-${entry.id}`);
    if (!el) return;
    const feed = document.getElementById('nl-feed');
    const newEl = buildEntryEl(entry);
    el.replaceWith(newEl);
    if (feed) ensurePinnedOrder(feed);
  }

  function removeEntry(id) {
    const el = document.getElementById(`nl-entry-${id}`);
    if (el) el.remove();
    updateEntryCount(-1);
  }

  function updateEntryCount(delta) {
    const countEl = document.getElementById('nl-entry-count');
    if (!countEl) return;
    const current = parseInt(countEl.textContent) || 0;
    countEl.textContent = current + delta;
  }

  function updateBadge(status) {
    const badge = document.getElementById('nl-status-badge');
    if (!badge) return;
    badge.className = `nl-badge nl-badge-${status}`;
    const txt = status === 'live' ? labels.live : status === 'paused' ? labels.paused : labels.ended;
    badge.innerHTML = (status === 'live' ? '' : '') + (txt || status.toUpperCase());
  }

  function buildEntryEl(entry) {
    const el = document.createElement('div');
    const typeClass = entry.entry_type !== 'update' ? ` nl-entry-${entry.entry_type}` : '';
    const pinnedClass = entry.is_pinned ? ' nl-entry-pinned-top' : '';
    el.className = `nl-entry${typeClass}${pinnedClass}`;
    el.id = `nl-entry-${entry.id}`;
    el.dataset.id = entry.id;

    const authorName = entry.author?.name || 'Unknown';
    const authorAvatar = entry.author?.avatar_url;
    const typeBadge = entry.entry_type === 'breaking'
      ? `<span class="nl-type-badge nl-type-breaking">${labels.breaking || 'BREAKING'}</span>`
      : entry.entry_type === 'pinned' || entry.is_pinned
      ? `<span class="nl-type-badge nl-type-pinned">${labels.pinned || 'PINNED'}</span>`
      : entry.entry_type === 'summary'
      ? `<span class="nl-type-badge nl-type-summary">${labels.summary || 'SUMMARY'}</span>`
      : '';

    const dateStr = formatDate(entry.created_at);
    const avatarHtml = authorAvatar
      ? `<img src="${esc(authorAvatar)}" class="nl-avatar" alt="${esc(authorName)}" loading="lazy">`
      : `<div class="nl-avatar nl-avatar-placeholder">${(authorName[0] || 'U').toUpperCase()}</div>`;

    el.innerHTML = `
      ${entry.is_pinned ? `<div class="nl-pinned-banner">${labels.pinned || 'IN EVIDENZA'}</div>` : ''}
      <div class="nl-entry-header">
        ${avatarHtml}
        <span class="nl-author">${esc(authorName)}</span>
        ${typeBadge}
        <time class="nl-time" datetime="${entry.created_at}">${dateStr}</time>
      </div>
      <div class="nl-entry-content">${entry.content}</div>
    `;

    // Lazy load embeds via Intersection Observer
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(obs => {
          if (obs.isIntersecting) {
            obs.target.querySelectorAll('iframe[data-src]').forEach(iframe => {
              iframe.src = iframe.dataset.src;
              delete iframe.dataset.src;
            });
            observer.unobserve(obs.target);
          }
        });
      });
      observer.observe(el);
    }

    return el;
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d)) return '';
    return d.toLocaleString(locale === 'en' ? 'en-US' : 'it-IT', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: timezone,
    });
  }

  function esc(str) {
    if (!str) return '';
    return str.toString()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Load more (pagination) ──────────────────────────────────────────────
  const loadMoreBtn = document.getElementById('nl-load-more');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', loadMore);
  }

  async function loadMore() {
    if (loadingMore) return;
    loadingMore = true;
    if (loadMoreBtn) loadMoreBtn.disabled = true;

    currentPage++;
    try {
      const resp = await fetch(`/api/blogs/${blogSlug}/entries?page=${currentPage}&limit=${pageSize}`);
      if (!resp.ok) { currentPage--; return; }
      const data = await resp.json();
      const entries = data.entries || [];
      const feed = document.getElementById('nl-feed');
      if (!feed) return;

      for (const entry of entries) {
        if (document.getElementById(`nl-entry-${entry.id}`)) continue;
        const el = buildEntryEl(entry);
        feed.appendChild(el);
        if (window.twttr?.widgets) window.twttr.widgets.load(el);
      }

      totalEntries = data.total || totalEntries;
      const rendered = feed.querySelectorAll('.nl-entry').length;
      if (rendered >= totalEntries || entries.length < pageSize) {
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
      }

      notifyResize();
    } catch (_) {
      currentPage--;
    } finally {
      loadingMore = false;
      if (loadMoreBtn) loadMoreBtn.disabled = false;
    }
  }

  // ─── Search filter ────────────────────────────────────────────────────────
  const searchInput = document.getElementById('nl-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase().trim();
      document.querySelectorAll('#nl-feed .nl-entry').forEach(el => {
        const text = el.textContent.toLowerCase();
        el.style.display = !q || text.includes(q) ? '' : 'none';
      });
    });
  }

  // ─── Connect ──────────────────────────────────────────────────────────────
  if (isLive) {
    connect();
  }

})();
