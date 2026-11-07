// server-api/lib/uploadPolicy.js
//
// Phase 9 security essentials: which files may be uploaded.
//
// Uploaded files are served from the CDN or /uploads. Active content (web
// pages, SVG, scripts, programs) could run in a visitor's browser or on a
// computer when opened, so only the media and document types this app actually
// uses are accepted. Both the file extension AND the browser-reported type must
// be acceptable, and must agree with each other.
//
// Usage with multer:
//   const { fileFilter } = require("../lib/uploadPolicy");
//   multer({ storage, fileFilter: fileFilter("media") })   // images, video, audio, documents
//   multer({ storage, fileFilter: fileFilter("images") })  // images only
//   multer({ storage, fileFilter: fileFilter("resources") })// documents + images
//
// Escape hatch (off by default): UPLOAD_ALLOW_SVG=true allows .svg images.

const path = require("path");

const GROUPS = {
  image: {
    ".jpg": ["image/jpeg", "image/pjpeg"],
    ".jpeg": ["image/jpeg", "image/pjpeg"],
    ".png": ["image/png"],
    ".gif": ["image/gif"],
    ".webp": ["image/webp"],
    ".avif": ["image/avif"],
    ".bmp": ["image/bmp", "image/x-ms-bmp"],
    ".heic": ["image/heic", "image/heif"],
    ".heif": ["image/heif", "image/heic"],
  },
  video: {
    ".mp4": ["video/mp4"],
    ".m4v": ["video/x-m4v", "video/mp4"],
    ".mov": ["video/quicktime"],
    ".webm": ["video/webm"],
    ".mkv": ["video/x-matroska", "video/matroska"],
    ".avi": ["video/x-msvideo", "video/avi"],
    ".wmv": ["video/x-ms-wmv"],
    ".mpeg": ["video/mpeg"],
    ".mpg": ["video/mpeg"],
    ".3gp": ["video/3gpp"],
    ".ts": ["video/mp2t"],
  },
  audio: {
    ".mp3": ["audio/mpeg", "audio/mp3"],
    ".wav": ["audio/wav", "audio/x-wav", "audio/wave"],
    ".m4a": ["audio/mp4", "audio/x-m4a", "audio/m4a"],
    ".aac": ["audio/aac", "audio/x-aac"],
    ".ogg": ["audio/ogg"],
    ".flac": ["audio/flac", "audio/x-flac"],
  },
  document: {
    ".pdf": ["application/pdf"],
    ".doc": ["application/msword"],
    ".docx": [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ".xls": ["application/vnd.ms-excel"],
    ".xlsx": [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    ".ppt": ["application/vnd.ms-powerpoint"],
    ".pptx": [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    ".odt": ["application/vnd.oasis.opendocument.text"],
    ".ods": ["application/vnd.oasis.opendocument.spreadsheet"],
    ".odp": ["application/vnd.oasis.opendocument.presentation"],
    ".rtf": ["application/rtf", "text/rtf"],
    ".txt": ["text/plain"],
    ".csv": [
      "text/csv",
      "application/csv",
      "text/plain",
      "application/vnd.ms-excel",
    ],
    ".epub": ["application/epub+zip"],
    ".zip": ["application/zip", "application/x-zip-compressed"],
  },
};

const PROFILES = {
  images: ["image"],
  media: ["image", "video", "audio", "document"],
  resources: ["document", "image"],
};

// Generic types some browsers send for valid files; the extension decides then.
const GENERIC_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

function allowedMap(profile) {
  const groups = PROFILES[profile] || PROFILES.media;
  const map = {};
  for (const g of groups) Object.assign(map, GROUPS[g]);
  if (
    groups.includes("image") &&
    String(process.env.UPLOAD_ALLOW_SVG) === "true"
  ) {
    map[".svg"] = ["image/svg+xml"];
  }
  return map;
}

function describe(profile) {
  const p = PROFILES[profile] ? profile : "media";
  if (p === "images") return "JPG, PNG, GIF, WebP, AVIF, BMP or HEIC images";
  if (p === "resources")
    return "documents (PDF, Word, Excel, PowerPoint, text, ZIP) or images";
  return "images, videos, audio files or documents";
}

// Returns "" when the file is acceptable, otherwise a message for the user.
function checkFile(file, profile = "media") {
  const name = String(file?.originalname || "");
  const ext = path.extname(name).toLowerCase();
  const type = String(file?.mimetype || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  const map = allowedMap(profile);
  const types = map[ext];
  if (!ext || !types) {
    return `“${name || "This file"}” can’t be uploaded here. Allowed: ${describe(profile)}.`;
  }
  if (!GENERIC_TYPES.has(type) && !types.includes(type)) {
    return `“${name}” looks like ${type || "an unknown type"}, which doesn’t match its .${ext.slice(1)} extension.`;
  }
  return "";
}

class UploadTypeError extends Error {
  constructor(message) {
    super(message);
    this.name = "UploadTypeError";
    this.code = "UPLOAD_TYPE_NOT_ALLOWED";
    this.status = 415;
  }
}

function fileFilter(profile = "media") {
  return (_req, file, cb) => {
    const problem = checkFile(file, profile);
    if (problem) return cb(new UploadTypeError(problem));
    return cb(null, true);
  };
}

// Express error handler for routes that call multer as middleware directly.
function uploadErrorHandler(err, _req, res, next) {
  if (err && err.code === "UPLOAD_TYPE_NOT_ALLOWED") {
    return res
      .status(415)
      .json({
        ok: false,
        error: err.message,
        message: err.message,
        code: err.code,
      });
  }
  return next(err);
}

module.exports = {
  checkFile,
  fileFilter,
  uploadErrorHandler,
  UploadTypeError,
  PROFILES,
};
