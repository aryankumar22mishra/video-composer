from rest_framework import viewsets, status
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.response import Response

from .models import ComposeJob, Clip
from .serializers import ComposeJobSerializer
from .tasks import compose_job_task


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

        job = ComposeJob.objects.create(
            audio=audio_file,
            image_duration=image_duration,
            status="pending",
        )

        for order, f in enumerate(clip_files):
            Clip.objects.create(job=job, file=f, order=order)

        compose_job_task.delay(str(job.id))

        serializer = self.get_serializer(job)
        return Response(serializer.data, status=status.HTTP_202_ACCEPTED)