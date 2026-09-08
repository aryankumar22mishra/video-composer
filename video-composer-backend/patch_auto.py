import codecs

p = r'composer/services/ffmpeg_service.py'
f = codecs.open(p, 'r', 'utf-8')
c = f.read()
f.close()
c = c.replace('\r\n', '\n')

# 1. Update the class docstring resolution bullet
old = '''    Each clip is normalized to:
        - requested duration
        - 1280x720 resolution'''
new = '''    Each clip is normalized to:
        - requested duration
        - output resolution (explicit target box, or the first clip's
          native dimensions when no target was requested)'''
assert c.count(old) == 1, f"docstring: {c.count(old)}"
c = c.replace(old, new)

# 2. Add _probe_dimensions helper right before _run
old = '''    # ---------------------------------------------------------
    # Run FFmpeg
    # ---------------------------------------------------------

    def _run(self, cmd):'''
new = '''    # ---------------------------------------------------------
    # Probe source dimensions (ffprobe)
    # ---------------------------------------------------------

    @staticmethod
    def _probe_dimensions(path):
        """Return the first video/image stream's (width, height), or None."""
        try:
            result = subprocess.run(
                [
                    "ffprobe", "-v", "error",
                    "-select_streams", "v:0",
                    "-show_entries", "stream=width,height",
                    "-of", "csv=p=0",
                    path,
                ],
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                return None
            width, height = result.stdout.strip().split(",")
            return int(width), int(height)
        except (ValueError, OSError):
            return None

    # ---------------------------------------------------------
    # Run FFmpeg
    # ---------------------------------------------------------

    def _run(self, cmd):'''
assert c.count(old) == 1, f"run anchor: {c.count(old)}"
c = c.replace(old, new)

# 3. Auto = pass the first source clip's native dimensions through
old = '''        # Resolve the effective resolution box for normalisation.
        # aspect_ratio="auto" without explicit dims -> 1280x720 legacy.
        if target_resolution and aspect_ratio != "auto":
            resolution = target_resolution
        else:
            resolution = "1280x720"'''
new = '''        # Resolve the effective resolution box for normalisation.
        if target_resolution and aspect_ratio != "auto":
            # Explicit target box from the dimension panel (preset/custom).
            resolution = target_resolution
        else:
            # Auto: pass the first source clip's dimensions through so the
            # output keeps the source's native aspect ratio (no rescale of
            # the frame shape). Falls back to the legacy 1280x720 box when
            # probing is unavailable.
            probed = self._probe_dimensions(clip_paths[0])
            if probed:
                probed_width = max(2, probed[0] - (probed[0] % 2))
                probed_height = max(2, probed[1] - (probed[1] % 2))
                resolution = f"{probed_width}x{probed_height}"
                print(f"[Compose] auto resolution passthrough -> {resolution}")
            else:
                resolution = "1280x720"'''
assert c.count(old) == 1, f"resolution block: {c.count(old)}"
c = c.replace(old, new)

f = codecs.open(p, 'w', 'utf-8')
f.write(c.replace('\n', '\r\n'))
f.close()
print("DONE: Auto passthrough + probe added")