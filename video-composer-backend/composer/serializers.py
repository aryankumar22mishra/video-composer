from rest_framework import serializers
from .models import ComposeJob, Clip, Project


class ProjectSerializer(serializers.ModelSerializer):
    class Meta:
        model = Project
        fields = [
            "id", "name", "composition", "export_file",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    def validate_composition(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("composition must be a JSON object.")
        return value


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
            "output_video", "error_message",
            "output_width", "output_height", "aspect_ratio", "fit_mode",
            "clips",
            "created_at", "updated_at",
        ]
        read_only_fields = ["status", "output_video", "error_message"]

    def validate(self, attrs):
        """Validate output dimensions and aspect-ratio / fit-mode combo."""
        width = attrs.get("output_width")
        height = attrs.get("output_height")
        aspect = attrs.get("aspect_ratio", "auto")
        fit = attrs.get("fit_mode", "pad")

        if width is not None or height is not None:
            if width is None or height is None:
                raise serializers.ValidationError(
                    "output_width and output_height must both be provided when "
                    "setting a custom resolution."
                )
            # H.264 requires even dimensions for both width and height.
            if width % 2 != 0:
                raise serializers.ValidationError(
                    f"output_width ({width}) must be an even number "
                    "(H.264 requirement)."
                )
            if height % 2 != 0:
                raise serializers.ValidationError(
                    f"output_height ({height}) must be an even number "
                    "(H.264 requirement)."
                )
            if width < 2 or height < 2:
                raise serializers.ValidationError(
                    "output_width and output_height must each be >= 2."
                )

        if aspect not in ("auto", "16:9", "9:16", "1:1", "4:3", "3:4", "custom"):
            raise serializers.ValidationError(
                f"aspect_ratio '{aspect}' is not supported."
            )

        if fit not in ("pad", "crop"):
            raise serializers.ValidationError(
                f"fit_mode '{fit}' is not supported (must be 'pad' or 'crop')."
            )

        return attrs