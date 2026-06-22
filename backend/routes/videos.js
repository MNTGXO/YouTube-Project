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

// ─── Multer config ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
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

const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    "video/mp4",
    "video/avi",
    "video/mov",
    "video/mkv",
    "video/webm",
    "video/quicktime",
    "video/x-msvideo",
    "video/x-matroska",
  ];
  if (allowedMimes.includes(file.mimetype) || file.mimetype.startsWith("video/")) {
    cb(null, true);
  } else {
    cb(new Error("Only video files are allowed"), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB
  },
});

// ─── POST /api/videos/upload ──────────────────────────────────────────────────
router.post("/upload", requireAuth, upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No video file provided" });
    }

    const {
      shortDuration = 60,
      title = "YouTube Short",
      description = "Created with ShortsAI",
      tags = "shorts,youtube",
      privacy = "public",
    } = req.body;

    const filePath = req.file.path;
    let duration = null;

    // Get video metadata
    try {
      const metadata = await getVideoMetadata(filePath);
      duration = metadata.format.duration;
    } catch (err) {
      console.warn("Could not read video metadata:", err.message);
    }

    const tagList = typeof tags === "string"
      ? tags.split(",").map((t) => t.trim()).filter(Boolean)
      : tags;

    // Save to DB
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

    // Update user stats
    await User.findByIdAndUpdate(req.user._id, {
      $inc: { totalVideosUploaded: 1 },
    });

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
    // Clean up file if it was saved
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: err.message || "Upload failed" });
  }
});

// ─── GET /api/videos ──────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    const videos = await Video.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .select("-localPath -clips.localPath");

    res.json({ videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/videos/:id ─────────────────────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const video = await Video.findOne({
      _id: req.params.id,
      userId: req.user._id,
    }).select("-localPath -clips.localPath");

    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    res.json({ video });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/videos/:id ──────────────────────────────────────────────────
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const video = await Video.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    // Only allow deletion if not currently processing
    if (["processing", "cutting", "uploading"].includes(video.status)) {
      return res.status(400).json({ error: "Cannot delete a video that is currently processing" });
    }

    // Clean up files
    try {
      if (fs.existsSync(video.localPath)) fs.unlinkSync(video.localPath);
      // Clean up clip files
      for (const clip of video.clips) {
        if (clip.localPath && fs.existsSync(clip.localPath)) {
          fs.unlinkSync(clip.localPath);
        }
      }
    } catch (cleanupErr) {
      console.warn("File cleanup warning:", cleanupErr.message);
    }

    await video.deleteOne();
    res.json({ message: "Video deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Multer error handler ─────────────────────────────────────────────────────
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large. Maximum size is 2GB." });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;
