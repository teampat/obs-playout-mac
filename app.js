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
  // These will be overridden by localStorage if available
  MEDIA_DIR: process.env.MEDIA_DIR || "/Users/team/OBS-Media",
  OBS_URL: process.env.OBS_URL || "ws://127.0.0.1:4455",
  OBS_PASSWORD: process.env.OBS_PASSWORD || "CHANGE_ME",
  OBS_TARGET_SCENE: "Scene", // Default scene name, will be overridden by localStorage
  
  // These remain in .env file
  SERVER_PORT: Number(process.env.PORT || 3000),
  OBS_VIDEO_INPUT: process.env.OBS_VIDEO_INPUT || "PlayerVideo",
  OBS_IMAGE_INPUT: process.env.OBS_IMAGE_INPUT || "PlayerImage",
  DEFAULT_THUMB_WIDTH: Number(process.env.DEFAULT_THUMB_WIDTH || 320),
};

// Set THUMB_CACHE after MEDIA_DIR is defined
CONFIG.THUMB_CACHE = process.env.THUMB_CACHE || path.join(CONFIG.MEDIA_DIR, "thumbnails");
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
// Don't auto-connect on startup - only manual connection
obs.on("ConnectionClosed", () => {
  obsConnected = false;
  console.warn("[OBS] Disconnected");
  // Removed automatic retry - only manual connection now
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
        // Skip thumbnails directory
        if (ent.name === 'thumbnails') {
          continue;
        }
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
    console.log(`Video source ${sourceName} already exists`);
    
    // Check if source exists in the target scene
    const targetScene = CONFIG.OBS_TARGET_SCENE === 'CURRENT_SCENE' 
      ? await getCurrentScene() 
      : (CONFIG.OBS_TARGET_SCENE || "Scene");
    const sceneItems = await obs.call("GetSceneItemList", { sceneName: targetScene });
    const existsInScene = sceneItems.sceneItems.some(item => item.sourceName === sourceName);
    
    if (!existsInScene) {
      console.log(`Adding existing source ${sourceName} to scene ${targetScene}`);
      await obs.call("CreateSceneItem", {
        sceneName: targetScene,
        sourceName: sourceName,
        sceneItemEnabled: true
      });
    }
  } catch (e) {
    // Source doesn't exist, create it
    const targetScene = CONFIG.OBS_TARGET_SCENE === 'CURRENT_SCENE' 
      ? await getCurrentScene() 
      : (CONFIG.OBS_TARGET_SCENE || "Scene");
    console.log(`Creating video source: ${sourceName} in scene: ${targetScene}`);
    try {
      await obs.call("CreateInput", {
        sceneName: targetScene,
        inputName: sourceName,
        inputKind: "ffmpeg_source",
        inputSettings: {},
        sceneItemEnabled: true
      });
      console.log(`Successfully created video source: ${sourceName}`);
    } catch (createError) {
      console.error(`Failed to create video source ${sourceName}:`, createError.message);
      throw createError;
    }
  }
}

async function ensureImageSource(sourceName) {
  try {
    // Try to get the source first
    await obs.call("GetInputSettings", { inputName: sourceName });
    console.log(`Image source ${sourceName} already exists`);
    
    // Check if source exists in the target scene
    const targetScene = CONFIG.OBS_TARGET_SCENE === 'CURRENT_SCENE' 
      ? await getCurrentScene() 
      : (CONFIG.OBS_TARGET_SCENE || "Scene");
    const sceneItems = await obs.call("GetSceneItemList", { sceneName: targetScene });
    const existsInScene = sceneItems.sceneItems.some(item => item.sourceName === sourceName);
    
    if (!existsInScene) {
      console.log(`Adding existing source ${sourceName} to scene ${targetScene}`);
      await obs.call("CreateSceneItem", {
        sceneName: targetScene,
        sourceName: sourceName,
        sceneItemEnabled: true
      });
    }
  } catch (e) {
    // Source doesn't exist, create it
    const targetScene = CONFIG.OBS_TARGET_SCENE === 'CURRENT_SCENE' 
      ? await getCurrentScene() 
      : (CONFIG.OBS_TARGET_SCENE || "Scene");
    console.log(`Creating image source: ${sourceName} in scene: ${targetScene}`);
    try {
      await obs.call("CreateInput", {
        sceneName: targetScene,
        inputName: sourceName,
        inputKind: "image_source",
        inputSettings: {},
        sceneItemEnabled: true
      });
      console.log(`Successfully created image source: ${sourceName}`);
    } catch (createError) {
      console.error(`Failed to create image source ${sourceName}:`, createError.message);
      throw createError;
    }
  }
}

async function getCurrentScene() {
  try {
    // If CURRENT_SCENE is selected, always get the current scene from OBS
    if (CONFIG.OBS_TARGET_SCENE === 'CURRENT_SCENE') {
      const response = await obs.call("GetCurrentProgramScene");
      return response.currentProgramSceneName || response.sceneName;
    }
    
    // Use the target scene from CONFIG first
    if (CONFIG.OBS_TARGET_SCENE && CONFIG.OBS_TARGET_SCENE !== "Scene") {
      return CONFIG.OBS_TARGET_SCENE;
    }
    
    const response = await obs.call("GetCurrentProgramScene");
    return response.currentProgramSceneName || response.sceneName;
  } catch (e) {
    // Fallback to config target scene or first scene
    if (CONFIG.OBS_TARGET_SCENE && CONFIG.OBS_TARGET_SCENE !== "Scene" && CONFIG.OBS_TARGET_SCENE !== 'CURRENT_SCENE') {
      return CONFIG.OBS_TARGET_SCENE;
    }
    
    const scenes = await obs.call("GetSceneList");
    return scenes.scenes[0]?.sceneName || "Scene";
  }
}

async function fitToScreen(sourceName) {
  try {
    const sceneName = CONFIG.OBS_TARGET_SCENE === 'CURRENT_SCENE' 
      ? await getCurrentScene() 
      : (CONFIG.OBS_TARGET_SCENE || await getCurrentScene());
    console.log(`Applying fit-to-screen for ${sourceName} in scene: ${sceneName}`);
    
    // Get canvas dimensions
    const videoSettings = await obs.call("GetVideoSettings");
    const canvasWidth = videoSettings.outputWidth;
    const canvasHeight = videoSettings.outputHeight;
    
    // Get scene item ID
    const sceneItems = await obs.call("GetSceneItemList", { sceneName });
    const sceneItem = sceneItems.sceneItems.find(item => item.sourceName === sourceName);
    
    if (!sceneItem) {
      console.log(`Scene item not found for source: ${sourceName} in scene: ${sceneName}`);
      console.log(`Available scene items:`, sceneItems.sceneItems.map(item => item.sourceName));
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
    const sceneName = CONFIG.OBS_TARGET_SCENE === 'CURRENT_SCENE' 
      ? await getCurrentScene() 
      : (CONFIG.OBS_TARGET_SCENE || await getCurrentScene());
    console.log(`Hiding source ${sourceName} in scene: ${sceneName}`);
    
    const sceneItems = await obs.call("GetSceneItemList", { sceneName });
    const sceneItem = sceneItems.sceneItems.find(item => item.sourceName === sourceName);
    
    if (sceneItem) {
      await obs.call("SetSceneItemEnabled", {
        sceneName: sceneName,
        sceneItemId: sceneItem.sceneItemId,
        sceneItemEnabled: false
      });
      console.log(`Hidden source: ${sourceName}`);
    } else {
      console.log(`Source ${sourceName} not found in scene ${sceneName} for hiding`);
    }
  } catch (e) {
    console.error(`Error hiding source ${sourceName}:`, e.message);
  }
}

async function showSource(sourceName) {
  try {
    const sceneName = CONFIG.OBS_TARGET_SCENE === 'CURRENT_SCENE' 
      ? await getCurrentScene() 
      : (CONFIG.OBS_TARGET_SCENE || await getCurrentScene());
    console.log(`Showing source ${sourceName} in scene: ${sceneName}`);
    
    const sceneItems = await obs.call("GetSceneItemList", { sceneName });
    const sceneItem = sceneItems.sceneItems.find(item => item.sourceName === sourceName);
    
    if (sceneItem) {
      await obs.call("SetSceneItemEnabled", {
        sceneName: sceneName,
        sceneItemId: sceneItem.sceneItemId,
        sceneItemEnabled: true
      });
      console.log(`Shown source: ${sourceName}`);
    } else {
      console.log(`Source ${sourceName} not found in scene ${sceneName} for showing`);
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

    console.log(`Playing video: ${filePath}`);
    console.log(`Target scene: ${CONFIG.OBS_TARGET_SCENE}`);

    // Switch to target scene first (skip if CURRENT_SCENE is selected)
    if (CONFIG.OBS_TARGET_SCENE && CONFIG.OBS_TARGET_SCENE !== 'CURRENT_SCENE') {
      try {
        await obs.call("SetCurrentProgramScene", { sceneName: CONFIG.OBS_TARGET_SCENE });
        console.log(`Switched to scene: ${CONFIG.OBS_TARGET_SCENE}`);
      } catch (sceneError) {
        console.error(`Failed to switch to scene ${CONFIG.OBS_TARGET_SCENE}:`, sceneError.message);
      }
    } else if (CONFIG.OBS_TARGET_SCENE === 'CURRENT_SCENE') {
      console.log(`Using current scene (no switch needed)`);
    }

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
      console.log("Video was already stopped or not playing");
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

    console.log(`Successfully started playing video: ${filePath}`);
    res.json({ ok: true });
  } catch (e) {
    console.error("Error playing video:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/show/image", async (req, res) => {
  try {
    const filePath = String(req.body.filePath || "");
    if (!filePath.startsWith(CONFIG.MEDIA_DIR)) return res.status(400).json({ ok: false, error: "invalid path" });
    if (!obsConnected) return res.status(503).json({ ok: false, error: "OBS not connected" });

    console.log(`Showing image: ${filePath}`);
    console.log(`Target scene: ${CONFIG.OBS_TARGET_SCENE}`);

    // Switch to target scene first (skip if CURRENT_SCENE is selected)
    if (CONFIG.OBS_TARGET_SCENE && CONFIG.OBS_TARGET_SCENE !== 'CURRENT_SCENE') {
      try {
        await obs.call("SetCurrentProgramScene", { sceneName: CONFIG.OBS_TARGET_SCENE });
        console.log(`Switched to scene: ${CONFIG.OBS_TARGET_SCENE}`);
      } catch (sceneError) {
        console.error(`Failed to switch to scene ${CONFIG.OBS_TARGET_SCENE}:`, sceneError.message);
      }
    } else if (CONFIG.OBS_TARGET_SCENE === 'CURRENT_SCENE') {
      console.log(`Using current scene (no switch needed)`);
    }

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

    console.log(`Successfully showing image: ${filePath}`);
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

// ------------------ OBS Connection Controls ----------------
app.post("/obs/connect", async (req, res) => {
  try {
    if (obsConnected) {
      return res.json({ ok: true, message: "Already connected to OBS" });
    }
    
    await connectOBS();
    
    if (obsConnected) {
      res.json({ ok: true, message: "Successfully connected to OBS" });
    } else {
      res.status(503).json({ ok: false, error: "Failed to connect to OBS" });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/obs/disconnect", async (req, res) => {
  try {
    if (!obsConnected) {
      return res.json({ ok: true, message: "Already disconnected from OBS" });
    }
    
    await obs.disconnect();
    obsConnected = false;
    console.log("[OBS] Manually disconnected");
    
    res.json({ ok: true, message: "Successfully disconnected from OBS" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/obs/status", async (req, res) => {
  res.json({ 
    ok: true, 
    connected: obsConnected,
    url: CONFIG.OBS_URL 
  });
});

app.get("/obs/scenes", async (req, res) => {
  try {
    if (!obsConnected) {
      return res.status(503).json({ ok: false, error: "OBS not connected" });
    }
    
    const scenes = await obs.call("GetSceneList");
    const currentScene = await obs.call("GetCurrentProgramScene");
    
    res.json({ 
      ok: true, 
      scenes: scenes.scenes.map(scene => ({
        name: scene.sceneName,
        index: scene.sceneIndex
      })),
      currentScene: currentScene.currentProgramSceneName || currentScene.sceneName
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/obs/scene", async (req, res) => {
  try {
    if (!obsConnected) {
      return res.status(503).json({ ok: false, error: "OBS not connected" });
    }
    
    const { sceneName } = req.body;
    if (!sceneName) {
      return res.status(400).json({ ok: false, error: "Scene name is required" });
    }
    
    // Update CONFIG with the new target scene
    CONFIG.OBS_TARGET_SCENE = sceneName;
    
    // Only switch scene if it's not CURRENT_SCENE
    if (sceneName !== 'CURRENT_SCENE') {
      await obs.call("SetCurrentProgramScene", { sceneName });
      res.json({ ok: true, message: `Switched to scene: ${sceneName}` });
    } else {
      res.json({ ok: true, message: `Target set to current scene` });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ------------------ Settings API ----------------
app.get("/api/settings", async (req, res) => {
  res.json({
    ok: true,
    settings: {
      MEDIA_DIR: CONFIG.MEDIA_DIR,
      OBS_URL: CONFIG.OBS_URL,
      OBS_PASSWORD: CONFIG.OBS_PASSWORD
    },
    storageInfo: {
      localStorage: ['MEDIA_DIR', 'OBS_URL', 'OBS_PASSWORD', 'OBS_TARGET_SCENE'],
      envFile: ['PORT', 'DEFAULT_THUMB_WIDTH', 'OBS_VIDEO_INPUT', 'OBS_IMAGE_INPUT']
    }
  });
});

app.post("/api/settings/localStorage", async (req, res) => {
  try {
    const localStorageSettings = req.body;
    
    // Update CONFIG with localStorage settings
    if (localStorageSettings.MEDIA_DIR) CONFIG.MEDIA_DIR = localStorageSettings.MEDIA_DIR;
    if (localStorageSettings.OBS_URL) CONFIG.OBS_URL = localStorageSettings.OBS_URL;
    if (localStorageSettings.OBS_PASSWORD) CONFIG.OBS_PASSWORD = localStorageSettings.OBS_PASSWORD;
    if (localStorageSettings.OBS_TARGET_SCENE) CONFIG.OBS_TARGET_SCENE = localStorageSettings.OBS_TARGET_SCENE;
    
    res.json({ ok: true, message: "localStorage settings applied" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    const newSettings = req.body;
    
    // Validate required fields
    if (!newSettings.MEDIA_DIR || !newSettings.OBS_URL) {
      return res.status(400).json({ ok: false, error: "MEDIA_DIR and OBS_URL are required" });
    }
    
    // Update CONFIG object with localStorage settings only
    if (newSettings.MEDIA_DIR) CONFIG.MEDIA_DIR = newSettings.MEDIA_DIR;
    if (newSettings.OBS_URL) CONFIG.OBS_URL = newSettings.OBS_URL;
    if (newSettings.OBS_PASSWORD) CONFIG.OBS_PASSWORD = newSettings.OBS_PASSWORD;
    if (newSettings.OBS_TARGET_SCENE) CONFIG.OBS_TARGET_SCENE = newSettings.OBS_TARGET_SCENE;
    
    // Return localStorage settings for frontend to store
    const localStorageSettings = {
      MEDIA_DIR: CONFIG.MEDIA_DIR,
      OBS_URL: CONFIG.OBS_URL,
      OBS_PASSWORD: CONFIG.OBS_PASSWORD
    };
    
    // If OBS settings changed, disconnect current connection
    if (newSettings.OBS_URL || newSettings.OBS_PASSWORD) {
      try {
        if (obsConnected) {
          await obs.disconnect();
          obsConnected = false;
          console.log("[OBS] Disconnected due to settings change");
        }
      } catch (e) {
        console.log("OBS disconnect:", e.message);
      }
    }
    
    res.json({ 
      ok: true, 
      message: "Settings updated successfully",
      localStorageSettings: localStorageSettings
    });
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
