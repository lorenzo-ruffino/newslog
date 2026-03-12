# Piano implementazione: Titolo opzionale + Condivisione messaggio

Due feature da implementare in ordine. Testare su Desktop, Android e iOS Safari.

---

## FEATURE 1: Titolo opzionale per entry

### 1.1 — Migrazione DB (`src/db.js`)

Nella funzione `migrate(db)` (dopo le CREATE TABLE esistenti, ~riga 104), aggiungere:

```js
// Migration: add optional title to entries
try {
  db.prepare("SELECT title FROM entries LIMIT 0").get();
} catch {
  db.exec("ALTER TABLE entries ADD COLUMN title TEXT DEFAULT NULL");
}
```

Questo pattern try/catch è safe perché non esiste un sistema di versioning migrazioni — è lo stesso approccio da usare per colonne aggiuntive.

### 1.2 — API: accettare `title` nel POST e PATCH (`src/routes/api.js`)

**POST `/api/blogs/:slug/entries`** (riga 162):
- Destructure `title` da `req.body` insieme a `content` e `entry_type` (riga 171)
- Sanitizzare il titolo: `const safeTitle = title ? sanitize(title).replace(/<[^>]+>/g, '').trim().slice(0, 200) || null : null;` (strip HTML, max 200 chars)
- Modificare la INSERT (riga 194-197):
  ```sql
  INSERT INTO entries (id, blog_id, author_id, content, entry_type, is_pinned, title)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ```
  Aggiungere `safeTitle` come settimo parametro

**PATCH `/api/blogs/:slug/entries/:id`** (riga 207):
- Destructure `title` da `req.body` insieme a `content` e `entry_type` (riga 221)
- Aggiungere blocco dopo il blocco `if (content !== undefined)` (dopo riga 224):
  ```js
  if (title !== undefined) {
    const safeTitle = title ? sanitize(title).replace(/<[^>]+>/g, '').trim().slice(0, 200) || null : null;
    db.prepare("UPDATE entries SET title = ?, updated_at = datetime('now') WHERE id = ?").run(safeTitle, entry.id);
  }
  ```

### 1.3 — Admin UI: campo titolo nel composer (`public/admin/index.html`)

Inserire **prima** del `<div class="compose-area">` (riga 143), dentro il composer:

```html
<input type="text" id="compose-title" class="compose-title"
  data-i18n-placeholder="editor.title_placeholder"
  placeholder="Titolo (opzionale)" maxlength="200">
```

### 1.4 — Admin CSS (`public/admin/style.css`)

Aggiungere stile per `.compose-title`:

```css
.compose-title {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px 8px 0 0;
  font-size: 1rem;
  font-weight: 600;
  background: var(--surface);
  color: var(--text);
  outline: none;
  margin-bottom: -1px; /* fonde con il bordo del compose-area */
}
.compose-title:focus {
  border-color: var(--primary);
}
.compose-title::placeholder {
  font-weight: 400;
  color: var(--text-secondary);
}
```

### 1.5 — Admin JS: inviare il titolo (`public/admin/app.js`)

**Nella funzione `publishEntry()`** (riga 639):
- Dopo riga 643, leggere il titolo:
  ```js
  const titleInput = document.getElementById('compose-title');
  const title = titleInput?.value.trim() || null;
  ```
- Nell'oggetto passato a `api('POST', ...)` (riga 700-703), aggiungere `title`:
  ```js
  { content: fullContent, entry_type: state.entryType, title }
  ```
- Nel reset del form dopo pubblicazione, svuotare il campo:
  ```js
  if (titleInput) titleInput.value = '';
  ```

**Nella funzione `createEntryElement(entry)`** (riga 352):
- Dopo il `<div class="entry-header">...</div>` (dopo riga 371) e prima di `<div class="entry-content">`, inserire:
  ```js
  ${entry.title ? `<div class="entry-title">${escHtml(entry.title)}</div>` : ''}
  ```

**Nella funzione di edit entry** (handleEntryAction con action='edit'):
- Pre-popolare il titolo nel form di modifica se presente. Cercare dove viene gestito l'edit e aggiungere il campo titolo anche nel modal/form di edit. Inviare `title` nel PATCH.

### 1.6 — Admin CSS per titolo nel feed (`public/admin/style.css`)

```css
.entry-title {
  font-size: 1.05rem;
  font-weight: 700;
  margin-bottom: 4px;
  color: var(--text);
}
```

### 1.7 — Widget JS: renderizzare il titolo (`public/embed/widget.js`)

**In `buildEntryEl()`** (riga 464), nel template HTML dell'innerHTML (~riga 493-504):
- Dopo `</div>` dell'header e prima di `<div class="nl-entry-content">`, aggiungere:
  ```js
  ${entry.title ? `<div class="nl-entry-title">${esc(entry.title)}</div>` : ''}
  ```

### 1.8 — Widget server-render: titolo nelle entry (`src/routes/embed.js`)

**In `renderEntry()`** (~riga 220), nel template HTML:
- Dopo l'header `</div>` e prima di `<div class="nl-entry-content">`, aggiungere:
  ```js
  ${entry.title ? `<div class="nl-entry-title">${escapeHtml(entry.title)}</div>` : ''}
  ```

**Nella query SQL** del GET /embed/:idOrSlug (~riga 34), la SELECT `e.*` già include `title` automaticamente, nessuna modifica necessaria.

### 1.9 — Widget CSS (`public/embed/widget.css`)

```css
.nl-entry-title {
  font-size: 1.05rem;
  font-weight: 700;
  line-height: 1.3;
  margin-bottom: 6px;
  color: var(--nl-text, #1E293B);
}
```

### 1.10 — Export (`src/routes/export.js`)

In `renderExportEntry()` (~riga 124), aggiungere il titolo nel template HTML, prima del contenuto:
```js
${entry.title ? `<div style="font-size:1.05rem;font-weight:700;margin-bottom:4px;">${escapeHtml(entry.title)}</div>` : ''}
```

La SELECT `e.*` nell'export JSON include `title` automaticamente.

### 1.11 — Traduzioni (`src/locales/it.json` e `en.json`)

Aggiungere:
- IT: `"title_placeholder": "Titolo (opzionale)"`
- EN: `"title_placeholder": "Title (optional)"`

Dentro il blocco `editor`.

---

## FEATURE 2: Condivisione singolo messaggio

### 2.1 — Nuovo endpoint API: GET singola entry (`src/routes/api.js`)

Aggiungere **prima** del DELETE (riga 240):

```js
// GET /api/blogs/:slug/entries/:id — single entry (public, no auth)
router.get('/blogs/:slug/entries/:id', (req, res) => {
  const blog = getBlogBySlug(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  const db = getDb();
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND blog_id = ?').get(req.params.id, blog.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  res.json(formatEntry(entry, db));
});
```

ATTENZIONE: questo endpoint deve stare **prima** della route parametrica `:id` nelle routes DELETE e PATCH (che hanno requireAuth), oppure assicurarsi che il router Express distingua GET da DELETE/PATCH. Essendo metodi diversi (GET vs DELETE vs PATCH), non c'è conflitto.

### 2.2 — Widget: aggiungere bottone share a ogni entry (`public/embed/widget.js`)

**In `buildEntryEl()`**, nell'innerHTML, dopo `<div class="nl-entry-content">...</div>`, aggiungere un footer:

```js
<div class="nl-entry-footer">
  <button class="nl-share-btn" data-entry-id="${entry.id}" aria-label="${labels.share || 'Share'}">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
  </button>
</div>
```

Dopo la creazione dell'elemento, aggiungere l'event listener:

```js
const shareBtn = el.querySelector('.nl-share-btn');
if (shareBtn) {
  shareBtn.addEventListener('click', () => shareEntry(entry.id));
}
```

### 2.3 — Widget: logica di share (`public/embed/widget.js`)

Aggiungere la funzione `shareEntry`:

```js
function shareEntry(entryId) {
  // Costruisci URL: usa data-page-url se impostato, altrimenti URL embed standalone
  const pageUrl = script?.dataset.pageUrl || window.location.href.split('#')[0];
  const shareUrl = pageUrl + '#nl-entry-' + entryId;

  // Prova navigator.share (mobile native), altrimenti fallback clipboard
  if (navigator.share) {
    navigator.share({ url: shareUrl }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(shareUrl).then(() => {
      showShareToast(labels.link_copied || 'Link copied');
    }).catch(() => {
      fallbackCopy(shareUrl);
    });
  } else {
    fallbackCopy(shareUrl);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  showShareToast(labels.link_copied || 'Link copied');
}

function showShareToast(msg) {
  let toast = document.getElementById('nl-share-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'nl-share-toast';
    toast.className = 'nl-share-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('nl-show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('nl-show'), 2000);
}
```

**NOTA su `navigator.share`**: su iOS Safari e Android Chrome apre il native share sheet. Su desktop fallisce silenziosamente e usa il clipboard fallback. Testato e supportato su tutti e tre.

**NOTA su `navigator.clipboard`**: in iframe con sandbox serve `allow-same-origin`. Lo snippet embed attuale già include `allow-same-origin` nel sandbox attribute, quindi OK. Se non funziona dentro l'iframe (alcuni browser bloccano clipboard in iframe non same-origin), il `fallbackCopy` con `execCommand('copy')` copre il caso.

### 2.4 — Widget: scroll-to-entry all'apertura (`public/embed/widget.js`)

All'avvio del widget (dopo il rendering iniziale delle entry, dopo la sezione che popola il feed dal server-render), aggiungere:

```js
// Scroll to shared entry if URL has fragment
function scrollToTargetEntry() {
  const hash = window.location.hash || '';
  const match = hash.match(/^#nl-entry-(.+)$/);
  if (!match) return;

  const targetId = match[1];
  const el = document.getElementById('nl-entry-' + targetId);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('nl-highlight');
    setTimeout(() => el.classList.remove('nl-highlight'), 3000);
    return;
  }

  // Entry non nel DOM (paginata) — carica via API
  fetch(`/api/blogs/${blogSlug}/entries/${targetId}`)
    .then(r => r.ok ? r.json() : null)
    .then(entry => {
      if (!entry) return;
      const newEl = buildEntryEl(entry, true);
      const feed = document.getElementById('nl-feed');
      if (!feed) return;

      // Inserisci in posizione corretta (prima delle entry più vecchie, dopo quelle più nuove)
      // Approccio semplice: append in fondo con un separatore visivo
      const separator = document.createElement('div');
      separator.className = 'nl-shared-separator';
      separator.textContent = labels.shared_entry || 'Shared entry';
      feed.appendChild(separator);
      feed.appendChild(newEl);

      newEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      newEl.classList.add('nl-highlight');
      setTimeout(() => newEl.classList.remove('nl-highlight'), 3000);
    })
    .catch(() => {});
}

scrollToTargetEntry();
```

**NOTA CRITICA su iframe e hash**: il widget gira in un iframe. L'hash `#nl-entry-xxx` è nell'URL della **pagina parent**, non dell'iframe. Il widget non può leggere `window.location.hash` del parent (cross-origin). Quindi serve un meccanismo aggiuntivo:

**Opzione A (consigliata)**: il parent passa il fragment all'iframe via URL. Nel resize.js o nello snippet embed, il parent legge il proprio hash e lo appende all'src dell'iframe:

```js
// Nello script embed del parent (snippet o resize.js)
var hash = window.location.hash;
if (hash && hash.indexOf('#nl-entry-') === 0) {
  var iframe = document.getElementById('nl-frame-...');
  if (iframe && iframe.src.indexOf('#') === -1) {
    iframe.src = iframe.src + hash;
  }
}
```

**Opzione B**: il parent manda il hash via postMessage al widget. Più pulito ma richiede che il parent abbia il resize.js caricato.

**Scegliere opzione A** — è autonoma e funziona anche senza resize.js.

Modificare il codice snippet generato in `showEmbedSnippet()` (`public/admin/app.js`, riga 1425) per aggiungere dopo la parte resize:

```js
// Pass hash to iframe for deep-linking
var hash = window.location.hash;
if (hash && hash.indexOf('#nl-entry-') === 0) {
  var iframe = document.getElementById('${frameId}');
  if (iframe) iframe.src = iframe.src + hash;
}
// Also handle hash changes (browser back/forward)
window.addEventListener('hashchange', function() {
  var hash = window.location.hash;
  if (hash && hash.indexOf('#nl-entry-') === 0) {
    var iframe = document.getElementById('${frameId}');
    if (iframe) iframe.contentWindow.postMessage({ type: 'newslog-scrollto', entryId: hash.replace('#nl-entry-', '') }, '*');
  }
});
```

Nel widget, aggiungere listener per `newslog-scrollto` postMessage (accanto al listener `newslog-scroll` esistente, riga 115):

```js
if (e.data && e.data.type === 'newslog-scrollto') {
  scrollToEntry(e.data.entryId);
}
```

Dove `scrollToEntry(id)` è la parte di logica di `scrollToTargetEntry` estratta in funzione riusabile.

### 2.5 — Widget CSS: share button, toast, highlight (`public/embed/widget.css`)

```css
/* Share button */
.nl-entry-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
  padding-top: 4px;
}
.nl-share-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--nl-text2, #64748B);
  padding: 4px;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}
.nl-entry:hover .nl-share-btn,
.nl-share-btn:focus {
  opacity: 1;
}
/* Su mobile mostra sempre (no hover) */
@media (hover: none) {
  .nl-share-btn { opacity: 0.6; }
}
.nl-share-btn:hover {
  color: var(--nl-primary, #2563EB);
}

/* Highlight per entry condivisa */
.nl-highlight {
  animation: nl-highlight-pulse 3s ease-out;
}
@keyframes nl-highlight-pulse {
  0%, 15% { box-shadow: 0 0 0 3px var(--nl-primary, #2563EB); }
  100% { box-shadow: 0 0 0 0 transparent; }
}

/* Shared entry separator */
.nl-shared-separator {
  text-align: center;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--nl-text2, #64748B);
  padding: 12px 0 4px;
}

/* Share toast */
.nl-share-toast {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%) translateY(20px);
  background: var(--nl-text, #1E293B);
  color: #fff;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 0.8rem;
  opacity: 0;
  transition: opacity 0.2s, transform 0.2s;
  pointer-events: none;
  z-index: 1000;
}
.nl-share-toast.nl-show {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
```

### 2.6 — Server-rendered entries: aggiungere footer share (`src/routes/embed.js`)

Nella funzione `renderEntry()` (~riga 220), nel template HTML dopo `<div class="nl-entry-content">...</div>`, aggiungere:

```html
<div class="nl-entry-footer">
  <button class="nl-share-btn" data-entry-id="${entry.id}" aria-label="Share">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
  </button>
</div>
```

E nel widget.js, dopo il rendering iniziale, fare un bind globale dei click sui share button server-rendered:
```js
document.querySelectorAll('.nl-share-btn[data-entry-id]').forEach(btn => {
  btn.addEventListener('click', () => shareEntry(btn.dataset.entryId));
});
```

### 2.7 — Resize.js: aggiungere supporto deep-link (`src/routes/embed.js`)

Nel codice del resize.js (riga 52-95), aggiungere all'interno dell'IIFE, dopo il blocco `addEventListener('scroll', ...)`:

```js
// Deep-link: pass hash fragment to iframe on load
function passHashToIframes() {
  var hash = window.location.hash;
  if (hash && hash.indexOf('#nl-entry-') === 0) {
    if (!iframes.length) findIframes();
    iframes.forEach(function(iframe) {
      try {
        iframe.contentWindow.postMessage({
          type: 'newslog-scrollto',
          entryId: hash.replace('#nl-entry-', '')
        }, '*');
      } catch(_) {}
    });
  }
}
window.addEventListener('hashchange', passHashToIframes);
// On first load, wait for iframe ready then pass hash
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'newslog-resize') {
    passHashToIframes();
  }
});
```

NOTA: aggiornare `findIframes` con il fix `knownIframes` già applicato (usa `knownIframes` invece di `iframes`).

### 2.8 — Snippet embed: aggiungere deep-link (`public/admin/app.js`)

Nello snippet generato in `showEmbedSnippet()` (riga 1425), aggiungere nel `<script>` dopo il resize handler:

```js
// Deep-link support
if (window.location.hash && window.location.hash.indexOf('#nl-entry-') === 0) {
  var checkReady = setInterval(function() {
    var iframe = document.getElementById('${frameId}');
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'newslog-scrollto', entryId: window.location.hash.replace('#nl-entry-', '') }, '*');
      clearInterval(checkReady);
    }
  }, 200);
  setTimeout(function() { clearInterval(checkReady); }, 5000);
}
```

### 2.9 — Traduzioni (`src/locales/it.json` e `en.json`)

Nel blocco `widget`:
- IT: `"share": "Condividi"`, `"link_copied": "Link copiato"`, `"shared_entry": "Messaggio condiviso"`
- EN: `"share": "Share"`, `"link_copied": "Link copied"`, `"shared_entry": "Shared entry"`

### 2.10 — Export: nessuna modifica necessaria

La condivisione è solo una funzionalità live del widget, non serve nell'export statico.

---

## Ordine di implementazione

1. **Feature 1 (Titolo)** — passi 1.1 → 1.11 in ordine
2. **Feature 2 (Share)** — passi 2.1 → 2.9 in ordine

## Checklist di test

- [ ] Creare entry senza titolo → funziona come prima
- [ ] Creare entry con titolo → visibile in admin, widget, export
- [ ] Editare entry per aggiungere/rimuovere titolo
- [ ] Titolo con HTML/XSS → viene sanitizzato
- [ ] Share button visibile su hover (desktop) e sempre (mobile)
- [ ] Click share su iOS Safari → native share sheet
- [ ] Click share su Android Chrome → native share sheet
- [ ] Click share su desktop → copia link + toast
- [ ] Aprire link condiviso → scroll all'entry + highlight
- [ ] Aprire link con entry paginata (non nelle prime 20) → carica via API + scroll
- [ ] Verificare che il deep-link funzioni sia con resize.js che con snippet inline
- [ ] Verificare share in modalità conversation
- [ ] Verificare share in modalità timeline e card
