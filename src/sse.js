'use strict';

const EventEmitter = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0);

// Map: blogSlug => Set of { res, userId, lastEventId }
const publicConnections = new Map();
// Map: blogSlug => Set of { res, userId, user }
const editorConnections = new Map();

function addPublicClient(slug, res, lastEventId = null) {
  if (!publicConnections.has(slug)) publicConnections.set(slug, new Set());
  const client = { res, lastEventId };
  publicConnections.get(slug).add(client);

  res.on('close', () => {
    const set = publicConnections.get(slug);
    if (set) {
      set.delete(client);
      if (set.size === 0) publicConnections.delete(slug);
    }
  });
}

function addEditorClient(slug, res, user) {
  if (!editorConnections.has(slug)) editorConnections.set(slug, new Set());
  const client = { res, user };
  editorConnections.get(slug).add(client);

  // Notify others that this editor joined
  broadcastToEditors(slug, 'editor_join', {
    user_id: user.id,
    name: user.name,
    avatar_url: user.avatar_url,
  }, user.id);

  res.on('close', () => {
    const set = editorConnections.get(slug);
    if (set) {
      set.delete(client);
      if (set.size === 0) editorConnections.delete(slug);
    }
    broadcastToEditors(slug, 'editor_leave', { user_id: user.id });
  });
}

function broadcastToPublic(slug, event, data, id = null) {
  const clients = publicConnections.get(slug);
  if (!clients) return;
  const payload = formatSSE(event, data, id);
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch (_) {}
  }
}

function broadcastToEditors(slug, event, data, excludeUserId = null) {
  const clients = editorConnections.get(slug);
  if (!clients) return;
  const payload = formatSSE(event, data);
  for (const client of clients) {
    if (excludeUserId && client.user.id === excludeUserId) continue;
    try {
      client.res.write(payload);
    } catch (_) {}
  }
}

function formatSSE(event, data, id = null) {
  let msg = '';
  if (id !== null) msg += `id: ${id}\n`;
  msg += `event: ${event}\n`;
  msg += `data: ${JSON.stringify(data)}\n\n`;
  return msg;
}

function getOnlineEditors(slug) {
  const clients = editorConnections.get(slug);
  if (!clients) return [];
  return Array.from(clients).map(c => ({
    user_id: c.user.id,
    name: c.user.name,
    avatar_url: c.user.avatar_url,
  }));
}

function startHeartbeat() {
  setInterval(() => {
    const now = Date.now();
    const payload = formatSSE('heartbeat', { timestamp: now });

    for (const clients of publicConnections.values()) {
      for (const client of clients) {
        try { client.res.write(payload); } catch (_) {}
      }
    }
    for (const clients of editorConnections.values()) {
      for (const client of clients) {
        try { client.res.write(payload); } catch (_) {}
      }
    }
  }, 30000);
}

module.exports = {
  addPublicClient,
  addEditorClient,
  broadcastToPublic,
  broadcastToEditors,
  getOnlineEditors,
  startHeartbeat,
  formatSSE,
};
