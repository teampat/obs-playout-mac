# OBS Playout Web App (Mac, single-file)

Features
- Modern web interface with EJS templating
- Upload video/image to a single media directory
- List with thumbnails (ffmpeg for video, sharp for images)
- Play video / show image on OBS via obs-websocket
- Touch-friendly dark theme interface
- Real-time active state indicators

## Prereqs
- macOS with OBS 28+ (WebSocket enabled)
- Homebrew ffmpeg: `brew install ffmpeg`
- Node.js 18+

## Setup
```bash
cd obs-playout-mac
npm i
# edit .env or app.js CONFIG (MEDIA_DIR, OBS_PASSWORD, etc.)
node app.js
open http://localhost:3000
```

## ENV (optional)
Create `.env` or export in shell:
```
MEDIA_DIR=/Users/<username>/Videos/OBS-Library
OBS_URL=ws://127.0.0.1:4455
OBS_PASSWORD=YOUR_PASSWORD
PORT=3000
OBS_VIDEO_INPUT=PlayerVideo
OBS_IMAGE_INPUT=PlayerImage
```
