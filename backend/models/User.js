const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    googleId: {
      type: String,
      required: true,
      unique: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    name: {
      type: String,
      required: true,
    },
    picture: {
      type: String,
    },
    // OAuth tokens for YouTube API
    accessToken: {
      type: String,
    },
    refreshToken: {
      type: String,
    },
    tokenExpiry: {
      type: Date,
    },
    // YouTube channel info
    youtubeChannelId: {
      type: String,
    },
    youtubeChannelName: {
      type: String,
    },
    // Stats
    totalVideosUploaded: {
      type: Number,
      default: 0,
    },
    totalShortsCreated: {
      type: Number,
      default: 0,
    },
    lastLoginAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("User", userSchema);
