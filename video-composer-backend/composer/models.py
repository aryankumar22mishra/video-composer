import uuid
from django.db import models


def clip_upload_path(instance, filename):
    return f"uploads/{instance.job.id}/clips/{filename}"


def audio_upload_path(instance, filename):
    return f"uploads/{instance.id}/audio/{filename}"


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