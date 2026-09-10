import uuid
from django.db import models


def clip_upload_path(instance, filename):
    return f"uploads/{instance.job.id}/clips/{filename}"


def audio_upload_path(instance, filename):
    return f"uploads/{instance.id}/audio/{filename}"


def project_export_path(instance, filename):
    return f"projects/{instance.id}/exports/{filename}"


class Project(models.Model):
    """A saved client-side composition.

    The browser renders and exports the video itself (Canvas/WebCodecs);
    the backend only persists the editable project (composition JSON) and
    optionally hosts the exported file for download/sharing. No Celery
    task, Redis queue, or FFmpeg step is involved in this path — the
    legacy ComposeJob/Clip pipeline stays intact but unused by it.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200, default="Untitled project")
    composition = models.JSONField(default=dict, blank=True)
    export_file = models.FileField(upload_to=project_export_path, blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"Project {self.name} ({self.id})"


class ComposeJob(models.Model):
    STATUS_CHOICES = [
        ("pending", "Pending"),
        ("processing", "Processing"),
        ("completed", "Completed"),
        ("failed", "Failed"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="pending")
    audio = models.FileField(upload_to=audio_upload_path, blank=True, null=True)
    image_duration = models.PositiveIntegerField(default=3)
    output_video = models.FileField(upload_to="outputs/", blank=True, null=True)
    error_message = models.TextField(blank=True, null=True)
    # Output resolution / aspect-ratio controls (client-side dimension panel).
    # null/None = preserve source (legacy "1280x720" default below).
    output_width = models.PositiveIntegerField(blank=True, null=True)
    output_height = models.PositiveIntegerField(blank=True, null=True)
    # 'auto' = preserve each source's native aspect ratio; otherwise a
    # preset label such as '16:9', '9:16', '1:1', '4:3', '3:4' or 'custom'.
    aspect_ratio = models.CharField(max_length=20, default="auto")
    # How to fit the source into the target box: 'pad' = fit+letterbox onto a
    # solid background (matches the previous 1280x720 behaviour); 'crop' =
    # scale-and-crop-fill. Defaults to 'pad' to stay backward compatible.
    fit_mode = models.CharField(max_length=10, default="pad")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"ComposeJob {self.id} ({self.status})"


class Clip(models.Model):
    job = models.ForeignKey(ComposeJob, related_name="clips", on_delete=models.CASCADE)
    file = models.FileField(upload_to=clip_upload_path)
    order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["order"]

    def __str__(self):
        return f"Clip {self.file.name} (job={self.job_id}, order={self.order})"