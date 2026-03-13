'use strict';

let fetch;
try {
  fetch = globalThis.fetch || require('node-fetch');
} catch {
  fetch = globalThis.fetch;
}

function extractYoutubeId(url) {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function extractTweetId(url) {
  const match = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
  return match ? match[1] : null;
}

async function resolveYoutube(url) {
  const videoId = extractYoutubeId(url);
  if (!videoId) return null;

  let title = `YouTube Video`;
  let thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const resp = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const data = await resp.json();
      title = data.title || title;
    }
  } catch (_) {}

  return {
    type: 'youtube',
    url,
    title,
    thumbnail,
    html: `<div class="nl-embed nl-embed-youtube"><iframe src="https://www.youtube-nocookie.com/embed/${videoId}" frameborder="0" allowfullscreen loading="lazy" style="width:100%;aspect-ratio:16/9;border-radius:6px;"></iframe></div>`,
    provider: 'YouTube',
    provider_icon: 'youtube',
  };
}

async function resolveTweet(url) {
  const tweetId = extractTweetId(url);
  if (!tweetId) return null;

  let title = 'Tweet';
  let html = `<div class="nl-embed nl-embed-tweet"><blockquote><a href="${url}" target="_blank" rel="noopener">${url}</a></blockquote></div>`;

  try {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`;
    const resp = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const data = await resp.json();
      title = data.author_name ? `@${data.author_name}` : title;
      html = `<div class="nl-embed nl-embed-tweet">${data.html}</div>`;
    }
  } catch (_) {}

  return {
    type: 'tweet',
    url,
    title,
    thumbnail: null,
    html,
    provider: 'X / Twitter',
    provider_icon: 'twitter',
  };
}

async function resolveInstagram(url) {
  let title = 'Instagram Post';
  let html = `<div class="nl-embed nl-embed-instagram"><a href="${url}" target="_blank" rel="noopener">${url}</a></div>`;

  try {
    const oembedUrl = `https://api.instagram.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`;
    const resp = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const data = await resp.json();
      title = data.title || title;
      html = `<div class="nl-embed nl-embed-instagram">${data.html}</div>`;
    }
  } catch (_) {}

  return {
    type: 'instagram',
    url,
    title,
    thumbnail: null,
    html,
    provider: 'Instagram',
    provider_icon: 'instagram',
  };
}

async function resolveBluesky(url) {
  // bsky.app/profile/{handle}/post/{id}
  const match = url.match(/bsky\.app\/profile\/([^/]+)\/post\/([a-zA-Z0-9]+)/);
  if (!match) return null;

  const handle = match[1];
  const postId = match[2];
  let title = `Post by @${handle}`;
  let html = `<div class="nl-embed nl-embed-bluesky"><a href="${url}" target="_blank" rel="noopener">${url}</a></div>`;

  try {
    const apiUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at://${handle}/app.bsky.feed.post/${postId}`;
    const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const data = await resp.json();
      const post = data.thread?.post?.record;
      if (post?.text) {
        title = post.text.slice(0, 100);
        html = `<div class="nl-embed nl-embed-bluesky"><p>${post.text}</p><a href="${url}" target="_blank" rel="noopener">View on Bluesky</a></div>`;
      }
    }
  } catch (_) {}

  return {
    type: 'bluesky',
    url,
    title,
    thumbnail: null,
    html,
    provider: 'Bluesky',
    provider_icon: 'bluesky',
  };
}

async function resolveDirectMedia(url) {
  const lowerUrl = url.toLowerCase().split('?')[0];
  if (/\.(jpg|jpeg|png|gif|webp)$/.test(lowerUrl)) {
    return {
      type: 'image',
      url,
      title: url.split('/').pop(),
      thumbnail: url,
      html: `<div class="nl-embed nl-embed-image"><img src="${url}" alt="" loading="lazy" style="max-width:100%;border-radius:6px;"></div>`,
      provider: 'Image',
      provider_icon: 'image',
    };
  }
  if (/\.(mp4|webm)$/.test(lowerUrl)) {
    return {
      type: 'video',
      url,
      title: url.split('/').pop(),
      thumbnail: null,
      html: `<div class="nl-embed nl-embed-video"><video src="${url}" controls style="max-width:100%;border-radius:6px;"></video></div>`,
      provider: 'Video',
      provider_icon: 'video',
    };
  }
  if (/\.(mp3|ogg|wav)$/.test(lowerUrl)) {
    return {
      type: 'audio',
      url,
      title: url.split('/').pop(),
      thumbnail: null,
      html: `<div class="nl-embed nl-embed-audio"><audio src="${url}" controls style="width:100%;"></audio></div>`,
      provider: 'Audio',
      provider_icon: 'audio',
    };
  }
  return null;
}

function buildLinkCard({ url, title, description, image, siteName }) {
  const safeTitle = title || url;
  const safeSite = siteName || new URL(url).hostname;
  const cardHtml = `<div class="nl-embed nl-embed-link">
    ${image ? `<img src="${image}" alt="" loading="lazy" style="max-width:100%;border-radius:4px 4px 0 0;">` : ''}
    <div class="nl-embed-link-body">
      <strong>${safeTitle}</strong>
      ${description ? `<p>${description.slice(0, 150)}</p>` : ''}
      <a href="${url}" target="_blank" rel="noopener">${safeSite}</a>
    </div>
  </div>`;

  return {
    type: 'link',
    url,
    title: safeTitle,
    thumbnail: image || null,
    html: cardHtml,
    provider: safeSite,
    provider_icon: 'link',
  };
}

async function resolveOpenGraph(url) {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsLog/1.0)' },
    });
    if (!resp.ok) {
      return buildLinkCard({ url, title: url, description: '', image: null, siteName: new URL(url).hostname });
    }
    const html = await resp.text();

    const getOgMeta = (property) => {
      const match = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, 'i'));
      return match ? match[1] : null;
    };

    const title = getOgMeta('og:title') || getOgMeta('twitter:title') || url;
    const description = getOgMeta('og:description') || getOgMeta('twitter:description') || '';
    const image = getOgMeta('og:image') || getOgMeta('twitter:image') || null;
    const siteName = getOgMeta('og:site_name') || new URL(url).hostname;

    return buildLinkCard({ url, title, description, image, siteName });
  } catch (_) {
    try {
      return buildLinkCard({ url, title: url, description: '', image: null, siteName: new URL(url).hostname });
    } catch {
      return null;
    }
  }
}

async function resolveEmbed(url) {
  if (!url || typeof url !== 'string') return null;

  try {
    new URL(url);
  } catch {
    return null;
  }

  // YouTube
  if (/(?:youtube\.com|youtu\.be)/.test(url)) return resolveYoutube(url);
  // Twitter/X
  if (/(?:twitter\.com|x\.com)\/\w+\/status\//.test(url)) return resolveTweet(url);
  // Instagram
  if (/instagram\.com\/(?:p|reel)\//.test(url)) return resolveInstagram(url);
  // Bluesky
  if (/bsky\.app\/profile\//.test(url)) return resolveBluesky(url);
  // Direct media files
  const media = await resolveDirectMedia(url);
  if (media) return media;
  // Generic Open Graph
  return resolveOpenGraph(url);
}

module.exports = { resolveEmbed };
