/**
 * OBS Playout Web App — Mac (single-file Node.js)
 * Features:
 *  - Upload video/image → saved into local media library (single directory)
 *  - List library with thumbnails (ffmpeg for video, sharp for images)
 *  - Play selected clip/image on OBS via obs-websocket
 *
 * Prereqs on macOS:
 * 1) Homebrew ffmpeg:  brew install ffmpeg
 * 2) Node.js 18+
 * 3) OBS → Tools → WebSocket Server → Enable + Password
 *
 * Usage:
 *   npm i
 *   # set ENV or edit CONFIG below
 *   node app.js
 *   open http://localhost:3000
 *
 * Configure at CONFIG section below.
 */

// Load environment variables from .env file
require('dotenv').config();

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const sharp = require("sharp");
const mime = require("mime");
const { OBSWebSocket } = require("obs-websocket-js");
const os = require("os");

// =================== CONFIG ===================
const CONFIG = {
  MEDIA_DIR: process.env.MEDIA_DIR || "/Users/team/OBS-Media", // fallback to default
  THUMB_CACHE: process.env.THUMB_CACHE || path.join(process.env.HOME || ".", ".cache", "obs-playout-thumbs"),
  SERVER_PORT: Number(process.env.PORT || 3000),
  OBS_URL: process.env.OBS_URL || "ws://127.0.0.1:4455",
  OBS_PASSWORD: process.env.OBS_PASSWORD || "CHANGE_ME",
  OBS_VIDEO_INPUT: process.env.OBS_VIDEO_INPUT || "PlayerVideo",
  OBS_IMAGE_INPUT: process.env.OBS_IMAGE_INPUT || "PlayerImage",
  DEFAULT_THUMB_WIDTH: 320,
};
// ==============================================

const LIB_DIR = CONFIG.MEDIA_DIR;

// Commented out automatic directory creation
// (async () => {
//   await fsp.mkdir(LIB_DIR, { recursive: true });
//   await fsp.mkdir(CONFIG.THUMB_CACHE, { recursive: true });
// })();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Set EJS as template engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------------- OBS WebSocket ----------------
const obs = new OBSWebSocket();
let obsConnected = false;
async function connectOBS() {
  try {
    await obs.connect(CONFIG.OBS_URL, CONFIG.OBS_PASSWORD);
    obsConnected = true;
    console.log("[OBS] Connected");
  } catch (e) {
    obsConnected = false;
    console.error("[OBS] Connect failed:", e.message);
  }
}
connectOBS();
obs.on("ConnectionClosed", () => {
  obsConnected = false;
  console.warn("[OBS] Disconnected. Will retry in 3s");
  setTimeout(connectOBS, 3000);
});

// -------------- Helper utilities ---------------
function isVideoFile(p) {
  const ext = path.extname(p).toLowerCase();
  return [".mp4", ".mov", ".mkv", ".webm", ".m4v"].includes(ext);
}
function isImageFile(p) {
  const ext = path.extname(p).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext);
}

async function listFilesRecursive(dir, type) {
  const out = [];
  try {
    // Check if directory exists
    if (!fs.existsSync(dir)) {
      return out; // Return empty array if directory doesn't exist
    }
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        out.push(...await listFilesRecursive(full, type));
      } else {
        if (type === "video" && isVideoFile(full)) out.push(full);
        if (type === "image" && isImageFile(full)) out.push(full);
      }
    }
  } catch (e) {
    console.error(`Error reading directory ${dir}:`, e.message);
  }
  return out;
}

function cacheKey(str) {
  return Buffer.from(str).toString("base64url");
}

// -------------- Thumbnail endpoints -------------
app.get("/thumb/image", async (req, res) => {
  try {
    const file = String(req.query.file || "");
    if (!file.startsWith(CONFIG.MEDIA_DIR)) return res.status(400).json({ error: "invalid file path" });

    const width = Number(req.query.w || CONFIG.DEFAULT_THUMB_WIDTH);
    const key = cacheKey(`img:${file}:${width}`);
    const outPath = path.join(CONFIG.THUMB_CACHE, key + ".jpg");

    if (fs.existsSync(outPath)) return res.sendFile(path.resolve(outPath));

    // Ensure cache directory exists
    await fsp.mkdir(CONFIG.THUMB_CACHE, { recursive: true });
    
    const buf = await sharp(file).resize({ width }).jpeg({ quality: 75 }).toBuffer();
    await fsp.writeFile(outPath, buf);
    res.type("image/jpeg").send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/thumb/video", async (req, res) => {
  try {
    const file = String(req.query.file || "");
    if (!file.startsWith(CONFIG.MEDIA_DIR)) return res.status(400).json({ error: "invalid file path" });

    const t = String(req.query.t || "5");
    const width = Number(req.query.w || CONFIG.DEFAULT_THUMB_WIDTH);
    const key = cacheKey(`vid:${file}:${t}:${width}`);
    const outPath = path.join(CONFIG.THUMB_CACHE, key + ".jpg");

    if (fs.existsSync(outPath)) return res.sendFile(path.resolve(outPath));

    // Ensure cache directory exists
    await fsp.mkdir(CONFIG.THUMB_CACHE, { recursive: true });

    const args = ["-ss", t, "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-1`, "-y", outPath];
    const ff = spawn("ffmpeg", args);
    ff.on("close", (code) => {
      if (code === 0) return res.sendFile(path.resolve(outPath));
      res.status(500).json({ error: "ffmpeg failed", code });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------- Media listing ----------------
app.get("/media", async (req, res) => {
  try {
    const videos = await listFilesRecursive(LIB_DIR, "video");
    const images = await listFilesRecursive(LIB_DIR, "image");

    const mapItem = (full, type) => ({
      id: cacheKey(full),
      type,
      filename: path.basename(full),
      path: full,
      url: type === "video"
        ? `/thumb/video?file=${encodeURIComponent(full)}&t=5`
        : `/thumb/image?file=${encodeURIComponent(full)}`,
    });

    const list = [
      ...videos.map((f) => mapItem(f, "video")),
      ...images.map((f) => mapItem(f, "image")),
    ].sort((a, b) => a.filename.localeCompare(b.filename));

    res.json({ ok: true, items: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ------------------ OBS Helper Functions ----------------
async function ensureVideoSource(sourceName) {
  try {
    // Try to get the source first
    await obs.call("GetInputSettings", { inputName: sourceName });
  } catch (e) {
    // Source doesn't exist, create it
    console.log(`Creating video source: ${sourceName}`);
    await obs.call("CreateInput", {
      sceneName: await getCurrentScene(),
      inputName: sourceName,
      inputKind: "ffmpeg_source",
      inputSettings: {},
      sceneItemEnabled: true
    });
  }
}

async function ensureImageSource(sourceName) {
  try {
    // Try to get the source first
    await obs.call("GetInputSettings", { inputName: sourceName });
  } catch (e) {
    // Source doesn't exist, create it
    console.log(`Creating image source: ${sourceName}`);
    await obs.call("CreateInput", {
      sceneName: await getCurrentScene(),
      inputName: sourceName,
      inputKind: "image_source",
      inputSettings: {},
      sceneItemEnabled: true
    });
  }
}

async function getCurrentScene() {
  try {
    const response = await obs.call("GetCurrentProgramScene");
    return response.currentProgramSceneName || response.sceneName;
  } catch (e) {
    // Fallback to first scene if current scene call fails
    const scenes = await obs.call("GetSceneList");
    return scenes.scenes[0]?.sceneName || "Scene";
  }
}

async function fitToScreen(sourceName) {
  try {
    const sceneName = await getCurrentScene();
    
    // Get canvas dimensions
    const videoSettings = await obs.call("GetVideoSettings");
    const canvasWidth = videoSettings.outputWidth;
    const canvasHeight = videoSettings.outputHeight;
    
    // Get scene item ID
    const sceneItems = await obs.call("GetSceneItemList", { sceneName });
    const sceneItem = sceneItems.sceneItems.find(item => item.sourceName === sourceName);
    
    if (!sceneItem) {
      console.log(`Scene item not found for source: ${sourceName}`);
      return;
    }
    
    // Get source dimensions
    const sourceSettings = await obs.call("GetInputSettings", { inputName: sourceName });
    
    // Set transform to fit screen
    await obs.call("SetSceneItemTransform", {
      sceneName: sceneName,
      sceneItemId: sceneItem.sceneItemId,
      sceneItemTransform: {
        positionX: 0,
        positionY: 0,
        scaleX: 1.0,
        scaleY: 1.0,
        cropLeft: 0,
        cropTop: 0,
        cropRight: 0,
        cropBottom: 0,
        rotation: 0,
        boundsType: "OBS_BOUNDS_SCALE_INNER",
        boundsAlignment: 0,
        boundsWidth: canvasWidth,
        boundsHeight: canvasHeight
      }
    });
    
    console.log(`Applied fit-to-screen transform for ${sourceName}`);
  } catch (e) {
    console.error(`Error applying fit-to-screen for ${sourceName}:`, e.message);
  }
}

async function hideSource(sourceName) {
  try {
    const sceneName = await getCurrentScene();
    const sceneItems = await obs.call("GetSceneItemList", { sceneName });
    const sceneItem = sceneItems.sceneItems.find(item => item.sourceName === sourceName);
    
    if (sceneItem) {
      await obs.call("SetSceneItemEnabled", {
        sceneName: sceneName,
        sceneItemId: sceneItem.sceneItemId,
        sceneItemEnabled: false
      });
      console.log(`Hidden source: ${sourceName}`);
    }
  } catch (e) {
    console.error(`Error hiding source ${sourceName}:`, e.message);
  }
}

async function showSource(sourceName) {
  try {
    const sceneName = await getCurrentScene();
    const sceneItems = await obs.call("GetSceneItemList", { sceneName });
    const sceneItem = sceneItems.sceneItems.find(item => item.sourceName === sourceName);
    
    if (sceneItem) {
      await obs.call("SetSceneItemEnabled", {
        sceneName: sceneName,
        sceneItemId: sceneItem.sceneItemId,
        sceneItemEnabled: true
      });
      console.log(`Shown source: ${sourceName}`);
    }
  } catch (e) {
    console.error(`Error showing source ${sourceName}:`, e.message);
  }
}

// ------------------ OBS controls ----------------
app.post("/play/video", async (req, res) => {
  try {
    const filePath = String(req.body.filePath || "");
    if (!filePath.startsWith(CONFIG.MEDIA_DIR)) return res.status(400).json({ ok: false, error: "invalid path" });
    if (!obsConnected) return res.status(503).json({ ok: false, error: "OBS not connected" });

    // Ensure video source exists
    await ensureVideoSource(CONFIG.OBS_VIDEO_INPUT);

    // Hide image source and show video source
    await hideSource(CONFIG.OBS_IMAGE_INPUT);
    await showSource(CONFIG.OBS_VIDEO_INPUT);

    // Stop current video (if any) and set new file
    try {
      await obs.call("TriggerMediaInputAction", {
        inputName: CONFIG.OBS_VIDEO_INPUT,
        mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP",
      });
    } catch (e) {
      // Ignore error if already stopped
    }

    await obs.call("SetInputSettings", {
      inputName: CONFIG.OBS_VIDEO_INPUT,
      inputSettings: { local_file: filePath },
      overlay: true,
    });
    
    // Start playing the new video
    await obs.call("TriggerMediaInputAction", {
      inputName: CONFIG.OBS_VIDEO_INPUT,
      mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART",
    });

    // Apply fit-to-screen transform
    await fitToScreen(CONFIG.OBS_VIDEO_INPUT);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/show/image", async (req, res) => {
  try {
    const filePath = String(req.body.filePath || "");
    if (!filePath.startsWith(CONFIG.MEDIA_DIR)) return res.status(400).json({ ok: false, error: "invalid path" });
    if (!obsConnected) return res.status(503).json({ ok: false, error: "OBS not connected" });

    // Ensure image source exists
    await ensureImageSource(CONFIG.OBS_IMAGE_INPUT);

    // Hide video source and show image source
    await hideSource(CONFIG.OBS_VIDEO_INPUT);
    await showSource(CONFIG.OBS_IMAGE_INPUT);

    await obs.call("SetInputSettings", {
      inputName: CONFIG.OBS_IMAGE_INPUT,
      inputSettings: { file: filePath },
      overlay: true,
    });

    // Apply fit-to-screen transform
    await fitToScreen(CONFIG.OBS_IMAGE_INPUT);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/stop/all", async (req, res) => {
  try {
    if (!obsConnected) return res.status(503).json({ ok: false, error: "OBS not connected" });

    // Hide both video and image sources
    await hideSource(CONFIG.OBS_VIDEO_INPUT);
    await hideSource(CONFIG.OBS_IMAGE_INPUT);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --------------- Simple Frontend UI --------------
app.get("/", (req, res) => {
  res.render('index', {
    title: 'OBS Playout',
    mediaDir: CONFIG.MEDIA_DIR,
    config: CONFIG
  });
});

// ------------------- Start server ----------------
app.listen(CONFIG.SERVER_PORT, '0.0.0.0', () => {
  console.log(`OBS Playout server running on port ${CONFIG.SERVER_PORT}`);
  console.log(`Local access: http://localhost:${CONFIG.SERVER_PORT}`);
  
  // Get network interfaces
  const networkInterfaces = os.networkInterfaces();
  Object.keys(networkInterfaces).forEach((interfaceName) => {
    networkInterfaces[interfaceName].forEach((iface) => {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`Network access: http://${iface.address}:${CONFIG.SERVER_PORT}`);
      }
    });
  });
  
  console.log(`Media dir => ${CONFIG.MEDIA_DIR}`);
});
