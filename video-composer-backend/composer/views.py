import json
import math

from rest_framework import viewsets, status
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ComposeJob, Clip, Project
from .serializers import ComposeJobSerializer, ProjectSerializer
from .tasks import compose_job_task
from .ai_agent import (
    ProviderConfigurationError,
    ProviderRequestError,
    ProviderResponseError,
    request_editing_actions,
)

# Upper bound for a single clip duration (seconds) — rejects absurd client
# values while leaving generous headroom for long screen recordings.
MAX_CLIP_DURATION = 1800  # 30 minutes


class AIAgentView(APIView):
    """Translate an editing request into a small, validated action list.

    Source media stays in the browser; only composition metadata and asset
    descriptors are sent to the provider.
    """

    def post(self, request, *args, **kwargs):
        prompt = str(request.data.get("prompt") or "").strip()
        if not prompt:
            return Response({"detail": "prompt is required."}, status=status.HTTP_400_BAD_REQUEST)
        composition = request.data.get("composition") or {}
        if not isinstance(composition, dict):
            return Response({"detail": "composition must be an object."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            result = request_editing_actions(
                prompt,
                composition,
                request.data.get("selected_clip"),
                request.data.get("assets") or [],
                history=request.data.get("history"),
                pending_clarification=request.data.get("pending_clarification"),
                last_edited_target=request.data.get("last_edited_target"),
                recording_state=request.data.get("recording_state", "idle"),
            )
        except ProviderConfigurationError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except (ProviderRequestError, ProviderResponseError) as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        except Exception:
            return Response({"detail": "AI Agent request failed."}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(result)


class ProjectViewSet(viewsets.ModelViewSet):
    """Save / load client-rendered projects (no Celery/FFmpeg involved).

    POST/PUT accept ``name`` + ``composition`` (JSON object matching the
    frontend's composition model) and optionally ``export_file`` (the
    browser-rendered MP4/WebM to host for download/sharing).
    """

    queryset = Project.objects.all().order_by("-updated_at")
    serializer_class = ProjectSerializer
    parser_classes = [MultiPartParser, FormParser]
    http_method_names = ["get", "post", "put", "patch", "delete"]

    def _composition_from_request(self):
        raw = self.request.data.get("composition")
        if raw in (None, ""):
            return {}
        if isinstance(raw, dict):
            return raw
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) else None

    def _save_project(self, project):
        composition = self._composition_from_request()
        if composition is None:
            return Response(
                {"detail": "composition must be a JSON object."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if "name" in self.request.data:
            project.name = self.request.data.get("name") or project.name
        if "composition" in self.request.data:
            project.composition = composition
        export_file = self.request.FILES.get("export_file")
        if export_file is not None:
            project.export_file = export_file
        project.save()
        return Response(self.get_serializer(project).data)

    def create(self, request, *args, **kwargs):
        return self._save_project(Project())

    def update(self, request, *args, **kwargs):
        return self._save_project(self.get_object())

    def partial_update(self, request, *args, **kwargs):
        return self._save_project(self.get_object())


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
    """Legacy server-side compose queue (kept intact as a fallback).

    Used only by the old server-render path; the client-side export sends
    no requests here. POST accepts clips+audio and dispatches a Celery task.
    """

    queryset = ComposeJob.objects.all().order_by("-created_at")
    serializer_class = ComposeJobSerializer
    parser_classes = [MultiPartParser, FormParser]
    http_method_names = ["get", "post", "delete"]

    def create(self, request, *args, **kwargs):
        clip_files = request.FILES.getlist("clips")
        audio_file = request.FILES.get("audio")

        # Guard against non-integer image_duration with a 400 instead of
        # letting int() raise a 500 for a client-controlled value.
        raw_image_duration = request.data.get("image_duration", 3)
        try:
            image_duration = int(raw_image_duration)
        except (TypeError, ValueError):
            return Response(
                {"detail": "image_duration must be an integer."},
                status=status.HTTP_400_BAD_REQUEST,
            )

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

        # Resolution / aspect-ratio controls from the dimension panel.
        raw_width = request.data.get("width")
        raw_height = request.data.get("height")
        raw_aspect = request.data.get("aspect_ratio", "auto")
        raw_fit = request.data.get("fit_mode", "pad")

        try:
            if raw_width not in (None, ""):
                job.output_width = int(raw_width)
            if raw_height not in (None, ""):
                job.output_height = int(raw_height)
        except (TypeError, ValueError):
            return Response(
                {"detail": "width and height must be integers."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # H.264 encoder requires even (divisible by 2) width and height.
        if (
            job.output_width is not None
            and job.output_height is not None
            and (
                job.output_width % 2 != 0
                or job.output_height % 2 != 0
            )
        ):
            return Response(
                {"detail": "width and height must both be even numbers "
                 "(H.264 requirement)."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if raw_aspect not in ("auto", "16:9", "9:16", "1:1", "4:3", "3:4", "custom"):
            return Response(
                {"detail": "aspect_ratio must be one of: "
                 "auto, 16:9, 9:16, 1:1, 4:3, 3:4, custom."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if raw_fit not in ("pad", "crop"):
            return Response(
                {"detail": "fit_mode must be 'pad' or 'crop'."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        job.aspect_ratio = raw_aspect
        job.fit_mode = raw_fit
        job.save(update_fields=["output_width", "output_height",
                                "aspect_ratio", "fit_mode"])

        compose_job_task.delay(str(job.id), clip_durations=clip_durations)

        serializer = self.get_serializer(job)
        return Response(serializer.data, status=status.HTTP_202_ACCEPTED)