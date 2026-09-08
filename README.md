# Mini AI Video Composer

A full-stack app that composes videos from uploaded images/clips, an optional
audio track, **and screen recordings**. The backend processes video in the
background using Celery + Redis + FFmpeg, while a React frontend lets users
upload files, record their screen, track job progress, and preview the result
on a timeline.

```
new project/
├── video-composer-backend/     ← Django + DRF + Celery + FFmpeg
└── video-composer-frontend/    ← React (Vite)
    └── src/recorder/           ← Screen recorder module (Phases 1-7)
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend Framework | Django 4.2.x + Django REST Framework |
| Background Jobs | Celery (worker pool: `--pool=solo`, **required on Windows**) |
| Message Broker | Redis |
| Media Processing | FFmpeg (invoked via subprocess) |
| Database | SQLite (dev) |
| Frontend | React 19 + Vite 8 |
| Screen Recording | `getDisplayMedia` + `getUserMedia` + `MediaRecorder` + Canvas compositing |
| Language | Python 3.12 / JavaScript |

---

## How It Works, End to End

### Upload flow

1. User opens the React dashboard and uploads clips (images/videos) plus
   optional audio through a form.
2. The frontend sends a `POST /api/jobs/` request. The Django API creates a
   `ComposeJob` record with status `pending`, saves the uploaded files, and
   immediately returns `202 Accepted` — it does **not** wait for the video
   to be generated.
3. The request also hands the job off to a Celery background task.
4. A Celery worker (running separately) picks up the task:
   - Sets the job to `processing`
   - Converts each **image** into a video segment lasting `image_duration`
     seconds (default: 3)
   - Renders each **video** (uploaded or recorded) for its **actual
     duration**, not a fixed length
   - Concatenates all segments in order using FFmpeg
   - Overlays the audio track, if provided
   - Sets the job to `completed` (with a link to the output video) or
     `failed` (with an error message)
5. The React frontend polls `GET /api/jobs/{id}/` every 2 seconds while the
   job is `pending`/`processing`, and displays the final video once it's
   `completed`.
6. The frontend also shows a timeline (video/audio tracks + playhead) that
   stays in sync with the video player through one shared `currentTime`
   value — the video updates it while playing, the playhead position is
   calculated from it, and clicking the timeline seeks the video.

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
   video — My Videos → timeline → canvas preview → `handleSubmit()` →
   `/api/jobs/` — with its real duration preserved end to end.

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

| Preset | Resolution | Notes |
|---|---|---|
| Auto | preserves current width & height | default active state |
| YouTube | 1920×1080 | 16:9 |
| TikTok | 1080×1920 | 9:16 |
| Instagram | 1080×1080 | 1:1 |
| Standard | 1440×1080 | 4:3 |
| Portrait | 1080×1440 | 3:4 |

**Custom** — enter any positive integer width and height (max 7680) and click
*Apply dimensions*. Invalid, zero, or non-integer values are rejected inline;
browser `alert()` is never used.

`composition.width` / `composition.height` are the **single source of truth** —
the live preview, timeline, and final export/download all derive the output
resolution from the same values. Existing clips are not distorted on aspect
change; they are fitted or cropped according to the composer's existing
cover/contain rules. Clip start times, durations, and ordering are preserved
when dimensions change.

When the job is submitted, the selected `output_width` / `output_height` are sent
to the backend alongside the existing `clip_durations`, and FFmpeg renders the
final video at those dimensions. If no dimensions are supplied, 1280×720
remains the fallback.

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

**`ComposeJob`**
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
| `src/renderer/CompositionRenderer.js` | Draws the active composition clip onto the canvas preview |
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
