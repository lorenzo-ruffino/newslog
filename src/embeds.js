'use strict';

// Detect embeddable URLs in text and return positions
const URL_REGEX = /https?:\/\/[^\s<>"']+/g;

const EMBED_PATTERNS = [
  { type: 'youtube', regex: /(?:youtube\.com\/watch\?v=|youtu\.be\/)[a-zA-Z0-9_-]{11}/ },
  { type: 'tweet', regex: /(?:twitter\.com|x\.com)\/\w+\/status\/\d+/ },
  { type: 'instagram', regex: /instagram\.com\/(?:p|reel)\/[^/]+/ },
  { type: 'bluesky', regex: /bsky\.app\/profile\/[^/]+\/post\/[a-zA-Z0-9]+/ },
  { type: 'image', regex: /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i },
  { type: 'video', regex: /\.(mp4|webm)(\?.*)?$/i },
  { type: 'audio', regex: /\.(mp3|ogg|wav)(\?.*)?$/i },
];

function detectUrls(text) {
  const urls = [];
  let match;
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    urls.push(match[0]);
  }
  return [...new Set(urls)];
}

function detectEmbedType(url) {
  for (const pattern of EMBED_PATTERNS) {
    if (pattern.regex.test(url)) return pattern.type;
  }
  return 'link';
}

module.exports = { detectUrls, detectEmbedType };
