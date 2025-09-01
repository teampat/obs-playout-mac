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
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OBS Playout</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            dark: {
              50: '#f8fafc',
              100: '#f1f5f9',
              200: '#e2e8f0',
              300: '#cbd5e1',
              400: '#94a3b8',
              500: '#64748b',
              600: '#475569',
              700: '#334155',
              800: '#1e293b',
              900: '#0f172a',
            }
          }
        }
      }
    }
  </script>
  <style>
    /* Custom animations and touch optimizations */
    .animate-press {
      transition: transform 0.1s ease;
    }
    .animate-press:active {
      transform: scale(0.95);
    }
    
    /* Smooth transitions */
    * {
      transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
    }
    
    /* Loading animation */
    .loading-spin {
      animation: spin 1s linear infinite;
    }
    
    .border-3 {
      border-width: 3px;
    }
    
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    .animate-pulse {
      animation: pulse 1.5s infinite;
    }
    
    /* Card hover effects */
    .bg-dark-750 {
      background-color: rgb(41 50 65);
    }
  </style>
</head>
<body class="dark bg-dark-900 text-white min-h-screen">
  <div class="container mx-auto px-4 py-6 max-w-7xl">
    <!-- Header -->
    <header class="flex flex-wrap items-center gap-4 mb-8 pb-6 border-b border-dark-700">
      <h1 class="text-2xl md:text-3xl font-bold text-white">🎬 OBS Playout</h1>
      <span class="px-3 py-1 bg-dark-800 border border-dark-600 rounded-full text-xs text-dark-300 whitespace-nowrap">
        📁 Media: ${CONFIG.MEDIA_DIR.replace(/</g, "&lt;")}
      </span>
    </header>

    <!-- OBS Controls Section -->
    <section class="mb-8">
      <h3 class="text-lg font-semibold mb-4 text-white flex items-center gap-2">
        🎛️ OBS Controls
      </h3>
      <button id="stopAllBtn" class="animate-press bg-red-600 hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium px-6 py-3 rounded-lg text-base min-h-12 transition-all touch-manipulation">
        ⏹ Stop All Sources
      </button>
    </section>

    <!-- Library Section -->
    <section>
      <h3 class="text-lg font-semibold mb-6 text-white flex items-center gap-2">
        📚 Media Library
      </h3>
      <div id="grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        <!-- Media items will be inserted here -->
      </div>
      
      <!-- Empty State -->
      <div id="emptyState" class="hidden text-center py-12">
        <div class="text-6xl mb-4">📂</div>
        <h3 class="text-xl font-medium text-dark-300 mb-2">No media files found</h3>
        <p class="text-dark-400">Add video or image files to your media directory to get started.</p>
      </div>
    </section>
  </div>

  <script>
    // Global state tracking
    let currentPlayingPath = null;
    let currentPlayingType = null;

    async function fetchMedia(){
      const res = await fetch('/media');
      const data = await res.json();
      const grid = document.getElementById('grid');
      const emptyState = document.getElementById('emptyState');
      
      grid.innerHTML = '';
      
      if (!data.items || data.items.length === 0) {
        emptyState.classList.remove('hidden');
        return;
      }
      
      emptyState.classList.add('hidden');
      
      for(const item of data.items){
        const div = document.createElement('div');
        const isCurrentlyPlaying = currentPlayingPath === item.path;
        
        let cardClasses = 'bg-dark-800 border-2 rounded-2xl p-4 cursor-pointer transition-all transform touch-manipulation';
        
        if (isCurrentlyPlaying) {
          cardClasses += ' border-green-500 bg-green-900/20';
        } else {
          cardClasses += ' border-dark-700 hover:border-blue-500 hover:bg-dark-750 hover:scale-105';
        }
        
        div.className = cardClasses;
        div.setAttribute('data-act', item.type === 'video' ? 'play' : 'show');
        div.setAttribute('data-path', item.path);
        div.setAttribute('data-type', item.type);
        
        const typeIcon = item.type === 'video' ? '🎬' : '🖼️';
        const statusText = isCurrentlyPlaying 
          ? (item.type === 'video' ? '▶️ Now Playing' : '🖼️ Currently Shown')
          : (item.type === 'video' ? 'Click to Play Video' : 'Click to Show Image');
        const statusColor = isCurrentlyPlaying ? 'text-green-400' : 'text-blue-400';
        
        div.innerHTML = \`
          <div class="relative mb-4">
            <img class="w-full h-44 object-cover rounded-xl bg-dark-700" src="\${item.url}" alt="thumbnail" loading="lazy"/>
            <div class="absolute top-2 left-2 bg-dark-900/90 backdrop-blur-sm text-white px-2 py-1 rounded-lg text-xs font-medium">
              \${typeIcon} \${item.type.toUpperCase()}
            </div>
            \${isCurrentlyPlaying ? \`
              <div class="absolute top-2 right-2 bg-green-600/90 backdrop-blur-sm text-white px-2 py-1 rounded-lg text-xs font-medium flex items-center gap-1">
                <div class="w-2 h-2 bg-green-300 rounded-full animate-pulse"></div>
                LIVE
              </div>
            \` : ''}
          </div>
          <div class="text-center">
            <h4 class="text-white font-medium text-sm mb-1 truncate" title="\${item.filename}">\${item.filename}</h4>
            <p class="\${statusColor} text-xs font-medium">\${statusText}</p>
          </div>
        \`;
        grid.appendChild(div);
      }
    }

    // Use event delegation on the parent grid (only set once)
    document.getElementById('grid').addEventListener('click', async (e)=>{
      const card = e.target.closest('[data-act]');
      if(!card) return;
      
      // Prevent double clicks
      if(card.classList.contains('processing')) return;
      
      card.classList.add('processing');
      
      const filePath = card.getAttribute('data-path');
      const act = card.getAttribute('data-act');
      const endpoint = act==='play' ? '/play/video' : '/show/image';
      
      try {
        const res = await fetch(endpoint, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ filePath }) });
        const j = await res.json();
        if(!j.ok) {
          showToast('❌ Failed: ' + (j.error || 'unknown'), 'error');
        } else {
          // Update current playing state
          currentPlayingPath = filePath;
          currentPlayingType = card.getAttribute('data-type');
          
          // Immediately refresh to show new states
          fetchMedia(); // Refresh to update all cards with current playing state
        }
      } catch (error) {
        showToast('❌ Network error: ' + error.message, 'error');
      } finally {
        card.classList.remove('processing');
      }
    });

    document.getElementById('stopAllBtn').addEventListener('click', async ()=>{
      const btn = document.getElementById('stopAllBtn');
      
      // Prevent double clicks
      if(btn.disabled) return;
      btn.disabled = true;
      
      try {
        const res = await fetch('/stop/all', { method:'POST' });
        const j = await res.json();
        if(!j.ok) {
          showToast('❌ Failed: ' + (j.error || 'unknown'), 'error');
        } else {
          // Clear current playing state
          currentPlayingPath = null;
          currentPlayingType = null;
          
          // Immediately refresh to update all cards (remove green borders)
          fetchMedia();
        }
      } catch (error) {
        showToast('❌ Network error: ' + error.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    // Toast notification system
    function showToast(message, type = 'info') {
      const toast = document.createElement('div');
      toast.className = \`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg font-medium text-sm transition-all transform translate-x-full opacity-0 \${
        type === 'error' ? 'bg-red-600 text-white' : 'bg-green-600 text-white'
      }\`;
      toast.textContent = message;
      
      document.body.appendChild(toast);
      
      // Animate in
      setTimeout(() => {
        toast.classList.remove('translate-x-full', 'opacity-0');
      }, 100);
      
      // Animate out after 3 seconds
      setTimeout(() => {
        toast.classList.add('translate-x-full', 'opacity-0');
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    }

    fetchMedia();
  </script>
</body>
</html>`);
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
