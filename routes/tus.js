// server-api/routes/tus.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const { Server } = require("tus-node-server");
const { FileStore } = require("@tus/file-store");

const router = express.Router();

const tusUploadDir = path.join(__dirname, "..", "tus_uploads");
if (!fs.existsSync(tusUploadDir))
  fs.mkdirSync(tusUploadDir, { recursive: true });

const tusServer = new Server({
  path: "/",
  datastore: new FileStore({ directory: tusUploadDir }),
});

// Important: tus uses its own request handling
router.all("/*", (req, res) => tusServer.handle(req, res));

module.exports = router;
