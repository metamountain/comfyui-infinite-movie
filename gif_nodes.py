"""Infinite Movie · Movie to GIF – film -> animated GIF / WebP with a live preview in the node.

Inputs universal (AGENTS „Nodes universal“): images (IMAGE) > video_path (STRING) > file
(selection + upload from ComfyUI/input). 109: the video (VIDEO) input was removed (not used in any workflow).
Everything runs through ffmpeg (no full IMAGE batch in RAM).

Live preview: web/infinite_movie_gif.js posts the widget values to /infinite_movie/gif_preview whenever one
changes; the server renders a small, short version into the temp folder and answers with its /view address plus
frames / size / an estimate of the full file size. The route only reads files inside ComfyUI's input / output /
temp folders or the source this node used in its last run (connected video/images) – never arbitrary paths.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time

from comfy_api.latest import io

from .nodes import _ffmpeg, _input_videos, _no_window
from .settings_nodes import SETTINGS, chain_settings

FORMATS = ["GIF", "WebP (animated, smaller)"]
CROPS = {"none": None, "1:1": (1, 1), "4:5": (4, 5), "9:16": (9, 16), "16:9": (16, 9)}
DIRECTIONS = ["forward", "reverse", "boomerang"]
DITHERS = ["sierra2_4a", "floyd_steinberg", "bayer", "none"]
PALETTES = ["global (best for calm films)", "per frame (best for colour changes)"]

PREVIEW_LONG = 320       # live preview: small …
PREVIEW_FPS = 12         # … low frame rate …
PREVIEW_MAX_S = 8.0      # … and at most 8 s, so it answers in about a second

# node id -> source file used in the last run (connected images); only these may be previewed outside the
# ComfyUI folders.
_LAST_SOURCE: dict = {}


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested in tools/infinite_movie_test.py)
# ---------------------------------------------------------------------------

def gif_params(**kw) -> dict:
    """Normalised parameter dict (widget values -> numbers / choices with safe ranges)."""
    def f(name, default, lo, hi):
        try:
            v = float(kw.get(name, default))
        except (TypeError, ValueError):
            v = default
        return min(max(v, lo), hi)
    p = {
        "format": kw.get("format") if kw.get("format") in FORMATS else FORMATS[0],
        "long_side": int(f("long_side", 480, 0, 4096)),
        "crop": kw.get("crop") if kw.get("crop") in CROPS else "none",
        "fps": f("fps", 15, 0, 60),
        "start": f("start", 0.0, 0, 36000),
        "end": f("end", 0.0, 0, 36000),
        "speed": f("speed", 1.0, 0.1, 8.0),
        "direction": kw.get("direction") if kw.get("direction") in DIRECTIONS else "forward",
        "colors": int(f("colors", 256, 2, 256)),
        "dither": kw.get("dither") if kw.get("dither") in DITHERS else DITHERS[0],
        "palette": kw.get("palette") if kw.get("palette") in PALETTES else PALETTES[0],
        "quality": int(f("quality", 80, 1, 100)),
        "repeat": int(f("repeat", 0, 0, 1000)),
    }
    return p


def _ext(p: dict) -> str:
    return ".webp" if p["format"].startswith("WebP") else ".gif"


def video_filter(p: dict) -> str:
    """Filter chain for one video stream: speed, fps, centre crop, scale, direction. Ends with label [v]."""
    parts = []
    if abs(p["speed"] - 1.0) > 1e-6:
        parts.append(f"setpts=PTS/{p['speed']:g}")
    if p["fps"] > 0:
        parts.append(f"fps={p['fps']:g}")
    ratio = CROPS.get(p["crop"])
    if ratio:
        a = ratio[0] / ratio[1]
        parts.append(f"crop='min(iw,ih*{a:.6f})':'min(ih,iw/{a:.6f})'")
    if p["long_side"] > 0:
        L = p["long_side"]
        parts.append(f"scale='if(gte(iw,ih),{L},-2)':'if(gte(iw,ih),-2,{L})':flags=lanczos")
    base = ",".join(parts) or "null"
    if p["direction"] == "reverse":
        return f"[0:v]{base},reverse[v]"
    if p["direction"] == "boomerang":
        # forward + backward without the duplicated reversal frame
        return (f"[0:v]{base},split[fw][bw];[bw]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[rv];"
                f"[fw][rv]concat=n=2:v=1:a=0[v]")
    return f"[0:v]{base}[v]"


def ffmpeg_args(ff: str, src: str, out: str, p: dict, max_seconds: float = 0.0) -> list:
    """Complete ffmpeg command line for src -> out (GIF with palette or animated WebP)."""
    args = [ff, "-y", "-v", "error"]
    if p["start"] > 0:
        args += ["-ss", f"{p['start']:g}"]
    dur = (p["end"] - p["start"]) if p["end"] > p["start"] else 0.0
    if max_seconds > 0:
        dur = min(dur, max_seconds) if dur > 0 else max_seconds
    if dur > 0:
        args += ["-t", f"{dur:g}"]   # -t before -i = duration in the source film (before speed)
    args += ["-i", src]
    chain = video_filter(p)
    if _ext(p) == ".gif":
        per_frame = p["palette"].startswith("per frame")
        dither = "bayer:bayer_scale=3" if p["dither"] == "bayer" else p["dither"]
        chain += (f";[v]split[s0][s1];[s0]palettegen=max_colors={p['colors']}"
                  f":stats_mode={'single' if per_frame else 'full'}[pal];"
                  f"[s1][pal]paletteuse=dither={dither}:diff_mode=rectangle{':new=1' if per_frame else ''}[out]")
        loop = 0 if p["repeat"] == 0 else (-1 if p["repeat"] == 1 else p["repeat"] - 1)
        args += ["-filter_complex", chain, "-map", "[out]", "-an", "-loop", str(loop), out]
    else:
        args += ["-filter_complex", chain, "-map", "[v]", "-an", "-c:v", "libwebp_anim", "-lossless", "0",
                 "-q:v", str(p["quality"]), "-compression_level", "4", "-loop", str(p["repeat"]), out]
    return args


def comfy_dirs() -> list:
    try:
        import folder_paths
        return [os.path.abspath(d) for d in (folder_paths.get_input_directory(), folder_paths.get_output_directory(),
                                             folder_paths.get_temp_directory())]
    except Exception:  # noqa: BLE001 – offline test
        return []


def allowed_source(path: str, dirs=None, extra=()) -> bool:
    """True only for existing files inside the ComfyUI folders or registered last-run sources."""
    if not path or not os.path.isfile(path):
        return False
    real = os.path.realpath(os.path.abspath(path)).lower()
    if any(real == os.path.realpath(os.path.abspath(e)).lower() for e in extra):
        return True
    for d in (comfy_dirs() if dirs is None else dirs):
        root = os.path.realpath(os.path.abspath(d)).lower().rstrip("\\/") + os.sep
        if real.startswith(root.lower()):
            return True
    return False


def _probe(ff: str, path: str) -> dict:
    """Width, height, duration (s) from the ffmpeg output; missing values 0."""
    import re
    err = subprocess.run([ff, "-hide_banner", "-i", path], capture_output=True, text=True, **_no_window()).stderr
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", err)
    d = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    return {"w": int(m.group(1)) if m else 0, "h": int(m.group(2)) if m else 0,
            "dur": (int(d.group(1)) * 3600 + int(d.group(2)) * 60 + float(d.group(3))) if d else 0.0}


def anim_info(path: str, fps: float = 0.0) -> dict:
    """Width, height, duration (s), frames of a GIF/WebP (PIL; ffmpeg cannot read animated WebP)."""
    from PIL import Image
    with Image.open(path) as im:
        n = getattr(im, "n_frames", 1)
        dur = 0
        for i in range(n):
            im.seek(i)
            dur += im.info.get("duration", 0) or 0
        d = dur / 1000.0
        if not d and n > 1 and fps > 0:   # PIL often provides no frame duration for WebP
            d = n / fps
        return {"w": im.width, "h": im.height, "dur": d, "frames": n}


def render(src: str, out: str, p: dict, max_seconds: float = 0.0, timeout: int = 600) -> dict:
    ff = _ffmpeg()
    t0 = time.time()
    part = out + ".part" + _ext(p)
    r = subprocess.run(ffmpeg_args(ff, src, part, p, max_seconds), capture_output=True, text=True,
                       timeout=timeout, **_no_window())
    if r.returncode != 0 or not os.path.isfile(part):
        raise RuntimeError(f"Movie to GIF: ffmpeg failed: {(r.stderr or '').strip()[-400:]}")
    os.replace(part, out)
    info = anim_info(out, p["fps"])
    info.update(bytes=os.path.getsize(out), seconds=round(time.time() - t0, 2))
    return info


def human(n: int) -> str:
    return f"{n / 1048576:.1f} MB" if n >= 1048576 else f"{n / 1024:.0f} KB"


def save_path(output_folder: str, filename: str, src: str, ext: str, settings=None, default_dir=None) -> str:
    """Target file: folder = output_folder > Settings > output_folder > <output>/infinite_movie/gif;
    name = filename > name of the source film; never overwrite (_2, _3 ...)."""
    folder = (output_folder or "").strip().strip('"')
    if not folder and isinstance(settings, dict):
        folder = str(settings.get("output_folder") or "").strip().strip('"')
    if not folder:
        if default_dir is None:
            import folder_paths
            default_dir = os.path.join(folder_paths.get_output_directory(), "infinite_movie", "gif")
        folder = default_dir
    os.makedirs(folder, exist_ok=True)
    stem = (filename or "").strip() or os.path.splitext(os.path.basename(src))[0] or "movie"
    stem = "".join("_" if c in '<>:"/\\|?*' else c for c in stem).strip(" .") or "movie"
    out, n = os.path.join(folder, stem + ext), 2
    while os.path.exists(out):
        out, n = os.path.join(folder, f"{stem}_{n}{ext}"), n + 1
    return out


def view_ref(path: str) -> dict:
    """/view address for display: directly if in the output folder, otherwise a copy in the temp folder."""
    import shutil
    import folder_paths
    out_dir = os.path.abspath(folder_paths.get_output_directory())
    ap = os.path.abspath(path)
    if ap.lower().startswith(out_dir.lower() + os.sep):
        sub, name = os.path.split(os.path.relpath(ap, out_dir))
        return {"filename": name, "subfolder": sub, "type": "output"}
    tmp = os.path.join(folder_paths.get_temp_directory(), "infinite_movie_gif")
    os.makedirs(tmp, exist_ok=True)
    shutil.copy2(ap, os.path.join(tmp, os.path.basename(ap)))
    return {"filename": os.path.basename(ap), "subfolder": "infinite_movie_gif", "type": "temp"}


# ---------------------------------------------------------------------------
# Source resolution
# ---------------------------------------------------------------------------

def _resolve_source(images, video_path: str, file: str, images_fps: float) -> str:
    import folder_paths
    tmp = os.path.join(folder_paths.get_temp_directory(), "infinite_movie_gif")
    os.makedirs(tmp, exist_ok=True)
    if images is not None:
        from .chunk_upscale_nodes import _images_to_file
        return _images_to_file(images, None, images_fps or 24.0, tmp)
    p = (video_path or "").strip().strip('"')
    if p:
        if not os.path.isfile(p):
            raise ValueError(f"Movie to GIF: video_path not found: {p}")
        return p
    if file and file != "(none)":
        return folder_paths.get_annotated_filepath(file)
    raise ValueError("Movie to GIF: connect images or video_path, or choose a file.")


# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------

class InfiniteMovieGif(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieGif",
            display_name="Infinite Movie · Movie to GIF",
            search_aliases=["gif", "webp", "animated", "movie to gif", "video to gif", "infinite movie"],
            category="Infinite Movie",
            description="Turns a film into an animated GIF or WebP. The preview in the node updates live while you "
                        "change size, crop, frame rate, trim, speed, direction or colours; the estimated file size "
                        "shows below it. Run saves the full version to the output folder.",
            is_output_node=True,
            inputs=[
                SETTINGS.Input("settings", optional=True, display_name="settings",
                               tooltip="Settings chain (only passed on)."),
                io.Image.Input("images", optional=True, tooltip="Frame batch (priority 1), e.g. VHS Load Video."),
                io.String.Input("video_path", default="", optional=True,
                                tooltip="Path of a film (priority 2), e.g. Assemble → video_path."),
                io.Combo.Input("file", options=_input_videos(), upload=io.UploadType.video, optional=True,
                               tooltip="Film from ComfyUI/input (priority 3, used when nothing else is set)."),
                io.Combo.Input("format", optional=True, options=FORMATS, default=FORMATS[0],
                               tooltip="GIF plays everywhere; animated WebP is usually 3-5× smaller with more colours."),
                io.Int.Input("long_side", optional=True, default=480, min=0, max=4096, step=16,
                             tooltip="Longest side in pixels (0 = original). GIF size grows with the square of it."),
                io.Combo.Input("crop", optional=True, options=list(CROPS), default="none",
                               tooltip="Centre crop to a ratio before scaling (1:1 avatar, 4:5 Instagram, 9:16 story)."),
                io.Float.Input("fps", optional=True, default=15.0, min=0.0, max=60.0, step=1.0,
                               tooltip="Frame rate of the GIF (0 = like the film). 10-15 is typical for GIFs."),
                io.Float.Input("start", advanced=True, optional=True, default=0.0, min=0.0, max=36000.0, step=0.1,
                               tooltip="Start in seconds."),
                io.Float.Input("end", advanced=True, optional=True, default=0.0, min=0.0, max=36000.0, step=0.1,
                               tooltip="End in seconds (0 = to the end)."),
                io.Float.Input("speed", advanced=True, optional=True, default=1.0, min=0.1, max=8.0, step=0.05,
                               tooltip="Playback speed (2 = twice as fast, 0.5 = slow motion)."),
                io.Combo.Input("direction", advanced=True, optional=True, options=DIRECTIONS, default="forward",
                               tooltip="boomerang = forward then backward (seamless loop from any clip)."),
                io.Int.Input("colors", advanced=True, optional=True, default=256, min=2, max=256,
                             tooltip="GIF only: palette size. Fewer colours = smaller file, more banding."),
                io.Combo.Input("dither", advanced=True, optional=True, options=DITHERS, default=DITHERS[0],
                               tooltip="GIF only: how missing colours are mixed. none = smallest, flat areas band."),
                io.Combo.Input("palette", advanced=True, optional=True, options=PALETTES, default=PALETTES[0],
                               tooltip="GIF only: one palette for the whole film or a new one per frame."),
                io.Int.Input("quality", advanced=True, optional=True, default=80, min=1, max=100,
                             tooltip="WebP only: quality (higher = larger file)."),
                io.Int.Input("repeat", advanced=True, optional=True, default=0, min=0, max=1000,
                             tooltip="How often it plays: 0 = forever, 1 = once, n = n times."),
                io.Float.Input("max_mb", advanced=True, optional=True, default=0.0, min=0.0, max=100.0, step=0.5,
                               tooltip="Size limit in MB (0 = off). Above it the GIF is made smaller step by step "
                                       "(long side × 0.85) until it fits – e.g. 8 for Discord, 15 for GitHub."),
                io.String.Input("output_folder", optional=True, default="",
                                tooltip="Folder for the GIF – set it with 💾 Save as… below. Empty = Settings › output_folder, "
                                        "else the ComfyUI output folder (infinite_movie/gif)."),
                io.String.Input("filename", optional=True, default="",
                                tooltip="File name without extension. Empty = name of the film. An existing file is "
                                        "never overwritten (_2, _3 … is added)."),
                io.Float.Input("images_fps", default=24.0, min=1.0, max=120.0, optional=True, advanced=True,
                               tooltip="Frame rate of the images input."),
            ],
            outputs=[
                io.String.Output("gif_path", tooltip="Path of the saved GIF / WebP."),
                SETTINGS.Output("settings", display_name="settings ▶ chain",
                                tooltip="The incoming settings, passed on."),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(cls, **kw):
        p = (kw.get("video_path") or "").strip().strip('"')
        return f"{p}:{os.path.getmtime(p) if p and os.path.isfile(p) else ''}"

    @classmethod
    def execute(cls, format=FORMATS[0], long_side=480, crop="none", fps=15.0, start=0.0, end=0.0, speed=1.0,
                direction="forward", colors=256, dither=DITHERS[0], palette=PALETTES[0], quality=80, repeat=0,
                max_mb=0.0, output_folder="", filename="", settings=None, images=None,
                video_path="", file="(none)", images_fps=24.0) -> io.NodeOutput:
        import folder_paths
        src = _resolve_source(images, video_path, file, images_fps)
        uid = str(cls.hidden.unique_id) if getattr(cls, "hidden", None) else ""
        if uid:
            _LAST_SOURCE[uid] = os.path.abspath(src)
        p = gif_params(format=format, long_side=long_side, crop=crop, fps=fps, start=start, end=end, speed=speed,
                       direction=direction, colors=colors, dither=dither, palette=palette, quality=quality,
                       repeat=repeat)
        out = save_path(output_folder, filename, src, _ext(p), settings)
        info = render(src, out, p)
        tries = 0
        limit = int(max_mb * 1048576) if max_mb and max_mb > 0 else 0
        while limit and info["bytes"] > limit and tries < 8:
            cur = p["long_side"] or max(info["w"], info["h"]) or 480
            p["long_side"] = max(16, int(cur * 0.85) // 2 * 2)
            info = render(src, out, p)
            tries += 1
        note = ""
        if limit:
            note = (f" · fits {max_mb:g} MB" if info["bytes"] <= limit else f" · still above {max_mb:g} MB") + \
                   (f" (long side {p['long_side']})" if tries else "")
        text = f"{info['w']}×{info['h']} · {info['frames']} frames · {info['dur']:.1f} s · {human(info['bytes'])}{note}"
        print(f"[InfiniteMovieGif] {out}: {text}")
        ui = {"infinite_movie_gif": [{**view_ref(out), "text": text, "path": out, "token": uid}]}
        return io.NodeOutput(out, chain_settings(settings), ui=ui)


# ---------------------------------------------------------------------------
# Live preview route
# ---------------------------------------------------------------------------

def preview_source(body: dict) -> str:
    """Source for the live preview, from the request: token (last run) > video_path > file. '' = none."""
    import folder_paths
    tok = str(body.get("token") or "")
    if tok and tok in _LAST_SOURCE and os.path.isfile(_LAST_SOURCE[tok]):
        return _LAST_SOURCE[tok]
    p = str(body.get("video_path") or "").strip().strip('"')
    if p:
        return p if allowed_source(p, extra=_LAST_SOURCE.values()) else ""
    f = str(body.get("file") or "")
    if f and f != "(none)":
        try:
            path = folder_paths.get_annotated_filepath(f)
        except Exception:  # noqa: BLE001
            return ""
        return path if allowed_source(path) else ""
    return ""


def gif_preview(body: dict) -> dict:
    import folder_paths
    src = preview_source(body)
    if not src:
        return {"ok": False, "message": "No preview: choose a file / video_path, or Run once for a connected input "
                                        "(video_path must be inside the ComfyUI input/output folders)."}
    p = gif_params(**(body.get("params") or {}))
    full = dict(p)
    p["long_side"] = min(p["long_side"] or PREVIEW_LONG, PREVIEW_LONG)
    p["fps"] = min(p["fps"] or PREVIEW_FPS, PREVIEW_FPS)
    tmp = os.path.join(folder_paths.get_temp_directory(), "infinite_movie_gif")
    os.makedirs(tmp, exist_ok=True)
    key = hashlib.sha1(json.dumps([src, os.path.getmtime(src), p]).encode()).hexdigest()[:16]
    out = os.path.join(tmp, f"preview_{key}{_ext(p)}")
    info = render(src, out, p, max_seconds=PREVIEW_MAX_S, timeout=60) if not os.path.isfile(out) else \
        {**anim_info(out, p["fps"]), "bytes": os.path.getsize(out), "seconds": 0}
    srcinfo = _probe(_ffmpeg(), src)
    # Estimate of the full size: area x frame rate x duration compared to the preview
    est = None
    if info.get("w") and info.get("h") and srcinfo.get("w"):
        L = full["long_side"] or max(srcinfo["w"], srcinfo["h"])
        scale = L / max(info["w"], info["h"])
        f_full = full["fps"] or 24.0
        dur_src = srcinfo["dur"] or 0
        span = ((full["end"] or dur_src) - full["start"]) if dur_src else 0
        dur_full = max(span, 0) / full["speed"] * (2 if full["direction"] == "boomerang" else 1)
        dur_prev = info["dur"] or min(PREVIEW_MAX_S, dur_full) or 1
        est = int(info["bytes"] * scale * scale * (f_full / p["fps"]) * (dur_full / dur_prev if dur_full else 1))
    rel = os.path.relpath(out, folder_paths.get_temp_directory())
    sub, name = os.path.split(rel)
    return {"ok": True, "filename": name, "subfolder": sub, "type": "temp",
            "message": (f"preview {info['w']}×{info['h']} · {info['dur']:.1f} s" +
                        (f" (first {PREVIEW_MAX_S:g} s)" if dur_full_exceeds(full, srcinfo) else "") +
                        (f" · full ≈ {human(est)}" if est else ""))}


def dur_full_exceeds(full: dict, srcinfo: dict) -> bool:
    span = ((full["end"] or srcinfo.get("dur", 0)) - full["start"])
    return span > PREVIEW_MAX_S


def _register_routes():
    import asyncio
    try:
        from aiohttp import web
        from server import PromptServer

        @PromptServer.instance.routes.post("/infinite_movie/gif_preview")
        async def _gif_preview(request):
            try:
                body = await request.json()
            except Exception:  # noqa: BLE001
                body = {}
            try:
                res = await asyncio.to_thread(gif_preview, body)
            except Exception as e:  # noqa: BLE001
                res = {"ok": False, "message": f"preview failed: {e}"}
            return web.json_response(res)
    except Exception as e:  # noqa: BLE001 - without a server (unit tests) no route
        print(f"[InfiniteMovieGif] preview route not registered: {e}")


_register_routes()

GIF_NODE_LIST = [InfiniteMovieGif]
