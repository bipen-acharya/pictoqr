/**
 * PictoQR – Analytics service
 *
 * Records scan events with privacy-preserving IP hashing.
 * Raw IPs are never stored — only a SHA-256 hash for
 * deduplication and abuse detection.
 */

"use strict";

const crypto = require("crypto");
const db     = require("../db/database");

/**
 * SHA-256 hash an IP address with a daily rotating salt.
 * Using a daily salt means the hash cannot be cross-referenced
 * across days, balancing analytics utility with privacy.
 */
function hashIp(ip) {
  if (!ip) return null;
  const today  = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const salt   = process.env.IP_HASH_SALT || "pictoqr-default-salt";
  return crypto
    .createHash("sha256")
    .update(`${salt}:${today}:${ip}`)
    .digest("hex")
    .slice(0, 16); // 64-bit prefix is enough for deduplication
}

/**
 * Record a scan event for a given file.
 * Called whenever the file download endpoint is hit.
 *
 * @param {object} opts
 * @param {string} opts.fileId
 * @param {string} [opts.ip]
 * @param {string} [opts.userAgent]
 * @param {string} [opts.referer]
 */
function recordScan({ fileId, ip, userAgent, referer }) {
  try {
    db.recordScan({
      file_id:    fileId,
      ip_hash:    hashIp(ip),
      user_agent: userAgent ? userAgent.slice(0, 512) : null,
      referer:    referer   ? referer.slice(0, 512)   : null,
    });
    db.incrementScanCount(fileId);
  } catch (err) {
    // Analytics must never break the file serving path
    console.error("[analytics] Failed to record scan:", err.message);
  }
}

module.exports = { recordScan };
