const express = require("express");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const QRCode = require("qrcode");
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 104857600); // 100 MB
const CLEANUP_SECRET = process.env.CLEANUP_SECRET;

// ── CORS ─────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: [
      "https://pictoqr.com",
      "https://www.pictoqr.com",
      "http://localhost:3000",
      "http://localhost:3001",
    ],
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── R2 setup ─────────────────────────────────────────────────────────
const R2_CONFIGURED = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME &&
  process.env.R2_PUBLIC_URL
);

const r2 = R2_CONFIGURED
  ? new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

// ── In-memory stores ──────────────────────────────────────────────────
const scanCounts = new Map();
// slug -> { r2Key, fileUrl, expiresAt (ISO string | null) }
const slugMap = new Map();

// ── Local temp dir ────────────────────────────────────────────────────
const rootDir = path.join(__dirname, "..");
const uploadPath = path.join(rootDir, "uploads");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });

// ── Static files ──────────────────────────────────────────────────────
app.use(express.static(path.join(rootDir, "frontend")));
if (!R2_CONFIGURED) {
  app.use("/uploads", express.static(uploadPath));
}

// ── Multer ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadPath),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// ── Helpers ───────────────────────────────────────────────────────────
function parseHexColor(value, fallback) {
  const v = String(value || fallback).trim();
  return /^#([0-9a-fA-F]{6})$/.test(v) ? v : fallback;
}

const EXPIRY_MS = {
  "1h":  3_600_000,
  "7h":  25_200_000,
  "24h": 86_400_000,
  "7d":  604_800_000,
  "15d": 1_296_000_000,
};

function calcExpiresAt(expiry) {
  return EXPIRY_MS[expiry]
    ? new Date(Date.now() + EXPIRY_MS[expiry]).toISOString()
    : null;
}

// R2 key format: "expires-<unixMs>/<filename>" or "permanent/<filename>"
function makeR2Key(filename, expiresAt) {
  if (expiresAt) {
    return `expires-${new Date(expiresAt).getTime()}/${filename}`;
  }
  return `permanent/${filename}`;
}

async function uploadToR2(localPath, key, contentType) {
  const body = fs.readFileSync(localPath);
  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
    })
  );
  return `${process.env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
}

const SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
function generateSlug(length = 7) {
  let slug;
  do {
    slug = Array.from(crypto.randomBytes(length))
      .map((b) => SLUG_CHARS[b % SLUG_CHARS.length])
      .join("");
  } while (slugMap.has(slug));
  return slug;
}

// ── Expired page HTML ─────────────────────────────────────────────────
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
a{display:inline-block;background:#4F46E5;color:#fff;text-decoration:none;font-family:'Outfit',sans-serif;font-weight:600;font-size:15px;padding:13px 32px;border-radius:12px;transition:background .2s}
a:hover{background:#3730A3}
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
  res.json({
    success: true,
    status: "ok",
    timestamp: new Date().toISOString(),
    r2: R2_CONFIGURED,
  })
);

// Short URL redirect — /s/:slug
app.get("/s/:slug", (req, res) => {
  const entry = slugMap.get(req.params.slug);
  if (!entry) {
    return res.status(404).send(expiredPage());
  }
  if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
    slugMap.delete(req.params.slug);
    return res.status(410).send(expiredPage());
  }
  // increment scan count
  const key = entry.r2Key;
  scanCounts.set(key, (scanCounts.get(key) || 0) + 1);
  res.redirect(302, entry.fileUrl);
});

// Legacy QR scan redirect — /r/<r2key>
app.get("/r/*", (req, res) => {
  const key = req.params[0];
  scanCounts.set(key, (scanCounts.get(key) || 0) + 1);
  const fileUrl = `${process.env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
  res.redirect(302, fileUrl);
});

// Scan stats for a key
app.get("/api/stats/*", (req, res) => {
  const key = req.params[0];
  res.json({ key, scans: scanCounts.get(key) || 0 });
});

// Upload
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const expiresAt = calcExpiresAt(req.body.expiry);
    const r2Key = makeR2Key(req.file.filename, expiresAt);

    let fileUrl;
    if (R2_CONFIGURED) {
      fileUrl = await uploadToR2(req.file.path, r2Key, req.file.mimetype);
      fs.unlinkSync(req.file.path);
    } else {
      console.warn("⚠️  R2 not configured — using ephemeral local storage.");
      fileUrl = `${BASE_URL}/uploads/${req.file.filename}`;
    }

    const slug = generateSlug();
    slugMap.set(slug, { r2Key, fileUrl, expiresAt });

    const shortUrl = `${BASE_URL}/s/${slug}`;

    const qrDark  = parseHexColor(req.body.qrDark,  "#0f0f13");
    const qrLight = parseHexColor(req.body.qrLight, "#ffffff");

    const qrCode = await QRCode.toDataURL(shortUrl, {
      width: 1200,
      margin: 2,
      color: { dark: qrDark, light: qrLight },
    });

    res.json({
      success: true,
      fileUrl,
      trackUrl: shortUrl,
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
    res.status(500).json({ error: "Upload failed" });
  }
});

// Cleanup — lists R2 objects, deletes expired ones
app.post("/api/cleanup", async (req, res) => {
  if (!CLEANUP_SECRET || req.headers["x-cleanup-secret"] !== CLEANUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!R2_CONFIGURED) {
    return res.status(400).json({ error: "R2 not configured" });
  }

  try {
    const now = Date.now();
    const deleted = [];
    let ContinuationToken;

    do {
      const list = await r2.send(
        new ListObjectsV2Command({
          Bucket: process.env.R2_BUCKET_NAME,
          ContinuationToken,
        })
      );

      for (const obj of list.Contents || []) {
        const match = obj.Key.match(/^expires-(\d+)\//);
        if (match && Number(match[1]) < now) {
          await r2.send(
            new DeleteObjectCommand({
              Bucket: process.env.R2_BUCKET_NAME,
              Key: obj.Key,
            })
          );
          scanCounts.delete(obj.Key);
          deleted.push(obj.Key);
        }
      }

      ContinuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (ContinuationToken);

    // Also purge expired slugs from memory
    for (const [slug, entry] of slugMap) {
      if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
        slugMap.delete(slug);
      }
    }

    res.json({ deleted: deleted.length, keys: deleted });
  } catch (error) {
    console.error("Cleanup error:", error);
    res.status(500).json({ error: "Cleanup failed" });
  }
});

// Manual delete
app.delete("/api/file/*", async (req, res) => {
  const key = req.params[0];
  if (!R2_CONFIGURED) return res.status(400).json({ error: "R2 not configured" });

  try {
    await r2.send(
      new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key })
    );
    scanCounts.delete(key);
    res.json({ success: true, key });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ error: "Delete failed" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`R2 storage: ${R2_CONFIGURED ? "enabled" : "disabled (local fallback)"}`);
});
