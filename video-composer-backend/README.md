# Video Composer — Django backend

This repository combines a browser-based video editor with a lightweight Django backend. The app is centered around React and the HTML5 Canvas renderer in the frontend; the backend mainly provides AI orchestration, optional project metadata APIs, and the legacy FFmpeg render queue.

## Project overview

The current editor runs primarily in the browser:

- media uploads, timeline state, export, screen recording, and preview are handled in the frontend
- AI actions are sent to the backend as structured editing commands
- media files and composition state stay in browser memory unless a project API is used
- the backend never needs to receive the raw source media for AI edits

This keeps the editing flow fast, local, and compatible with browser-based export without requiring a heavy server render pipeline for normal use.

## Requirements

- Python 3.12+
- Node.js 20+ / npm for the frontend
- Redis for Celery when using the legacy render job flow
- FFmpeg for the backend render queue and optional job processing

## Quick start

### 1) Backend environment

```powershell
cd video-composer-backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python manage.py migrate
```

Copy `.env.example` to `.env`, then fill in values before starting the server.

### 2) Frontend environment

```powershell
cd video-composer-frontend
npm install
npm run dev
```

Open the local Vite URL, usually `http://localhost:5173`.

### 3) Run the backend API

```powershell
cd video-composer-backend
.\.venv\Scripts\Activate.ps1
python manage.py runserver
```

The Django app runs on `http://localhost:8000`.

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

## Run the project in development

You need two terminals for the full stack:

### Terminal 1 — Django

```powershell
cd video-composer-backend
.\.venv\Scripts\Activate.ps1
python manage.py runserver
```

### Terminal 2 — Celery

```powershell
cd video-composer-backend
.\.venv\Scripts\Activate.ps1
celery -A video_composer worker -l info
```

Make sure Redis is running before starting Celery.

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