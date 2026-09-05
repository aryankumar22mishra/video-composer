import json
import math

from rest_framework import viewsets, status
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.response import Response

from .models import ComposeJob, Clip
from .serializers import ComposeJobSerializer
from .tasks import compose_job_task

# Upper bound for a single clip duration (seconds) — rejects absurd client
# values while leaving generous headroom for long screen recordings.
MAX_CLIP_DURATION = 1800  # 30 minutes


def parse_clip_durations(request, clip_count):
    """Parse the optional ``clip_durations`` form field.

    Expects a JSON array of per-clip durations in seconds, in the same
    order the clip files were submitted. When the field is absent the job
    falls back to the legacy ``image_duration`` behavior for every clip
    (backward compatible with older clients).

    Returns ``(clip_durations, error_response)``:
      - ``clip_durations`` is ``None`` when the field is absent.
      - ``error_response`` is a 400 Response for any malformed input
        (bad JSON, not a list, wrong length, non-numeric, NaN/Infinity,
        zero/negative, or unreasonably large values).
    """
    raw = request.data.get("clip_durations")
    if raw in (None, ""):
        return None, None

    if isinstance(raw, (list, tuple)):
        parsed = list(raw)
    else:
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return None, Response(
                {"detail": "clip_durations must be a JSON array of numbers."},
                status=status.HTTP_400_BAD_REQUEST,
            )

    if not isinstance(parsed, list):
        return None, Response(
            {"detail": "clip_durations must be a JSON array of numbers."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if len(parsed) != clip_count:
        return None, Response(
            {"detail": "clip_durations must contain exactly one duration per submitted clip."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    durations = []
    for value in parsed:
        # bool is an int subclass in Python — reject it explicitly.
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None, Response(
                {"detail": "clip_durations must contain only numbers."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not math.isfinite(value) or value <= 0:
            return None, Response(
                {"detail": "clip_durations must contain positive finite durations."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if value > MAX_CLIP_DURATION:
            return None, Response(
                {"detail": f"Each clip duration must be at most {MAX_CLIP_DURATION} seconds."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        durations.append(float(value))

    print(f"[Compose] clip_durations={durations}")
    return durations, None


class ComposeJobViewSet(viewsets.ModelViewSet):
    queryset = ComposeJob.objects.all().order_by("-created_at")
    serializer_class = ComposeJobSerializer
    parser_classes = [MultiPartParser, FormParser]
    http_method_names = ["get", "post", "delete"]

    def create(self, request, *args, **kwargs):
        clip_files = request.FILES.getlist("clips")
        audio_file = request.FILES.get("audio")
        image_duration = int(request.data.get("image_duration", 3))

        if not clip_files:
            return Response(
                {"detail": "At least one clip (video or image) is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        clip_durations, duration_error = parse_clip_durations(request, len(clip_files))
        if duration_error is not None:
            return duration_error

        job = ComposeJob.objects.create(
            audio=audio_file,
            image_duration=image_duration,
            status="pending",
        )

        for order, f in enumerate(clip_files):
            Clip.objects.create(job=job, file=f, order=order)

        compose_job_task.delay(str(job.id), clip_durations=clip_durations)

        serializer = self.get_serializer(job)
        return Response(serializer.data, status=status.HTTP_202_ACCEPTED)