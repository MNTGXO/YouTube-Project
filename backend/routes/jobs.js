const express = require("express");
const path = require("path");
const fs = require("fs");
const { requireAuth } = require("../middleware/auth");
const Video = require("../models/Video");
const Job = require("../models/Job");
const User = require("../models/User");
const { cutVideoIntoShorts, cleanupFiles } = require("../utils/ffmpeg");
const { uploadToYouTube } = require("../utils/youtube");

const router = express.Router();

// Track active jobs in memory (for SSE progress streaming)
const activeJobs = new Map();

/**
 * Internal function: run a cut-and-upload job
 */
async function runCutAndUploadJob(job, video, user) {
  const jobId = job._id.toString();

  const logAndUpdate = async (message, level = "info", progress = null) => {
    console.log(`[Job ${jobId}] ${message}`);
    const update = {
      $push: { log: { message, level, time: new Date() } },
      message,
    };
    if (progress !== null) update.progress = progress;
    await Job.findByIdAndUpdate(jobId, update);

    // Broadcast to SSE clients
    if (activeJobs.has(jobId)) {
      activeJobs.get(jobId).forEach((res) => {
        res.write(
          `data: ${JSON.stringify({ message, level, progress, status: "running" })}\n\n`
        );
      });
    }
  };

  try {
    await Job.findByIdAndUpdate(jobId, {
      status: "running",
      startedAt: new Date(),
      progress: 0,
      message: "Starting job...",
    });
    await Video.findByIdAndUpdate(video._id, { status: "processing" });

    await logAndUpdate("📂 Starting video processing...", "info", 5);

    // ── Step 1: Cut video into clips ────────────────────────────────────────
    const clipsDir = path.join(
      __dirname,
      "../uploads/clips",
      video._id.toString()
    );
    await logAndUpdate(`✂️ Cutting video into ${video.shortDuration}s shorts...`, "info", 10);
    await Video.findByIdAndUpdate(video._id, { status: "cutting" });

    const { clips } = await cutVideoIntoShorts(
      video.localPath,
      clipsDir,
      video.shortDuration,
      async (clipIdx, totalClips, pct) => {
        const overallProgress = 10 + Math.round(((clipIdx + pct / 100) / totalClips) * 40);
        await logAndUpdate(
          `✂️ Cutting clip ${clipIdx + 1}/${totalClips} (${pct}%)`,
          "info",
          overallProgress
        );
      }
    );

    await logAndUpdate(`✅ Created ${clips.length} clips`, "info", 50);

    // Save clips to video document
    await Video.findByIdAndUpdate(video._id, {
      clips: clips.map((c) => ({ ...c, title: `${video.defaultTitle} - Part ${c.index + 1}` })),
      totalClips: clips.length,
      status: "uploading",
    });

    // ── Step 2: Upload each clip to YouTube ─────────────────────────────────
    await logAndUpdate("📤 Starting YouTube uploads...", "info", 52);
    const uploadedUrls = [];
    let uploadedCount = 0;

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const clipTitle = `${video.defaultTitle} - Part ${i + 1}`;
      const clipTags = [
        ...video.defaultTags,
        "shorts",
        "youtubeshorts",
        `part${i + 1}`,
      ];

      await logAndUpdate(
        `📤 Uploading clip ${i + 1}/${clips.length}: "${clipTitle}"`,
        "info",
        52 + Math.round((i / clips.length) * 44)
      );

      // Update clip status
      await Video.findOneAndUpdate(
        { _id: video._id, "clips.index": i },
        { $set: { "clips.$.status": "uploading" } }
      );

      try {
        const { videoId, youtubeUrl } = await uploadToYouTube(
          user._id.toString(),
          clip.localPath,
          {
            title: clipTitle,
            description: video.defaultDescription,
            tags: clipTags,
            privacyStatus: video.privacy,
          },
          async (pct) => {
            if (pct % 25 === 0) {
              await logAndUpdate(
                `📤 Uploading clip ${i + 1}/${clips.length}: ${pct}%`,
                "info"
              );
            }
          }
        );

        // Update clip in DB
        await Video.findOneAndUpdate(
          { _id: video._id, "clips.index": i },
          {
            $set: {
              "clips.$.youtubeVideoId": videoId,
              "clips.$.youtubeUrl": youtubeUrl,
              "clips.$.status": "uploaded",
              "clips.$.uploadedAt": new Date(),
              "clips.$.title": clipTitle,
            },
          }
        );

        uploadedUrls.push(youtubeUrl);
        uploadedCount++;
        await logAndUpdate(`✅ Clip ${i + 1} uploaded: ${youtubeUrl}`, "info");
      } catch (uploadErr) {
        console.error(`Failed to upload clip ${i + 1}:`, uploadErr.message);
        await logAndUpdate(`❌ Failed to upload clip ${i + 1}: ${uploadErr.message}`, "error");

        await Video.findOneAndUpdate(
          { _id: video._id, "clips.index": i },
          {
            $set: {
              "clips.$.status": "failed",
              "clips.$.errorMessage": uploadErr.message,
            },
          }
        );
      }

      // Optional: clean up clip file after upload to save disk space
      try {
        if (fs.existsSync(clip.localPath)) {
          fs.unlinkSync(clip.localPath);
        }
      } catch (e) {
        // ignore cleanup errors
      }
    }

    // ── Step 3: Finalize ─────────────────────────────────────────────────────
    const finalStatus = uploadedCount > 0 ? "completed" : "failed";
    await Video.findByIdAndUpdate(video._id, {
      status: finalStatus,
      completedAt: new Date(),
    });

    await User.findByIdAndUpdate(user._id, {
      $inc: { totalShortsCreated: uploadedCount },
    });

    await Job.findByIdAndUpdate(jobId, {
      status: "completed",
      progress: 100,
      message: `✅ Done! ${uploadedCount}/${clips.length} shorts uploaded to YouTube.`,
      completedAt: new Date(),
      result: {
        clipsCreated: clips.length,
        clipsUploaded: uploadedCount,
        youtubeUrls: uploadedUrls,
      },
    });

    await logAndUpdate(
      `🎉 Job complete! ${uploadedCount} shorts uploaded to YouTube.`,
      "info",
      100
    );

    // Notify SSE clients of completion
    if (activeJobs.has(jobId)) {
      activeJobs.get(jobId).forEach((res) => {
        res.write(
          `data: ${JSON.stringify({
            status: "completed",
            message: `✅ Done! ${uploadedCount}/${clips.length} shorts uploaded.`,
            progress: 100,
            result: { uploadedCount, totalClips: clips.length, youtubeUrls: uploadedUrls },
          })}\n\n`
        );
        res.end();
      });
      activeJobs.delete(jobId);
    }
  } catch (err) {
    console.error(`Job ${jobId} failed:`, err);

    await Job.findByIdAndUpdate(jobId, {
      status: "failed",
      errorMessage: err.message,
      message: `❌ Job failed: ${err.message}`,
      completedAt: new Date(),
    });

    await Video.findByIdAndUpdate(video._id, {
      status: "failed",
      errorMessage: err.message,
    });

    if (activeJobs.has(jobId)) {
      activeJobs.get(jobId).forEach((res) => {
        res.write(
          `data: ${JSON.stringify({
            status: "failed",
            message: `❌ Failed: ${err.message}`,
            progress: 0,
          })}\n\n`
        );
        res.end();
      });
      activeJobs.delete(jobId);
    }
  }
}

// ─── POST /api/jobs/start ────────────────────────────────────────────────────
router.post("/start", requireAuth, async (req, res) => {
  try {
    const { videoId } = req.body;

    if (!videoId) {
      return res.status(400).json({ error: "videoId is required" });
    }

    const video = await Video.findOne({ _id: videoId, userId: req.user._id });
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    if (!["uploaded", "failed"].includes(video.status)) {
      return res.status(400).json({
        error: `Video is already ${video.status}. Cannot start a new job.`,
      });
    }

    // Check user has YouTube connected
    if (!req.user.accessToken) {
      return res.status(400).json({
        error: "YouTube account not connected. Please log out and log in again.",
      });
    }

    // Create job
    const job = new Job({
      userId: req.user._id,
      videoId: video._id,
      type: "cut_and_upload",
      status: "queued",
      message: "Job queued, starting soon...",
    });
    await job.save();

    // Start processing asynchronously (don't await)
    runCutAndUploadJob(job, video, req.user).catch((err) => {
      console.error("Unhandled job error:", err);
    });

    res.status(201).json({
      message: "Job started",
      jobId: job._id,
    });
  } catch (err) {
    console.error("Start job error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/jobs/:id/progress (SSE) ────────────────────────────────────────
router.get("/:id/progress", requireAuth, async (req, res) => {
  const jobId = req.params.id;

  // Verify ownership
  const job = await Job.findOne({ _id: jobId, userId: req.user._id });
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  // If already completed/failed, return immediately
  if (["completed", "failed"].includes(job.status)) {
    res.setHeader("Content-Type", "application/json");
    return res.json({ status: job.status, progress: job.progress, message: job.message, result: job.result });
  }

  // Server-Sent Events setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current state immediately
  res.write(
    `data: ${JSON.stringify({
      status: job.status,
      progress: job.progress,
      message: job.message,
    })}\n\n`
  );

  // Register for live updates
  if (!activeJobs.has(jobId)) {
    activeJobs.set(jobId, []);
  }
  activeJobs.get(jobId).push(res);

  // Clean up on disconnect
  req.on("close", () => {
    if (activeJobs.has(jobId)) {
      const listeners = activeJobs.get(jobId).filter((r) => r !== res);
      if (listeners.length === 0) {
        activeJobs.delete(jobId);
      } else {
        activeJobs.set(jobId, listeners);
      }
    }
  });
});

// ─── GET /api/jobs/:id ────────────────────────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const job = await Job.findOne({ _id: req.params.id, userId: req.user._id })
      .populate("videoId", "originalFilename duration totalClips clips");

    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/jobs ────────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    const jobs = await Job.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate("videoId", "originalFilename");

    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
