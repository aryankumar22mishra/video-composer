import os
import subprocess
import uuid


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".avif"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}


class FFmpegError(Exception):
    pass


class VideoComposerService:
    """
    Combines uploaded video/image clips + optional audio via FFmpeg.
    Later, an AIVideoGeneratorService can implement the same
    compose(clip_paths, audio_path, output_path) interface to
    generate video from prompts instead of stitching uploads.
    """

    def __init__(self, work_dir):
        self.work_dir = work_dir
        os.makedirs(self.work_dir, exist_ok=True)

    def _run(self, cmd):
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise FFmpegError(result.stderr[-2000:])
        return result

    def _image_to_clip(self, image_path, duration, resolution="1280x720"):
        clip_path = os.path.join(self.work_dir, f"{uuid.uuid4().hex}.mp4")
        cmd = [
            "ffmpeg", "-y", "-loop", "1", "-i", image_path,
            "-t", str(duration), "-vf", f"scale={resolution}", "-r", "30",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", clip_path,
        ]
        self._run(cmd)
        return clip_path

    def _normalize_clip(self, video_path, resolution="1280x720"):
        clip_path = os.path.join(self.work_dir, f"{uuid.uuid4().hex}.mp4")
        cmd = [
            "ffmpeg", "-y", "-i", video_path,
            "-vf", f"scale={resolution}", "-r", "30",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
            clip_path,
        ]
        self._run(cmd)
        return clip_path

    def _prepare_segments(self, clip_paths, image_duration):
        segments = []
        for path in clip_paths:
            ext = os.path.splitext(path)[1].lower()
            if ext in IMAGE_EXTENSIONS:
                segments.append(self._image_to_clip(path, image_duration))
            elif ext in VIDEO_EXTENSIONS:
                segments.append(self._normalize_clip(path))
            else:
                raise FFmpegError(f"Unsupported file type: {ext}")
        return segments

    def _concat_segments(self, segments):
        list_file = os.path.join(self.work_dir, f"{uuid.uuid4().hex}.txt")
        with open(list_file, "w") as f:
            for seg in segments:
                f.write(f"file '{seg}'\n")

        concatenated = os.path.join(
            self.work_dir,
            f"{uuid.uuid4().hex}.mp4"
        )

        cmd = [
            "ffmpeg",
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", list_file,
            "-c", "copy",
            concatenated,
        ]
        self._run(cmd)
        return concatenated

    def _add_audio(self, video_path, audio_path, output_path):
        cmd = [
            "ffmpeg", "-y", "-i", video_path, "-i", audio_path,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-shortest",
            output_path,
        ]
        self._run(cmd)

    def compose(self, clip_paths, audio_path, output_path, image_duration=3):
        segments = self._prepare_segments(clip_paths, image_duration)
        concatenated = self._concat_segments(segments)
        if audio_path:
            self._add_audio(concatenated, audio_path, output_path)
        else:
            os.replace(concatenated, output_path)
        return output_path