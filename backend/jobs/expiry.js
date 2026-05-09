/**
 * PictoQR – File expiry cron job
 *
 * Runs every hour. Finds files whose `expires_at` has passed,
 * deletes them from disk, and marks them deleted in the DB.
 *
 * Schedule is configurable via EXPIRY_CRON_SCHEDULE env var.
 * Default: "0 * * * *" (top of every hour)
 */

"use strict";

const path    = require("path");
const fs      = require("fs");
const cron    = require("node-cron");
const db      = require("../db/database");

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || "uploads");
const SCHEDULE   = process.env.EXPIRY_CRON_SCHEDULE || "0 * * * *";

function deleteFileFromDisk(fileId) {
  const dir = path.join(UPLOAD_DIR, fileId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
  return false;
}

async function runExpiryJob() {
  const database = db.getDb();

  // Find all expired, non-deleted files
  const expired = database.prepare(`
    SELECT id FROM files
    WHERE  expires_at IS NOT NULL
      AND  expires_at <= unixepoch()
      AND  deleted_at IS NULL
  `).all();

  if (expired.length === 0) return;

  console.log(`[expiry-job] Processing ${expired.length} expired file(s)…`);

  let deleted = 0;
  for (const { id } of expired) {
    try {
      deleteFileFromDisk(id);
      db.softDeleteFile(id);
      deleted++;
    } catch (err) {
      console.error(`[expiry-job] Failed to delete file ${id}:`, err.message);
    }
  }

  console.log(`[expiry-job] Cleaned up ${deleted}/${expired.length} file(s).`);
}

function startExpiryJob() {
  if (!cron.validate(SCHEDULE)) {
    console.warn(`[expiry-job] Invalid cron schedule "${SCHEDULE}", using default.`);
  }

  const task = cron.schedule(SCHEDULE, () => {
    runExpiryJob().catch((err) =>
      console.error("[expiry-job] Unexpected error:", err)
    );
  });

  console.log(`[expiry-job] Scheduled — "${SCHEDULE}"`);
  return task;
}

module.exports = { startExpiryJob, runExpiryJob };
