/**
 * PictoQR – SQLite database layer (via better-sqlite3)
 *
 * Stores:
 *   files        – metadata for every uploaded file
 *   scan_events  – one row per QR scan / file access
 *
 * Using better-sqlite3 (synchronous API) because:
 *  - Zero async complexity for a single-process Node server
 *  - Extremely fast for this read-heavy workload
 *  - No external database server required for self-hosting
 *
 * Swap to postgres via `pg` + connection pool for multi-instance deployments.
 */

"use strict";

const path = require("path");
const fs   = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "pictoqr.db");

let _db;

function getDb() {
  if (_db) return _db;

  _db = new Database(DB_PATH, {
    // WAL mode: concurrent reads + single write — ideal for web apps
    pragma: { journal_mode: "WAL", foreign_keys: "ON", synchronous: "NORMAL" },
  });

  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id            TEXT PRIMARY KEY,          -- UUID
      file_name     TEXT NOT NULL,             -- sanitised original name
      mime_type     TEXT NOT NULL,
      file_size     INTEGER NOT NULL,          -- bytes
      file_url      TEXT NOT NULL,
      qr_url        TEXT,                      -- optional persisted QR URL
      password_hash TEXT,                      -- bcrypt hash or NULL
      expires_at    INTEGER,                   -- unix epoch seconds, NULL = never
      scan_count    INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      deleted_at    INTEGER                    -- soft-delete timestamp
    );

    CREATE INDEX IF NOT EXISTS idx_files_expires ON files(expires_at)
      WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS scan_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      scanned_at INTEGER NOT NULL DEFAULT (unixepoch()),
      user_agent TEXT,
      referer    TEXT,
      ip_hash    TEXT    -- SHA-256 of IP for privacy (not raw IP)
    );

    CREATE INDEX IF NOT EXISTS idx_scans_file_id ON scan_events(file_id);
    CREATE INDEX IF NOT EXISTS idx_scans_time    ON scan_events(scanned_at);
  `);

  return _db;
}

/* ── File operations ─────────────────────────────────────────────── */

const insertFile = (db => (file) => {
  db().prepare(`
    INSERT INTO files (id, file_name, mime_type, file_size, file_url, expires_at)
    VALUES (@id, @file_name, @mime_type, @file_size, @file_url, @expires_at)
  `).run(file);
})(getDb);

const getFile = (db => (id) =>
  db().prepare("SELECT * FROM files WHERE id = ? AND deleted_at IS NULL").get(id)
)(getDb);

const listFiles = (db => ({ limit = 50, offset = 0 } = {}) =>
  db().prepare(`
    SELECT id, file_name, mime_type, file_size, file_url, scan_count,
           created_at, expires_at
    FROM   files
    WHERE  deleted_at IS NULL
    ORDER  BY created_at DESC
    LIMIT  ? OFFSET ?
  `).all(limit, offset)
)(getDb);

const countFiles = (db => () =>
  db().prepare("SELECT COUNT(*) AS n FROM files WHERE deleted_at IS NULL").get().n
)(getDb);

const softDeleteFile = (db => (id) =>
  db().prepare("UPDATE files SET deleted_at = unixepoch() WHERE id = ?").run(id)
)(getDb);

const hardDeleteExpired = (db => () =>
  db().prepare(`
    DELETE FROM files
    WHERE expires_at IS NOT NULL
      AND expires_at <= unixepoch()
      AND deleted_at IS NULL
  `).run()
)(getDb);

const incrementScanCount = (db => (id) =>
  db().prepare("UPDATE files SET scan_count = scan_count + 1 WHERE id = ?").run(id)
)(getDb);

/* ── Scan events ─────────────────────────────────────────────────── */

const recordScan = (db => (event) =>
  db().prepare(`
    INSERT INTO scan_events (file_id, user_agent, referer, ip_hash)
    VALUES (@file_id, @user_agent, @referer, @ip_hash)
  `).run(event)
)(getDb);

const getScansForFile = (db => (fileId, days = 30) =>
  db().prepare(`
    SELECT date(scanned_at, 'unixepoch') AS day, COUNT(*) AS scans
    FROM   scan_events
    WHERE  file_id = ?
      AND  scanned_at >= unixepoch() - (? * 86400)
    GROUP  BY day
    ORDER  BY day ASC
  `).all(fileId, days)
)(getDb);

/* ── Global analytics ────────────────────────────────────────────── */

const getGlobalStats = (db => () => {
  const d = db();
  return {
    totalFiles:  d.prepare("SELECT COUNT(*) AS n FROM files WHERE deleted_at IS NULL").get().n,
    totalScans:  d.prepare("SELECT COUNT(*) AS n FROM scan_events").get().n,
    totalSizeBytes: d.prepare("SELECT COALESCE(SUM(file_size),0) AS s FROM files WHERE deleted_at IS NULL").get().s,
    scansToday:  d.prepare(`
      SELECT COUNT(*) AS n FROM scan_events
      WHERE scanned_at >= unixepoch('now','start of day')
    `).get().n,
    recentFiles: d.prepare(`
      SELECT id, file_name, mime_type, file_size, scan_count, created_at
      FROM   files WHERE deleted_at IS NULL
      ORDER  BY created_at DESC LIMIT 10
    `).all(),
    topFiles: d.prepare(`
      SELECT id, file_name, scan_count FROM files
      WHERE  deleted_at IS NULL
      ORDER  BY scan_count DESC LIMIT 5
    `).all(),
    scansByDay: d.prepare(`
      SELECT date(scanned_at,'unixepoch') AS day, COUNT(*) AS scans
      FROM   scan_events
      WHERE  scanned_at >= unixepoch() - (30 * 86400)
      GROUP  BY day ORDER BY day ASC
    `).all(),
  };
})(getDb);

module.exports = {
  getDb,
  insertFile,
  getFile,
  listFiles,
  countFiles,
  softDeleteFile,
  hardDeleteExpired,
  incrementScanCount,
  recordScan,
  getScansForFile,
  getGlobalStats,
};
