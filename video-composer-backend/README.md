# Video Composer — Django backend

This repository combines a browser-based video editor with a lightweight Django backend. The app is centered around React and the HTML5 Canvas renderer in the frontend; the backend mainly provides AI orchestration, optional project metadata APIs, and the legacy FFmpeg render queue.

## Project overview

The current editor runs primarily in the browser:

- media uploads, timeline state, export, screen recording, and preview are handled in the frontend
- AI actions are sent to the backend as structured editing commands
- media files and composition state stay in browser memory unless a project API is used
- the backend never needs to receive the raw source media for AI edits

This keeps the editing flow fast, local, and compatible with browser-based export without requiring a heavy server render pipeline for normal use.

## What needs to run?

| Workflow | Required processes |
| --- | --- |
| Upload, record, edit, preview, export and download | Frontend only |
| Editor with AI Agent | Frontend + Django, with AI credentials configured |
| Project storage API | Django; save/load is not connected to the editor UI |
| Legacy server rendering through `/api/jobs/` | Django + Redis + Celery + FFmpeg |

Normal export runs in the browser; the Export button does not submit a server
render job. Files and edits remain in browser memory, so download your result
before refreshing or closing the page.

## Requirements

- Node.js 22.12 or newer and npm for the frontend.
- Python 3.12+ for the backend.
- A browser supporting Canvas, Web Audio and MediaRecorder. Fast export also uses
  WebCodecs when supported. Recording requires browser capture permissions.
- Redis and FFmpeg only if you use the legacy server-rendering API.

The following commands use Windows PowerShell and the checkout at `C:\new project`.
Replace that path if you cloned the project elsewhere. Each terminal block starts
with an absolute path, so it can be run from any working directory.

## One-time setup

### 1. Install frontend dependencies

```powershell
Set-Location 'C:\new project\video-composer-frontend'
node --version
npm --version
npm ci
```

For normal recording, editing and downloading, this is the only setup required.
Start the frontend using the development instructions below.

### 2. Set up the backend (for AI or backend APIs)

```powershell
Set-Location 'C:\new project\video-composer-backend'
python --version
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
}
.\.venv\Scripts\python.exe manage.py migrate
```

This creates a backend-local virtual environment and initializes the SQLite
schema, including agent operation receipts. The copy command preserves an existing
`.env`. These instructions invoke the environment's Python directly, so PowerShell
activation-script permissions are not required.

For AI features, edit `video-composer-backend/.env` with your provider, model and
API key as explained below. Normal browser editing does not need an API key.
Restart Django after changing environment settings. Separate media-generation
services are optional; their configuration is in [AGENT_PLANNER.md](AGENT_PLANNER.md).

## Run the project in development

### Terminal 1: frontend

```powershell
Set-Location 'C:\new project\video-composer-frontend'
npm run dev
```

Open the URL printed by Vite, normally **http://localhost:5173**. Leave this terminal
running. This alone enables uploading, recording, editing, previewing and downloading.

### Terminal 2: Django (when using AI or backend APIs)

```powershell
Set-Location 'C:\new project\video-composer-backend'
.\.venv\Scripts\python.exe manage.py runserver
```

Django runs at **http://localhost:8000**. Open the editor through Vite, not port 8000.
Vite forwards `/api` and `/media` requests to Django. You can check the backend at
**http://localhost:8000/api/ai/tools/**, which lists tool availability without calling
an AI provider.

Press **Ctrl+C** in each terminal to stop its process. On future runs, use these
terminal commands again; you do not need to recreate the virtual environment.
After pulling changes, run `npm ci` if frontend dependencies changed, reinstall
backend requirements if needed, and run `manage.py migrate` for new migrations.

### Try the normal editor workflow

1. Open **My media > Upload** and select images or videos. Add optional background audio.
2. Click a media card to add it to the timeline, then edit and preview your composition.
3. To record, choose **Record**, select your sources, share a screen and allow the
   browser permissions. Stop, review, and choose **Use Recording**; then add it to the timeline.
4. Choose **Export**, wait for rendering, and download the result as MP4 or WebM.
   Keep the tab visible during the real-time export fallback.

### Optional: legacy server rendering

Only use this section if you call `/api/jobs/` directly. The current browser Export
button does not require these services.

1. Install FFmpeg and add its executable directory to PATH. Verify `ffmpeg -version`.
2. In VS Code, open **Terminal > New Terminal** and start your locally installed
   Redis server on port 6379, matching the broker URL in `.env`:

   ```powershell
   redis-server --bind 127.0.0.1 --port 6379
   ```

   This command assumes Redis is installed and its executable directory is on PATH.
   If it is not on PATH, open a terminal in your Redis installation directory and
   run `.\redis-server.exe --bind 127.0.0.1 --port 6379` instead. If your Redis
   installation is inside WSL, select the WSL terminal profile in VS Code and run
   `redis-server --bind 127.0.0.1 --port 6379` there.

   Leave the Redis terminal running while processing jobs. In another terminal
   using the same environment, verify Redis is responding:

   ```powershell
   redis-cli -h 127.0.0.1 -p 6379 ping
   ```

   The expected response is `PONG`. Use `.\redis-cli.exe` from the Redis installation
   directory if it is not on PATH. If Redis is already running, just verify it with
   this command; you do not need to start a second server.
3. Keep Django running and start a Celery worker in another PowerShell terminal:

   ```powershell
   Set-Location 'C:\new project\video-composer-backend'
   .\.venv\Scripts\Activate.ps1
   python -m celery -A video_composer worker -l info --pool=solo
   ```

   If your terminal already shows `(.venv)`, skip activation and run the complete
   `python -m celery` command above. Do not start the command with `-m` alone.

   `--pool=solo` is used for the Windows development worker. FFmpeg must be available
   on the worker's PATH. Django accepts the job, Redis queues it, Celery runs FFmpeg,
   and the completed output is served through `/media/`.

## Checks and troubleshooting

Frontend checks:

```powershell
Set-Location 'C:\new project\video-composer-frontend'
npm test
npm run lint
npm run build
npm run preview
```

`npm run preview` serves the production build for checking browser editing/export;
use `npm run dev` for the documented Django API proxy and full AI development flow.

Backend checks:

```powershell
Set-Location 'C:\new project\video-composer-backend'
.\.venv\Scripts\python.exe manage.py check
.\.venv\Scripts\python.exe manage.py test
```

| Symptom | What to check |
| --- | --- |
| `node`, `npm` or `python` is not recognized | Install the required runtime, then reopen the terminal so PATH updates take effect. |
| Missing Python packages | Run the requirements install with the same `.venv\Scripts\python.exe` used to start Django. |
| Missing database table | Run `.\.venv\Scripts\python.exe manage.py migrate` from the backend directory. |
| AI backend cannot be reached | Start Django on port 8000 and open the editor through the Vite development server. |
| AI provider not configured or rejects requests | Check provider, model, URL and key in `.env`, then restart Django. |
| AI provider returns HTTP 413 | The provider rejected an oversized planning request. Restart Django after updating to use the compact, single-copy tool registry. If it persists, try a smaller composition or a model/account with a higher input limit; changing the API key alone does not reduce request size. |
| Recording fails | Use localhost, allow screen/microphone/camera access, and check whether your browser supports the selected capture source. |
| Legacy render job stays pending | Verify Redis is running and the Celery worker uses the same broker URL as Django. |
| Legacy job reports missing FFmpeg | Add FFmpeg to PATH and restart the worker terminal. |

## Environment configuration

The project loads environment variables from `video-composer-backend/.env` using `python-dotenv`. This is the main place for AI and backend settings.

Example values:

```env
DJANGO_SECRET_KEY=replace-with-a-long-random-secret
DJANGO_DEBUG=true
DJANGO_ALLOWED_HOSTS=127.0.0.1,localhost

AI_PROVIDER=google
AI_MODEL=gemini-2.5-flash
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
AI_API_KEY=your-google-ai-studio-key
AI_EXTRA_TOOLS=open_recording_setup,stop_recording,open_media_upload

CELERY_BROKER_URL=redis://localhost:6379/0
CELERY_RESULT_BACKEND=redis://localhost:6379/0

DATA_UPLOAD_MAX_MEMORY_SIZE=209715200
FILE_UPLOAD_MAX_MEMORY_SIZE=209715200
```

Notes:

- `AI_PROVIDER` supports `google` and `openai`-style providers
- `AI_BASE_URL` is optional for Google AI Studio, but required for OpenAI-compatible providers such as Groq
- `AI_API_KEY` is the main key used by the backend, while some providers may also use `GROQ_API_KEY`
- `.env` is git-ignored; do not commit real secrets

### Example: Groq / OpenAI-compatible provider

```env
AI_PROVIDER=openai
AI_MODEL=openai/gpt-oss-20b
AI_BASE_URL=https://api.groq.com/openai/v1
AI_API_KEY=your-groq-api-key
```

## AI Agent

The current editor uses a registry-driven planner and staged browser executor.
See [AGENT_PLANNER.md](AGENT_PLANNER.md) for architecture, service gateway
configuration, approval behavior, limits and tests. Run `python manage.py migrate`
after updating to add durable media-operation receipts.


The React app calls `POST /api/ai/plan/` with natural-language goals and actual tool results from preceding execution rounds. The legacy `POST /api/ai/` endpoint remains available for older callers. The request includes:

- the prompt from the user
- current composition metadata
- clip selection / timeline context
- available asset descriptors

The backend validates the provider response and only returns a safe allowlist of supported frontend actions, including:

- trim
- split
- reorder
- text edits
- speed
- volume
- dimensions
- grayscale
- keep_clip_range
- remove_clip_range
- UI control actions such as `open_media_upload`, `open_recording_setup`, and `stop_recording`

The frontend then applies the returned actions atomically to the composition state, preserving the browser preview, export pipeline, timeline state, and undo history.

The app does not send raw uploaded media files to the AI provider. Only metadata and prompt context are transmitted.

## API endpoints

### Core app endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/ai/tools/` | Tool registry and configured availability |
| `POST` | `/api/ai/plan/` | Plan the next supported tool calls |
| `POST` | `/api/ai/` | Ask the AI agent for editing actions |
| `GET` | `/admin/` | Django admin |

### Legacy render queue

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/jobs/` | List composed jobs |
| `POST` | `/api/jobs/` | Upload clips and queue a render |
| `GET` | `/api/jobs/{id}/` | Read job status and output |
| `DELETE` | `/api/jobs/{id}/` | Delete a job |

The legacy queue still exists for compatibility with the original FFmpeg-based flow, but the main editor now prefers client-side rendering and AI-generated editing actions.

## Project structure

```text
video-composer-backend/
├── composer/
│   ├── ai_agent.py              # AI provider integration and response validation
│   ├── admin.py                 # Django admin registration
│   ├── apps.py
│   ├── models.py                # Legacy backend models
│   ├── serializers.py
│   ├── tasks.py                 # Celery tasks
│   ├── urls.py                 # API routes
│   ├── views.py                # API view logic
│   └── services/
│       └── ffmpeg_service.py   # Legacy FFmpeg-based render pipeline
├── media/
│   ├── uploads/
│   ├── outputs/
│   └── tmp/
├── video_composer/
│   ├── __init__.py
│   ├── asgi.py
│   ├── celery.py
│   ├── settings.py             # Django settings, env config, Celery broker settings
│   ├── urls.py
│   └── wsgi.py
├── .env.example                # Safe example environment template
├── .env                        # Local secrets; git-ignored
├── db.sqlite3
├── manage.py
├── requirements.txt
└── README.md
```

## Notes for contributors

- prefer editing `.env.example` when adding new environment variables
- keep provider keys and secrets out of version control
- the browser editor is the primary path for composition work; backend job processing remains optional/legacy
- when changing AI tool support, update both the backend allowlist and the frontend command layer together

## Useful links

- Frontend app: `video-composer-frontend/`
- Browser editor entry: `video-composer-frontend/src/App.jsx`
- Shared editing command layer: `video-composer-frontend/src/state/editingCommands.js`
- AI orchestration backend: `video-composer-backend/composer/ai_agent.py`
- Django settings: `video-composer-backend/video_composer/settings.py`
