const express = require("express");
const { google } = require("googleapis");
const User = require("../models/User");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Build OAuth2 client
const getOAuthClient = () => {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
};

// ─── GET /api/auth/google ─────────────────────────────────────────────────────
// Redirect user to Google OAuth consent screen
router.get("/google", (req, res) => {
  const oauth2Client = getOAuthClient();

  const scopes = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent", // Force consent to get refresh token every time
    state: "google_oauth",
  });

  res.json({ authUrl });
});

// ─── GET /api/auth/callback ───────────────────────────────────────────────────
// Handle OAuth callback from Google
router.get("/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error("OAuth error:", error);
    return res.redirect(
      `${process.env.FRONTEND_URL || "http://localhost:3000"}?error=${encodeURIComponent(error)}`
    );
  }

  if (!code) {
    return res.redirect(
      `${process.env.FRONTEND_URL || "http://localhost:3000"}?error=no_code`
    );
  }

  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    // Get YouTube channel info
    let channelId = null;
    let channelName = null;
    try {
      const youtube = google.youtube({ version: "v3", auth: oauth2Client });
      const channelRes = await youtube.channels.list({
        part: ["snippet"],
        mine: true,
      });
      if (channelRes.data.items && channelRes.data.items.length > 0) {
        channelId = channelRes.data.items[0].id;
        channelName = channelRes.data.items[0].snippet.title;
      }
    } catch (ytErr) {
      console.warn("Could not fetch YouTube channel info:", ytErr.message);
    }

    // Upsert user in DB
    const user = await User.findOneAndUpdate(
      { googleId: userInfo.id },
      {
        googleId: userInfo.id,
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || undefined,
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
        youtubeChannelId: channelId,
        youtubeChannelName: channelName,
        lastLoginAt: new Date(),
      },
      { upsert: true, new: true }
    );

    // Save session
    req.session.userId = user._id.toString();

    // Redirect to frontend
    res.redirect(`${process.env.FRONTEND_URL || "http://localhost:3000"}?login=success`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.redirect(
      `${process.env.FRONTEND_URL || "http://localhost:3000"}?error=${encodeURIComponent(
        "Authentication failed"
      )}`
    );
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req, res) => {
  const user = req.user;
  res.json({
    id: user._id,
    name: user.name,
    email: user.email,
    picture: user.picture,
    youtubeChannelId: user.youtubeChannelId,
    youtubeChannelName: user.youtubeChannelName,
    totalVideosUploaded: user.totalVideosUploaded,
    totalShortsCreated: user.totalShortsCreated,
  });
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: "Logout failed" });
    }
    res.clearCookie("connect.sid");
    res.json({ message: "Logged out successfully" });
  });
});

module.exports = router;
module.exports.getOAuthClient = getOAuthClient;
