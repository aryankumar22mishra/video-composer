import os
import traceback

from celery import shared_task
from django.conf import settings

from .models import ComposeJob
from .services.ffmpeg_service import FFmpegError, VideoComposerService


@shared_task
def compose_job_task(job_id):
    try:
        job = ComposeJob.objects.get(id=job_id)
    except ComposeJob.DoesNotExist:
        return {
            "job_id": str(job_id),
            "status": "ignored",
            "error_message": "Compose job no longer exists.",
        }

    try:
        job.status = "processing"
        job.save(update_fields=["status", "updated_at"])

        if not job.clips.exists():
            raise ValueError("No clips were attached to this job.")

        work_dir = os.path.join(settings.MEDIA_ROOT, "tmp", str(job.id))
        service = VideoComposerService(work_dir=work_dir)

        clip_paths = [clip.file.path for clip in job.clips.all().order_by("order")]
        audio_path = job.audio.path if job.audio else None

        output_dir = os.path.join(settings.MEDIA_ROOT, "outputs", str(job.id))
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, "output.mp4")

        service.compose(
            clip_paths=clip_paths,
            audio_path=audio_path,
            output_path=output_path,
            image_duration=job.image_duration,
        )

        job.output_video.name = os.path.relpath(output_path, settings.MEDIA_ROOT)
        job.status = "completed"
        job.error_message = ""
        job.save(update_fields=["output_video", "status", "error_message", "updated_at"])

        return {
            "job_id": str(job.id),
            "output_video": job.output_video.name,
            "status": job.status,
        }

    except FFmpegError as exc:
        job.status = "failed"
        job.error_message = str(exc)
        job.save(update_fields=["status", "error_message", "updated_at"])
        return {
            "job_id": str(job.id),
            "status": "failed",
            "error_message": str(exc),
        }

    except ValueError as exc:
        job.status = "failed"
        job.error_message = str(exc)
        job.save(update_fields=["status", "error_message", "updated_at"])
        return {
            "job_id": str(job.id),
            "status": "failed",
            "error_message": str(exc),
        }

    except Exception:
        job.status = "failed"
        job.error_message = traceback.format_exc()[-2000:]
        job.save(update_fields=["status", "error_message", "updated_at"])
        raise
