'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const { getDb } = require('./db');
const { startHeartbeat } = require('./sse');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security & Middleware ─────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'www.youtube-nocookie.com', 'publish.twitter.com', 'platform.twitter.com'],
      frameSrc: ["'self'", 'www.youtube-nocookie.com', 'www.youtube.com', 'publish.twitter.com'],
      imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
      mediaSrc: ["'self'", 'https:', 'blob:'],
      connectSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
  // Allow embed iframe
  frameguard: false,
}));

// Allow embed pages to be loaded in any iframe
app.use('/embed', (req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.removeHeader('Content-Security-Policy');
  next();
});

const corsOrigins = process.env.CORS_ORIGINS
  ? [process.env.BASE_URL, ...process.env.CORS_ORIGINS.split(',')].filter(Boolean)
  : process.env.BASE_URL || '*';

app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));

app.use(compression({
  filter: (req, res) => {
    // Disable compression for SSE streams (would buffer real-time events)
    if (req.path.includes('/stream')) return false;
    return compression.filter(req, res);
  },
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Global rate limit
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ─── Static Files ─────────────────────────────────────────────────────────────

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use('/uploads', express.static(UPLOADS_DIR));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/auth', require('./routes/auth'));

const apiRouter = require('./routes/api');
const exportRouter = require('./routes/export');
const uploadRouter = require('./routes/upload');
const embedApiRouter = require('./routes/embed-api');
const backupRouter = require('./routes/backup');
const embedPageRouter = require('./routes/embed');

// Mount API sub-routers
app.use('/api', apiRouter);
app.use('/api', exportRouter);
app.use('/api', uploadRouter);
app.use('/api/embed', embedApiRouter);
app.use('/api/admin/backups', backupRouter);

// Locale JSON files for the admin SPA
app.use('/locales', express.static(path.join(__dirname, 'locales')));

// Embed widget static files (widget.js, widget.css) — no cache to ensure updates propagate
app.use('/embed', express.static(path.join(__dirname, '..', 'public', 'embed'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));
// Embed widget pages
app.use('/embed', embedPageRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Admin SPA — serve for all non-API routes
app.use('/', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/embed') || req.path.startsWith('/uploads')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

// ─── Scheduled Backup ─────────────────────────────────────────────────────────

if (process.env.S3_BACKUP_ENABLED === 'true') {
  const schedule = process.env.S3_BACKUP_SCHEDULE || '0 3 * * *';
  cron.schedule(schedule, async () => {
    console.log('[Backup] Starting scheduled backup...');
    try {
      const { runBackup } = require('./backup');
      const result = await runBackup();
      console.log(`[Backup] Completed: ${result.filename}`);
    } catch (err) {
      console.error('[Backup] Failed:', err.message);
    }
  });
  console.log(`[Backup] Scheduled backup configured: ${schedule}`);
}

// ─── Start Server ─────────────────────────────────────────────────────────────

// Initialize DB
getDb();
startHeartbeat();

app.listen(PORT, () => {
  console.log(`NewsLog running on port ${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}`);
});

module.exports = app;
