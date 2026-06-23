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

// ─── Multer for chunks (small pieces, no size limit per chunk) ────────────────
const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const chunkDir = path.join(__dirname, "../uploads/chunks", req.body.uploadId || "unknown");
    if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir, { recursive: true });
    cb(null, chunkDir);
  },
  filename: (req, file, cb) => {
    cb(null, `chunk_${req.body.chunkIndex}`);
  },
});

const chunkUpload = multer({
  storage: chunkStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per chunk
});

// ─── Multer for small direct uploads (< 50MB) ─────────────────────────────────
const directStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "../uploads");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const directUpload = multer({
  storage: directStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("video/")) cb(null, true);
    else cb(new Error("Only video files are allowed"), false);
  },
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB for direct
});

// ─── POST /api/videos/chunk ───────────────────────────────────────────────────
// Receive one chunk of a large file
router.post("/chunk", requireAuth, chunkUpload.single("chunk"), async (req, res) => {
  try {
    const { uploadId, chunkIndex, totalChunks, filename } = req.body;

    if (!uploadId || chunkIndex === undefined || !totalChunks) {
      return res.status(400).json({ error: "Missing chunk metadata" });
    }

    // Store metadata in a temp JSON file
    const metaPath = path.join(__dirname, "../uploads/chunks", uploadId, "meta.json");
    if (!fs.existsSync(metaPath)) {
      fs.writeFileSync(metaPath, JSON.stringify({
        uploadId,
        totalChunks: parseInt(totalChunks),
        filename,
        userId: req.user._id.toString(),
      }));
    }

    const received = parseInt(chunkIndex) + 1;
    const total = parseInt(totalChunks);

    res.json({
      received,
      total,
      done: received >= total,
    });
  } catch (err) {
    console.error("Chunk upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/videos/assemble ────────────────────────────────────────────────
// Assemble all chunks into final file, create Video record, auto-start job
router.post("/assemble", requireAuth, async (req, res) => {
  const { uploadId, shortDuration = 60, title = "YouTube Short",
          description = "Created with ShortsAI", tags = "shorts,youtube", privacy = "public" } = req.body;

  if (!uploadId) return res.status(400).json({ error: "uploadId required" });

  const chunkDir = path.join(__dirname, "../uploads/chunks", uploadId);
  const metaPath = path.join(chunkDir, "meta.json");

  if (!fs.existsSync(metaPath)) {
    return res.status(404).json({ error: "Upload session not found" });
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));

  // Verify ownership
  if (meta.userId !== req.user._id.toString()) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const ext = path.extname(meta.filename) || ".mp4";
    const finalFilename = `${uuidv4()}${ext}`;
    const finalPath = path.join(__dirname, "../uploads", finalFilename);
    const writeStream = fs.createWriteStream(finalPath);

    // Concatenate all chunks in order
    for (let i = 0; i < meta.totalChunks; i++) {
      const chunkPath = path.join(chunkDir, `chunk_${i}`);
      if (!fs.existsSync(chunkPath)) {
        writeStream.close();
        fs.unlinkSync(finalPath);
        return res.status(400).json({ error: `Missing chunk ${i}` });
      }
      const data = fs.readFileSync(chunkPath);
      writeStream.write(data);
    }

    await new Promise((resolve, reject) => {
      writeStream.end();
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    // Clean up chunk directory
    fs.rmSync(chunkDir, { recursive: true, force: true });

    // Get video metadata
    let duration = null;
    let fileSize = fs.statSync(finalPath).size;
    try {
      const { getVideoMetadata } = require("../utils/ffmpeg");
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

// ─── POST /api/videos/upload (small files direct) ────────────────────────────
router.post("/upload", requireAuth, directUpload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video file provided" });

    const { shortDuration = 60, title = "YouTube Short",
            description = "Created with ShortsAI", tags = "shorts,youtube", privacy = "public" } = req.body;

    const filePath = req.file.path;
    let duration = null;

    try {
      const metadata = await getVideoMetadata(filePath);
      duration = metadata.format.duration;
    } catch (e) {
      console.warn("Could not read video metadata:", e.message);
    }

    const tagList = typeof tags === "string"
      ? tags.split(",").map(t => t.trim()).filter(Boolean)
      : tags;

    const video = new Video({
      userId: req.user._id,
      originalFilename: req.file.originalname,
      localPath: filePath,
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
      return res.status(400).json({ error: "Cannot delete a video that is currently processing" });
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

router.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "Chunk too large. Max 10MB per chunk." });
  next(err);
});

module.exports = router;
