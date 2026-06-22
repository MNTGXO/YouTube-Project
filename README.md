# 🎬 ShortsAI — Auto YouTube Shorts Uploader

Upload any long-form video → auto-cut into 60s clips → upload directly to YouTube Shorts.

---

## ✨ Features

- **Google OAuth login** (Gmail sign-in with YouTube scope)
- **Video upload** up to 2 GB
- **FFmpeg auto-cutting** into vertical Shorts (9:16 format, configurable duration)
- **Bulk YouTube upload** via YouTube Data API v3
- **Real-time progress** via Server-Sent Events
- **MongoDB** for users, videos, and job tracking
- **Koyeb deploy** with Docker (includes FFmpeg)

---

## 🏗️ Architecture

```
ShortsAI/
├── backend/
│   ├── server.js           # Express entry point
│   ├── routes/
│   │   ├── auth.js         # Google OAuth flow
│   │   ├── videos.js       # Upload & manage videos
│   │   └── jobs.js         # Cut+upload job runner (SSE)
│   ├── models/
│   │   ├── User.js         # MongoDB user + OAuth tokens
│   │   ├── Video.js        # Video + clip tracking
│   │   └── Job.js          # Job progress log
│   ├── utils/
│   │   ├── ffmpeg.js       # Video cutting utilities
│   │   └── youtube.js      # YouTube upload helper
│   └── middleware/
│       └── auth.js         # Session auth guard
├── frontend/
│   └── public/
│       └── index.html      # Single-page app (vanilla JS)
├── Dockerfile              # Production Docker image with FFmpeg
├── koyeb.yaml              # Koyeb deployment config
└── README.md
```

---

## 🚀 Setup Guide

### 1. Google Cloud Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (e.g., "ShortsAI")
3. **Enable APIs:**
   - YouTube Data API v3
   - Google+ API (or People API)
4. **Create OAuth 2.0 credentials:**
   - Type: Web Application
   - Authorized redirect URIs:
     - `http://localhost:5000/api/auth/callback` (dev)
     - `https://your-app.koyeb.app/api/auth/callback` (prod)
5. Copy your **Client ID** and **Client Secret**

> ⚠️ YouTube uploads require OAuth verification for public apps. For testing, add your Google account as a test user in the OAuth consent screen.

---

### 2. MongoDB Atlas

1. Go to [mongodb.com/atlas](https://mongodb.com/atlas)
2. Create a free cluster
3. Create a database user (username + password)
4. Whitelist `0.0.0.0/0` (or Koyeb IPs) in Network Access
5. Get your connection string:
   ```
   mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/youtube-shorts
   ```

---

### 3. Local Development

```bash
# Clone and enter the project
cd youtube-shorts-app

# Install backend deps
cd backend
npm install

# Create your .env
cp .env.example .env
# Edit .env with your credentials

# Start dev server
npm run dev
# → Server at http://localhost:5000
```

---

### 4. Deploy to Koyeb

#### Option A: Deploy via Koyeb CLI

```bash
# Install Koyeb CLI
curl -fsSL https://raw.githubusercontent.com/koyeb/koyeb-cli/master/install.sh | bash

# Login
koyeb login

# Deploy (from project root)
koyeb deploy .
```

#### Option B: Deploy via Koyeb Dashboard

1. Push your code to GitHub
2. Go to [app.koyeb.com](https://app.koyeb.com)
3. New Service → GitHub → Select your repo
4. Build settings: **Dockerfile** (auto-detected)
5. Set environment variables (see below)
6. Deploy!

#### Environment Variables for Koyeb

| Variable | Value |
|---|---|
| `MONGODB_URI` | Your Atlas connection string |
| `GOOGLE_CLIENT_ID` | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | `https://your-app.koyeb.app/api/auth/callback` |
| `SESSION_SECRET` | Random 32+ char string |
| `FRONTEND_URL` | `https://your-app.koyeb.app` |
| `NODE_ENV` | `production` |
| `PORT` | `8000` |

---

## 📡 API Reference

### Auth
| Method | Path | Description |
|---|---|---|
| GET | `/api/auth/google` | Get Google OAuth URL |
| GET | `/api/auth/callback` | OAuth callback handler |
| GET | `/api/auth/me` | Get current user |
| POST | `/api/auth/logout` | Sign out |

### Videos
| Method | Path | Description |
|---|---|---|
| POST | `/api/videos/upload` | Upload video file |
| GET | `/api/videos` | List user's videos |
| GET | `/api/videos/:id` | Get video details |
| DELETE | `/api/videos/:id` | Delete video |

### Jobs
| Method | Path | Description |
|---|---|---|
| POST | `/api/jobs/start` | Start cut+upload job |
| GET | `/api/jobs/:id/progress` | SSE progress stream |
| GET | `/api/jobs/:id` | Get job details |
| GET | `/api/jobs` | List all jobs |

---

## ⚙️ Configuration Notes

- **FFmpeg** must be installed on the server (Dockerfile handles this)
- YouTube Shorts require vertical video (9:16). FFmpeg auto-converts and pads
- Videos are stored locally in `uploads/` — for production, swap to S3/R2
- Clips are deleted after upload to save disk space
- Sessions persist in MongoDB via `connect-mongo`

---

## 🧪 Testing OAuth Locally

Add `http://localhost:5000` as an authorized origin and `http://localhost:5000/api/auth/callback` as a redirect URI in Google Cloud Console. Then in `.env`, set:

```env
GOOGLE_REDIRECT_URI=http://localhost:5000/api/auth/callback
FRONTEND_URL=http://localhost:3000
```

---

## 📦 Tech Stack

- **Backend**: Node.js, Express, Mongoose
- **Database**: MongoDB Atlas
- **Auth**: Google OAuth 2.0 (googleapis)
- **Video**: FFmpeg (fluent-ffmpeg)
- **Upload API**: YouTube Data API v3
- **Realtime**: Server-Sent Events (SSE)
- **Deploy**: Docker + Koyeb
