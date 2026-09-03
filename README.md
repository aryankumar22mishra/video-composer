# Video Composer

A local video composition application with a Django REST backend and a React frontend.
Users upload images or videos, optionally add audio, and start a background render job. FFmpeg creates the final MP4 video.

## Project Structure

```text
new project/
|-- README.md
|-- video-composer-backend/
|   |-- manage.py
|   |-- composer/
|   |-- video_composer/
|   |-- media/
|   |-- venv/
|-- video-composer-frontend/
    |-- src/
    |-- package.json
    |-- vite.config.js
```

## Technology

- Django 4.2
- Django REST Framework
- Celery 5.4
- Redis
- FFmpeg
- React with Vite
- SQLite for local development

## Requirements

Install or configure these tools before running the project:

- Python
- Node.js and npm
- Redis server
- FFmpeg

The Python dependencies are listed in:

```text
video-composer-backend/requirements.txt
```

## Backend Setup

Open a terminal and run:

```powershell
cd "C:\new project\video-composer-backend"
.\venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python manage.py migrate
```

## Run Redis

Open another terminal:

```powershell
cd "C:\new project\video-composer-backend"
& "C:\Program Files\Redis\redis-server.exe" "C:\Program Files\Redis\redis.windows.conf"
```

If Redis reports that port `6379` is already in use, Redis is already running. Do not start a second Redis process.

## Run Django

Open another terminal:

```powershell
cd "C:\new project\video-composer-backend"
.\venv\Scripts\Activate.ps1
python manage.py runserver
```

The backend API will be available at:

```text
http://127.0.0.1:8000/
```

## Run Celery

Open another terminal:

```powershell
cd "C:\new project\video-composer-backend"
.\venv\Scripts\Activate.ps1
python -m celery -A video_composer worker -l info --pool=solo
```

The `--pool=solo` option is important on Windows. It avoids the permission errors that can occur with Celery's default worker pool.

A successful worker startup includes:

```text
Connected to redis://localhost:6379/0
celery@... ready.
```

## Run the Frontend

Open another terminal:

```powershell
cd "C:\new project\video-composer-frontend"
$env:Path = "C:\Program Files\nodejs;" + $env:Path
& "C:\Program Files\nodejs\node.exe" .\node_modules\vite\bin\vite.js
```

Open the URL shown by Vite, usually:

```text
http://localhost:5173/
```

If port `5173` is busy, Vite may use `5174` instead.

## Using the Application

1. Open the frontend URL.
2. Select one or more image or video clips.
3. Optionally select an audio file.
4. Set the image duration in seconds.
5. Click `Compose video`.
6. Watch the job status change from `pending` to `processing`.
7. When the job is complete, play the generated video in the result panel.

## API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/jobs/` | List jobs |
| POST | `/api/jobs/` | Upload clips and create a render job |
| GET | `/api/jobs/<id>/` | Read one job and its status |
| DELETE | `/api/jobs/<id>/` | Delete a job |

The upload endpoint returns `202 Accepted` because the video is rendered asynchronously.

## Job Statuses

```text
pending -> processing -> completed
                         or failed
```

- `pending`: the job is waiting for Celery.
- `processing`: the worker is running FFmpeg.
- `completed`: the output video was created.
- `failed`: the render failed and the error is saved on the job.

## Frontend Development

Install frontend dependencies:

```powershell
cd "C:\new project\video-composer-frontend"
& "C:\Program Files\nodejs\npm.cmd" install
```

Build the frontend:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run build
```

Run lint:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run lint
```

The Vite development proxy forwards these paths to Django:

- `/api` -> `http://localhost:8000`
- `/media` -> `http://localhost:8000`

## Backend Validation

Run Django's system check:

```powershell
cd "C:\new project\video-composer-backend"
.\venv\Scripts\Activate.ps1
python manage.py check
```

## Common Problems

### The API shows JSON instead of the UI

Use the frontend root URL:

```text
http://localhost:5173/
```

The following URL is an API and intentionally returns JSON:

```text
http://localhost:5173/api/jobs/
```

### Redis port is already in use

This usually means Redis is already running on port `6379`. Leave the existing Redis process running and start only Celery.

### Jobs remain pending

Check that Redis and Celery are both running. Start Celery with:

```powershell
python -m celery -A video_composer worker -l info --pool=solo
```

### FFmpeg image render fails

Supported image formats include JPG, JPEG, PNG, BMP, WEBP, and AVIF. The backend converts still images into video clips using the selected image duration.

## Media Files

Uploaded files are stored under:

```text
video-composer-backend/media/uploads/
```

Rendered videos are stored under:

```text
video-composer-backend/media/outputs/
```

Temporary FFmpeg files are stored under:

```text
video-composer-backend/media/tmp/
```
