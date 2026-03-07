# NewsLog

![NewsLog](public/admin/logo-rect-light.jpg)

Self-hosted live blog platform. Publish real-time updates, embed them on any website via iframe, manage editors and themes — no third-party services required.

## Features

- Real-time updates via Server-Sent Events
- Embeddable widget (iframe) for any website
- Magic link authentication (no passwords)
- Rich text editor with image/video/audio uploads
- Multiple live blogs, multiple editors
- Themes, dark/light mode, layout presets
- Backup & restore (local download + optional S3)
- Italian and English UI

## Quick start with Docker

### 1. Clone the repo

```bash
git clone https://github.com/lorenzo-ruffino/newslog.git
cd newslog
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values. The required fields are:

| Variable | Description |
|----------|-------------|
| `BASE_URL` | Public URL of your instance, e.g. `https://newslog.example.com` |
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_PORT` | SMTP port (usually `587`) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `SMTP_FROM` | Sender address, e.g. `NewsLog <noreply@example.com>` |
| `SECRET_KEY` | Random secret for JWT signing — generate with: `openssl rand -hex 48` |

### 3. Start

```bash
docker compose up -d
```

The app will be available at `http://localhost:3000` (or the port set in `.env`).

The first user to log in becomes admin automatically.

### 4. Reverse proxy (recommended)

Put Nginx or Caddy in front for HTTPS. Example Caddy config:

```
newslog.example.com {
    reverse_proxy localhost:3000
}
```

## Updating

```bash
git pull
docker compose up -d --build
```

Data (database + uploads) is stored in `./data/` and persists across updates.

## Backup & restore

From the admin UI (user menu → Backup & Restore):

- **Download backup** — downloads a `.tar.gz` archive with the full database and all uploaded media
- **Restore from file** — upload a previously downloaded archive to restore

Optionally, configure S3 in `.env` for automatic scheduled backups (see `.env.example`).

## Running without Docker

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
# edit .env
node src/server.js
```

## Development

```bash
npm run dev
```

Hot-reloads the server on file changes (uses `node --watch`).

## Embedding

From the admin UI, open any live blog and click the `<>` button in the toolbar to get the embed snippet. Paste it into any HTML page:

```html
<iframe
  id="nl-frame-my-blog"
  src="https://newslog.example.com/embed/my-blog"
  style="width:100%;border:none;display:block;"
  scrolling="no"
  loading="lazy"
></iframe>
<script>
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'newslog-resize') {
    var iframe = document.getElementById('nl-frame-my-blog');
    if (iframe) iframe.style.height = e.data.height + 'px';
  }
});
</script>
```

## License

MIT

---

Built with [Claude Code](https://claude.ai/claude-code) by Anthropic.
