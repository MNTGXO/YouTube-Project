const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { requireAuth } = require("../middleware/auth");
const Video = require("../models/Video");
const User = require("../models/User");
const { getVideoMetadata } = require("../utils/ffmpeg");

const router = express.Router();

// ─── Multer for chunks ────────────────────────────────────────────────────────
// uploadId comes from URL param (req.params), NOT body — avoids multer ordering bug
const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    // req.params.uploadId is always available (from URL, not body)
    const chunkDir = path.join(__dirname, "../uploads/chunks", req.params.uploadId);
    fs.mkdirSync(chunkDir, { recursive: true });
    cb(null, chunkDir);
  },
  filename: (req, file, cb) => {
    // chunkIndex also in URL param
    cb(null, `chunk_${req.params.chunkIndex}`);
  },
});

const chunkUpload = multer({
  storage: chunkStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per chunk
});

// ─── Multer for small direct uploads ─────────────────────────────────────────
const directStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "../uploads");
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".mp4";
    cb(null, `${uuidv4()}${ext}`);
  },
});

const directUpload = multer({
  storage: directStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("video/")) cb(null, true);
    else cb(new Error("Only video files are allowed"), false);
  },
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ─── POST /api/videos/chunk/:uploadId/:chunkIndex ────────────────────────────
// uploadId and chunkIndex in URL so multer can use them before body is parsed
router.post("/chunk/:uploadId/:chunkIndex", requireAuth, chunkUpload.single("chunk"), async (req, res) => {
  try {
    const { uploadId, chunkIndex } = req.params;
    const { totalChunks, filename } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "No chunk data received" });
    }

    // Write meta.json once (on first chunk)
    const metaPath = path.join(__dirname, "../uploads/chunks", uploadId, "meta.json");
    if (!fs.existsSync(metaPath)) {
      fs.writeFileSync(metaPath, JSON.stringify({
        uploadId,
        totalChunks: parseInt(totalChunks),
        filename: filename || "video.mp4",
        userId: req.user._id.toString(),
        createdAt: new Date().toISOString(),
      }));
    }

    const received = parseInt(chunkIndex) + 1;
    const total = parseInt(totalChunks);

    console.log(`Chunk ${received}/${total} saved for uploadId=${uploadId}`);

    res.json({ received, total, done: received >= total });
  } catch (err) {
    console.error("Chunk error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/videos/assemble ────────────────────────────────────────────────
router.post("/assemble", requireAuth, async (req, res) => {
  const {
    uploadId,
    shortDuration = 60,
    title = "YouTube Short",
    description = "Created with ShortsAI",
    tags = "shorts,youtube",
    privacy = "public",
  } = req.body;

  if (!uploadId) return res.status(400).json({ error: "uploadId required" });

  const chunkDir = path.join(__dirname, "../uploads/chunks", uploadId);
  const metaPath = path.join(chunkDir, "meta.json");

  console.log(`Assembling uploadId=${uploadId}, chunkDir=${chunkDir}`);
  console.log(`meta.json exists: ${fs.existsSync(metaPath)}`);

  if (!fs.existsSync(chunkDir)) {
    return res.status(404).json({ error: `Chunk directory not found for uploadId: ${uploadId}` });
  }
  if (!fs.existsSync(metaPath)) {
    // List what IS in the dir to help debug
    const files = fs.readdirSync(chunkDir);
    return res.status(404).json({ error: `meta.json missing. Found files: ${files.join(", ")}` });
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));

  if (meta.userId !== req.user._id.toString()) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const ext = path.extname(meta.filename) || ".mp4";
    const finalFilename = `${uuidv4()}${ext}`;
    const finalPath = path.join(__dirname, "../uploads", finalFilename);
    const writeStream = fs.createWriteStream(finalPath);

    console.log(`Assembling ${meta.totalChunks} chunks → ${finalPath}`);

    for (let i = 0; i < meta.totalChunks; i++) {
      const chunkPath = path.join(chunkDir, `chunk_${i}`);
      if (!fs.existsSync(chunkPath)) {
        writeStream.destroy();
        return res.status(400).json({ error: `Missing chunk ${i} of ${meta.totalChunks}` });
      }
      const data = fs.readFileSync(chunkPath);
      writeStream.write(data);
    }

    await new Promise((resolve, reject) => {
      writeStream.end();
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    // Clean up chunks
    fs.rmSync(chunkDir, { recursive: true, force: true });
    console.log(`Assembly complete: ${finalPath}`);

    // Get video metadata
    let duration = null;
    const fileSize = fs.statSync(finalPath).size;
    try {
      const metadata = await getVideoMetadata(finalPath);
      duration = metadata.format.duration;
    } catch (e) {
      console.warn("Could not read video metadata:", e.message);
    }

    const tagList = typeof tags === "string"
      ? tags.split(",").map(t => t.trim()).filter(Boolean)
      : tags;

    const video = new Video({
      userId: req.user._id,
      originalFilename: meta.filename,
      localPath: finalPath,
      fileSize,
      duration,
      mimeType: "video/mp4",
      shortDuration: parseInt(shortDuration),
      defaultTitle: title,
      defaultDescription: description,
      defaultTags: tagList,
      privacy,
      status: "uploaded",
    });

    await video.save();
    await User.findByIdAndUpdate(req.user._id, { $inc: { totalVideosUploaded: 1 } });

    res.status(201).json({
      message: "Video assembled successfully",
      video: {
        id: video._id,
        originalFilename: video.originalFilename,
        fileSize: video.fileSize,
        duration: video.duration,
        estimatedClips: duration ? Math.ceil(duration / parseInt(shortDuration)) : null,
        status: video.status,
        createdAt: video.createdAt,
      },
    });
  } catch (err) {
    console.error("Assemble error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/videos/upload (direct for small files) ────────────────────────
router.post("/upload", requireAuth, directUpload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video file provided" });

    const {
      shortDuration = 60, title = "YouTube Short",
      description = "Created with ShortsAI", tags = "shorts,youtube", privacy = "public",
    } = req.body;

    let duration = null;
    try {
      const metadata = await getVideoMetadata(req.file.path);
      duration = metadata.format.duration;
    } catch (e) {
      console.warn("Metadata read failed:", e.message);
    }

    const tagList = typeof tags === "string"
      ? tags.split(",").map(t => t.trim()).filter(Boolean)
      : tags;

    const video = new Video({
      userId: req.user._id,
      originalFilename: req.file.originalname,
      localPath: req.file.path,
      fileSize: req.file.size,
      duration,
      mimeType: req.file.mimetype,
      shortDuration: parseInt(shortDuration),
      defaultTitle: title,
      defaultDescription: description,
      defaultTags: tagList,
      privacy,
      status: "uploaded",
    });

    await video.save();
    await User.findByIdAndUpdate(req.user._id, { $inc: { totalVideosUploaded: 1 } });

    res.status(201).json({
      message: "Video uploaded successfully",
      video: {
        id: video._id,
        originalFilename: video.originalFilename,
        fileSize: video.fileSize,
        duration: video.duration,
        estimatedClips: duration ? Math.ceil(duration / parseInt(shortDuration)) : null,
        status: video.status,
        createdAt: video.createdAt,
      },
    });
  } catch (err) {
    console.error("Upload error:", err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message || "Upload failed" });
  }
});

// ─── GET /api/videos ──────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    const videos = await Video.find({ userId: req.user._id })
      .sort({ createdAt: -1 }).limit(50)
      .select("-localPath -clips.localPath");
    res.json({ videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/videos/:id ─────────────────────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, userId: req.user._id })
      .select("-localPath -clips.localPath");
    if (!video) return res.status(404).json({ error: "Video not found" });
    res.json({ video });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/videos/:id ──────────────────────────────────────────────────
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, userId: req.user._id });
    if (!video) return res.status(404).json({ error: "Video not found" });
    if (["processing", "cutting", "uploading"].includes(video.status)) {
      return res.status(400).json({ error: "Cannot delete a video currently processing" });
    }
    try {
      if (fs.existsSync(video.localPath)) fs.unlinkSync(video.localPath);
      for (const clip of video.clips) {
        if (clip.localPath && fs.existsSync(clip.localPath)) fs.unlinkSync(clip.localPath);
      }
    } catch (e) { console.warn("Cleanup warning:", e.message); }
    await video.deleteOne();
    res.json({ message: "Video deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
