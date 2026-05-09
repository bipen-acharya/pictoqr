const express      = require("express");
const compression  = require("compression");
const multer       = require("multer");
const cors         = require("cors");
const dotenv       = require("dotenv");
const path         = require("path");
const fs           = require("fs");
const crypto       = require("crypto");
const QRCode       = require("qrcode");
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

dotenv.config();

const app            = express();
const PORT           = process.env.PORT || 3000;
const BASE_URL       = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const MAX_FILE_SIZE  = Number(process.env.MAX_FILE_SIZE || 104857600); // 100 MB
const CLEANUP_SECRET = process.env.CLEANUP_SECRET;

// ── Blocked file extensions ────────────────────────────────────────────
const BLOCKED_EXT = new Set([".exe",".sh",".bat",".ps1",".cmd",".msi",".vbs",".jar",".com",".pif",".scr"]);

// ── Expiry map (key → ms offset) ──────────────────────────────────────
const EXPIRY_MS = {
  "1h":  3_600_000,
  "7h":  25_200_000,
  "24h": 86_400_000,
  "7d":  604_800_000,
  "15d": 1_296_000_000,
};

// ── Base62 charset ────────────────────────────────────────────────────
const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

// ── In-memory stores ──────────────────────────────────────────────────
// slug → { fileUrl, expiresAt (ISO|null), r2Key }
const slugMap   = new Map();
// scan counts keyed by r2Key
const scanCounts = new Map();
// rate limiting: ip → { count, resetAt }
const rateLimitMap = new Map();

// ── R2 setup ─────────────────────────────────────────────────────────
const R2_CONFIGURED = !!(
  process.env.R2_ACCOUNT_ID    &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME   &&
  process.env.R2_PUBLIC_URL
);

const r2 = R2_CONFIGURED
  ? new S3Client({
      region:   "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

// ── Local temp dir ────────────────────────────────────────────────────
const rootDir    = path.join(__dirname, "..");
const uploadPath = path.join(rootDir, "uploads");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });

// ── Middleware ────────────────────────────────────────────────────────
app.use(compression());
app.use(cors({
  origin: [
    "https://pictoqr.com",
    "https://www.pictoqr.com",
    "http://localhost:3000",
    "http://localhost:3001",
  ],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request-ID header on every response
app.use((req, res, next) => {
  res.setHeader("X-Request-ID", crypto.randomUUID());
  next();
});

// Static files with cache-busting headers for immutable assets
app.use(express.static(path.join(rootDir, "frontend"), {
  maxAge: "1d",
  etag:   true,
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      // HTML: always revalidate
      res.setHeader("Cache-Control", "no-cache");
    }
  },
}));

if (!R2_CONFIGURED) {
  app.use("/uploads", express.static(uploadPath, {
    maxAge: "7d",
    immutable: true,
    etag: true,
  }));
}

// ── Multer ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadPath),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// ── Helpers ───────────────────────────────────────────────────────────
function parseHexColor(value, fallback) {
  const v = String(value || fallback).trim();
  return /^#([0-9a-fA-F]{6})$/.test(v) ? v : fallback;
}

function calcExpiresAt(expiry) {
  return EXPIRY_MS[expiry]
    ? new Date(Date.now() + EXPIRY_MS[expiry]).toISOString()
    : null;
}

function makeR2Key(filename, expiresAt) {
  return expiresAt
    ? `expires-${new Date(expiresAt).getTime()}/${filename}`
    : `permanent/${filename}`;
}

async function uploadToR2(localPath, key, contentType) {
  const body = fs.readFileSync(localPath);
  await r2.send(new PutObjectCommand({
    Bucket:      process.env.R2_BUCKET_NAME,
    Key:         key,
    Body:        body,
    ContentType: contentType || "application/octet-stream",
  }));
  return `${process.env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
}

// 4-char Base62 slug (62^4 = 14.7M combinations)
function generateSlug(len = 4) {
  let slug;
  let attempts = 0;
  do {
    const bytes = crypto.randomBytes(len);
    slug = Array.from(bytes).map(b => B62[b % 62]).join("");
    attempts++;
    if (attempts > 100) { len++; attempts = 0; } // auto-expand on collision pressure
  } while (slugMap.has(slug));
  return slug;
}

function isExpired(entry) {
  return entry.expiresAt && new Date(entry.expiresAt) <= new Date();
}

// Rate limit: 10 uploads per IP per hour
function checkRateLimit(ip) {
  const now  = Date.now();
  const hour = 3_600_000;
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + hour });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

function clientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

// ── Expired page ──────────────────────────────────────────────────────
function expiredPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Link Expired · PictoQR</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;700&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#F8F7FF;color:#1A1830;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;border:1px solid #E5E4F0;border-radius:20px;box-shadow:0 12px 48px rgba(79,70,229,.1);padding:48px 40px;text-align:center;max-width:420px;width:100%}
.icon{width:72px;height:72px;border-radius:50%;background:#FEF3C7;display:flex;align-items:center;justify-content:center;margin:0 auto 24px;font-size:36px}
h1{font-family:'Outfit',sans-serif;font-size:26px;font-weight:700;margin-bottom:10px;color:#1A1830}
p{color:#4B4870;font-size:15px;line-height:1.6;margin-bottom:28px}
a{display:inline-block;background:linear-gradient(135deg,#4F46E5,#7C3AED);color:#fff;text-decoration:none;font-family:'Outfit',sans-serif;font-weight:600;font-size:15px;padding:13px 32px;border-radius:12px;transition:opacity .2s}
a:hover{opacity:.85}
</style>
</head>
<body>
<div class="card">
  <div class="icon">⏱</div>
  <h1>This link has expired</h1>
  <p>The file attached to this QR code is no longer available.<br/>Upload a new file to get a fresh link.</p>
  <a href="/">Create a new QR code</a>
</div>
</body>
</html>`;
}

// ── Routes ────────────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.sendFile(path.join(rootDir, "frontend", "index.html"))
);
app.get("/admin", (req, res) =>
  res.sendFile(path.join(rootDir, "frontend", "admin.html"))
);

app.get("/api/health", (req, res) =>
  res.json({ success: true, status: "ok", timestamp: new Date().toISOString(), r2: R2_CONFIGURED })
);

// Short URL redirect: /r/:slug  (4-char Base62)
app.get("/r/:slug", (req, res) => {
  const { slug } = req.params;

  // Legacy long-path fallback (old /r/permanent/... or /r/expires-.../... links)
  if (slug.includes("/") || slug.length > 8) {
    const key = req.params[0] || slug;
    scanCounts.set(key, (scanCounts.get(key) || 0) + 1);
    return res.redirect(302, `${process.env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`);
  }

  const entry = slugMap.get(slug);
  if (!entry) return res.status(404).send(expiredPage());
  if (isExpired(entry)) {
    slugMap.delete(slug);
    return res.status(410).send(expiredPage());
  }
  scanCounts.set(entry.r2Key, (scanCounts.get(entry.r2Key) || 0) + 1);
  // No-cache: always re-check expiry on each visit
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, entry.fileUrl);
});

// Handle old /r/* wildcard (legacy)
app.get("/r/*", (req, res) => {
  const key = req.params[0];
  scanCounts.set(key, (scanCounts.get(key) || 0) + 1);
  const fileUrl = `${process.env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
  res.redirect(302, fileUrl);
});

// Also keep /s/:slug from previous session
app.get("/s/:slug", (req, res) => {
  const entry = slugMap.get(req.params.slug);
  if (!entry) return res.status(404).send(expiredPage());
  if (isExpired(entry)) { slugMap.delete(req.params.slug); return res.status(410).send(expiredPage()); }
  scanCounts.set(entry.r2Key, (scanCounts.get(entry.r2Key) || 0) + 1);
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, entry.fileUrl);
});

// Scan stats
app.get("/api/stats/:slug", (req, res) => {
  const entry = slugMap.get(req.params.slug);
  const key   = entry?.r2Key || req.params.slug;
  res.json({ slug: req.params.slug, scans: scanCounts.get(key) || 0 });
});

// Upload
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    // Rate limit
    const ip = clientIp(req);
    if (!checkRateLimit(ip)) {
      return res.status(429).json({
        success: false,
        error: "Too many uploads. You can upload up to 10 files per hour.",
        code: "RATE_LIMITED",
      });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded.", code: "NO_FILE" });
    }

    // Block dangerous extensions
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (BLOCKED_EXT.has(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        success: false,
        error: `File type "${ext}" is not allowed for security reasons.`,
        code: "BLOCKED_TYPE",
      });
    }

    // Double-check file size (multer rejects >MAX but be explicit)
    if (req.file.size > MAX_FILE_SIZE) {
      fs.unlinkSync(req.file.path);
      return res.status(413).json({
        success: false,
        error: `File too large. Maximum allowed size is ${Math.round(MAX_FILE_SIZE / 1048576)} MB.`,
        code: "FILE_TOO_LARGE",
      });
    }

    const expiresAt = calcExpiresAt(req.body.expiry);
    const r2Key     = makeR2Key(req.file.filename, expiresAt);

    let fileUrl;
    if (R2_CONFIGURED) {
      fileUrl = await uploadToR2(req.file.path, r2Key, req.file.mimetype);
      fs.unlinkSync(req.file.path);
    } else {
      console.warn("⚠️  R2 not configured — using ephemeral local storage.");
      fileUrl = `${BASE_URL}/uploads/${req.file.filename}`;
    }

    const slug     = generateSlug();
    slugMap.set(slug, { fileUrl, r2Key, expiresAt });

    const shortUrl  = `${BASE_URL}/r/${slug}`;
    const qrDark    = parseHexColor(req.body.qrDark,  "#0f0f13");
    const qrLight   = parseHexColor(req.body.qrLight, "#ffffff");

    const qrCode = await QRCode.toDataURL(shortUrl, {
      width:  1200,
      margin: 2,
      color:  { dark: qrDark, light: qrLight },
    });

    res.json({
      success:  true,
      fileUrl,
      shortUrl,
      slug,
      expiresAt,
      qrCode,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
    });
  } catch (error) {
    console.error("Upload error:", error);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: "Upload failed. Please try again.", code: "INTERNAL_ERROR" });
  }
});

// Cleanup (called by Cloudflare Worker cron)
app.post("/api/cleanup", async (req, res) => {
  if (!CLEANUP_SECRET || req.headers["x-cleanup-secret"] !== CLEANUP_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  if (!R2_CONFIGURED) {
    return res.status(400).json({ success: false, error: "R2 not configured" });
  }

  try {
    const now     = Date.now();
    const deleted = [];
    let ContinuationToken;

    do {
      const list = await r2.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
        ContinuationToken,
      }));

      for (const obj of list.Contents || []) {
        const match = obj.Key.match(/^expires-(\d+)\//);
        if (match && Number(match[1]) < now) {
          await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: obj.Key }));
          scanCounts.delete(obj.Key);
          deleted.push(obj.Key);
        }
      }
      ContinuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (ContinuationToken);

    // Purge expired in-memory slugs
    for (const [slug, entry] of slugMap) {
      if (isExpired(entry)) slugMap.delete(slug);
    }

    res.json({ success: true, deleted: deleted.length, keys: deleted });
  } catch (error) {
    console.error("Cleanup error:", error);
    res.status(500).json({ success: false, error: "Cleanup failed" });
  }
});

// Manual delete
app.delete("/api/file/:key(*)", async (req, res) => {
  const key = req.params.key;
  if (!R2_CONFIGURED) return res.status(400).json({ success: false, error: "R2 not configured" });
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
    scanCounts.delete(key);
    res.json({ success: true, key });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ success: false, error: "Delete failed" });
  }
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

app.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`);
  console.log(`✓ R2 storage: ${R2_CONFIGURED ? "enabled" : "disabled (local fallback)"}`);
  console.log(`✓ Compression: enabled`);
  console.log(`✓ Max upload: ${Math.round(MAX_FILE_SIZE / 1048576)} MB`);
});
