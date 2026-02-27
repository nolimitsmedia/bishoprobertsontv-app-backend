// server-api/routes/uploadsPages.js
const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const crypto = require("crypto");
const authenticateAdmin = require("../middleware/authenticateAdmin"); // adjust

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function makeName(original) {
  const ext = path.extname(original || "").toLowerCase() || ".jpg";
  const id = crypto.randomBytes(10).toString("hex");
  return `${Date.now()}_${id}${ext}`;
}

const baseDir = path.join(__dirname, "..", "uploads", "pages");
const heroDir = path.join(baseDir, "hero");
const inlineDir = path.join(baseDir, "inline");
ensureDir(heroDir);
ensureDir(inlineDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = String(req.query.type || "inline");
    cb(null, type === "hero" ? heroDir : inlineDir);
  },
  filename: (req, file, cb) => cb(null, makeName(file.originalname)),
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

router.use(authenticateAdmin);

// POST /api/uploads/pages?type=hero|inline
router.post("/pages", upload.single("file"), (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ ok: false, error: "No file uploaded" });

    const type = String(req.query.type || "inline");
    const url =
      type === "hero"
        ? `/uploads/pages/hero/${req.file.filename}`
        : `/uploads/pages/inline/${req.file.filename}`;

    res.json({ ok: true, url });
  } catch (e) {
    console.error("[uploadsPages] error:", e);
    res.status(500).json({ ok: false, error: "Upload failed" });
  }
});

module.exports = router;
