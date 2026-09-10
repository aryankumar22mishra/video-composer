# Mini AI Video Composer

A full-stack video composer that renders and exports videos **entirely in the
browser**: image/video clips, an optional background audio track, screen
recordings, and text overlays are composed with **React + Canvas**, encoded
with **WebCodecs/MediaRecorder**, and muxed to **MP4 / WebM** on the client —
no server-side encode is involved in the default flow.

The Django backend is kept for **project save/load and optional file storage**
(`/api/projects/`). The legacy FFmpeg + Celery + Redis compose pipeline
(`/api/jobs/`) is still present as a fallback but is not used by the
client-side export.

```
new project/
├── video-composer-backend/     ← Django + DRF (Project save/load; legacy FFmpeg path)
└── video-composer-frontend/    ← React (Vite)
    └── src/
        ├── renderer/           ← Client-side composition render + exporters (WebM / MP4)
        ├── state/              ← Composition model (clips / texts / dimensions)
        ├── assets/             ← Media metadata (real durations, dimensions)
        └── recorder/           ← Screen recorder module
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite 8 |
| Client Rendering | Canvas (`drawCompositionFrame`) + WebCodecs (`VideoEncoder`/`AudioEncoder`) + `MediaRecorder` |
| Client Muxing | `mp4-muxer`, `webm-muxer` (pure JS) |
| Client Audio | `AudioContext` (`decodeAudioData` + `OfflineAudioContext` mix) |
| Backend Framework | Django 4.2.x + Django REST Framework |
| Backend Storage | SQLite (dev) + `MEDIA_ROOT` for project exports |
| Legacy Backend Path | Celery (`--pool=solo` on Windows) + Redis + FFmpeg — kept as a fallback, unused by the default client-side flow |
| Screen Recording | `getDisplayMedia` + `getUserMedia` + `MediaRecorder` + Canvas compositing |
| Language | JavaScript / Python 3.12 |

---

## How It Works, End to End

### Export flow (fully client-side)

1. User uploads clips (images/videos) plus optional audio, records their
   screen, arranges clips on the timeline, and optionally adds text overlays.
2. The **Live Preview** renders the composition onto a `<canvas>` in real time
   via `drawCompositionFrame()` — the *exact same* function the exporter uses,
   so the exported file can never diverge from what the user sees.
3. Clicking **⬇ Export** in the left sidebar runs the export:
   - **Audio** — every clip's audio and the background track are decoded to
     PCM and mixed into one time-aligned buffer (`AudioPipeline.js`).
   - **MP4 (default, fast)** — WebCodecs `VideoEncoder` (H.264) +
     `AudioEncoder` (AAC) draw frames as fast as possible and mux via
     `mp4-muxer`.
   - **WebM** — either the fast WebCodecs/`webm-muxer` path or, on browsers
     without WebCodecs, a real-time `MediaRecorder` capture of an offscreen
     canvas (zero dependencies, works everywhere).
4. When the render finishes, the result card shows two buttons: **⬇ Download
   WebM** and **⬇ Download MP4**. Clicking one downloads that format
   (re-rendering the other format first if needed).
5. The timeline (video/audio tracks + playhead, adaptive time ruler,
   horizontal scroll, click-to-seek) is driven by one shared `currentTime`,
   so preview, playhead, and export always agree.

### Screen recording flow

1. User clicks the **🎥 Record** button in the sidebar to open the
   **Recording Setup** modal.
2. They configure camera (shape/size/mirror/position), microphone, and system
   audio, then click **Share screen**.
3. The browser's native screen-picker opens (`getDisplayMedia`). After a
   source is selected, the optional microphone (`getUserMedia({ audio })`) and
   camera (`getUserMedia({ video })`) permissions are requested in order.
4. A live preview shows the shared screen with the webcam composited on top.
5. Clicking **Start recording** begins capturing:
   - **Screen only** — the screen stream is recorded directly
   - **Screen + webcam** — screen and camera are composited onto a single
     `canvas` whose `captureStream(30)` provides **one video track** to
     `MediaRecorder` (browsers cannot reliably encode two video tracks)
   - Audio tracks (system audio from the screen stream + microphone) are
     carried onto the final stream unchanged
6. Clicking **Stop recording** finalizes the `MediaRecorder`, builds a `Blob`
   → `File` (`screen-recording-<timestamp>.webm`), and commits it via
   `onCommit(file)`.
7. The recording enters the **exact same `clips[]` pipeline** as an uploaded
   video — My Videos → timeline → canvas preview → client-side export — with
   its real duration preserved end to end (MediaRecorder WebM files have their
   `Infinity` duration resolved via a seek-to-end probe).

---

## Screen Recorder

The recorder lives in `src/recorder/` as two files:

| File | Role |
|---|---|
| `useScreenRecorder.js` | Owns all browser recording internals: screen/mic/camera streams, `MediaRecorder`, canvas compositing, chunk collection, `Blob`→`File`, cleanup, and the state machine |
| `RecordModal.jsx` | Presentation-only OpenVid-style UI: live preview, camera/mic/system-audio settings, and the state-driven footer |

### Recording combinations supported

| | Screen | Mic | System audio | Webcam |
|---|---|---|---|---|
| ✅ | ✅ | | | |
| ✅ | ✅ | ✅ | | |
| ✅ | ✅ | | ✅ | |
| ✅ | ✅ | | | ✅ |
| ✅ | ✅ | ✅ | ✅ | |
| ✅ | ✅ | ✅ | | ✅ |
| ✅ | ✅ | | ✅ | ✅ |
| ✅ | ✅ | ✅ | ✅ | ✅ |

### State machine

`idle` → `requesting_permission` → `ready` → `recording` → `stopping` →
`processing` → `completed`, with `error` reachable from any state.

### Webcam overlay

The camera is composited onto the screen using a dedicated canvas (never the
composer canvas). The overlay supports:

- **Shape** — Squircle (rounded square), Circle, Square
- **Size** — S (18%), M (25%), L (32%) of canvas width
- **Mirror** — horizontal flip of the webcam only (screen is never mirrored)
- **Position** — Top Left / Top Right / Bottom Left / Bottom Right

A cover-style center crop preserves the camera's aspect ratio with no
stretching or black bars.

### Duration handling

Recorded WebM files produced by Chrome's `MediaRecorder` do not declare a
duration in their header, so a `<video>` element reports `duration ===
Infinity`. The frontend resolves the real duration with a seek-to-end
workaround (`currentTime = 1e101` → wait for `durationchange` → read the true
value), guaranteeing recordings display and render at their actual length.

The frontend also sends a `clip_durations` array (one duration per clip, in
submission order) with every job. The backend validates it and passes each
video its real duration to FFmpeg, while images continue to use
`image_duration`. This means a mixed timeline of a 3s image, a 10s recording,
a 3s image, and a 7s uploaded video renders as a single ~23s output.

### Dimensions control

A persistent **Dimensions** control in the composer toolbar lets users set the
composition resolution before exporting. Click the dimension button (e.g.
`1080×1920`) to open a popover with presets and a custom input:

**Presets**

| Preset | Resolution | Ratio |
|---|---|---|
| Auto | preserves current width & height | native |
| Wide | 1920×1080 | 16:9 |
| Vertical | 1080×1920 | 9:16 |
| Square | 1080×1080 | 1:1 |
| Classic | 1440×1080 | 4:3 |
| Social | 1080×1350 | 4:5 |
| Cinema | 2560×1080 | 21:9 |
| Portrait | 1080×1620 | 2:3 |

**Custom** — enter any positive integer width and height (max 7680) and click
*Apply dimensions*. Invalid, zero, or non-integer values are rejected inline;
browser `alert()` is never used.

`composition.width` / `composition.height` are the **single source of truth** —
the live preview, timeline, and final export/download all derive the output
resolution from the same values. Existing clips are not distorted on aspect
change; they are fitted or cropped according to the composer's existing
cover/contain rules. Clip start times, durations, and ordering are preserved
when dimensions change.

The browser exports the final video at exactly `composition.width` ×
`composition.height` — the same values the live preview uses. If no preset is
selected ("Auto"), the project base size (1280×720) is used.

### Permission & error handling

- Camera/mic/system-audio permission denials stop the flow cleanly, reset to
  `idle`, show a friendly message, and never call `onCommit()`.
- Browser-native "Stop sharing" finalizes the recording exactly once and
  cleans up all tracks.
- A disconnected camera mid-recording drops the webcam overlay and continues
  recording screen + audio, with a non-blocking notice.
- Cancel / Escape / backdrop close / component unmount all stop every active
  track and animation frame — no camera or microphone LED stays on.

### Cleanup

Every teardown path releases: screen stream, mic stream, camera stream,
combined/canvas streams, `MediaRecorder`, hidden video elements, the
recording canvas, the animation frame, and all event listeners.

---

## Backend

### Data Models

**`Project`** (used by the client-side flow)
- `id` — UUID, primary key
- `name` — display name
- `composition` — JSON object matching the frontend composition model
- `export_file` — optional uploaded MP4/WebM for hosting/sharing
- `created_at` / `updated_at` — timestamps

**`ComposeJob`** (legacy server-side flow, kept for compatibility)
- `id` — UUID, primary key
- `status` — `pending` → `processing` → `completed` / `failed`
- `audio` — optional audio file
- `image_duration` — seconds each image clip is shown for (default: 3)
- `output_video` — final rendered video file
- `error_message` — populated if the job fails
- `created_at` / `updated_at` — timestamps

**`Clip`**
- `job` — foreign key to `ComposeJob`
- `file` — the uploaded image or video file
- `order` — position in the final video sequence

### API Endpoints

All routes are under `/api/jobs/` (DRF `DefaultRouter`):

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/jobs/` | Upload clips + optional audio, starts a background job |
| `GET` | `/api/jobs/` | List all jobs |
| `GET` | `/api/jobs/{id}/` | Get one job's status/details |
| `DELETE` | `/api/jobs/{id}/` | Delete a job |

**`POST` request format** (`multipart/form-data`):
- `clips` — one or more files (images/videos/recordings)
- `audio` — single audio file (optional)
- `image_duration` — seconds per image (optional, default 3)
- `clip_durations` — JSON array of per-clip durations in seconds, in the
  same order as `clips` (optional; videos use their real duration, images
  use `image_duration`). Example: `[3, 10, 3, 7]`

`clip_durations` is validated server-side: it must be a JSON array whose
length matches the clip count, containing only positive finite numbers ≤ 1800
(30 minutes). Malformed values are rejected with `400 Bad Request`. When the
field is absent, the job falls back to the legacy `image_duration` behavior
for every clip (backward compatible with older clients).

**Response codes:**
- `202 Accepted` — job created and queued (not `201`, since the resource
  — the finished video — isn't ready yet)
- `400 Bad Request` — no clips provided, or invalid `clip_durations`

### Architecture Notes

- **Video composition logic is isolated** in
  `composer/services/ffmpeg_service.py` behind a single
  `compose(clip_paths, audio_path, output_path)` method. An AI-based video
  generator can later be swapped in behind the same interface without
  changing the API or view layer.
- **Processing is fully asynchronous.** The original version ran FFmpeg
  synchronously inside the HTTP request, blocking the server on large jobs.
  This was refactored to use Celery + Redis so the API responds instantly
  and a background worker does the actual work.

### FFmpeg composition

`ffmpeg_service.py` normalizes every clip into a uniform segment, then
concatenates them and overlays audio:

- **Images** → `_image_to_clip(path, image_duration)` — converted to a
  segment lasting `image_duration` seconds
- **Videos** → `_normalize_clip(path, duration)` — rendered for their real
  `duration` (from `clip_durations`), normalized to 1280×720, 30 FPS, H.264

---

## Frontend

Built with React 19 + Vite 8. Key modules:

| File | Role |
|---|---|
| `src/App.jsx` | Dashboard: media library, upload form, timeline editor, job polling, submission |
| `src/state/composition.js` | Composition model (`createComposition`, `createCompositionClip`) |
| `src/assets/AssetManager.js` | Reads real media metadata (dimensions/duration) from files, including the WebM Infinity-duration workaround |
 | `src/renderer/CompositionRenderer.js` | Draws the active composition clip onto the canvas preview (shared with the exporter so output always matches preview) |
| `src/renderer/AudioPipeline.js` | Decodes clip + background audio to PCM and mixes them into one time-aligned buffer for export |
| `src/renderer/webmExporter.js` | Real-time client-side export: offscreen canvas → `captureStream` → `MediaRecorder` → WebM (zero-dep fallback) |
| `src/renderer/mp4Exporter.js` | Fast non-real-time client-side export: WebCodecs `VideoEncoder`/`AudioEncoder` → MP4/VP9 via `mp4-muxer`/`webm-muxer` |
| `src/renderer/useClientExport.js` | Orchestrates the full export: MP4 (fast, WebCodecs) → WebM fallback chain, progress, cancel, format-specific downloads |
| `src/recorder/useScreenRecorder.js` | Screen recorder hook (streams, MediaRecorder, canvas compositing, state machine) |
| `src/recorder/RecordModal.jsx` | Recording Setup modal (OpenVid-style two-column UI) |

### My Videos / media library

Uploaded and recorded files appear together in one library. Each card shows a
thumbnail (images) or a 🎬 placeholder (videos) with its **real duration**
fetched from the file metadata. Clicking a card adds it to the timeline.

### Timeline editor

VIDEO/AUDIO tracks, playhead, play/pause, zoom in/out, click-to-seek — all
driven by one shared `currentTime` state so the video and timeline always stay
in sync. Timeline blocks are sized to each clip's actual duration.

### Screen recorder UI

Opened from the **🎥 Record** sidebar button, the Recording Setup modal uses
a two-column layout: a large live preview (shared screen with webcam bubble
overlay) on the left, and Camera / Microphone / System Audio settings cards
on the right. The webcam preview responds live to shape, size, mirror, and
position changes via CSS only — the recording canvas stays authoritative. On
mobile (≤900px) the modal collapses to a single scrolling column.

`vite.config.js` proxies `/api` and `/media` requests to
`http://localhost:8000` during development, so the frontend can talk to
the Django backend without CORS issues.

---

## ⚠️ Critical Windows Note: Celery Worker Pool

Celery's default worker pool (`prefork`) relies on Unix-style process
forking, which Windows does not support the same way. Running the worker
without `--pool=solo` causes every spawned worker process to crash
immediately with `PermissionError: [WinError 5] Access is denied` — tasks
get accepted ("received") but never actually run, leaving jobs stuck on
`pending` forever.

**Always start the worker with `--pool=solo` on Windows:**
```powershell
python -m celery -A video_composer worker -l info --pool=solo
```

---

## Local Setup (Windows)

### 1. Backend setup

```powershell
cd video-composer-backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
python manage.py migrate
python manage.py createsuperuser   # optional, for /admin/
```

Make sure **FFmpeg** is installed and on PATH (`ffmpeg -version` should work).

### 2. Frontend setup

```powershell
cd video-composer-frontend
npm install
```

### 3. Running everything — 4 terminals needed

**Terminal 1 — Redis**
```powershell
& "C:\Program Files\Redis\redis-server.exe" "C:\Program Files\Redis\redis.windows.conf"
```

**Terminal 2 — Django server**
```powershell
cd video-composer-backend
.\venv\Scripts\Activate.ps1
python manage.py runserver
```

**Terminal 3 — Celery worker**
```powershell
cd video-composer-backend
.\venv\Scripts\Activate.ps1
python -m celery -A video_composer worker -l info --pool=solo
```

**Terminal 4 — Frontend dev server**
```powershell
cd video-composer-frontend
npm run dev
```

Then open the frontend URL shown in Terminal 4 (typically `http://localhost:5173`).

---

## Verified So Far

- ✅ Backend: models, serializers, admin, URLs, FFmpeg composition service
- ✅ Synchronous version tested end-to-end (upload → completed video)
- ✅ Refactored to async processing with Celery + Redis
- ✅ Confirmed `202 Accepted` returned immediately with `status: "pending"`
- ✅ Confirmed background worker completes jobs (`pending` → `completed`
  in ~1.7s without blocking the initial request)
- ✅ Frontend: upload form, job polling, and timeline/video sync all working
- ✅ Diagnosed and fixed a real Windows Celery bug (`--pool=solo` requirement)
- ✅ **Screen recording**: screen-only, screen + mic, screen + webcam, and all
  8 combinations record correctly and commit a real WebM `File`
- ✅ **Webcam compositing**: screen + camera rendered to a single canvas
  video track with shape/size/mirror/position controls
- ✅ **Duration fix**: recorded WebM `Infinity` duration resolved via
  seek-to-end; `clip_durations` sent, validated by Django, and passed to
  FFmpeg so videos render at their actual length while images keep
  `image_duration`
- ✅ **Dimensions control**: OpenVid-style dimension picker in the composer
  toolbar with Auto, YouTube (16:9), TikTok (9:16), Instagram (1:1),
  Standard (4:3), Portrait (3:4) presets and a custom W×H input;
  `composition.width`/`composition.height` are the single source of truth
  for preview, timeline, and final export/download resolution
- ✅ **Recording Setup UI**: OpenVid-style two-column modal (preview +
  settings + footer), responsive single-column on mobile
- ✅ `npm run lint` — 0 errors; `npm run build` — succeeds

---

## Known Gaps / Next Steps

- ❌ **No authentication** — the API is currently open to anyone
- ❌ **No automated tests** — `tests.py` is still empty; needs coverage for
  job creation, the pending → processing → completed flow, failure
  handling, and the new `clip_durations` validation
- ❌ **No cleanup of temporary files** after processing completes
- ❌ **File validation is extension-based only**, not real content/MIME-type
  checking
- ❌ **No retry strategy decided** for transient vs. genuine processing
  failures
- 🔲 Production hardening not yet done: environment variables, Postgres
  instead of SQLite, proper Redis/Celery deployment config
