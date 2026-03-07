'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../auth');
const { runBackup, listBackups, restoreBackup, restoreFromFile, getLastBackupStatus, createBackupArchive, formatDate } = require('../backup');

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024 } });

// GET /api/admin/backups/config
router.get('/config', requireAuth, requireAdmin, (req, res) => {
  res.json({ s3_enabled: process.env.S3_BACKUP_ENABLED === 'true' });
});

// GET /api/admin/backups/status
router.get('/status', requireAuth, requireAdmin, (req, res) => {
  const status = getLastBackupStatus();
  res.json(status || { status: 'none' });
});

// GET /api/admin/backups/download — create archive and stream to browser
router.get('/download', requireAuth, requireAdmin, async (req, res) => {
  const tmpPath = path.join(os.tmpdir(), `newslog-backup-${Date.now()}.tar.gz`);
  try {
    await createBackupArchive(tmpPath);
    const filename = `newslog-backup-${formatDate(new Date())}.tar.gz`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/gzip');
    const stream = fs.createReadStream(tmpPath);
    stream.pipe(res);
    stream.on('end', () => { try { fs.unlinkSync(tmpPath); } catch {} });
    stream.on('error', () => { try { fs.unlinkSync(tmpPath); } catch {} res.end(); });
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/backups
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const backups = await listBackups();
    res.json(backups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/backups (manual S3 backup)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await runBackup();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/backups/restore-file — restore from uploaded .tar.gz
router.post('/restore-file', requireAuth, requireAdmin, upload.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    await restoreFromFile(req.file.path);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch {}
  }
});

// POST /api/admin/backups/:filename/restore (S3 restore)
router.post('/:filename/restore', requireAuth, requireAdmin, async (req, res) => {
  const { confirm } = req.body;
  if (!confirm) return res.status(400).json({ error: 'Confirmation required' });
  try {
    await restoreBackup(req.params.filename);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
