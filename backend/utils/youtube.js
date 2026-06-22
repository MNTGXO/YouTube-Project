const { google } = require("googleapis");
const fs = require("fs");
const User = require("../models/User");

/**
 * Build an authenticated OAuth2 client for a user
 */
const buildAuthClient = async (userId) => {
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");
  if (!user.accessToken) throw new Error("No access token. Please re-login.");

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: user.accessToken,
    refresh_token: user.refreshToken,
    expiry_date: user.tokenExpiry ? user.tokenExpiry.getTime() : undefined,
  });

  // Auto-save refreshed tokens
  oauth2Client.on("tokens", async (tokens) => {
    const update = {};
    if (tokens.access_token) update.accessToken = tokens.access_token;
    if (tokens.refresh_token) update.refreshToken = tokens.refresh_token;
    if (tokens.expiry_date) update.tokenExpiry = new Date(tokens.expiry_date);
    await User.findByIdAndUpdate(userId, update);
    console.log("Tokens refreshed for user:", userId);
  });

  return oauth2Client;
};

/**
 * Upload a single video file to YouTube as a Short
 * @param {string} userId - MongoDB user ID
 * @param {string} filePath - Local video file path
 * @param {object} metadata - title, description, tags, privacyStatus
 * @param {function} onProgress - Progress callback (percent)
 */
const uploadToYouTube = async (userId, filePath, metadata, onProgress) => {
  const auth = await buildAuthClient(userId);
  const youtube = google.youtube({ version: "v3", auth });

  const {
    title = "YouTube Short",
    description = "Created with ShortsAI #shorts",
    tags = ["shorts"],
    privacyStatus = "public",
  } = metadata;

  // Ensure #shorts is in the description (required for YouTube Shorts classification)
  const finalDescription = description.includes("#shorts")
    ? description
    : `${description}\n\n#shorts #youtubeshorts`;

  const fileSize = fs.statSync(filePath).size;

  const res = await youtube.videos.insert(
    {
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: title.substring(0, 100), // YouTube title max 100 chars
          description: finalDescription.substring(0, 5000),
          tags: [...tags, "shorts", "youtubeshorts"].slice(0, 500),
          categoryId: "22", // People & Blogs
          defaultLanguage: "en",
        },
        status: {
          privacyStatus,
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        mimeType: "video/mp4",
        body: fs.createReadStream(filePath),
      },
    },
    {
      // Track upload progress
      onUploadProgress: (evt) => {
        const progress = Math.round((evt.bytesRead / fileSize) * 100);
        if (onProgress) onProgress(progress);
      },
    }
  );

  const videoId = res.data.id;
  const youtubeUrl = `https://www.youtube.com/shorts/${videoId}`;

  console.log(`✅ Uploaded to YouTube: ${youtubeUrl}`);
  return { videoId, youtubeUrl };
};

module.exports = { uploadToYouTube, buildAuthClient };
