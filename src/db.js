'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'newslog.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db);
  }
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'editor',
      avatar_url  TEXT,
      locale      TEXT DEFAULT 'it',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login  DATETIME
    );

    CREATE TABLE IF NOT EXISTS blogs (
      id          TEXT PRIMARY KEY,
      slug        TEXT UNIQUE NOT NULL,
      title       TEXT NOT NULL,
      description TEXT,
      status      TEXT DEFAULT 'live',
      created_by  TEXT REFERENCES users(id),
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      settings    TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS magic_links (
      id          TEXT PRIMARY KEY,
      email       TEXT NOT NULL,
      token       TEXT UNIQUE NOT NULL,
      expires_at  DATETIME NOT NULL,
      used        INTEGER DEFAULT 0,
      invite_type TEXT DEFAULT 'login',
      blog_id     TEXT REFERENCES blogs(id)
    );

    CREATE TABLE IF NOT EXISTS blog_members (
      id          TEXT PRIMARY KEY,
      blog_id     TEXT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      added_by    TEXT NOT NULL REFERENCES users(id),
      added_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(blog_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS entries (
      id          TEXT PRIMARY KEY,
      blog_id     TEXT NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
      author_id   TEXT NOT NULL REFERENCES users(id),
      content     TEXT NOT NULL,
      entry_type  TEXT DEFAULT 'update',
      media       TEXT,
      is_pinned   INTEGER DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id),
      token_hash  TEXT NOT NULL,
      expires_at  DATETIME NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS backup_log (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      status      TEXT NOT NULL,
      filename    TEXT,
      size        INTEGER,
      message     TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_entries_blog ON entries(blog_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_entries_pinned ON entries(blog_id, is_pinned, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_blogs_slug ON blogs(slug);
    CREATE INDEX IF NOT EXISTS idx_magic_links_token ON magic_links(token);
    CREATE INDEX IF NOT EXISTS idx_blog_members ON blog_members(blog_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_blog_members_user ON blog_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);

  // Migration: add optional title to entries
  try {
    db.prepare("SELECT title FROM entries LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE entries ADD COLUMN title TEXT DEFAULT NULL");
  }
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb };
