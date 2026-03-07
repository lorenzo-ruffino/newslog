'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { requireAuth, requireBlogAccess } = require('../auth');

const UPLOADS_BASE = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'data', 'uploads');
const MAX_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || '52428800'); // 50MB default

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm',
  'audio/mpeg', 'audio/ogg', 'audio/wav',
]);

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter(req, file, cb) {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error(`File type not allowed: ${file.mimetype}`));
  },
});

// POST /api/blogs/:slug/upload
router.post('/blogs/:slug/upload', requireAuth, requireBlogAccess, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const blog = getDb().prepare('SELECT * FROM blogs WHERE slug = ?').get(req.params.slug);
  if (!blog) return res.status(404).json({ error: 'Blog not found' });

  const ext = path.extname(req.file.originalname).toLowerCase() || `.${req.file.mimetype.split('/')[1]}`;
  const filename = `${uuidv4()}${ext}`;
  const blogUploadsDir = path.join(UPLOADS_BASE, req.params.slug);

  fs.mkdirSync(blogUploadsDir, { recursive: true });
  const filePath = path.join(blogUploadsDir, filename);

  let buffer = req.file.buffer;

  // Resize images
  if (req.file.mimetype.startsWith('image/') && req.file.mimetype !== 'image/gif') {
    try {
      const sharp = require('sharp');
      buffer = await sharp(buffer)
        .resize({ width: 1920, withoutEnlargement: true })
        .toBuffer();
    } catch (_) {}
  }

  fs.writeFileSync(filePath, buffer);

  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const url = `${baseUrl}/uploads/${req.params.slug}/${filename}`;

  res.json({ url, filename, size: buffer.length, type: req.file.mimetype });
});

// POST /api/users/me/avatar
const avatarUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB for avatars
  fileFilter(req, file, cb) {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed for avatar'));
  },
});

router.post('/users/me/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const avatarsDir = path.join(UPLOADS_BASE, 'avatars');
  fs.mkdirSync(avatarsDir, { recursive: true });

  const ext = '.webp';
  const filename = `${req.user.id}${ext}`;
  const filePath = path.join(avatarsDir, filename);

  let buffer = req.file.buffer;
  try {
    const sharp = require('sharp');
    buffer = await sharp(buffer)
      .resize(200, 200, { fit: 'cover' })
      .webp({ quality: 85 })
      .toBuffer();
  } catch (_) {}

  fs.writeFileSync(filePath, buffer);

  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const avatarUrl = `${baseUrl}/uploads/avatars/${filename}?v=${Date.now()}`;

  const db = getDb();
  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.user.id);

  res.json({ avatar_url: avatarUrl });
});

module.exports = router;
