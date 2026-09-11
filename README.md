# Mini AI Video Composer

A React video editor for combining images, videos, screen recordings, background audio, and basic text overlays. The current editor previews compositions on Canvas and exports MP4 or WebM directly in the browser.

The repository also includes a Django API for storing project metadata and exported files, plus a legacy FFmpeg rendering queue. The editor currently uses browser memory and client-side export; project save/load is not wired into the UI. The AI Agent uses a backend provider endpoint for structured editing actions while keeping source media in the browser.

## Quick start

To use the current editor, start just the frontend from the repository root:

```powershell
cd video-composer-frontend
npm ci
npm run dev
```

Open the URL printed by Vite, normally `http://localhost:5173`. Django, Redis, Celery, and FFmpeg are not required for this workflow.

Requirements:

- Node.js matching `^20.19.0 || >=22.12.0`, as required by the installed Vite, React plugin, and Oxlint packages, plus npm.
- A browser with Canvas, Web Audio, and MediaRecorder support. Fast export additionally requires WebCodecs and the requested codecs.
- Screen recording requires browser capture support and screen, microphone, or camera permissions for the sources you enable. Use localhost for local development.

## Using the editor

1. Open **My media > Upload** and choose image or video files. Optionally select one background audio file and set the image duration (default: 3 seconds).
2. Switch to **Videos** and click a media card to append it to the timeline. Uploaded files and confirmed screen recordings share the same library. A file can be added more than once.
3. Use the preview transport to play, pause, or seek. Drag the playhead or adjust timeline zoom to navigate. Select a clip to resize it with the preview handles, adjust its duration with the timeline arrow controls, or remove it from the timeline.
4. Use **Add text** on the TEXT track to insert a centered, three-second placeholder overlay at the playhead. Text content and styling controls are not currently exposed in the UI.
5. Open the dimensions control beside the preview transport to choose an output preset or custom size.
6. Click **Export** in the left navigation. The export panel shows progress and a cancel action, then WebM and MP4 download buttons. Requesting a different format starts another render when needed.

### AI Agent

Click **AI Agent** between Record and Export to open a persistent chat panel.
Prompts can be typed or dictated; speech transcripts remain editable before
sending. The backend receives only the prompt, composition metadata, selected
clip metadata, and asset descriptors. It returns a validated list of supported
editing tools: trim, split, reorder, text editing, speed, volume, dimensions,
and grayscale. The React command layer applies each response atomically, so
the existing preview, timeline, undo/redo, and browser export use the result.
Configure `AI_API_KEY`, and optionally `AI_MODEL` and `AI_BASE_URL`, in the
Django process environment as described in `video-composer-backend/README.md`.

Media files, composition state, and export object URLs are held in browser memory. Refreshing the page loses the current editing session; download the result before closing it.

### Screen recording

1. Click **Record** and configure the camera, microphone, and system audio. Camera settings include device, shape, size, mirroring, and corner position.
2. Click **Share screen**, select a screen/window/tab in the browser picker, and grant any enabled microphone/camera permissions.
3. The setup modal closes and a **3-2-1 countdown** starts recording automatically. The recording lifecycle belongs to `App`, so closing the setup UI does not end an active recording.
4. Click **Stop** in the recording controls. Review the captured video, then choose **Use Recording** to add it to the media library or **Discard** to abandon it.
5. Click the recording's media card to add it to the timeline.

Screen-only capture records the display stream directly. With a camera enabled, the hook first attempts an OffscreenCanvas compositor in a Web Worker. If the worker path is unavailable, it falls back to separate screen and camera recorders. The current review/commit UI consumes only the primary recording, so the fallback does not add the separate webcam recording to the composition.

System audio availability depends on the browser, operating system, and selected capture source. When both system audio and microphone tracks are available, the hook uses Web Audio to mix them. Recorded WebM duration is resolved through metadata probing, with measured recording time as an additional fallback.

### Output dimensions

The composition starts at **1280 x 720, 30 FPS**. Preview and exporters derive their canvas sizes from `composition.width` and `composition.height`.

| Preset | Resolution | Displayed ratio |
| --- | --- | --- |
| Auto | 1280 x 720 | Resets to the project default |
| Wide | 1920 x 1080 | 16:9 |
| Vertical | 1080 x 1920 | 9:16 |
| Square | 1080 x 1080 | 1:1 |
| Classic | 1440 x 1080 | 4:3 |
| Social | 1080 x 1350 | 4:5 |
| Cinema | 2560 x 1080 | 21:9 |
| Portrait | 1080 x 1620 | 2:3 |

Custom inputs accept whole numbers from 2 to 7680 and round to even dimensions for encoding. **Both client exporters currently reject dimensions above 3840 pixels on either side**, even though the picker accepts larger values. Export duration is capped at **30 minutes** by the audio pipeline. Browser codec and memory limits may be lower.

## Architecture

| Area | Implementation |
| --- | --- |
| Editor | React 19, Vite 8, JavaScript, CSS |
| Composition | In-memory video/audio tracks, clip timing/transforms, text overlays, and output dimensions |
| Preview and export drawing | Shared Canvas renderer in `CompositionRenderer.js` |
| Export audio | Web Audio decoding and `OfflineAudioContext` mixing |
| Fast MP4 export | WebCodecs H.264/AAC with `mp4-muxer` |
| Fast WebM export | WebCodecs VP9/Opus with `webm-muxer` |
| Real-time export fallback | Canvas `captureStream` and MediaRecorder |
| Recorder | Browser media capture, MediaRecorder, optional worker compositor |
| Optional API | Django 4.2, Django REST Framework, SQLite, local media storage |
| Legacy render queue | Celery 5.4, Redis, FFmpeg |

### Client export flow

```text
Local files / confirmed recording
  -> media library -> composition timeline
  -> shared Canvas renderer + decoded/mixed audio
  -> WebCodecs MP4
       -> on failure: WebCodecs WebM
            -> on failure/unavailable: real-time MediaRecorder WebM
  -> in-memory result -> download
```

An explicit WebM request starts with the WebM branch. Keep the tab visible during real-time export. The audio mix follows the video composition duration: shorter background audio leaves silence, and longer background audio is trimmed. Audio that the browser cannot decode is skipped.

The fallback chain stays entirely in the browser; it does not submit a Django job. An MP4 request can produce WebM when MP4 encoding fails. The current download handler names files using the requested format, so a fallback result can receive a `.mp4` filename despite containing WebM.

### Source map

| Path | Role |
| --- | --- |
| [src/App.jsx](video-composer-frontend/src/App.jsx) | Editor state, media library, preview playback, timeline, recording lifecycle, and export UI |
| [src/state/composition.js](video-composer-frontend/src/state/composition.js) | Composition, clip, and text defaults and factories |
| [src/assets/AssetManager.js](video-composer-frontend/src/assets/AssetManager.js) | File metadata, duration probing, and object URL helpers |
| [src/components/Sidebar.jsx](video-composer-frontend/src/components/Sidebar.jsx) | My media, Record, and Export navigation |
| [src/components/DimensionsPopover.jsx](video-composer-frontend/src/components/DimensionsPopover.jsx) | Dimension picker currently mounted by `App` |
| [src/dimensions/DimensionPresets.js](video-composer-frontend/src/dimensions/DimensionPresets.js) | Shared presets and even-dimension helpers |
| [src/dimensions/DimensionPanel.jsx](video-composer-frontend/src/dimensions/DimensionPanel.jsx) | Earlier dimension panel, currently not mounted by `App` |
| [src/renderer/](video-composer-frontend/src/renderer/) | Shared renderer, audio pipeline, MP4/WebM exporters, and `useClientExport` hook |
| [src/recorder/](video-composer-frontend/src/recorder/) | Capture hook, setup modal, countdown/controls, review UI, and compositor worker |
| [composer/](video-composer-backend/composer/) | Django models, API views/serializers, migrations, and Celery task |
| [composer/services/ffmpeg_service.py](video-composer-backend/composer/services/ffmpeg_service.py) | Legacy clip normalization, concatenation, and background audio rendering |
| [video_composer/](video-composer-backend/video_composer/) | Django settings, root URLs, and Celery configuration |

## Optional backend setup

Use the backend when developing the project storage API or legacy server rendering. Python 3.12 is the version used by the local environments in this checkout.

From the repository root, in PowerShell:

```powershell
cd video-composer-backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

On macOS/Linux, activate the environment with `source .venv/bin/activate` instead. Create an admin account with `python manage.py createsuperuser` if needed, then visit `http://localhost:8000/admin/`.

The API runs at `http://localhost:8000/api/`. Vite forwards `/api` and `/media` requests to `http://localhost:8000` through [vite.config.js](video-composer-frontend/vite.config.js).

Current configuration is in [settings.py](video-composer-backend/video_composer/settings.py):

| Setting | Development value |
| --- | --- |
| Database | `video-composer-backend/db.sqlite3` |
| Uploaded/generated files | `video-composer-backend/media/` |
| Media URL | `/media/` |
| Celery broker and results | `redis://localhost:6379/0` |

There is no application `.env` loader configured. Project exports are stored under `media/projects/<project-id>/exports/`; legacy jobs use `media/uploads/`, `media/tmp/`, and `media/outputs/`.

### Project storage API

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET | `/api/projects/` | List projects, newest update first |
| POST | `/api/projects/` | Create a project |
| GET | `/api/projects/{id}/` | Retrieve a project |
| PUT / PATCH | `/api/projects/{id}/` | Update supplied project fields |
| DELETE | `/api/projects/{id}/` | Delete a project record |

Writes accept `multipart/form-data` or form-encoded fields, not an `application/json` request body:

- `name`: optional display name; defaults to `Untitled project`.
- `composition`: JSON-encoded object as a form field.
- `export_file`: optional rendered video upload, using multipart form data.

Responses include `id`, `name`, `composition`, `export_file`, `created_at`, and `updated_at`. Create/update currently return **200 OK**. The API stores composition JSON and an optional output file; it does not upload the source media referenced by the composition or restore local browser `File` objects.

### Legacy server rendering

This API remains available for direct callers. To enable it, install FFmpeg on PATH (`ffmpeg -version` should succeed), start Redis on port 6379, and run Django plus a Celery worker.

In a separate PowerShell terminal, from the repository root:

```powershell
cd video-composer-backend
.\.venv\Scripts\Activate.ps1
python -m celery -A video_composer worker -l info --pool=solo
```

Use `--pool=solo` for the Windows worker. The worker reads its broker configuration from Django settings.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| POST | `/api/jobs/` | Upload clips and queue a render; returns `202 Accepted` |
| GET | `/api/jobs/` | List jobs |
| GET | `/api/jobs/{id}/` | Read status, output URL, and errors |
| DELETE | `/api/jobs/{id}/` | Delete a job record |

Job creation uses `multipart/form-data`:

| Field | Description |
| --- | --- |
| `clips` | One or more image/video files, repeated under the same field name |
| `audio` | Optional background audio file |
| `image_duration` | Integer seconds per image; default `3` |
| `clip_durations` | Optional JSON array with one positive finite duration per clip, each at most 1800 seconds |
| `width`, `height` | Optional output dimensions; provide both as positive even integers |
| `aspect_ratio` | `auto`, `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, or `custom` |
| `fit_mode` | `pad` (default) or `crop` |

Jobs transition from `pending` to `processing`, then `completed` or `failed`. Poll the detail endpoint to read `output_video` or `error_message`.

Images use `image_duration`; videos use `clip_durations` when supplied, otherwise they also use `image_duration`. The FFmpeg service uses explicit dimensions only when `aspect_ratio` is not `auto`; otherwise it falls back to 1280 x 720. Preset labels alone do not select a resolution in the service. Use `aspect_ratio=custom` with explicit `width` and `height` for a custom output size.

The legacy job payload does not support the browser composition's text overlays or full clip transform model.

## Development checks

From `video-composer-frontend/`:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite with hot reload |
| `npm run lint` | Run Oxlint |
| `npm run build` | Build the frontend into `dist/` |
| `npm run preview` | Serve the built frontend locally |

From `video-composer-backend/`, with its environment activated:

```powershell
python manage.py check
python manage.py test
```

The backend's `composer/tests.py` is currently a scaffold with no test cases, and the frontend has no automated test script. Lint/build checks do not verify media playback, recording permissions, or output quality. For manual verification, compose an image and a short video, add background audio, change dimensions, export, and inspect the downloaded video and audio. Repeat with a confirmed screen recording.

## Current limitations

- Project save/load and source-media persistence are not integrated into the editor.
- Basic text insertion is available, but editing text content/style is unfinished. Undo/redo stores composition snapshots, while the media library and timeline item list have separate state.
- The dimension picker permits values beyond the exporters' 3840-pixel cap. MP4 fallback and webcam recording fallback have the limitations described above.
- The backend uses development settings (`DEBUG=True`, a development secret, SQLite) and has no API access restrictions configured.
- Legacy media handling classifies files by extension. Temporary/output file cleanup and task retry policy are not implemented.