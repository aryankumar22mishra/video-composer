import os
import subprocess
import uuid


IMAGE_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".bmp",
    ".webp",
    ".avif",
}

VIDEO_EXTENSIONS = {
    ".mp4",
    ".mov",
    ".avi",
    ".mkv",
    ".webm",
}


class FFmpegError(Exception):
    pass


class VideoComposerService:
    """
    Combines uploaded video/image clips + optional audio using FFmpeg.

    Each clip is normalized to:
        - requested duration
        - 1280x720 resolution
        - 30 FPS
        - H.264 video
        - yuv420p pixel format
        - no audio

    Then all normalized clips are concatenated.
    """

    def __init__(self, work_dir):
        self.work_dir = work_dir
        os.makedirs(self.work_dir, exist_ok=True)

    # ---------------------------------------------------------
    # Run FFmpeg
    # ---------------------------------------------------------

    def _run(self, cmd):
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            raise FFmpegError(
                f"FFmpeg command failed:\n"
                f"{' '.join(cmd)}\n\n"
                f"{result.stderr[-4000:]}"
            )

        return result

    # ---------------------------------------------------------
    # Normalize image format (handles AVIF/WEBP/HEIC etc.)
    # ---------------------------------------------------------

    def _normalize_image_format(self, image_path):
        """
        FFmpeg's -loop option only works reliably with formats handled
        by its image2 demuxer (JPG, PNG, BMP). Newer formats like AVIF
        are not recognized there, so convert them to PNG first.
        """
        ext = os.path.splitext(image_path)[1].lower()

        if ext in {".jpg", ".jpeg", ".png", ".bmp"}:
            return image_path  # already a format -loop handles directly

        normalized_path = os.path.join(
            self.work_dir,
            f"{uuid.uuid4().hex}.png",
        )

        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            image_path,
            normalized_path,
        ]

        self._run(cmd)

        return normalized_path

    # ---------------------------------------------------------
    # Convert image to video
    # ---------------------------------------------------------

    def _image_to_clip(
        self,
        image_path,
        duration,
        resolution="1280x720",
    ):
        # Convert AVIF/WEBP/HEIC etc. to PNG first, since -loop
        # doesn't recognize those formats directly.
        normalized_image_path = self._normalize_image_format(image_path)

        clip_path = os.path.join(
            self.work_dir,
            f"{uuid.uuid4().hex}.mp4",
        )

        # Convert "1280x720" into:
        # width = 1280
        # height = 720
        width, height = resolution.split("x")

        video_filter = (
            f"scale={width}:{height}:"
            f"force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:"
            f"(ow-iw)/2:(oh-ih)/2"
        )

        cmd = [
            "ffmpeg",
            "-y",

            # Loop the image
            "-loop",
            "1",

            "-i",
            normalized_image_path,

            # Exact duration
            "-t",
            str(duration),

            # Scale + pad
            "-vf",
            video_filter,

            # FPS
            "-r",
            "30",

            # Video codec
            "-c:v",
            "libx264",

            # Pixel format
            "-pix_fmt",
            "yuv420p",

            # Reset timestamps
            "-start_at_zero",

            clip_path,
        ]

        self._run(cmd)

        return clip_path

    # ---------------------------------------------------------
    # Normalize video
    # ---------------------------------------------------------

    def _normalize_clip(
        self,
        video_path,
        duration,
        resolution="1280x720",
    ):
        """
        Normalize a video into the same format used by images.

        Every video is limited to the requested duration.
        """

        clip_path = os.path.join(
            self.work_dir,
            f"{uuid.uuid4().hex}.mp4",
        )

        width, height = resolution.split("x")

        video_filter = (
            f"scale={width}:{height}:"
            f"force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:"
            f"(ow-iw)/2:(oh-ih)/2"
        )

        cmd = [
            "ffmpeg",
            "-y",

            "-i",
            video_path,

            # Limit video to requested duration
            "-t",
            str(duration),

            # Scale + pad
            "-vf",
            video_filter,

            # Normalize FPS
            "-r",
            "30",

            # Normalize codec
            "-c:v",
            "libx264",

            # Pixel format
            "-pix_fmt",
            "yuv420p",

            # Remove audio
            "-an",

            # Reset timestamps
            "-start_at_zero",

            clip_path,
        ]

        self._run(cmd)

        return clip_path

    # ---------------------------------------------------------
    # Prepare segments
    # ---------------------------------------------------------

    def _prepare_segments(
        self,
        clip_paths,
        image_duration,
        clip_durations=None,
    ):
        """Normalize every clip into a uniform segment.

        ``clip_durations`` optionally carries one duration per clip (same
        order as ``clip_paths``). Images always use ``image_duration``;
        videos use their per-clip duration when available and fall back to
        ``image_duration`` only for legacy callers that did not send
        ``clip_durations``.
        """
        segments = []

        for index, path in enumerate(clip_paths):

            if not os.path.exists(path):
                raise FFmpegError(
                    f"Input file does not exist: {path}"
                )

            ext = os.path.splitext(path)[1].lower()

            # -------------------------
            # Image
            # -------------------------

            if ext in IMAGE_EXTENSIONS:

                segment = self._image_to_clip(
                    path,
                    image_duration,
                )

                segments.append(segment)

            # -------------------------
            # Video
            # -------------------------

            elif ext in VIDEO_EXTENSIONS:

                video_duration = image_duration
                if clip_durations and index < len(clip_durations):
                    requested = clip_durations[index]
                    if isinstance(requested, (int, float)) and requested > 0:
                        video_duration = requested

                print(f"[Compose] clip {index + 1} video duration={video_duration}")

                segment = self._normalize_clip(
                    path,
                    video_duration,
                )

                segments.append(segment)

            # -------------------------
            # Unsupported
            # -------------------------

            else:
                raise FFmpegError(
                    f"Unsupported file type: {ext}"
                )

        if not segments:
            raise FFmpegError(
                "No valid clips were provided."
            )

        return segments

    # ---------------------------------------------------------
    # Concatenate segments
    # ---------------------------------------------------------

    def _concat_segments(self, segments):

        if not segments:
            raise FFmpegError(
                "No segments available for concatenation."
            )

        list_file = os.path.join(
            self.work_dir,
            f"{uuid.uuid4().hex}.txt",
        )

        with open(
            list_file,
            "w",
            encoding="utf-8",
        ) as f:

            for segment in segments:

                if not os.path.exists(segment):
                    raise FFmpegError(
                        f"Segment does not exist: {segment}"
                    )

                segment_path = os.path.abspath(
                    segment
                ).replace("\\", "/")

                f.write(
                    f"file '{segment_path}'\n"
                )

        concatenated = os.path.join(
            self.work_dir,
            f"{uuid.uuid4().hex}.mp4",
        )

        cmd = [
            "ffmpeg",
            "-y",

            "-f",
            "concat",

            "-safe",
            "0",

            "-i",
            list_file,

            "-c",
            "copy",

            concatenated,
        ]

        self._run(cmd)

        # Remove temporary concat list
        try:
            os.remove(list_file)
        except OSError:
            pass

        return concatenated

    # ---------------------------------------------------------
    # Add audio
    # ---------------------------------------------------------

    def _add_audio(
        self,
        video_path,
        audio_path,
        output_path,
    ):
        if not os.path.exists(video_path):
            raise FFmpegError(
                f"Video does not exist: {video_path}"
            )

        if not os.path.exists(audio_path):
            raise FFmpegError(
                f"Audio does not exist: {audio_path}"
            )

        cmd = [
            "ffmpeg",
            "-y",

            # Video input
            "-i",
            video_path,

            # Audio input
            "-i",
            audio_path,

            # Select video
            "-map",
            "0:v:0",

            # Select audio
            "-map",
            "1:a:0",

            # Copy video
            "-c:v",
            "copy",

            # Encode audio
            "-c:a",
            "aac",

            # Stop when shortest input ends
            "-shortest",

            output_path,
        ]

        self._run(cmd)

    # ---------------------------------------------------------
    # Compose
    # ---------------------------------------------------------

    def compose(
        self,
        clip_paths,
        audio_path,
        output_path,
        image_duration=3,
        clip_durations=None,
    ):
        """
        Compose images/videos into one video.

        Example:

            3 clips × 3 seconds = 9 seconds

        Images are normalized to ``image_duration``. Videos use their
        per-clip duration from ``clip_durations`` (same order as
        ``clip_paths``) when provided; when ``clip_durations`` is None
        (legacy callers), videos fall back to ``image_duration``.
        """

        if not clip_paths:
            raise FFmpegError(
                "No clips were provided."
            )

        if image_duration <= 0:
            raise FFmpegError(
                "Clip duration must be greater than 0."
            )

        # Step 1:
        # Convert/normalize all clips
        segments = self._prepare_segments(
            clip_paths,
            image_duration,
            clip_durations,
        )

        # Step 2:
        # Concatenate clips
        concatenated = self._concat_segments(
            segments
        )

        # Step 3:
        # Add audio or move final video
        if audio_path:

            self._add_audio(
                concatenated,
                audio_path,
                output_path,
            )

        else:

            output_directory = os.path.dirname(
                os.path.abspath(output_path)
            )

            os.makedirs(
                output_directory,
                exist_ok=True,
            )

            os.replace(
                concatenated,
                output_path,
            )

        return output_path