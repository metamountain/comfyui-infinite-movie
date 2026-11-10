"""Infinite Movie · Film (user 2026-11-03: "status confirmation saved, show the finished movie, node at the end").

Last node of the chain: shows the finished film as a video in the node (loop, muted, controls) and a
status line "Saved: <path> · 6.0 s · 1080x1350 · 12.3 MB · 14:32". No outputs, display only.
Input: video_path (STRING) – 109: the video (VIDEO) input was removed (not used in any workflow).
Preview via /view: only files in the ComfyUI output folder are reachable; otherwise only the status line.
"""

from __future__ import annotations

import os
import re
import subprocess
import time

from comfy_api.latest import io

from .nodes import _ffmpeg


def _no_window() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


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
        out_dir = os.path.abspath(folder_paths.get_output_directory())
        ap = os.path.abspath(path)
        if os.path.commonpath([out_dir, ap]).lower() == out_dir.lower():
            rel = os.path.relpath(ap, out_dir)
            info["view"] = {"filename": os.path.basename(rel), "subfolder": os.path.dirname(rel), "type": "output"}
    except Exception:  # noqa: BLE001
        pass
    parts = [f"Saved: {path}"]
    if "seconds" in info:
        parts.append(f"{info['seconds']:.1f} s")
    if "size" in info:
        parts.append(info["size"])
    parts.append(f"{info['mb']} MB")
    parts.append(info["saved_at"])
    info["status"] = " · ".join(parts)
    return info


# "Open folder" (user 2026-11-03): Explorer with the film highlighted. ComfyUI listens on the LAN (--listen) -
# therefore ONLY paths this node itself reported (_SHOWN), existing files, without a shell.
_SHOWN: set[str] = set()


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


class InfiniteMovieFilm(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieFilm",
            display_name="Infinite Movie · Film",
            category="Infinite Movie",
            description="Shows the finished film (looping preview) and confirms where it was saved.",
            inputs=[
                io.String.Input("video_path", optional=True, force_input=True,
                                tooltip="Path of the finished film, e.g. Assemble → video_path."),
            ],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, video_path="") -> io.NodeOutput:
        path = (video_path or "").strip()
        info = film_info(path)
        if info.get("exists"):
            _SHOWN.add(os.path.abspath(path).lower())
        print(f"[InfiniteMovieFilm] {info['status']}")
        return io.NodeOutput(ui={"infinite_movie_film": [info]})


FILM_NODE_LIST = [InfiniteMovieFilm]
