# NewsLog

![NewsLog](public/admin/logo-rect-light.jpg)

NewsLog is a self-hosted live blog platform. It was vibe-coded, tested with real usage, and it is actively used today, so we are confident it works well in practice.

It provides a live blog embed with no external dependencies beyond this service, supports multiple users and roles, and keeps sharing and deep-linking reliable across desktop, Android, and iOS.

## Features

- Embeddable live blog with no third-party dependencies beyond this service
- Multi-user access with admin and non-admin roles
- Access is invite-only (only invited users can log in)
- The first user to log in becomes admin automatically; admins can promote other users
- Magic link authentication via email (no password management)
- Per-blog access control (limit specific blogs to specific users)
- Multiple languages (Italian and English)
- Multiple themes, layout presets, and color customization
- Author display with name and avatar
- Rich text editor (WYSIWYG) with optional titles per update
- Update types: standard updates, breaking, pinned, and summary
- Search inside each live blog
- Live blog states: live, paused, or ended
- Posts can be edited or deleted
- Shareable links that point to a specific post
- Dark mode and light mode
- Tested on desktop, Android, and iOS

If you find a bug, please report it so it can be fixed. Even though this started as a vibe-coded project, it has been tested and used in real scenarios.

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

## License

MIT
