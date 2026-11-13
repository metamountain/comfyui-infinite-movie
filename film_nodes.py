"""Infinite Movie · Video Preview (user 2026-11-13: "any video source, show it in the node, pass it on as VIDEO").

General video preview node (like VHS "Video Combine"): shows a video in the node (loop, muted, controls) and
passes it on as VIDEO. Status line "Saved/Preview: <path> · 6.0 s · 1080x1350 · 12.3 MB · 14:32".
Inputs (all optional, priority video > images > video_path > file): video (VIDEO), images (IMAGE batch, encoded
to H.264 like Video Combine) + audio + fps, video_path (STRING), file (ComfyUI/input).
Preview via /view: files in the ComfyUI output, temp or input folder are reachable; otherwise only the status line.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time

import numpy as np

from comfy_api.latest import io

from .media import _ffmpeg, _input_videos, _no_window




def _probe(path: str) -> dict:
    """Duration, size, fps from ffmpeg -i (like post_nodes._probe_fps/_probe_size)."""
    try:
        err = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path], capture_output=True, text=True,
                             timeout=30, **_no_window()).stderr
    except Exception:  # noqa: BLE001
        return {}
    out = {}
    m = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", err)
    if m:
        out["seconds"] = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", err)
    if m:
        out["size"] = f"{m.group(1)}×{m.group(2)}"
    m = re.search(r"(\d+(?:\.\d+)?) fps", err)
    if m:
        out["fps"] = float(m.group(1))
    return out


def _inside(ap: str, base: str) -> bool:
    """ap inside base (case-insensitive); False on different drives (commonpath raises)."""
    try:
        return os.path.commonpath([base, ap]).lower() == base.lower()
    except ValueError:
        return False


def film_info(path: str) -> dict:
    """Display data for the frontend (also usable in tests without a ComfyUI server)."""
    info = {"path": path, "exists": bool(path) and os.path.isfile(path)}
    if not info["exists"]:
        info["status"] = f"No film found: {path or '(empty path)'}"
        return info
    st = os.stat(path)
    info["mb"] = round(st.st_size / 1e6, 1)
    info["saved_at"] = time.strftime("%H:%M:%S", time.localtime(st.st_mtime))
    info.update(_probe(path))
    try:
        import folder_paths
        ap = os.path.abspath(path)
        for kind in ("output", "temp", "input"):   # 118: view reachable for all three /view sources
            base = os.path.abspath(getattr(folder_paths, f"get_{kind}_directory")())
            if _inside(ap, base):
                rel = os.path.relpath(ap, base)
                info["view"] = {"filename": os.path.basename(rel), "subfolder": os.path.dirname(rel), "type": kind}
                break
    except Exception:  # noqa: BLE001
        pass
    verb = "Preview" if info.get("view", {}).get("type") == "temp" else "Saved"
    parts = [f"{verb}: {path}"]
    if "seconds" in info:
        parts.append(f"{info['seconds']:.1f} s")
    if "size" in info:
        parts.append(info["size"])
    parts.append(f"{info['mb']} MB")
    parts.append(info["saved_at"])
    info["status"] = " · ".join(parts)
    return info


def _images_to_mp4(images, audio, fps: float) -> str:
    """Encode an IMAGE batch to H.264 .mp4 in the ComfyUI temp dir, so the node preview (a browser) can play it.
    chunk_upscale_nodes._images_to_file writes lossless yuv444p mkv, which browsers refuse.
    Model: _images_to_file – pipe to ffmpeg, 16 frames per block, name from form + probe sample so the same
    frames reuse the file. Odd width/height are cropped to even first; audio (if any) is muxed as AAC."""
    import folder_paths
    n, h, w = images.shape[0], images.shape[1], images.shape[2]
    probe = images[:: max(1, n // 8)].float().mean().item()
    key = hashlib.sha1(json.dumps([n, h, w, round(probe, 6), fps]).encode()).hexdigest()[:16]
    tmp = folder_paths.get_temp_directory()
    os.makedirs(tmp, exist_ok=True)
    path = os.path.join(tmp, f"images_{key}.mp4")
    if os.path.isfile(path):
        return path
    part = path + ".part.mp4"
    cmd = [_ffmpeg(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
           "-r", f"{fps:g}", "-i", "-", "-c:v", "libx264", "-crf", "17", "-pix_fmt", "yuv420p",
           "-movflags", "+faststart"]
    if w % 2 or h % 2:
        cmd += ["-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2"]
    cmd += [part]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE, **_no_window())
    for i in range(0, n, 16):
        enc.stdin.write((images[i:i + 16].clamp(0, 1) * 255 + 0.5).byte().cpu().numpy().tobytes())
    enc.stdin.close()
    enc.wait()
    from .audio_nodes import audio_or_none
    audio = audio_or_none(audio)   # VHS-LazyAudioMap raises on silent films -> continue without audio
    if audio is not None:
        wav = audio["waveform"][0].float().cpu().numpy().T.copy()        # [S, C]
        apath = path + ".f32"
        wav.astype(np.float32).tofile(apath)
        subprocess.run([_ffmpeg(), "-y", "-v", "error", "-i", part, "-f", "f32le", "-ar", str(int(audio["sample_rate"])),
                        "-ac", str(wav.shape[1]), "-i", apath, "-c:v", "copy", "-c:a", "aac", "-shortest", path],
                       check=True, **_no_window())
        os.remove(apath)
        os.remove(part)
    else:
        os.replace(part, path)
    return path


# "Open folder" (user 2026-11-03): Explorer with the film highlighted. ComfyUI listens on the LAN (--listen) -
# therefore ONLY paths this node itself reported (_SHOWN), existing files, without a shell.
# 2026-11-13: _SHOWN is kept in user/infinite_movie_shown.json (last 500), otherwise 📂 failed after a ComfyUI restart
# for the film the preview still shows (node.properties.im_recent survives the restart, the memory did not).
_SHOWN: set[str] = set()
_SHOWN_ORDER: list[str] = []
_SHOWN_MAX = 500


def _shown_file() -> str:
    import folder_paths
    return os.path.join(folder_paths.get_user_directory(), "infinite_movie_shown.json")


def _shown_load() -> None:
    try:
        with open(_shown_file(), encoding="utf-8") as f:
            items = [str(x).lower() for x in json.load(f)][-_SHOWN_MAX:]
    except Exception:  # noqa: BLE001 - no file yet / unreadable -> start empty
        return
    _SHOWN_ORDER[:] = items
    _SHOWN.update(items)


def _shown_add(path: str) -> None:
    key = os.path.abspath(path).lower()
    if key in _SHOWN:
        return
    _SHOWN.add(key)
    _SHOWN_ORDER.append(key)
    while len(_SHOWN_ORDER) > _SHOWN_MAX:
        _SHOWN.discard(_SHOWN_ORDER.pop(0))
    try:
        with open(_shown_file(), "w", encoding="utf-8") as f:
            json.dump(_SHOWN_ORDER, f)
    except Exception as e:  # noqa: BLE001 - the button then only works until the next restart
        print(f"[InfiniteMovieFilm] could not save {_shown_file()}: {e}")


def _register_open_route():
    try:
        from aiohttp import web
        from server import PromptServer

        @PromptServer.instance.routes.post("/infinite_movie/open_folder")
        async def _open_folder(request):
            data = await request.json()
            path = os.path.abspath(str(data.get("path", "")))
            if path.lower() not in _SHOWN or not os.path.isfile(path):
                return web.json_response({"ok": False, "error": "unknown path"}, status=403)
            if os.name == "nt":
                subprocess.Popen(["explorer", "/select,", path])
            else:
                subprocess.Popen(["xdg-open", os.path.dirname(path)])
            return web.json_response({"ok": True})
    except Exception as e:  # noqa: BLE001 - without a server (unit tests) no route
        print(f"[InfiniteMovieFilm] open_folder route not registered: {e}")


_register_open_route()
try:
    _shown_load()
except Exception:  # noqa: BLE001 - without ComfyUI (unit tests) no user directory
    pass


class InfiniteMovieFilm(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieFilm",
            display_name="Video Preview · Infinite Movie",
            search_aliases=["video preview", "preview video", "video combine", "film", "player", "mp4",
                            "infinite movie"],
            category="Infinite Movie",
            description="Shows a video in the node (looping preview) and passes it on as VIDEO. Takes video, "
                        "images (+audio), video_path or a file; priority video > images > video_path > file.",
            is_output_node=True,
            inputs=[
                io.Video.Input("video", optional=True, tooltip="Video (priority 1)."),
                io.Image.Input("images", optional=True,
                               tooltip="Frame batch (priority 2), encoded to H.264 like Video Combine."),
                io.Audio.Input("audio", optional=True, tooltip="Only with images: muxed into the preview."),
                io.Float.Input("fps", optional=True, default=24.0, min=1.0, max=120.0, step=1.0,
                               tooltip="Only with images: frames per second."),
                io.String.Input("video_path", optional=True, force_input=True,
                                tooltip="Path of a film (priority 3), e.g. Even Motion → video_path."),
                io.Combo.Input("file", options=_input_videos(), default="(none)", upload=io.UploadType.video, optional=True,
                               tooltip="Film from ComfyUI/input (priority 4)."),
            ],
            outputs=[io.Video.Output("video")],
        )

    @classmethod
    def execute(cls, video=None, images=None, audio=None, fps=24.0, video_path="", file="(none)") -> io.NodeOutput:
        from .gif_nodes import _resolve_source
        if images is not None:
            path = _images_to_mp4(images, audio, float(fps or 24.0))
        else:
            try:
                path = _resolve_source(video, None, video_path, file, 24.0)
            except ValueError as e:
                if "not found" in str(e):
                    raise
                path = ""   # nothing connected -> no error, status line only
        info = film_info(path)
        if info.get("exists"):
            _shown_add(path)
        print(f"[InfiniteMovieFilm] {info['status']}")
        from comfy_api.latest import InputImpl
        return io.NodeOutput(InputImpl.VideoFromFile(path) if info.get("exists") else None,
                             ui={"infinite_movie_film": [info]})


FILM_NODE_LIST = [InfiniteMovieFilm]
