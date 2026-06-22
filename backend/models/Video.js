const mongoose = require("mongoose");

const shortClipSchema = new mongoose.Schema({
  index: Number,
  startTime: Number, // seconds
  endTime: Number,   // seconds
  duration: Number,  // seconds
  localPath: String,
  youtubeVideoId: String,
  youtubeUrl: String,
  title: String,
  status: {
    type: String,
    enum: ["pending", "uploading", "uploaded", "failed"],
    default: "pending",
  },
  errorMessage: String,
  uploadedAt: Date,
});

const videoSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    originalFilename: {
      type: String,
      required: true,
    },
    localPath: {
      type: String,
      required: true,
    },
    fileSize: {
      type: Number, // bytes
    },
    duration: {
      type: Number, // seconds
    },
    mimeType: {
      type: String,
    },
    // Processing config
    shortDuration: {
      type: Number,
      default: 60, // seconds per short
    },
    defaultTitle: {
      type: String,
      default: "Auto Short",
    },
    defaultDescription: {
      type: String,
      default: "Created with ShortsAI",
    },
    defaultTags: {
      type: [String],
      default: ["shorts", "youtube"],
    },
    privacy: {
      type: String,
      enum: ["public", "private", "unlisted"],
      default: "public",
    },
    // Clips
    clips: [shortClipSchema],
    totalClips: {
      type: Number,
      default: 0,
    },
    // Status
    status: {
      type: String,
      enum: ["uploaded", "processing", "cutting", "uploading", "completed", "failed"],
      default: "uploaded",
    },
    errorMessage: String,
    processingStartedAt: Date,
    completedAt: Date,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Video", videoSchema);
