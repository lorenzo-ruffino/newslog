/* NewsLog Admin SPA */
'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  user: null,
  locale: localStorage.getItem('nl-locale') || 'it',
  theme: localStorage.getItem('nl-theme') || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  blogs: [],
  activeBlog: null,
  entries: [],
  members: [],
  entryType: 'update',
  pendingEmbeds: [],
  typingTimers: {},
  editorSSE: null,
  feedSSE: null,
  onlineEditors: [],
  soundEnabled: localStorage.getItem('nl-sound') !== 'off',
};

// ─── Translations ─────────────────────────────────────────────────────────────
let i18n = {};

async function loadTranslations(locale) {
  const resp = await fetch(`/locales/${locale}.json`).catch(() => null);
  if (resp?.ok) {
    i18n = await resp.json();
  } else {
    // Inline minimal fallback
    i18n = {
      auth: { login_title: 'Sign in to NewsLog', email_placeholder: 'Your email', send_link: 'Send login link', check_email: 'Check your email' },
      blog: { new_blog: 'New Live Blog', status_live: 'Live', status_paused: 'Paused', status_ended: 'Ended', no_entries_yet: 'No entries yet.' },
      editor: { placeholder: 'Write an update...', publish_btn: 'Publish', type_update: 'Update', type_breaking: 'Breaking', type_pinned: 'Pinned', type_summary: 'Summary' },
      common: { save: 'Save', cancel: 'Cancel', delete: 'Delete', edit: 'Edit', copy: 'Copy', copied: 'Copied!' },
    };
  }
}

function t(key, vars = {}) {
  const parts = key.split('.');
  let val = i18n;
  for (const p of parts) { val = val?.[p]; if (val === undefined) break; }
  if (typeof val !== 'string') return key;
  return val.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  if (resp.status === 401) { showLogin(); return null; }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  await loadTranslations(state.locale);
  applyTheme(state.theme);
  applyLocaleUI();

  // Try to get current user
  const user = await api('GET', '/auth/me');
  if (!user) return showLogin();

  state.user = user;
  if (user.locale && user.locale !== state.locale) {
    state.locale = user.locale;
    await loadTranslations(state.locale);
    applyLocaleUI();
  }

  showApp();
  await loadBlogs();

  // Show onboarding for new users who haven't set their name yet
  const emailPrefix = user.email.split('@')[0];
  if (user.name === emailPrefix || !user.name) {
    showOnboardingModal();
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  applyLoginTranslations();
}

function applyLoginTranslations() {
  const tEl = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
  tEl('login-title', 'auth.login_title');
  tEl('login-heading', 'auth.login_heading');
  const btn = document.querySelector('#login-form button[type="submit"]');
  if (btn) btn.textContent = t('auth.send_link');
  const input = document.getElementById('login-email');
  if (input) input.placeholder = t('auth.email_placeholder');
}

document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const btn = document.querySelector('#login-form button[type="submit"]');
  btn.disabled = true;
  btn.textContent = t('common.loading');

  try {
    const result = await api('POST', '/auth/request', { email });
    if (result) {
      document.getElementById('login-form-view').classList.add('hidden');
      document.getElementById('login-sent-view').classList.remove('hidden');
      document.getElementById('login-sent-desc').textContent = t('auth.check_email_desc', { email });

      if (result.debug_link) {
        // SMTP not configured — show clickable link directly
        const sentView = document.getElementById('login-sent-view');
        sentView.querySelector('p').textContent = result.smtp_warning || t('auth.smtp_warning');
        const btn2 = document.createElement('a');
        btn2.href = result.debug_link;
        btn2.textContent = t('auth.dev_login_now');
        btn2.style.cssText = 'display:inline-block;margin-top:16px;padding:10px 20px;background:#2563EB;color:#fff;border-radius:6px;font-weight:600;text-decoration:none;';
        sentView.appendChild(btn2);
        const small = document.createElement('p');
        small.style.cssText = 'margin-top:10px;font-size:0.72rem;color:#8B90A0;word-break:break-all;';
        small.textContent = result.debug_link;
        sentView.appendChild(small);
      }
    }
  } catch (err) {
    const errEl = document.getElementById('login-error');
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = t('auth.send_link');
  }
});

// ─── App ──────────────────────────────────────────────────────────────────────
function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  // Set user display
  const nameEl = document.getElementById('user-name-display');
  if (nameEl) nameEl.textContent = state.user.name;
  const avatarEl = document.getElementById('user-avatar');
  if (avatarEl) setAvatar(avatarEl, state.user);

  // Admin controls
  if (state.user.role === 'admin') {
    document.getElementById('btn-new-blog').style.display = '';
  }

  bindTopbarEvents();
  bindComposerEvents();
  bindRightPanelEvents();
  initResizers();
  applyLocaleUI();
}

function applyLocaleUI() {
  document.querySelectorAll('.locale-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.locale === state.locale);
  });

  // Process data-i18n attributes (textContent)
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const val = t(el.dataset.i18n);
    if (val !== el.dataset.i18n) el.textContent = val;
  });
  // Process data-i18n-placeholder attributes
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const val = t(el.dataset.i18nPlaceholder);
    if (val !== el.dataset.i18nPlaceholder) el.placeholder = val;
  });
  // Process data-i18n-title attributes
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const val = t(el.dataset.i18nTitle);
    if (val !== el.dataset.i18nTitle) el.title = val;
  });

  const tEl = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
  tEl('btn-new-blog-text', 'blog.new_blog');
  const compEditor = document.getElementById('compose-editor');
  if (compEditor) compEditor.dataset.placeholder = t('editor.placeholder');
  const pubBtn = document.getElementById('btn-publish');
  if (pubBtn) pubBtn.textContent = t('editor.publish_btn');
  updateTypeButtons();
  applyLoginTranslations();
}

function applyMobileThemeIcon() {
  const sunM = document.querySelector('.icon-sun-m');
  const moonM = document.querySelector('.icon-moon-m');
  if (sunM) sunM.classList.toggle('hidden', state.theme === 'dark');
  if (moonM) moonM.classList.toggle('hidden', state.theme === 'light');
}

function applyMobileSoundIcon() {
  document.getElementById('icon-sound-on-m')?.classList.toggle('hidden', !state.soundEnabled);
  document.getElementById('icon-sound-off-m')?.classList.toggle('hidden', state.soundEnabled);
}

function openMobileSettings() {
  const sheet = document.getElementById('mobile-settings-sheet');
  if (!sheet) return;
  // Populate user info
  if (state.user) {
    document.getElementById('mobile-user-name').textContent = state.user.name || '';
    document.getElementById('mobile-user-email').textContent = state.user.email || '';
    const avatarEl = document.getElementById('mobile-avatar');
    if (avatarEl) setAvatar(avatarEl, state.user);
    // Show admin-only buttons
    if (state.user.role === 'admin') {
      document.getElementById('mobile-btn-users').style.display = '';
      document.getElementById('mobile-btn-backup').style.display = '';
    }
  }
  applyMobileThemeIcon();
  applyMobileSoundIcon();
  sheet.classList.add('open');
}

function closeMobileSettings() {
  document.getElementById('mobile-settings-sheet')?.classList.remove('open');
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const sunIcon = document.querySelector('.icon-sun');
  const moonIcon = document.querySelector('.icon-moon');
  if (sunIcon) sunIcon.classList.toggle('hidden', theme === 'dark');
  if (moonIcon) moonIcon.classList.toggle('hidden', theme === 'light');
  // Update logo srcs based on theme
  const brandLogo = document.getElementById('brand-logo-img');
  if (brandLogo) brandLogo.src = theme === 'light' ? '/logo-square-light.jpg' : '/logo-square-dark.jpg';
  const loginLogo = document.getElementById('login-logo-img');
  if (loginLogo) loginLogo.src = theme === 'light' ? '/logo-rect-light.jpg' : '/logo-rect-dark.jpg';
}

// ─── Blogs ────────────────────────────────────────────────────────────────────
async function loadBlogs() {
  const blogs = await api('GET', '/api/blogs');
  if (!blogs) return;
  state.blogs = blogs;
  renderBlogsList();
  // Auto-select most recent blog on first load
  if (blogs.length && !state.activeBlog) {
    selectBlog(blogs[0]);
  }
}

function renderBlogsList() {
  const list = document.getElementById('blogs-list');
  if (!list) return;
  list.innerHTML = '';
  if (!state.blogs.length) {
    list.innerHTML = `<div style="padding:10px 10px;font-size:0.8rem;color:var(--text3);">${t('blog.no_blogs')}</div>`;
    return;
  }
  state.blogs.forEach(blog => {
    const item = document.createElement('div');
    item.className = `blog-item${state.activeBlog?.id === blog.id ? ' active' : ''}`;
    item.dataset.id = blog.id;
    const createdDate = blog.created_at
      ? new Date(blog.created_at).toLocaleDateString(state.locale === 'en' ? 'en-US' : 'it-IT', { day: 'numeric', month: 'short', year: 'numeric' })
      : '';
    item.innerHTML = `
      <div class="blog-status-dot ${blog.status}"></div>
      <div class="blog-item-info">
        <span class="blog-item-title">${escHtml(blog.title)}</span>
        ${createdDate ? `<span class="blog-item-date">${createdDate}</span>` : ''}
      </div>
    `;
    item.addEventListener('click', () => selectBlog(blog));
    list.appendChild(item);
  });
}

async function selectBlog(blog) {
  state.activeBlog = blog;
  renderBlogsList();

  document.getElementById('empty-state')?.classList.add('hidden');
  document.getElementById('workspace')?.classList.remove('hidden');
  // Default mobile view: compose
  const mainArea = document.getElementById('main-area');
  if (mainArea && !mainArea.dataset.mobileView) mainArea.dataset.mobileView = 'compose';
  document.getElementById('topbar-blog-info').style.display = '';
  document.getElementById('topbar-blog-title').textContent = blog.title;
  const renameBtn = document.getElementById('btn-rename-blog');
  if (renameBtn) renameBtn.style.display = state.user?.role === 'admin' ? '' : 'none';

  updateBlogStatusUI(blog.status);

  document.getElementById('btn-embed-snippet').style.display = '';
  document.getElementById('btn-export').style.display = '';

  // Disconnect previous SSE
  disconnectSSE();

  await loadEntries();
  await loadMembers();
  updatePreviewIframe();
  renderThemePanel();

  // Connect SSE
  connectPublicSSE(blog.slug);
  connectEditorSSE(blog.slug);
}

async function loadEntries() {
  if (!state.activeBlog) return;
  const data = await api('GET', `/api/blogs/${state.activeBlog.slug}/entries?limit=50`);
  if (!data) return;
  state.entries = data.entries;
  renderFeed();
  bindFeedSearch();
  const countEl = document.getElementById('feed-count');
  if (countEl) countEl.textContent = t('blog.entries_count', { count: data.total });
}

function renderFeed(filter = '') {
  const feed = document.getElementById('feed');
  if (!feed) return;
  feed.innerHTML = '';
  const filtered = filter
    ? state.entries.filter(e => e.content.replace(/<[^>]+>/g, '').toLowerCase().includes(filter.toLowerCase()))
    : state.entries;
  if (!filtered.length) {
    feed.innerHTML = `<div style="text-align:center;color:var(--text3);padding:40px 20px;font-size:0.875rem;">${filter ? t('blog.no_results') : t('blog.no_entries_yet')}</div>`;
    return;
  }
  filtered.forEach(entry => {
    feed.appendChild(createEntryElement(entry));
  });
}

function bindFeedSearch() {
  const searchEl = document.getElementById('feed-search');
  if (!searchEl) return;
  searchEl.value = '';
  searchEl.oninput = () => renderFeed(searchEl.value.trim());
}

function createEntryElement(entry) {
  const el = document.createElement('div');
  el.className = `feed-entry${entry.entry_type !== 'update' ? ' ' + entry.entry_type : ''}${entry.is_pinned ? ' is-pinned' : ''}`;
  el.id = `entry-${entry.id}`;
  el.dataset.id = entry.id;

  const authorName = entry.author?.name || 'Unknown';
  const authorAvatar = entry.author?.avatar_url;
  const typeBadge = entry.entry_type !== 'update'
    ? `<span class="entry-type-badge type-${entry.entry_type}">${t(`editor.type_${entry.entry_type}`)}</span>` : '';
  const canEdit = state.user.role === 'admin' || entry.author_id === state.user.id;

  el.innerHTML = `
    ${entry.is_pinned ? `<div class="entry-pinned-banner">${t('editor.type_pinned')}</div>` : ''}
    <div class="entry-header">
      <div class="avatar-sm">${authorAvatar ? `<img src="${escHtml(authorAvatar)}" alt="">` : authorName[0].toUpperCase()}</div>
      <span class="entry-author">${escHtml(authorName)}</span>
      ${typeBadge}
      <time class="entry-time">${formatDate(entry.created_at)}</time>
    </div>
    <div class="entry-content">${entry.content}</div>
    ${canEdit ? `<div class="entry-actions">
      <button class="entry-action-btn" title="${t('editor.pin_entry')}" data-action="pin">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="${entry.is_pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
      </button>
      <button class="entry-action-btn" title="${t('common.edit')}" data-action="edit">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="entry-action-btn danger" title="${t('common.delete')}" data-action="delete">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6m4-6v6"/><path d="M9 6V4h6v2"/></svg>
      </button>
    </div>` : ''}
  `;

  // Entry action events
  el.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleEntryAction(entry, btn.dataset.action);
    });
  });

  return el;
}

async function handleEntryAction(entry, action) {
  if (action === 'delete') {
    if (!confirm(t('editor.delete_entry_confirm'))) return;
    await api('DELETE', `/api/blogs/${state.activeBlog.slug}/entries/${entry.id}`);
    const el = document.getElementById(`entry-${entry.id}`);
    if (el) el.remove();
    state.entries = state.entries.filter(e => e.id !== entry.id);
    refreshFeedCount();
    updatePreviewIframe();
  } else if (action === 'pin') {
    await api('POST', `/api/blogs/${state.activeBlog.slug}/entries/${entry.id}/pin`);
    await loadEntries();
    updatePreviewIframe();
  } else if (action === 'edit') {
    showEditModal(entry);
  }
}

function showEditModal(entry) {
  showModal({
    title: t('editor.edit_entry'),
    body: `<div class="form-group"><label>${t('common.edit')}</label><textarea id="edit-content" style="min-height:120px;">${escHtml(entry.content.replace(/<[^>]+>/g, ''))}</textarea></div>`,
    actions: [
      { label: t('common.cancel'), cls: 'btn-secondary', action: closeModal },
      { label: t('common.save'), cls: 'btn-primary', action: async () => {
        const content = document.getElementById('edit-content').value;
        await api('PATCH', `/api/blogs/${state.activeBlog.slug}/entries/${entry.id}`, { content });
        await loadEntries();
        updatePreviewIframe();
        closeModal();
      }},
    ],
  });
}

function refreshFeedCount() {
  const countEl = document.getElementById('feed-count');
  if (countEl) countEl.textContent = t('blog.entries_count', { count: state.entries.length });
}

// Returns the DOM node before which a new (non-pinned) entry should be inserted,
// so that pinned entries always stay at the top.
function getNewEntryInsertPoint(feed, newEntryIsPinned) {
  if (newEntryIsPinned) return feed.firstChild;
  const pinnedEntries = feed.querySelectorAll('.feed-entry.is-pinned');
  if (pinnedEntries.length) return pinnedEntries[pinnedEntries.length - 1].nextSibling;
  return feed.firstChild;
}

// ─── Composer ─────────────────────────────────────────────────────────────────
function bindComposerEvents() {
  const editor = document.getElementById('compose-editor');
  const publishBtn = document.getElementById('btn-publish');
  const charCount = document.getElementById('char-count');

  if (!editor) return;

  function onEditorInput() {
    const text = editor.innerText.trim();
    const len = text.length;
    charCount.textContent = t('editor.char_count', { count: len });
    publishBtn.disabled = len === 0;
    detectEmbedUrls(editor.innerText);
    signalTyping();
  }

  editor.addEventListener('input', onEditorInput);

  // Paste as plain text to avoid injecting external formatting
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!publishBtn.disabled) publishEntry();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault();
      document.execCommand('bold');
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
      e.preventDefault();
      document.execCommand('italic');
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      const url = prompt('URL:');
      if (url) document.execCommand('createLink', false, url);
    }
  });

  publishBtn.addEventListener('click', publishEntry);

  // Type selector
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.entryType = btn.dataset.type;
    });
  });

  // Format toolbar — use execCommand for WYSIWYG
  document.getElementById('tool-bold')?.addEventListener('click', () => { editor.focus(); document.execCommand('bold'); });
  document.getElementById('tool-italic')?.addEventListener('click', () => { editor.focus(); document.execCommand('italic'); });
  document.getElementById('tool-link')?.addEventListener('click', () => {
    const url = prompt('URL:');
    if (url) { editor.focus(); document.execCommand('createLink', false, url); }
  });
  document.getElementById('tool-ul')?.addEventListener('click', () => { editor.focus(); document.execCommand('insertUnorderedList'); });
  document.getElementById('tool-ol')?.addEventListener('click', () => { editor.focus(); document.execCommand('insertOrderedList'); });
  document.getElementById('tool-h2')?.addEventListener('click', () => { editor.focus(); document.execCommand('formatBlock', false, 'h2'); });
  document.getElementById('tool-h3')?.addEventListener('click', () => { editor.focus(); document.execCommand('formatBlock', false, 'h3'); });

  // File uploads
  document.getElementById('tool-image')?.addEventListener('click', () => triggerFileUpload('image/*'));
  document.getElementById('tool-video')?.addEventListener('click', () => triggerFileUpload('video/*'));
  document.getElementById('tool-audio')?.addEventListener('click', () => triggerFileUpload('audio/*'));

  document.getElementById('file-input')?.addEventListener('change', handleFileUpload);

  // Embed URL
  document.getElementById('tool-embed')?.addEventListener('click', () => {
    document.getElementById('embed-url-field').classList.toggle('hidden');
  });
  document.getElementById('btn-embed-close')?.addEventListener('click', () => {
    document.getElementById('embed-url-field').classList.add('hidden');
  });
  document.getElementById('btn-embed-resolve')?.addEventListener('click', async () => {
    const url = document.getElementById('embed-url-input').value.trim();
    if (url) await resolveAndPreviewEmbed(url);
    document.getElementById('embed-url-input').value = '';
    document.getElementById('embed-url-field').classList.add('hidden');
  });
}

function updateTypeButtons() {
  const labels = { update: t('editor.type_update'), breaking: t('editor.type_breaking'), pinned: t('editor.type_pinned'), summary: t('editor.type_summary') };
  document.querySelectorAll('.type-btn').forEach(btn => {
    if (labels[btn.dataset.type]) btn.textContent = labels[btn.dataset.type];
  });
}

function triggerFileUpload(accept) {
  const input = document.getElementById('file-input');
  input.accept = accept;
  input.click();
}

async function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file || !state.activeBlog) return;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const resp = await fetch(`/api/blogs/${state.activeBlog.slug}/upload`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);

    const editor = document.getElementById('compose-editor');
    const tag = file.type.startsWith('image/')
      ? `<img src="${data.url}" alt="" loading="lazy">`
      : file.type.startsWith('video/')
      ? `<video src="${data.url}" controls></video>`
      : `<audio src="${data.url}" controls></audio>`;
    editor.focus();
    document.execCommand('insertHTML', false, tag);
    editor.dispatchEvent(new Event('input'));
    toast(t('common.copied') || 'Uploaded!', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  e.target.value = '';
}

const embedDetectionTimer = {};
async function detectEmbedUrls(text) {
  clearTimeout(embedDetectionTimer.t);
  embedDetectionTimer.t = setTimeout(async () => {
    const urlRegex = /https?:\/\/[^\s<>"']+/g;
    const urls = [...new Set(text.match(urlRegex) || [])];
    const pending = state.pendingEmbeds.map(e => e.url);

    for (const url of urls) {
      if (!pending.includes(url)) {
        await resolveAndPreviewEmbed(url, true);
      }
    }
  }, 600);
}

async function resolveAndPreviewEmbed(url, fromDetect = false) {
  if (state.pendingEmbeds.find(e => e.url === url)) return;

  try {
    const data = await api('POST', '/api/embed/resolve', { url });
    if (!data) return;
    state.pendingEmbeds.push({ url, ...data });
    renderEmbedPreviews();
  } catch (_) {}
}

function renderEmbedPreviews() {
  const container = document.getElementById('embed-previews');
  if (!container) return;
  container.innerHTML = '';
  state.pendingEmbeds.forEach((embed, idx) => {
    const div = document.createElement('div');
    div.className = 'embed-preview-item';
    div.innerHTML = `
      <span class="embed-preview-icon">${embedIcon(embed.provider_icon)}</span>
      <div class="embed-preview-info">
        <div class="embed-preview-title">${escHtml(embed.title?.slice(0, 60) || embed.url)}</div>
        <div class="embed-preview-provider">${escHtml(embed.provider || 'Link')}</div>
      </div>
      <button class="embed-preview-remove" data-idx="${idx}" title="${t('editor.remove_embed')}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;
    div.querySelector('.embed-preview-remove').addEventListener('click', () => {
      state.pendingEmbeds.splice(idx, 1);
      renderEmbedPreviews();
    });
    container.appendChild(div);
  });
}

function embedIcon(type) {
  const icons = { youtube: '▶', twitter: '🐦', instagram: '📷', bluesky: '🦋', image: '🖼', video: '🎬', audio: '🎵', link: '🔗' };
  return icons[type] || '🔗';
}

async function publishEntry() {
  const editor = document.getElementById('compose-editor');
  if (!editor || !state.activeBlog) return;
  const rawText = editor.innerText.trim();
  if (!rawText) return;

  // Strip embed URLs from editor DOM, then read innerHTML
  const clone = editor.cloneNode(true);
  for (const embed of state.pendingEmbeds) {
    // Remove anchor tags whose href matches the embed URL (handles &amp; encoding automatically)
    clone.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (href === embed.url || href === embed.url.replace(/&/g, '&amp;')) {
        a.replaceWith(document.createTextNode(''));
      }
    });
    // Walk all text nodes and remove the URL string directly.
    // On mobile iOS, the browser may insert newlines within the URL in the contenteditable,
    // so we also try matching after collapsing whitespace.
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) {
      if (!node.nodeValue) continue;
      if (node.nodeValue.includes(embed.url)) {
        node.nodeValue = node.nodeValue.split(embed.url).join('').trim();
      } else {
        // Collapse all whitespace in the node value and check if the URL appears
        const collapsed = node.nodeValue.replace(/\s+/g, '');
        if (collapsed.includes(embed.url.replace(/\s+/g, ''))) {
          // Build a regex that allows optional whitespace between each character of the URL
          const escapedUrl = embed.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const looseUrl = escapedUrl.split('').join('\\s*');
          node.nodeValue = node.nodeValue.replace(new RegExp(looseUrl), '').trim();
        }
      }
    }
  }
  let htmlContent = clone.innerHTML.trim();
  // Clean up empty/whitespace-only tags and stray <br> left after URL removal
  htmlContent = htmlContent
    .replace(/<(p|div|span)[^>]*>\s*(<br\s*\/?>)?\s*<\/\1>/g, '')
    .replace(/^(<br\s*\/?>)+|(<br\s*\/?>)+$/g, '')
    .trim();

  let fullContent = htmlContent;
  for (const embed of state.pendingEmbeds) {
    if (embed.html) fullContent += (fullContent ? '\n' : '') + embed.html;
  }

  const btn = document.getElementById('btn-publish');
  btn.disabled = true;
  btn.textContent = t('common.loading');

  try {
    const entry = await api('POST', `/api/blogs/${state.activeBlog.slug}/entries`, {
      content: fullContent,
      entry_type: state.entryType,
    });

    // Play sound immediately on publish
    if (entry) playNewEntrySound(entry.entry_type || state.entryType);
    // Immediately insert into feed
    if (entry && entry.id) {
      // Remove existing element if SSE beat us to it
      document.getElementById(`entry-${entry.id}`)?.remove();
      state.entries = state.entries.filter(e => e.id !== entry.id);
      state.entries.unshift(entry);
      const feed = document.getElementById('feed');
      if (feed) {
        // Remove empty state if present
        const empty = feed.querySelector('[style*="text-align:center"]');
        if (empty) empty.remove();
        const el = createEntryElement(entry);
        feed.insertBefore(el, getNewEntryInsertPoint(feed, entry.is_pinned));
      }
      refreshFeedCount();
    }

    editor.innerHTML = '';
    state.pendingEmbeds = [];
    renderEmbedPreviews();
    document.getElementById('char-count').textContent = t('editor.char_count', { count: 0 });
    editor.dispatchEvent(new Event('input'));
    updatePreviewIframe();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = editor.innerText.trim().length === 0;
    btn.textContent = t('editor.publish_btn');
  }
}

// ─── SSE ──────────────────────────────────────────────────────────────────────
function connectPublicSSE(slug) {
  if (state.feedSSE) state.feedSSE.close();
  const sse = new EventSource(`/api/blogs/${slug}/stream`);
  state.feedSSE = sse;

  sse.addEventListener('new_entry', (e) => {
    const entry = JSON.parse(e.data);
    // Play sound for entries from others (own entries play sound in publishEntry)
    if (!document.getElementById(`entry-${entry.id}`)) {
      playNewEntrySound(entry.entry_type);
    }
    // Deduplicate: may have been inserted immediately by publishEntry()
    if (document.getElementById(`entry-${entry.id}`)) return;
    state.entries.unshift(entry);
    const feed = document.getElementById('feed');
    if (feed) {
      const el = createEntryElement(entry);
      // Remove empty state
      const empty = feed.querySelector('[style*="text-align:center"]');
      if (empty) empty.remove();
      feed.insertBefore(el, getNewEntryInsertPoint(feed, entry.is_pinned));
    }
    refreshFeedCount();
    updatePreviewIframe();
  });

  sse.addEventListener('update_entry', (e) => {
    const entry = JSON.parse(e.data);
    const idx = state.entries.findIndex(en => en.id === entry.id);
    const wasPinned = idx !== -1 && state.entries[idx].is_pinned;
    if (idx !== -1) state.entries[idx] = entry;
    const el = document.getElementById(`entry-${entry.id}`);
    if (el) {
      const newEl = createEntryElement(entry);
      // If pin status changed, reposition the element in the feed
      if (wasPinned !== entry.is_pinned) {
        el.remove();
        const feed = document.getElementById('feed');
        if (feed) feed.insertBefore(newEl, getNewEntryInsertPoint(feed, entry.is_pinned));
      } else {
        el.replaceWith(newEl);
      }
    }
    updatePreviewIframe();
  });

  sse.addEventListener('delete_entry', (e) => {
    const { id } = JSON.parse(e.data);
    state.entries = state.entries.filter(e => e.id !== id);
    const el = document.getElementById(`entry-${id}`);
    if (el) el.remove();
    refreshFeedCount();
    updatePreviewIframe();
  });

  sse.addEventListener('blog_status', (e) => {
    const { status } = JSON.parse(e.data);
    if (state.activeBlog) state.activeBlog.status = status;
    updateBlogStatusUI(status);
  });

  // On reconnect: reload entries to fill any gap missed during the drop window
  let sseWasOpen = false;
  sse.addEventListener('heartbeat', () => {
    if (!sseWasOpen) sseWasOpen = true;
  });
  sse.onerror = () => {
    if (sseWasOpen) {
      sseWasOpen = false;
      const syncOnReopen = () => {
        if (sse.readyState === EventSource.OPEN) {
          loadEntries();
        } else {
          setTimeout(syncOnReopen, 500);
        }
      };
      setTimeout(syncOnReopen, 500);
    }
  };

}

// Mobile: reconnect SSE and refresh entries when page comes back to foreground
// Browsers suspend SSE in background tabs; readyState can be CONNECTING (stuck) or CLOSED
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.activeBlog) return;
  const slug = state.activeBlog.slug;
  if (!state.feedSSE || state.feedSSE.readyState !== EventSource.OPEN) {
    connectPublicSSE(slug);
  }
  if (!state.editorSSE || state.editorSSE.readyState !== EventSource.OPEN) {
    connectEditorSSE(slug);
  }
  // Always reload entries to fill any gap from background suspension
  loadEntries();
});

function connectEditorSSE(slug) {
  if (state.editorSSE) state.editorSSE.close();
  const sse = new EventSource(`/api/blogs/${slug}/editors-stream`);
  state.editorSSE = sse;

  sse.addEventListener('editors_list', (e) => {
    state.onlineEditors = JSON.parse(e.data);
    renderPresence();
  });
  sse.addEventListener('editor_join', (e) => {
    const ed = JSON.parse(e.data);
    if (!state.onlineEditors.find(o => o.user_id === ed.user_id)) {
      state.onlineEditors.push(ed);
      renderPresence();
    }
  });
  sse.addEventListener('editor_leave', (e) => {
    const { user_id } = JSON.parse(e.data);
    state.onlineEditors = state.onlineEditors.filter(o => o.user_id !== user_id);
    renderPresence();
  });
  sse.addEventListener('editor_typing', (e) => {
    const { user_id, name } = JSON.parse(e.data);
    if (user_id === state.user?.id) return;
    showTypingIndicator(user_id, name);
  });
}

function disconnectSSE() {
  if (state.feedSSE) { state.feedSSE.close(); state.feedSSE = null; }
  if (state.editorSSE) { state.editorSSE.close(); state.editorSSE = null; }
}

function renderPresence() {
  const container = document.getElementById('topbar-presence');
  if (!container) return;
  const others = state.onlineEditors.filter(e => e.user_id !== state.user?.id);
  if (!others.length) { container.innerHTML = ''; return; }
  container.innerHTML = `<div class="presence-avatars">${others.map(e => `<div class="presence-avatar" title="${escHtml(e.name)}">${(e.name || 'U')[0].toUpperCase()}</div>`).join('')}</div>`;
}

let typingSignalTimer;
function signalTyping() {
  if (!state.activeBlog) return;
  clearTimeout(typingSignalTimer);
  typingSignalTimer = setTimeout(() => {
    api('POST', `/api/blogs/${state.activeBlog.slug}/typing`).catch(() => {});
  }, 1000);
}

function showTypingIndicator(userId, name) {
  const container = document.getElementById('typing-indicators');
  if (!container) return;

  clearTimeout(state.typingTimers[userId]);
  let el = document.getElementById(`typing-${userId}`);
  if (!el) {
    el = document.createElement('div');
    el.id = `typing-${userId}`;
    el.className = 'typing-indicator';
    el.innerHTML = `<span>${escHtml(name)} ${t('editor.typing_indicator', { name: '' }).trim()}</span> <div class="typing-dots"><span></span><span></span><span></span></div>`;
    container.appendChild(el);
  }
  state.typingTimers[userId] = setTimeout(() => { el.remove(); delete state.typingTimers[userId]; }, 5000);
}

// ─── Right Panel ──────────────────────────────────────────────────────────────
function bindRightPanelEvents() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-content-${btn.dataset.tab}`)?.classList.add('active');

      if (btn.dataset.tab === 'members') renderMembersPanel();
      if (btn.dataset.tab === 'theme') renderThemePanel();
      if (btn.dataset.tab === 'preview') updatePreviewIframe();
    });
  });
}

function updatePreviewIframe() {
  if (!state.activeBlog) return;
  const iframe = document.getElementById('preview-iframe');
  if (!iframe) return;
  if (document.getElementById('tab-content-preview')?.classList.contains('active')) {
    iframe.src = `/embed/${state.activeBlog.slug}?t=${Date.now()}`;
  }
}

// ─── Theme Panel ──────────────────────────────────────────────────────────────

function renderThemePanel(panel) {
  if (!state.activeBlog) return;
  panel = panel || document.getElementById('theme-panel');
  if (!panel) return;

  let settings = {};
  try { settings = typeof state.activeBlog.settings === 'string' ? JSON.parse(state.activeBlog.settings) : (state.activeBlog.settings || {}); } catch {}
  const theme = settings.theme || {};
  const colors = theme.colors || {};
  const typography = theme.typography || {};
  const layout = theme.layout || {};

  const entryStyle = layout.entry_style || 'card';

  panel.innerHTML = `
    <div class="theme-section">
      <div class="theme-section-title">${t('theme.widget_header')}</div>
      <div class="theme-row">
        <label>${t('theme.widget_title_label')}</label>
        <input type="text" id="theme-widget-title" class="theme-text-input" value="${escHtml(theme.widget_title || '')}" placeholder="Liveblog">
      </div>
    </div>

    <div class="theme-section">
      <div class="theme-section-title">${t('theme.mode')}</div>
      <div class="theme-row">
        <div class="theme-toggle">
          <button class="theme-toggle-btn${theme.mode !== 'dark' ? ' active' : ''}" data-mode="light">${t('theme.light')}</button>
          <button class="theme-toggle-btn${theme.mode === 'dark' ? ' active' : ''}" data-mode="dark">${t('theme.dark')}</button>
        </div>
      </div>
    </div>

    <div class="theme-section">
      <div class="theme-section-title">${t('theme.colors')}</div>
      ${colorRow('primary', t('theme.primary_color'), colors.primary || '#2563EB')}
      ${colorRow('breaking', t('theme.breaking_color'), colors.breaking || '#DC2626')}
      ${colorRow('pinned', t('theme.pinned_color'), colors.pinned || '#F59E0B')}
      ${colorRow('live_badge', t('theme.live_badge_color'), colors.live_badge || '#16A34A')}
      ${colorRow('live_badge_bg', t('theme.live_badge_bg_color'), colors.live_badge_bg || '#16A34A')}
    </div>

    <div class="theme-section">
      <div class="theme-section-title">${t('theme.typography')}</div>
      <div class="theme-row">
        <label>${t('theme.font')}</label>
        <select class="theme-select" id="theme-font">
          <option value="system"${typography.font_family === 'system' || !typography.font_family ? ' selected' : ''}>${t('theme.font_system')}</option>
          <option value="serif"${typography.font_family === 'serif' ? ' selected' : ''}>${t('theme.font_serif')}</option>
          <option value="mono"${typography.font_family === 'mono' ? ' selected' : ''}>${t('theme.font_mono')}</option>
        </select>
      </div>
    </div>

    <div class="theme-section">
      <div class="theme-section-title">${t('theme.layout')}</div>
      <div class="theme-row">
        <label>${t('theme.entry_style')}</label>
        <div class="theme-toggle">
          <button class="theme-toggle-btn${entryStyle === 'card' ? ' active' : ''}" data-layout-style="card">${t('theme.style_card')}</button>
          <button class="theme-toggle-btn${entryStyle === 'timeline' ? ' active' : ''}" data-layout-style="timeline">${t('theme.style_timeline')}</button>
          <button class="theme-toggle-btn${entryStyle === 'conversation' ? ' active' : ''}" data-layout-style="conversation">Chat</button>
        </div>
      </div>
      <div class="theme-row">
        <label>${t('theme.max_width')}</label>
        <select class="theme-select" id="theme-maxwidth">
          <option value="600px"${layout.max_width === '600px' ? ' selected' : ''}>600px</option>
          <option value="720px"${!layout.max_width || layout.max_width === '720px' ? ' selected' : ''}>720px</option>
          <option value="900px"${layout.max_width === '900px' ? ' selected' : ''}>900px</option>
          <option value="100%"${layout.max_width === '100%' ? ' selected' : ''}>100%</option>
        </select>
      </div>
      <div class="theme-row">
        <label><input type="checkbox" id="theme-avatars" ${layout.show_avatars !== false ? 'checked' : ''}> ${t('theme.show_avatars')}</label>
      </div>
      <div class="theme-row">
        <label><input type="checkbox" id="theme-timestamps" ${layout.show_timestamps !== false ? 'checked' : ''}> ${t('theme.show_timestamps')}</label>
      </div>
      <div class="theme-row">
        <label><input type="checkbox" id="theme-count" ${layout.show_entry_count !== false ? 'checked' : ''}> ${t('theme.show_entry_count')}</label>
      </div>
    </div>

    <div class="theme-section">
      <div class="theme-section-title">${t('theme.widget_locale')}</div>
      <div class="theme-row">
        <div class="theme-toggle">
          <button class="theme-toggle-btn${settings.locale !== 'en' ? ' active' : ''}" data-widget-locale="it">Italiano</button>
          <button class="theme-toggle-btn${settings.locale === 'en' ? ' active' : ''}" data-widget-locale="en">English</button>
        </div>
      </div>
    </div>

    <button class="btn-primary w-full" id="btn-save-theme">${t('common.save')}</button>
  `;

  function bindToggleGroup(attr) {
    panel.querySelectorAll(`[${attr}]`).forEach(btn => {
      btn.addEventListener('click', () => {
        btn.parentElement.querySelectorAll(`[${attr}]`).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updateThemePreview();
      });
    });
  }
  bindToggleGroup('data-mode');
  bindToggleGroup('data-layout-style');
  bindToggleGroup('data-widget-locale');

  panel.querySelectorAll('input[type="color"]').forEach(input => {
    input.addEventListener('input', () => {
      input.nextElementSibling.textContent = input.value;
      updateThemePreview();
    });
  });
  panel.querySelectorAll('select, input[type="checkbox"]').forEach(el => {
    el.addEventListener('change', () => updateThemePreview());
  });
  panel.querySelector('#theme-widget-title')?.addEventListener('input', () => updateThemePreview());
  panel.querySelector('#btn-save-theme')?.addEventListener('click', saveTheme);
}

function colorRow(name, label, value) {
  return `<div class="theme-row">
    <label>${label}</label>
    <div class="color-input-wrap">
      <input type="color" id="color-${name}" value="${value}">
      <span>${value}</span>
    </div>
  </div>`;
}

function updateThemePreview() {
  // Gather current values and refresh iframe
  setTimeout(() => updatePreviewIframe(), 100);
}

async function saveTheme() {
  if (!state.activeBlog) return;

  const getColor = id => document.getElementById(`color-${id}`)?.value;
  const getMode = () => document.querySelector('[data-mode].active')?.dataset.mode || 'light';
  const getLayoutStyle = () => document.querySelector('[data-layout-style].active')?.dataset.layoutStyle || 'card';
  const getWidgetLocale = () => document.querySelector('[data-widget-locale].active')?.dataset.widgetLocale || 'it';

  let existing = {};
  try { existing = typeof state.activeBlog.settings === 'string' ? JSON.parse(state.activeBlog.settings) : (state.activeBlog.settings || {}); } catch {}

  const newSettings = {
    ...existing,
    locale: getWidgetLocale(),
    theme: {
      mode: getMode(),
      widget_title: document.getElementById('theme-widget-title')?.value || '',
      colors: {
        primary: getColor('primary') || '#2563EB',
        breaking: getColor('breaking') || '#DC2626',
        pinned: getColor('pinned') || '#F59E0B',
        live_badge: getColor('live_badge') || '#16A34A',
        live_badge_bg: getColor('live_badge_bg') || '#16A34A',
      },
      typography: {
        font_family: document.getElementById('theme-font')?.value || 'system',
      },
      layout: {
        entry_style: getLayoutStyle(),
        max_width: document.getElementById('theme-maxwidth')?.value || '720px',
        show_avatars: document.getElementById('theme-avatars')?.checked !== false,
        show_timestamps: document.getElementById('theme-timestamps')?.checked !== false,
        show_entry_count: document.getElementById('theme-count')?.checked !== false,
      },
    },
  };

  try {
    await api('PATCH', `/api/blogs/${state.activeBlog.slug}`, { settings: newSettings });
    state.activeBlog.settings = newSettings;
    toast(t('common.save') + '!', 'success');
    updatePreviewIframe();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function showMobileThemeModal() {
  if (!state.activeBlog) {
    toast(t('blog.select_blog') || 'Seleziona un blog prima', 'error');
    return;
  }
  showModal({
    title: t('common.theme'),
    body: `<div id="mobile-theme-panel" style="max-height:60vh;overflow-y:auto;"></div>`,
    actions: [{ label: t('common.close'), cls: 'btn-secondary', action: closeModal }],
  });
  renderThemePanel(document.getElementById('mobile-theme-panel'));
}

// ─── Members Panel ────────────────────────────────────────────────────────────
async function loadMembers() {
  if (!state.activeBlog || state.user.role !== 'admin') return;
  const members = await api('GET', `/api/blogs/${state.activeBlog.slug}/members`);
  if (!members) return;
  state.members = members;
}

function renderMembersPanel() {
  if (!state.activeBlog) return;
  const panel = document.getElementById('members-panel');
  if (!panel) return;

  const membersHtml = state.members.map(m => `
    <div class="member-item" data-id="${m.id}">
      <div class="avatar-sm">${(m.name || 'U')[0].toUpperCase()}</div>
      <div class="member-info">
        <div class="member-name">${escHtml(m.name)}</div>
        <div class="member-email">${escHtml(m.email)}</div>
      </div>
      <span class="member-role ${m.role}">${m.role === 'admin' ? t('members.role_admin') : t('members.role_editor')}</span>
      ${state.user.role === 'admin' ? `<button class="member-remove" title="${t('members.remove')}" data-id="${m.id}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>` : ''}
    </div>
  `).join('');

  const isRestricted = state.activeBlog.settings?.restricted === true;
  panel.innerHTML = `
    ${state.user.role === 'admin' ? `
    <div class="theme-row" style="margin-bottom:12px;">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
        <input type="checkbox" id="blog-restricted" ${isRestricted ? 'checked' : ''}>
        <span>${t('blog.restricted_access')}</span>
      </label>
    </div>` : ''}
    <div class="members-list">${membersHtml || `<p style="color:var(--text3);font-size:0.875rem;">${t('members.no_members')}</p>`}</div>
    ${state.user.role === 'admin' ? `
    <div class="invite-form">
      <label>${t('members.invite')}</label>
      <input type="email" id="invite-email" placeholder="${t('members.invite_placeholder')}">
      <button class="btn-primary w-full" id="btn-invite-member">${t('members.invite')}</button>
      <p class="invite-info">${t('members.invite_info')}</p>
    </div>` : ''}
  `;

  panel.querySelector('#blog-restricted')?.addEventListener('change', async (e) => {
    const restricted = e.target.checked;
    const newSettings = { ...(state.activeBlog.settings || {}), restricted };
    await api('PATCH', `/api/blogs/${state.activeBlog.slug}`, { settings: newSettings });
    state.activeBlog.settings = newSettings;
    toast(restricted ? t('blog.restricted_on') : t('blog.restricted_off'), 'success');
  });

  panel.querySelectorAll('.member-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('members.remove_confirm'))) return;
      await api('DELETE', `/api/blogs/${state.activeBlog.slug}/members/${btn.dataset.id}`);
      await loadMembers();
      renderMembersPanel();
    });
  });

  panel.querySelector('#btn-invite-member')?.addEventListener('click', async () => {
    const email = panel.querySelector('#invite-email').value.trim();
    if (!email) return;
    try {
      await api('POST', `/api/blogs/${state.activeBlog.slug}/members`, { email });
      toast(t('members.added') + '!', 'success');
      panel.querySelector('#invite-email').value = '';
      await loadMembers();
      renderMembersPanel();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ─── Topbar events ────────────────────────────────────────────────────────────
function bindTopbarEvents() {
  document.getElementById('btn-theme-toggle')?.addEventListener('click', () => {
    const next = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('nl-theme', next); // explicit manual choice
    applyTheme(next);
  });

  // Auto-follow system preference if user hasn't manually overridden
  window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener('change', (e) => {
    if (!localStorage.getItem('nl-theme')) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  });

  // Sound toggle
  const applySoundUI = () => {
    document.getElementById('icon-sound-on')?.classList.toggle('hidden', !state.soundEnabled);
    document.getElementById('icon-sound-off')?.classList.toggle('hidden', state.soundEnabled);
  };
  applySoundUI();
  document.getElementById('btn-sound-toggle')?.addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    localStorage.setItem('nl-sound', state.soundEnabled ? 'on' : 'off');
    applySoundUI();
    if (state.soundEnabled) playNewEntrySound('update');
  });


  document.querySelectorAll('.locale-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.locale = btn.dataset.locale;
      localStorage.setItem('nl-locale', state.locale);
      await loadTranslations(state.locale);
      applyLocaleUI();
      // Re-render dynamic content that uses t() at render time
      if (state.activeBlog) {
        updateBlogStatusUI(state.activeBlog.status);
        refreshFeedCount();
        renderFeed(document.getElementById('feed-search')?.value.trim() || '');
        const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
        if (activeTab === 'theme') renderThemePanel();
        else if (activeTab === 'members') renderMembersPanel();
      }
      await api('PATCH', '/api/users/me', { locale: state.locale }).catch(() => {});
    });
  });

  document.getElementById('user-menu-btn')?.addEventListener('click', () => {
    document.getElementById('user-dropdown').classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-menu-wrapper')) {
      document.getElementById('user-dropdown')?.classList.add('hidden');
    }
    if (!e.target.closest('.blog-status-menu-wrapper')) {
      document.getElementById('blog-status-dropdown')?.classList.add('hidden');
    }
  });

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await api('POST', '/auth/logout');
    location.reload();
  });

  document.getElementById('btn-new-blog')?.addEventListener('click', showNewBlogModal);
  document.getElementById('btn-embed-snippet')?.addEventListener('click', showEmbedSnippet);
  document.getElementById('btn-export')?.addEventListener('click', exportBlog);
  document.getElementById('topbar-blog-badge')?.addEventListener('click', (e) => {
    if (state.user?.role !== 'admin') return;
    e.stopPropagation();
    document.getElementById('blog-status-dropdown')?.classList.toggle('hidden');
  });
  document.getElementById('blog-status-dropdown')?.querySelectorAll('[data-status]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      document.getElementById('blog-status-dropdown').classList.add('hidden');
      if (!state.activeBlog) return;
      const newStatus = btn.dataset.status;
      if (newStatus === state.activeBlog.status) return;
      if (newStatus === 'ended' && !confirm(t('blog.close_confirm'))) return;
      await api('PATCH', `/api/blogs/${state.activeBlog.slug}`, { status: newStatus });
      state.activeBlog.status = newStatus;
      updateBlogStatusUI(newStatus);
      const dot = document.querySelector(`[data-id="${state.activeBlog.id}"] .blog-status-dot`);
      if (dot) dot.className = `blog-status-dot ${newStatus}`;
    });
  });

  document.getElementById('btn-profile')?.addEventListener('click', showProfileModal);
  document.getElementById('btn-users-manage')?.addEventListener('click', showUsersModal);
  document.getElementById('btn-backup-manage')?.addEventListener('click', showBackupModal);

  document.getElementById('btn-rename-blog')?.addEventListener('click', showRenameBlogModal);

  // Hamburger
  document.getElementById('hamburger-btn')?.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('open');
    document.getElementById('drawer-backdrop').classList.toggle('hidden', !sidebar.classList.contains('open'));
  });
  document.getElementById('drawer-backdrop')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('drawer-backdrop').classList.add('hidden');
  });

  // Mobile nav
  document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === 'settings') {
        openMobileSettings();
        return;
      }
      if (view === 'theme') {
        showMobileThemeModal();
        return;
      }
      document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (view === 'blogs') {
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.add('open');
        document.getElementById('drawer-backdrop').classList.remove('hidden');
      } else {
        // Close sidebar if open
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('drawer-backdrop').classList.add('hidden');
        const mainArea = document.getElementById('main-area');
        if (mainArea) mainArea.dataset.mobileView = view;
      }
    });
  });

  // Mobile settings sheet
  document.getElementById('mobile-settings-close')?.addEventListener('click', closeMobileSettings);
  document.getElementById('mobile-theme-toggle')?.addEventListener('click', () => {
    const next = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('nl-theme', next);
    applyTheme(next);
    applyMobileThemeIcon();
  });
  document.getElementById('mobile-sound-toggle')?.addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    localStorage.setItem('nl-sound', state.soundEnabled ? 'on' : 'off');
    applyMobileSoundIcon();
    if (state.soundEnabled) playNewEntrySound('update');
  });
  document.getElementById('mobile-btn-profile')?.addEventListener('click', () => { closeMobileSettings(); showProfileModal(); });
  document.getElementById('mobile-btn-theme')?.addEventListener('click', () => { closeMobileSettings(); showMobileThemeModal(); });
  document.getElementById('mobile-btn-users')?.addEventListener('click', () => { closeMobileSettings(); showUsersModal(); });
  document.getElementById('mobile-btn-backup')?.addEventListener('click', () => { closeMobileSettings(); showBackupModal(); });
  document.getElementById('mobile-btn-logout')?.addEventListener('click', async () => {
    await api('POST', '/auth/logout');
    location.reload();
  });
}

function showNewBlogModal() {
  showModal({
    title: t('blog.new_blog'),
    body: `
      <div class="form-group"><label>${t('blog.title_placeholder')}</label><input type="text" id="new-blog-title" placeholder="${t('blog.title_placeholder')}" autofocus></div>
      <div class="form-group"><label>${t('blog.description_placeholder')}</label><textarea id="new-blog-desc" placeholder="${t('blog.description_placeholder')}" rows="2"></textarea></div>
    `,
    actions: [
      { label: t('common.cancel'), cls: 'btn-secondary', action: closeModal },
      { label: t('blog.create_blog'), cls: 'btn-primary', action: async () => {
        const title = document.getElementById('new-blog-title').value.trim();
        if (!title) return;
        try {
          const blog = await api('POST', '/api/blogs', { title, description: document.getElementById('new-blog-desc').value.trim() });
          await loadBlogs();
          selectBlog(blog);
          closeModal();
        } catch (err) { toast(err.message, 'error'); }
      }},
    ],
  });
}

function showRenameBlogModal() {
  if (!state.activeBlog) return;
  showModal({
    title: t('blog.rename'),
    body: `<div class="form-group"><label>${t('theme.widget_title_label')}</label><input type="text" id="rename-blog-title" value="${escHtml(state.activeBlog.title)}" autofocus></div>`,
    actions: [
      { label: t('common.cancel'), cls: 'btn-secondary', action: closeModal },
      { label: t('common.save'), cls: 'btn-primary', action: async () => {
        const title = document.getElementById('rename-blog-title').value.trim();
        if (!title) return;
        try {
          await api('PATCH', `/api/blogs/${state.activeBlog.slug}`, { title });
          state.activeBlog.title = title;
          document.getElementById('topbar-blog-title').textContent = title;
          const blogItem = document.querySelector(`[data-id="${state.activeBlog.id}"] .blog-item-title`);
          if (blogItem) blogItem.textContent = title;
          const idx = state.blogs.findIndex(b => b.id === state.activeBlog.id);
          if (idx !== -1) state.blogs[idx].title = title;
          toast(t('blog.renamed'), 'success');
          closeModal();
        } catch (err) { toast(err.message, 'error'); }
      }},
    ],
  });
  setTimeout(() => {
    const inp = document.getElementById('rename-blog-title');
    if (inp) { inp.focus(); inp.select(); }
  }, 50);
}

function showEmbedSnippet() {
  if (!state.activeBlog) return;
  const baseUrl = location.origin;
  const embedId = state.activeBlog.numeric_id || state.activeBlog.slug;
  const frameId = `nl-frame-${embedId}`;
  const snippet = `<iframe\n  id="${frameId}"\n  src="${baseUrl}/embed/${embedId}"\n  style="width:100%;border:none;display:block;overflow:hidden;"\n  scrolling="no"\n  loading="lazy"\n  allow="autoplay; notifications"\n></iframe>\n<script>\nwindow.addEventListener('message', function(e) {\n  if (e.data && e.data.type === 'newslog-resize') {\n    var iframe = document.getElementById('${frameId}');\n    if (iframe) iframe.style.height = e.data.height + 'px';\n  }\n});\n<\/script>`;

  showModal({
    title: t('blog.embed_snippet'),
    body: `<div class="snippet-code">${escHtml(snippet)}</div>`,
    actions: [
      { label: t('common.copy'), cls: 'btn-primary', action: () => { navigator.clipboard.writeText(snippet); toast(t('common.copied'), 'success'); closeModal(); } },
      { label: t('common.close'), cls: 'btn-secondary', action: closeModal },
    ],
  });
}

async function exportBlog() {
  if (!state.activeBlog) return;
  const url = `/api/blogs/${state.activeBlog.slug}/export`;
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.activeBlog.slug}-export.html`;
  a.click();
}

function showOnboardingModal() {
  showModal({
    title: t('onboarding.title'),
    body: `
      <p style="color:var(--text2);margin-bottom:16px;">${t('onboarding.subtitle')}</p>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div>
          <label style="font-size:0.8rem;color:var(--text3);display:block;margin-bottom:4px;">${t('onboarding.first_name')} <span style="color:var(--accent);">*</span></label>
          <input type="text" id="onboard-name" placeholder="Es. Mario" style="width:100%;padding:8px;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;color:var(--text);" required>
        </div>
        <div>
          <label style="font-size:0.8rem;color:var(--text3);display:block;margin-bottom:4px;">${t('onboarding.last_name')} <span style="color:var(--accent);">*</span></label>
          <input type="text" id="onboard-surname" placeholder="Es. Rossi" style="width:100%;padding:8px;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;color:var(--text);" required>
        </div>
        <div>
          <label style="font-size:0.8rem;color:var(--text3);display:block;margin-bottom:4px;">${t('onboarding.avatar_optional')}</label>
          <div style="display:flex;align-items:center;gap:12px;">
            <div id="onboard-avatar-preview" style="width:48px;height:48px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:1.2rem;color:#fff;font-weight:700;overflow:hidden;">?</div>
            <button type="button" class="btn-secondary" id="onboard-avatar-btn">${t('onboarding.choose_image')}</button>
            <input type="file" id="onboard-avatar-input" accept="image/*" style="display:none;">
          </div>
        </div>
        <p id="onboard-error" style="color:#ef4444;font-size:0.8rem;min-height:1em;"></p>
      </div>`,
    actions: [
      { label: t('onboarding.continue'), cls: 'btn-primary', action: saveOnboarding },
    ],
    dismissable: false,
  });

  document.getElementById('onboard-avatar-btn').addEventListener('click', () => {
    document.getElementById('onboard-avatar-input').click();
  });
  document.getElementById('onboard-avatar-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const err = document.getElementById('onboard-error');
    err.textContent = t('onboarding.loading');
    try {
      const form = new FormData();
      form.append('avatar', file);
      const res = await fetch('/api/users/me/avatar', { method: 'POST', body: form, credentials: 'include' });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      state.user.avatar_url = data.avatar_url;
      const preview = document.getElementById('onboard-avatar-preview');
      preview.innerHTML = `<img src="${escHtml(data.avatar_url)}" style="width:100%;height:100%;object-fit:cover;">`;
      err.textContent = '';
    } catch (e2) {
      err.textContent = `${t('onboarding.upload_error')} ${e2.message}`;
    }
  });
  // Focus first input
  setTimeout(() => document.getElementById('onboard-name')?.focus(), 100);
}

async function saveOnboarding() {
  const firstName = document.getElementById('onboard-name')?.value.trim();
  const lastName = document.getElementById('onboard-surname')?.value.trim();
  const errEl = document.getElementById('onboard-error');
  if (!firstName || !lastName) {
    if (errEl) errEl.textContent = t('onboarding.required_fields');
    return;
  }
  const fullName = `${firstName} ${lastName}`;
  try {
    const user = await api('PATCH', '/api/users/me', { name: fullName });
    state.user = { ...state.user, ...user };
    const nameEl = document.getElementById('user-name-display');
    if (nameEl) nameEl.textContent = state.user.name;
    const avatarEl = document.getElementById('user-avatar');
    if (avatarEl) setAvatar(avatarEl, state.user);
    closeModal();
  } catch (err) {
    if (errEl) errEl.textContent = `${t('onboarding.error')} ${err.message}`;
  }
}

function showProfileModal() {
  const user = state.user;
  const avatarHtml = user.avatar_url
    ? `<img src="${escHtml(user.avatar_url)}" alt="" style="width:72px;height:72px;border-radius:50%;object-fit:cover;">`
    : `<div style="width:72px;height:72px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:2rem;color:#fff;font-weight:700;">${(user.name || 'U')[0].toUpperCase()}</div>`;

  showModal({
    title: t('profile.title'),
    body: `
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px;">
        <div id="profile-avatar-wrap" style="cursor:pointer;position:relative;" title="${t('profile.change_avatar')}">
          ${avatarHtml}
          <div style="position:absolute;bottom:0;right:0;background:var(--accent);border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </div>
        </div>
        <input type="file" id="profile-avatar-input" accept="image/*" style="display:none;">
        <div style="width:100%;display:flex;flex-direction:column;gap:8px;margin-top:8px;">
          <label style="font-size:0.8rem;color:var(--text3);">${t('profile.name_label')}</label>
          <input type="text" id="profile-name-input" value="${escHtml(user.name || '')}" placeholder="${t('profile.name_placeholder')}" style="width:100%;padding:8px;background:var(--bg-raised);border:1px solid var(--border);border-radius:6px;color:var(--text);">
        </div>
        <div style="width:100%;font-size:0.8rem;color:var(--text3);">${escHtml(user.email)}</div>
        <p id="profile-status" style="color:var(--text3);font-size:0.8rem;min-height:1em;"></p>
      </div>`,
    actions: [
      { label: t('common.save'), cls: 'btn-primary', action: saveProfile },
      { label: t('common.close'), cls: 'btn-secondary', action: closeModal },
    ],
  });

  document.getElementById('profile-avatar-wrap').addEventListener('click', () => {
    document.getElementById('profile-avatar-input').click();
  });

  document.getElementById('profile-avatar-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = document.getElementById('profile-status');
    status.textContent = t('profile.loading_avatar');
    try {
      const form = new FormData();
      form.append('avatar', file);
      const res = await fetch('/api/users/me/avatar', {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      state.user.avatar_url = data.avatar_url;
      const wrap = document.getElementById('profile-avatar-wrap');
      wrap.querySelector('img, div:first-child') && (wrap.innerHTML = `
        <img src="${escHtml(data.avatar_url)}" alt="" style="width:72px;height:72px;border-radius:50%;object-fit:cover;">
        <div style="position:absolute;bottom:0;right:0;background:var(--accent);border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </div>`);
      const avatarEl = document.getElementById('user-avatar');
      if (avatarEl) setAvatar(avatarEl, state.user);
      status.textContent = t('profile.avatar_updated');
    } catch (err) {
      status.textContent = `${t('onboarding.error')} ${err.message}`;
    }
  });
}

async function saveProfile() {
  const name = document.getElementById('profile-name-input')?.value.trim();
  const status = document.getElementById('profile-status');
  if (!name) return;
  try {
    const user = await api('PATCH', '/api/users/me', { name });
    state.user = { ...state.user, ...user };
    const nameEl = document.getElementById('user-name-display');
    if (nameEl) nameEl.textContent = state.user.name;
    if (status) status.textContent = t('profile.saved');
    setTimeout(closeModal, 800);
  } catch (err) {
    if (status) status.textContent = `${t('onboarding.error')} ${err.message}`;
  }
}

function showUsersModal() {
  showModal({
    title: t('users.title'),
    body: `<div id="users-modal-content"><p style="color:var(--text3);">${t('common.loading')}</p></div>`,
    actions: [{ label: t('common.close'), cls: 'btn-secondary', action: closeModal }],
  });
  loadUsersModal();
}

async function loadUsersModal() {
  const users = await api('GET', '/api/users');
  if (!users) return;
  const container = document.getElementById('users-modal-content');
  if (!container) return;

  container.innerHTML = `
    <div style="margin-bottom:16px;">
      <button class="btn-primary" id="btn-global-invite">${t('users.invite_user')}</button>
    </div>
    <table class="users-table">
      <thead><tr><th>${t('users.col_name')}</th><th>${t('users.col_email')}</th><th>${t('users.col_role')}</th><th></th></tr></thead>
      <tbody>
        ${users.map(u => `
          <tr>
            <td>${escHtml(u.name)}</td>
            <td style="color:var(--text2);">${escHtml(u.email)}</td>
            <td><span class="member-role ${u.role}">${u.role}</span></td>
            <td>
              ${u.id !== state.user.id ? `
                <button class="entry-action-btn" title="${u.role === 'admin' ? t('users.demote_editor') : t('users.promote_admin')}" data-action="role" data-id="${u.id}" data-role="${u.role === 'admin' ? 'editor' : 'admin'}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4m0 14v4M4.22 4.22l2.83 2.83m9.9 9.9l2.83 2.83M1 12h4m14 0h4M4.22 19.78l2.83-2.83m9.9-9.9l2.83-2.83"/></svg>
                </button>
                <button class="entry-action-btn danger" title="${t('users.delete_user')}" data-action="delete" data-id="${u.id}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6m4-6v6"/></svg>
                </button>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  container.querySelector('#btn-global-invite')?.addEventListener('click', async () => {
    const email = prompt('Email:');
    if (!email) return;
    try {
      await api('POST', '/api/users/invite', { email });
      toast(t('users.invite_sent'), 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  container.querySelectorAll('[data-action="role"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api('PATCH', `/api/users/${btn.dataset.id}/role`, { role: btn.dataset.role });
      loadUsersModal();
    });
  });
  container.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('users.delete_confirm'))) return;
      await api('DELETE', `/api/users/${btn.dataset.id}`);
      loadUsersModal();
    });
  });
}

function showBackupModal() {
  showModal({
    title: t('backup.title'),
    body: `<div id="backup-modal-content"><p style="color:var(--text3);">${t('common.loading')}</p></div>`,
    actions: [{ label: t('common.close'), cls: 'btn-secondary', action: closeModal }],
  });
  loadBackupModal();
}

async function loadBackupModal() {
  const container = document.getElementById('backup-modal-content');
  if (!container) return;

  const config = await api('GET', '/api/admin/backups/config').catch(() => ({ s3_enabled: false }));
  const s3Enabled = config?.s3_enabled;

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:16px;">

      <div style="background:var(--bg-raised);border-radius:8px;padding:14px;">
        <div style="font-weight:600;margin-bottom:4px;">${t('backup.download')}</div>
        <div style="font-size:0.8rem;color:var(--text3);margin-bottom:10px;">${t('backup.download_desc')}</div>
        <button class="btn-primary" id="btn-download-backup">${t('backup.download')}</button>
      </div>

      <div style="background:var(--bg-raised);border-radius:8px;padding:14px;">
        <div style="font-weight:600;margin-bottom:4px;">${t('backup.restore_from_file')}</div>
        <div style="font-size:0.8rem;color:var(--text3);margin-bottom:10px;">${t('backup.restore_confirm')}</div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <input type="file" id="backup-file-input" accept=".tar.gz,.gz" style="flex:1;min-width:0;font-size:0.8rem;color:var(--text2);">
          <button class="btn-secondary" id="btn-restore-file">${t('backup.restore_file_btn')}</button>
        </div>
        <p id="restore-file-status" style="font-size:0.8rem;color:var(--accent-red,#ef4444);margin-top:6px;min-height:1em;"></p>
      </div>

      ${s3Enabled ? `
      <div style="background:var(--bg-raised);border-radius:8px;padding:14px;">
        <div style="font-weight:600;margin-bottom:4px;">${t('backup.s3_section')}</div>
        <div style="font-size:0.8rem;color:var(--text3);margin-bottom:10px;">${t('backup.s3_desc')}</div>
        <button class="btn-secondary" id="btn-s3-backup">${t('backup.s3_backup_now')}</button>
        <div id="s3-backup-list" style="margin-top:12px;"><p style="font-size:0.8rem;color:var(--text3);">${t('common.loading')}</p></div>
      </div>` : ''}

    </div>
  `;

  // Download backup
  container.querySelector('#btn-download-backup')?.addEventListener('click', () => {
    const btn = container.querySelector('#btn-download-backup');
    btn.textContent = t('backup.downloading');
    btn.disabled = true;
    const a = document.createElement('a');
    a.href = '/api/admin/backups/download';
    a.click();
    setTimeout(() => { btn.textContent = t('backup.download'); btn.disabled = false; }, 3000);
  });

  // Restore from uploaded file
  container.querySelector('#btn-restore-file')?.addEventListener('click', async () => {
    const fileInput = container.querySelector('#backup-file-input');
    const statusEl = container.querySelector('#restore-file-status');
    if (!fileInput.files[0]) { statusEl.textContent = t('backup.restore_file_label'); return; }
    if (!confirm(t('backup.restore_file_confirm'))) return;

    const formData = new FormData();
    formData.append('backup', fileInput.files[0]);
    const btn = container.querySelector('#btn-restore-file');
    btn.disabled = true;
    btn.textContent = t('common.loading');
    statusEl.textContent = '';
    try {
      const resp = await fetch('/api/admin/backups/restore-file', { method: 'POST', body: formData, credentials: 'include' });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);
      toast(t('backup.restore_completed'), 'success');
      closeModal();
    } catch (err) {
      statusEl.textContent = `${t('onboarding.error')} ${err.message}`;
      btn.disabled = false;
      btn.textContent = t('backup.restore_file_btn');
    }
  });

  // S3 section
  if (s3Enabled) {
    const listEl = container.querySelector('#s3-backup-list');
    const backups = await api('GET', '/api/admin/backups').catch(() => []);
    listEl.innerHTML = backups?.length ? backups.map(b => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);">
        <div style="flex:1;">
          <div style="font-size:0.8rem;font-weight:500;">${b.filename}</div>
          <div style="font-size:0.75rem;color:var(--text3);">${(b.size/1024/1024).toFixed(2)} MB · ${new Date(b.date).toLocaleString()}</div>
        </div>
        <button class="btn-secondary" style="font-size:0.75rem;" data-s3-restore="${b.filename}">${t('backup.restore')}</button>
      </div>
    `).join('') : `<p style="font-size:0.8rem;color:var(--text3);">${t('backup.no_backups')}</p>`;

    container.querySelector('#btn-s3-backup')?.addEventListener('click', async () => {
      const btn = container.querySelector('#btn-s3-backup');
      btn.disabled = true;
      btn.textContent = t('backup.backup_in_progress');
      try {
        await api('POST', '/api/admin/backups');
        toast(t('backup.backup_completed'), 'success');
        loadBackupModal();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = t('backup.s3_backup_now');
      }
    });

    listEl.querySelectorAll('[data-s3-restore]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(t('backup.restore_confirm'))) return;
        const confirmStr = prompt(t('backup.restore_type_confirm'));
        if (!confirmStr) return;
        try {
          await api('POST', `/api/admin/backups/${btn.dataset.s3Restore}/restore`, { confirm: confirmStr });
          toast(t('backup.restore_completed'), 'success');
          closeModal();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  }
}

function updateBlogStatusUI(status) {
  const badge = document.getElementById('topbar-blog-badge');
  if (badge) {
    badge.className = `topbar-blog-badge ${status}`;
    const textEl = document.getElementById('topbar-blog-badge-text');
    const label = status === 'live' ? t('blog.status_live') : status === 'paused' ? t('blog.status_paused') : t('blog.status_ended');
    if (textEl) textEl.textContent = label; else badge.firstChild.textContent = label;
    badge.style.cursor = state.user?.role === 'admin' ? 'pointer' : 'default';
    const chevron = badge.querySelector('.badge-chevron');
    if (chevron) chevron.style.display = state.user?.role === 'admin' ? '' : 'none';
  }
  // Disable composer when blog is ended
  const composer = document.getElementById('composer');
  if (composer) {
    const ended = status === 'ended';
    composer.style.opacity = ended ? '0.5' : '';
    composer.style.pointerEvents = ended ? 'none' : '';
    const endedBanner = document.getElementById('ended-banner');
    if (ended && !endedBanner) {
      const banner = document.createElement('div');
      banner.id = 'ended-banner';
      banner.className = 'ended-banner';
      banner.textContent = t('blog.ended_banner');
      composer.insertAdjacentElement('afterend', banner);
    } else if (!ended && endedBanner) {
      endedBanner.remove();
    }
  }
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function showModal({ title, body, actions, dismissable = true }) {
  const overlay = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');
  content.innerHTML = `
    <div class="modal-title">${escHtml(title)}</div>
    <div>${body}</div>
    <div class="modal-footer">${actions.map((a, i) => `<button class="${a.cls}" data-action-idx="${i}">${a.label}</button>`).join('')}</div>
  `;
  overlay.classList.remove('hidden');
  content.querySelectorAll('[data-action-idx]').forEach(btn => {
    btn.addEventListener('click', () => actions[parseInt(btn.dataset.actionIdx)].action());
  });
  if (dismissable) {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); }, { once: true });
  }
}

function closeModal() {
  document.getElementById('modal-overlay')?.classList.add('hidden');
}

// ─── Toasts ───────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return str.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleString(state.locale === 'en' ? 'en-US' : 'it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function setAvatar(el, user) {
  if (user.avatar_url) {
    el.innerHTML = `<img src="${escHtml(user.avatar_url)}" alt="">`;
  } else {
    el.textContent = (user.name || 'U')[0].toUpperCase();
  }
}

function wrapSelection(textarea, before, after) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end);
  const newText = before + (selected || 'testo') + after;
  textarea.value = textarea.value.slice(0, start) + newText + textarea.value.slice(end);
  textarea.focus();
  textarea.dispatchEvent(new Event('input'));
}

function insertAtCursor(textarea, text) {
  const pos = textarea.selectionStart;
  textarea.value = textarea.value.slice(0, pos) + text + textarea.value.slice(pos);
  textarea.selectionStart = textarea.selectionEnd = pos + text.length;
}

// ─── Locales served inline (fallback) ─────────────────────────────────────────
// The admin app loads translations from the server, but we also need them for login
// We serve translation files via static public/admin/locales/ (see below)

// ─── Sound ────────────────────────────────────────────────────────────────────
let audioCtx = null;

// Create and unlock AudioContext on first user gesture (required after page refresh)
function unlockAudioCtx() {
  if (!audioCtx && state.soundEnabled) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}
document.addEventListener('click', unlockAudioCtx, { passive: true });
document.addEventListener('touchend', unlockAudioCtx, { passive: true });
document.addEventListener('keydown', unlockAudioCtx, { passive: true });
// Also try to unlock when returning to the page (covers mobile tab switching)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') unlockAudioCtx();
}, { passive: true });

// Keep AudioContext alive — play silent buffer every 25s to prevent browser suspension
setInterval(() => {
  if (!audioCtx || !state.soundEnabled) return;
  if (audioCtx.state === 'suspended') { audioCtx.resume().catch(() => {}); return; }
  const buf = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  src.start();
}, 25000);

function playNewEntrySound(type = 'update') {
  if (!state.soundEnabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const ctx = audioCtx;
    const now = ctx.currentTime;
    if (type === 'breaking') {
      // Single triangle-wave beep, higher pitch than update
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'triangle';
      o.frequency.value = 660;
      g.gain.setValueAtTime(0.15, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      o.start(now);
      o.stop(now + 0.25);
    } else if (type === 'pinned') {
      // Warm ascending chime: C5 → E5
      const o1 = ctx.createOscillator();
      const g1 = ctx.createGain();
      o1.connect(g1); g1.connect(ctx.destination);
      o1.type = 'sine';
      o1.frequency.value = 523;
      g1.gain.setValueAtTime(0.18, now);
      g1.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      o1.start(now);
      o1.stop(now + 0.28);
      const o2 = ctx.createOscillator();
      const g2 = ctx.createGain();
      o2.connect(g2); g2.connect(ctx.destination);
      o2.type = 'sine';
      o2.frequency.value = 659;
      g2.gain.setValueAtTime(0.15, now + 0.22);
      g2.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
      o2.start(now + 0.22);
      o2.stop(now + 0.5);
    } else {
      // Single soft sine ding
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'sine';
      o.frequency.value = 440;
      g.gain.setValueAtTime(0.12, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      o.start(now);
      o.stop(now + 0.22);
    }
  } catch (_) {}
}

// ─── Column Resizers ──────────────────────────────────────────────────────────
function initResizers() {
  const STORAGE_KEY = 'nl-col-widths';
  const saved = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; } })();

  const sidebar = document.getElementById('sidebar');
  const rightPanel = document.getElementById('right-panel');

  if (sidebar && saved.sidebar) sidebar.style.width = saved.sidebar + 'px';
  if (rightPanel && saved.right) rightPanel.style.width = saved.right + 'px';

  function makeResizer(resizerId, getTarget, getSide) {
    const resizer = document.getElementById(resizerId);
    if (!resizer) return;
    let startX, startW;
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = getTarget().offsetWidth;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMove(e) {
        const delta = getSide() === 'left' ? e.clientX - startX : startX - e.clientX;
        const el = getTarget();
        const min = parseInt(el.style.minWidth) || 160;
        const max = parseInt(el.style.maxWidth) || 600;
        const newW = Math.min(max, Math.max(min, startW + delta));
        el.style.width = newW + 'px';
        const key = resizerId === 'resizer-left' ? 'sidebar' : 'right';
        const s = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; } })();
        s[key] = newW;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      }

      function onUp() {
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  makeResizer('resizer-left', () => document.getElementById('sidebar'), () => 'left');
  makeResizer('resizer-right', () => document.getElementById('right-panel'), () => 'right');
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
init().catch(console.error);
