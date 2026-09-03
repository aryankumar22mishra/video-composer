from rest_framework import serializers
from .models import ComposeJob, Clip


class ClipSerializer(serializers.ModelSerializer):
    class Meta:
        model = Clip
        fields = ["id", "file", "order"]


class ComposeJobSerializer(serializers.ModelSerializer):
    clips = ClipSerializer(many=True, read_only=True)

    class Meta:
        model = ComposeJob
        fields = [
            "id", "status", "audio", "image_duration",
            "output_video", "error_message", "clips",
            "created_at", "updated_at",
        ]
        read_only_fields = ["status", "output_video", "error_message"]