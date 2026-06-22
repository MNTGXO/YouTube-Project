const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");

/**
 * Get video duration in seconds
 */
const getVideoDuration = (filePath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata.format.duration;
      resolve(duration);
    });
  });
};

/**
 * Get video metadata
 */
const getVideoMetadata = (filePath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata);
    });
  });
};

/**
 * Cut a single segment from a video
 * @param {string} inputPath - Source video file path
 * @param {string} outputPath - Output clip file path
 * @param {number} startTime - Start time in seconds
 * @param {number} duration - Duration in seconds
 * @param {function} onProgress - Progress callback
 */
const cutVideoSegment = (inputPath, outputPath, startTime, duration, onProgress) => {
  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath)
      .setStartTime(startTime)
      .setDuration(duration)
      // Re-encode for YouTube Shorts compatibility
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions([
        "-preset fast",
        "-crf 23",
        "-movflags +faststart",
        // Force 9:16 aspect ratio for Shorts (with padding if needed)
        "-vf scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black",
        "-r 30",           // 30 fps
        "-b:a 128k",
        "-ar 44100",
      ])
      .output(outputPath)
      .on("start", (cmdline) => {
        console.log("FFmpeg started:", cmdline);
      })
      .on("progress", (progress) => {
        if (onProgress && progress.percent) {
          onProgress(Math.round(progress.percent));
        }
      })
      .on("end", () => resolve(outputPath))
      .on("error", (err, stdout, stderr) => {
        console.error("FFmpeg error:", err.message);
        console.error("FFmpeg stderr:", stderr);
        reject(err);
      });

    command.run();
  });
};

/**
 * Cut a video into multiple short clips
 * @param {string} inputPath - Source video path
 * @param {string} outputDir - Directory for output clips
 * @param {number} shortDuration - Length of each clip in seconds (default 60)
 * @param {function} onClipProgress - Called with (clipIndex, totalClips, percentDone)
 */
const cutVideoIntoShorts = async (
  inputPath,
  outputDir,
  shortDuration = 60,
  onClipProgress
) => {
  const totalDuration = await getVideoDuration(inputPath);
  console.log(`Video duration: ${totalDuration}s, cutting into ${shortDuration}s segments`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const clips = [];
  let currentTime = 0;
  let clipIndex = 0;

  while (currentTime < totalDuration) {
    const remaining = totalDuration - currentTime;
    const clipDuration = Math.min(shortDuration, remaining);

    // Skip clips shorter than 5 seconds (not useful as Shorts)
    if (clipDuration < 5) {
      break;
    }

    const outputFilename = `clip_${String(clipIndex + 1).padStart(3, "0")}.mp4`;
    const outputPath = path.join(outputDir, outputFilename);
    const totalClips = Math.ceil(totalDuration / shortDuration);

    console.log(
      `Cutting clip ${clipIndex + 1}/${totalClips}: ${currentTime}s → ${
        currentTime + clipDuration
      }s`
    );

    await cutVideoSegment(
      inputPath,
      outputPath,
      currentTime,
      clipDuration,
      (pct) => {
        if (onClipProgress) {
          onClipProgress(clipIndex, totalClips, pct);
        }
      }
    );

    clips.push({
      index: clipIndex,
      startTime: currentTime,
      endTime: currentTime + clipDuration,
      duration: clipDuration,
      localPath: outputPath,
      status: "pending",
    });

    currentTime += shortDuration;
    clipIndex++;
  }

  console.log(`✅ Created ${clips.length} clips`);
  return { clips, totalDuration };
};

/**
 * Clean up temporary files
 */
const cleanupFiles = (filePaths) => {
  for (const filePath of filePaths) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Deleted: ${filePath}`);
      }
    } catch (err) {
      console.warn(`Could not delete ${filePath}:`, err.message);
    }
  }
};

/**
 * Clean up a directory
 */
const cleanupDirectory = (dirPath) => {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
      console.log(`Deleted directory: ${dirPath}`);
    }
  } catch (err) {
    console.warn(`Could not delete directory ${dirPath}:`, err.message);
  }
};

module.exports = {
  getVideoDuration,
  getVideoMetadata,
  cutVideoSegment,
  cutVideoIntoShorts,
  cleanupFiles,
  cleanupDirectory,
};
