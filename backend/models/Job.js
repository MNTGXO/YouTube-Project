const mongoose = require("mongoose");

const jobSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    videoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Video",
      required: true,
    },
    type: {
      type: String,
      enum: ["cut", "upload", "cut_and_upload"],
      required: true,
    },
    status: {
      type: String,
      enum: ["queued", "running", "completed", "failed"],
      default: "queued",
    },
    progress: {
      type: Number,
      default: 0, // 0-100
    },
    message: {
      type: String,
      default: "Waiting to start...",
    },
    log: [
      {
        time: { type: Date, default: Date.now },
        message: String,
        level: { type: String, enum: ["info", "warn", "error"], default: "info" },
      },
    ],
    result: {
      clipsCreated: Number,
      clipsUploaded: Number,
      youtubeUrls: [String],
    },
    errorMessage: String,
    startedAt: Date,
    completedAt: Date,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Job", jobSchema);
