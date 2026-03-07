'use strict';

const express = require('express');
const router = express.Router();
const { resolveEmbed } = require('../embed-resolver');
const rateLimit = require('express-rate-limit');

const embedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many embed resolve requests' },
});

// POST /api/embed/resolve
router.post('/resolve', embedLimiter, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const result = await resolveEmbed(url);
    if (!result) return res.status(422).json({ error: 'Could not resolve embed for this URL' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve embed' });
  }
});

module.exports = router;
