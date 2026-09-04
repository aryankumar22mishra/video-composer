# Mini AI Video Composer

A full-stack app that composes videos from uploaded images/clips and an
optional audio track. The backend processes video in the background using
Celery + Redis + FFmpeg, while a React frontend lets users upload files,
track job progress, and preview the result on a timeline.

```
new project/
├── video-composer-backend/     ← Django + DRF + Celery + FFmpeg
└── video-composer-frontend/    ← React (Vite)
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
| Frontend | React 18 + Vite |
| Language | Python 3.12 / JavaScript |

---

## How It Works, End to End

1. User opens the React dashboard and uploads clips (images/videos) plus
   optional audio through a form.
2. The frontend sends a `POST /api/jobs/` request. The Django API creates a
   `ComposeJob` record with status `pending`, saves the uploaded files, and
   immediately returns `202 Accepted` — it does **not** wait for the video
   to be generated.
3. The request also hands the job off to a Celery background task.
4. A Celery worker (running separately) picks up the task:
   - Sets the job to `processing`
   - Converts each image into a short video segment (`image_duration`
     seconds), and normalizes any video clips (resolution/framerate/codec)
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
- `clips` — one or more files (images/videos)
- `audio` — single audio file (optional)
- `image_duration` — seconds per image (optional, default 3)

**Response codes:**
- `202 Accepted` — job created and queued (not `201`, since the resource
  — the finished video — isn't ready yet)
- `400 Bad Request` — no clips provided

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

---

## Frontend

Single-page React app (`src/App.jsx`) covering:

- **Upload form** — clips, optional audio, image duration
- **Job polling** — checks job status every 2 seconds while
  `pending`/`processing`, stops once `completed`/`failed`
- **Render result panel** — shows job ID, status badge, error message (if
  failed), and the final video once ready
- **Timeline editor** — VIDEO/AUDIO tracks, playhead, play/pause, zoom
  in/out, click-to-seek — all driven by one shared `currentTime` state so
  the video and timeline always stay in sync

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

---

## Known Gaps / Next Steps

- ❌ **No authentication** — the API is currently open to anyone
- ❌ **No automated tests** — `tests.py` is still empty; needs coverage for
  job creation, the pending → processing → completed flow, and failure
  handling
- ❌ **No cleanup of temporary files** after processing completes
- ❌ **File validation is extension-based only**, not real content/MIME-type
  checking
- ❌ **No retry strategy decided** for transient vs. genuine processing
  failures
- 🔲 Production hardening not yet done: environment variables, Postgres
  instead of SQLite, proper Redis/Celery deployment config
