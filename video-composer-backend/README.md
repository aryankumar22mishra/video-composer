# Video Composer — Backend

The backend is a **Django 4.2** application powered by **Django REST Framework** that exposes a REST API for creating and managing video composition jobs. Asynchronous processing is handled by **Celery** with **Redis** as the broker, and **FFmpeg** performs the actual video stitching.

## Requirements

- **Python** 3.12+
- **Redis** (running on `localhost:6379` by default)
- **FFmpeg** (installed and available on `PATH`)

## Setup

```bash
cd video-composer-backend

# Create & activate a virtual environment
python -m venv .venv
.venv\Scripts\activate      # Windows
# source .venv/bin/activate  # macOS / Linux

# Install dependencies
pip install -r requirements.txt

# Run database migrations
python manage.py migrate

# (Optional) Create a superuser for Django admin
python manage.py createsuperuser
```

## Run the project

You need **two terminals** — one for Django, one for Celery.

### Terminal 1 — Django dev server

```bash
cd video-composer-backend
.venv\Scripts\activate
python manage.py runserver
# → http://localhost:8000
```

### Terminal 2 — Celery worker

```bash
cd video-composer-backend
.venv\Scripts\activate
celery -A video_composer worker -l info
```

Make sure **Redis** is running before starting Celery.

## API endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/jobs/` | List all compose jobs |
| `POST` | `/api/jobs/` | Create a new compose job (multipart form) |
| `GET` | `/api/jobs/{id}/` | Retrieve job status & output URL |
| `DELETE` | `/api/jobs/{id}/` | Delete a job |
| `GET` | `/admin/` | Django admin interface (if superuser created) |

### POST `/api/jobs/` — form fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `clips` | File (multiple) | ✅ Yes | — | Image or video files to stitch |
| `audio` | File | ❌ No | — | Optional background audio track |
| `image_duration` | Integer | ❌ No | `3` | Seconds each image clip should display |

### Job statuses

`pending` → `processing` → `completed` / `failed`

The frontend polls the job endpoint every 2 seconds while the job is pending or processing.

## Project structure

```
video-composer-backend/
├── composer/                    # Main Django app
│   ├── migrations/              # DB schema migrations
│   ├── services/
│   │   ├── __init__.py
│   │   └── ffmpeg_service.py    # VideoComposerService (FFmpeg logic)
│   ├── admin.py                 # Django admin registration
│   ├── apps.py                  # App config
│   ├── models.py                # ComposeJob & Clip models
│   ├── serializers.py           # DRF serializers
│   ├── tasks.py                 # Celery task (compose_job_task)
│   ├── urls.py                  # API router (/api/jobs)
│   └── views.py                 # ComposeJobViewSet
├── media/                       # Uploaded & generated files
│   ├── uploads/                 # Raw uploads
│   ├── outputs/                 # Final rendered videos
│   └── tmp/                     # Temp working files
├── video_composer/              # Django project config
│   ├── __init__.py
│   ├── asgi.py
│   ├── celery.py                # Celery app setup
│   ├── settings.py              # Django settings
│   ├── urls.py                  # Root URL config
│   └── wsgi.py
├── db.sqlite3                   # SQLite database (created after migrate)
├── manage.py                    # Django CLI entry point
└── requirements.txt             # Python dependencies