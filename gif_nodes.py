"""Infinite Movie · Movie to GIF – film -> animated GIF / WebP with a live preview in the node.

Inputs universal (AGENTS „Nodes universal“): video (VIDEO) > images (IMAGE) > video_path (STRING) > file
(selection + upload from ComfyUI/input). Everything runs through ffmpeg (no full IMAGE batch in RAM).
End node (2026-11-12): no outputs, no settings socket. Where the GIF goes follows the source like
Preview Image MM: next to the source film; uploads (ComfyUI/input) and frames of the images input
(temp) go to <output>/infinite_movie/gif. save as… opens the OS save dialog on the ComfyUI computer.

Live preview: web/infinite_movie_gif.js posts the widget values to /infinite_movie/gif_preview whenever one
changes; the server renders a small, short version into the temp folder (never saved) and answers with its
/view address plus an estimate of the full file size. /infinite_movie/gif_save renders the full version with
the same values and saves it. The routes only read files inside ComfyUI's input / output / temp folders or
the source this node used in its last run – never arbitrary paths.
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import time

from comfy_api.latest import io

from .nodes import _ffmpeg, _input_videos, _no_window

FORMATS = ["GIF", "WebP (animated, smaller)"]
CROPS = {"none": None, "1:1": (1, 1), "4:5": (4, 5), "9:16": (9, 16), "16:9": (16, 9)}
DIRECTIONS = ["forward", "reverse", "boomerang"]
DITHERS = ["sierra2_4a", "floyd_steinberg", "bayer", "none"]
PALETTES = ["global (best for calm films)", "per frame (best for colour changes)"]

GIF_MAX_FPS = 50         # GIF stores delays in 1/100 s: 60 fps = 10/20 ms mixed, browsers stretch 10 ms to 100 ms
PREVIEW_LONG = 320       # live preview: small …
PREVIEW_FPS = 12         # … low frame rate …
PREVIEW_MAX_S = 8.0      # … and at most 8 s, so it answers in about a second
PREVIEW_KEEP = 40        # preview files kept in temp (oldest are deleted)

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
    fmt = kw.get("format") if kw.get("format") in FORMATS else FORMATS[0]
    p = {
        "format": fmt,
        "long_side": int(f("long_side", 480, 0, 4096)),
        "crop": kw.get("crop") if kw.get("crop") in CROPS else "none",
        "nth": int(f("every_nth", 1, 1, 30)),
        "src_fps": f("src_fps", 0.0, 0, 240),    # rate of the frames going in (probe / loader); 0 = unknown
        "max_fps": f("max_fps", 0.0, 0, 240),    # extra cap (live preview)
        "start": f("start", 0.0, 0, 36000),
        "end": f("end", 0.0, 0, 36000),
        "direction": kw.get("direction") if kw.get("direction") in DIRECTIONS else "forward",
        "colors": int(f("colors", 256, 2, 256)),
        "dither": kw.get("dither") if kw.get("dither") in DITHERS else DITHERS[0],
        "palette": kw.get("palette") if kw.get("palette") in PALETTES else PALETTES[0],
        "quality": int(f("quality", 80, 1, 100)),
        "repeat": int(f("repeat", 0, 0, 1000)),
        "pre": "",
    }
    return p


def loader_filter(loader: dict, native_fps: float, source_fps: float = 0.0) -> tuple:
    """Filters that turn a film file into the frames a VHS Load Video node hands on (force_rate,
    skip_first_frames, select_every_nth, frame_load_cap), timed like the images input in a Run:
    source_fps > 0 = that rate, 0 = what the loader delivers (force_rate or native / nth)."""
    def num(k, d=0.0):
        try:
            return float(loader.get(k) or d)
        except (TypeError, ValueError):
            return d
    force, skip, nth, cap = num("force_rate"), int(num("skip_first_frames")), max(1, int(num("select_every_nth", 1))), \
        int(num("frame_load_cap"))
    parts = []
    if force > 0:
        parts.append(f"fps={force:g}")
    if skip > 0:
        parts.append(f"trim=start_frame={skip}")
    if nth > 1:
        parts.append(f"select='not(mod(n\\,{nth}))'")
    if cap > 0:
        parts.append(f"trim=end_frame={cap}")
    rate = source_fps if source_fps > 0 else ((force or native_fps or 24.0) / nth)
    parts.append(f"setpts=N/({rate:g}*TB)")
    return ",".join(parts), rate


def _ext(p: dict) -> str:
    return ".webp" if p["format"].startswith("WebP") else ".gif"


def out_fps(p: dict) -> float:
    """Playback rate of the result = always the film's own rate (0 = unknown). every_nth only drops frames,
    so the GIF plays every_nth times faster and is every_nth times shorter."""
    return p["src_fps"]


def fps_cap(p: dict) -> float:
    """Frame-rate limit: GIF at most 50 (delays in 1/100 s), the preview its own limit; 0 = none."""
    caps = [c for c in (GIF_MAX_FPS if _ext(p) == ".gif" else 0, p["max_fps"]) if c]
    return min(caps) if caps else 0.0


def video_filter(p: dict, max_seconds: float = 0.0) -> str:
    """Filter chain for one video stream: [loader frames + trim], every n-th frame played at the film's own
    rate, fps cap, centre crop, scale, direction. Ends with label [v]."""
    parts = []
    if p.get("pre"):
        # loader mode: start/end apply to the delivered frames, not to the file (no -ss/-t)
        parts.append(p["pre"])
        end = p["end"] if p["end"] > p["start"] else 0.0
        if max_seconds > 0:
            end = min(end, p["start"] + max_seconds) if end else p["start"] + max_seconds
        if p["start"] > 0 or end:
            parts.append("trim=" + ":".join(([f"start={p['start']:g}"] if p["start"] > 0 else []) +
                                            ([f"end={end:g}"] if end else [])) + ",setpts=PTS-STARTPTS")
    if p["nth"] > 1:
        # keep every n-th frame and play them at the film's own rate -> n times faster, n times shorter
        parts.append(f"select='not(mod(n\\,{p['nth']}))',setpts=PTS/{p['nth']}")
    cap, rate = fps_cap(p), out_fps(p)
    if cap and rate > cap + 0.01:   # only when known and too high – fps= on a slower stream duplicates frames
        parts.append(f"fps={cap:g}")
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
    if not p.get("pre"):
        if p["start"] > 0:
            args += ["-ss", f"{p['start']:g}"]
        dur = (p["end"] - p["start"]) if p["end"] > p["start"] else 0.0
        if max_seconds > 0:
            dur = min(dur, max_seconds) if dur > 0 else max_seconds
        if dur > 0:
            args += ["-t", f"{dur:g}"]   # -t before -i = duration in the source film
    args += ["-i", src]
    chain = video_filter(p, max_seconds)
    if _ext(p) == ".gif":
        per_frame = p["palette"].startswith("per frame")
        dither = "bayer:bayer_scale=3" if p["dither"] == "bayer" else p["dither"]
        chain += (f";[v]split[s0][s1];[s0]palettegen=max_colors={p['colors']}"
                  f":stats_mode={'single' if per_frame else 'full'}[pal];"
                  f"[s1][pal]paletteuse=dither={dither}:diff_mode=rectangle{':new=1' if per_frame else ''}[out]")
        # GIF loop = extra plays (0 forever, -1 none); WebP loop = total plays – measured with PIL 2026-11-12
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


def _inside(path: str, root: str) -> bool:
    try:
        a, r = os.path.realpath(os.path.abspath(path)), os.path.realpath(os.path.abspath(root))
        return os.path.commonpath([a.lower(), r.lower()]) == r.lower()
    except ValueError:  # other drive
        return False


def allowed_source(path: str, dirs=None, extra=()) -> bool:
    """True only for existing files inside the ComfyUI folders or registered last-run sources."""
    if not path or not os.path.isfile(path):
        return False
    real = os.path.realpath(os.path.abspath(path)).lower()
    if any(real == os.path.realpath(os.path.abspath(e)).lower() for e in extra):
        return True
    return any(_inside(path, d) for d in (comfy_dirs() if dirs is None else dirs))


def _probe(ff: str, path: str) -> dict:
    """Width, height, duration (s), fps from the ffmpeg output; missing values 0."""
    err = subprocess.run([ff, "-hide_banner", "-i", path], capture_output=True, text=True, timeout=30,
                         **_no_window()).stderr
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", err)
    d = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    r = re.search(r"Video:.*?([\d.]+) fps", err)
    return {"w": int(m.group(1)) if m else 0, "h": int(m.group(2)) if m else 0,
            "dur": (int(d.group(1)) * 3600 + int(d.group(2)) * 60 + float(d.group(3))) if d else 0.0,
            "fps": float(r.group(1)) if r else 0.0}


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
    info = anim_info(out, min(x for x in (out_fps(p), fps_cap(p) or 999) if x) if out_fps(p) else 0.0)
    info.update(bytes=os.path.getsize(out), seconds=round(time.time() - t0, 2))
    return info


def render_fit(src: str, out: str, p: dict, max_mb: float = 0.0) -> tuple:
    """Full render; above max_mb the long side shrinks step by step (× 0.85, at most 8 tries).
    Returns (info, note)."""
    p = dict(p)
    info = render(src, out, p)
    limit = int(max_mb * 1048576) if max_mb and max_mb > 0 else 0
    tries = 0
    while limit and info["bytes"] > limit and tries < 8:
        cur = p["long_side"] or max(info["w"], info["h"]) or 480
        p["long_side"] = max(16, int(cur * 0.85) // 2 * 2)
        info = render(src, out, p)
        tries += 1
    note = ""
    if limit:
        note = (f" · fits {max_mb:g} MB" if info["bytes"] <= limit else f" · still above {max_mb:g} MB") + \
               (f" (long side {p['long_side']})" if tries else "")
    return info, note


def human(n: int) -> str:
    return f"{n / 1048576:.1f} MB" if n >= 1048576 else f"{n / 1024:.0f} KB"


def describe(info: dict, note: str = "") -> str:
    return f"{info['w']}×{info['h']} · {info['frames']} frames · {info['dur']:.1f} s · {human(info['bytes'])}{note}"


def save_target(folder: str, filename: str, ext: str, out_dir: str | None = None, make: bool = True) -> str:
    """Where save writes: folder (relative = inside the ComfyUI output folder, default GIF) / filename
    (default GIF#, # = next free number: GIF1, GIF2 …; without # an existing file gets _2, _3 …)."""
    if out_dir is None:
        import folder_paths
        out_dir = folder_paths.get_output_directory()
    folder = (folder or "").strip().strip('"') or "GIF"
    if not os.path.isabs(folder):
        folder = os.path.join(out_dir, folder)
    stem = "".join("_" if c in '<>:"/\\|?*' else c for c in os.path.splitext((filename or "").strip())[0])
    stem = stem.strip(" .") or "GIF#"
    if make:
        os.makedirs(folder, exist_ok=True)
    if "#" in stem:
        n = 1
        while os.path.exists(os.path.join(folder, stem.replace("#", str(n)) + ext)):
            n += 1
        return os.path.join(folder, stem.replace("#", str(n)) + ext)
    out, n = os.path.join(folder, stem + ext), 2
    while os.path.exists(out):
        out, n = os.path.join(folder, f"{stem}_{n}{ext}"), n + 1
    return out


def view_ref(path: str) -> dict:
    """/view address for display: directly if in the output or temp folder, otherwise a copy in temp."""
    import folder_paths
    ap = os.path.abspath(path)
    for kind, base in (("output", folder_paths.get_output_directory()), ("temp", folder_paths.get_temp_directory())):
        base = os.path.abspath(base)
        if _inside(ap, base):
            sub, name = os.path.split(os.path.relpath(ap, base))
            return {"filename": name, "subfolder": sub, "type": kind}
    tmp = os.path.join(folder_paths.get_temp_directory(), "infinite_movie_gif")
    os.makedirs(tmp, exist_ok=True)
    shutil.copy2(ap, os.path.join(tmp, os.path.basename(ap)))
    return {"filename": os.path.basename(ap), "subfolder": "infinite_movie_gif", "type": "temp"}


def _tmp_dir() -> str:
    import folder_paths
    tmp = os.path.join(folder_paths.get_temp_directory(), "infinite_movie_gif")
    os.makedirs(tmp, exist_ok=True)
    return tmp


def prune_previews(folder: str, keep: int = PREVIEW_KEEP) -> int:
    """Delete all but the newest `keep` preview files. Returns the number deleted."""
    files = sorted(glob.glob(os.path.join(folder, "preview_*")), key=os.path.getmtime, reverse=True)
    n = 0
    for f in files[keep:]:
        try:
            os.remove(f)
            n += 1
        except OSError:
            pass
    return n


# ---------------------------------------------------------------------------
# Source resolution
# ---------------------------------------------------------------------------

def _resolve_source(video, images, video_path: str, file: str, images_fps: float) -> str:
    import folder_paths
    if video is not None:
        s = video.get_stream_source()   # path when the video comes from a file, BytesIO otherwise
        if isinstance(s, str) and os.path.isfile(s):
            return s
        path = os.path.join(_tmp_dir(), f"video_{id(video) ^ int(time.time() * 1e6):x}.mp4")
        video.save_to(path)
        return path
    if images is not None:
        from .chunk_upscale_nodes import _images_to_file
        return _images_to_file(images, None, images_fps or 24.0, _tmp_dir())
    p = (video_path or "").strip().strip('"')
    if p:
        if not os.path.isfile(p):
            raise ValueError(f"Movie to GIF: video_path not found: {p}")
        return p
    if file and file != "(none)":
        return folder_paths.get_annotated_filepath(file)
    raise ValueError("Movie to GIF: connect images or video_path, or choose a file.")


def loader_fps(prompt, uid: str) -> float:
    """source_fps = 0 (auto): rate of the frames a VHS Load Video node feeds into `images`
    (force_rate, else the film's own rate, divided by select_every_nth). 0 = unknown."""
    try:
        link = (prompt or {}).get(str(uid), {}).get("inputs", {}).get("images")
        node = prompt.get(str(link[0]), {}) if isinstance(link, list) else {}
        if not str(node.get("class_type", "")).startswith("VHS_LoadVideo"):
            return 0.0
        inp = node.get("inputs", {})
        nth = max(1, int(inp.get("select_every_nth") or 1))
        force = float(inp.get("force_rate") or 0)
        if force > 0:
            return force / nth
        v = str(inp.get("video") or "").strip().strip('"')
        if v and not os.path.isfile(v):
            import folder_paths
            v = folder_paths.get_annotated_filepath(v)
        fps = _probe(_ffmpeg(), v)["fps"] if v and os.path.isfile(v) else 0.0
        return fps / nth if fps else 0.0
    except Exception:  # noqa: BLE001 – unknown loader layout -> fall back to 24
        return 0.0


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
                        "change size, crop, every_nth, trim, direction or colours (nothing is saved); the line "
                        "below shows the result (length, speed, estimated size). save writes the full version to "
                        "output_folder / filename, save as… chooses folder and name. Run renders the full version; "
                        "with auto_save every Run saves (batches).",
            is_output_node=True,
            inputs=[
                io.Video.Input("video", optional=True,
                               tooltip="Video (priority 1), e.g. Load Video."),
                io.Image.Input("images", optional=True, tooltip="Frame batch (priority 2), e.g. VHS Load Video."),
                io.String.Input("video_path", default="", optional=True,
                                tooltip="Path of a film (priority 3), e.g. Assemble → video_path."),
                io.Combo.Input("file", options=_input_videos(), upload=io.UploadType.video, optional=True,
                               tooltip="Film from ComfyUI/input (priority 4, used when nothing else is set)."),
                io.Combo.Input("format", optional=True, options=FORMATS, default=FORMATS[0],
                               tooltip="GIF plays everywhere; animated WebP is usually 3-5× smaller with more colours."),
                io.Int.Input("long_side", optional=True, default=480, min=0, max=4096, step=16,
                             tooltip="Longest side in pixels (0 = original). GIF size grows with the square of it."),
                io.Combo.Input("crop", optional=True, options=list(CROPS), default="none",
                               tooltip="Centre crop to a ratio before scaling (1:1 avatar, 4:5 Instagram, 9:16 story)."),
                io.String.Input("output_folder", optional=True, default="GIF",
                                tooltip="Folder for save and auto_save. Relative = inside the ComfyUI output folder; "
                                        "a full path works too."),
                io.String.Input("filename", optional=True, default="GIF#",
                                tooltip="File name without extension. # = next free number (GIF1, GIF2 …). "
                                        "Never overwrites."),
                io.Boolean.Input("auto_save", display_name="auto_save (batch)", optional=True, default=False,
                                 tooltip="Off: Run only renders and shows the full version – save it with the save "
                                         "button. On: every Run saves (for batches)."),
                io.Float.Input("start", advanced=True, optional=True, default=0.0, min=0.0, max=36000.0, step=0.1,
                               tooltip="Start in seconds."),
                io.Float.Input("end", advanced=True, optional=True, default=0.0, min=0.0, max=36000.0, step=0.1,
                               tooltip="End in seconds (0 = to the end)."),
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
                io.Float.Input("max_mb", advanced=True, optional=True, default=0.0, min=0.0, max=100.0, step=0.5,
                               tooltip="Size limit in MB (0 = off). Above it the GIF is made smaller step by step "
                                       "(long side × 0.85) until it fits – e.g. 8 for Discord, 15 for GitHub."),
                io.Float.Input("source_fps", default=0.0, min=0.0, max=120.0, optional=True,
                               tooltip="Only for the images input: at what rate were these frames made? "
                                       "0 = auto (read from a connected VHS Load Video, else 24). "
                                       "A wrong value makes the GIF play too fast or too slow."),
                io.Int.Input("every_nth", optional=True, default=1, min=1, max=30, step=1,
                             display_mode=io.NumberDisplay.slider,
                             tooltip="Compression by frames: only every n-th frame goes in (1 = all, 2 = every 2nd, "
                                     "10 = every 10th). The GIF always plays at the film's own frame rate, so it gets "
                                     "n times shorter and faster (time-lapse) and about n times smaller. "
                                     f"GIF plays at most {GIF_MAX_FPS} fps."),
            ],
            outputs=[],
            hidden=[io.Hidden.unique_id, io.Hidden.prompt],
        )

    @classmethod
    def fingerprint_inputs(cls, **kw):
        p = (kw.get("video_path") or "").strip().strip('"')
        return f"{p}:{os.path.getmtime(p) if p and os.path.isfile(p) else ''}"

    @classmethod
    def execute(cls, format=FORMATS[0], long_side=480, crop="none", every_nth=1, output_folder="GIF",
                filename="GIF#", auto_save=False, start=0.0, end=0.0, direction="forward", colors=256, dither=DITHERS[0], palette=PALETTES[0],
                quality=80, max_mb=0.0, video=None, images=None, video_path="", file="(none)",
                source_fps=0.0) -> io.NodeOutput:
        hidden = getattr(cls, "hidden", None)
        uid = str(hidden.unique_id) if hidden and hidden.unique_id is not None else ""
        rate = source_fps
        if images is not None and not rate:
            rate = loader_fps(getattr(hidden, "prompt", None), uid) or 24.0
        src = _resolve_source(video, images, video_path, file, rate)
        if uid:
            _LAST_SOURCE[uid] = os.path.abspath(src)
        p = gif_params(format=format, long_side=long_side, crop=crop, every_nth=every_nth, start=start, end=end,
                       direction=direction, colors=colors, dither=dither, palette=palette,
                       quality=quality, src_fps=_probe(_ffmpeg(), src)["fps"])
        full = os.path.join(_tmp_dir(), f"run_{uid or 'x'}{_ext(p)}")
        info, note = render_fit(src, full, p, max_mb)
        text = describe(info, note)
        saved = ""
        if auto_save:
            saved = save_target(output_folder, filename, _ext(p))
            shutil.copy2(full, saved)
        print(f"[InfiniteMovieGif] {saved or full}: {text}")
        ui = {"infinite_movie_gif": [{**view_ref(full), "text": text, "saved": saved, "token": uid}]}
        return io.NodeOutput(ui=ui)


# ---------------------------------------------------------------------------
# Live preview / save routes
# ---------------------------------------------------------------------------

def preview_source(body: dict) -> str:
    """Source from the request: token (last run) > video_path > file. '' = none."""
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


NO_SOURCE = ("No preview: choose a file / video_path, or Run once for a connected input "
             "(video_path must be inside the ComfyUI input/output folders).")


def _request_params(body: dict, src: str, srcinfo: dict) -> dict:
    prm = {k: v for k, v in (body.get("params") or {}).items() if k not in ("src_fps", "max_fps")}
    p = gif_params(**prm, src_fps=srcinfo.get("fps", 0.0))
    if isinstance(body.get("loader"), dict):   # images from a VHS loader: same frames as in a Run
        try:
            sf = float(prm.get("source_fps") or 0)
        except (TypeError, ValueError):
            sf = 0.0
        p["pre"], p["src_fps"] = loader_filter(body["loader"], srcinfo.get("fps", 0.0), sf)
    return p


def gif_preview(body: dict) -> dict:
    import folder_paths
    src = preview_source(body)
    if not src:
        return {"ok": False, "message": NO_SOURCE}
    srcinfo = _probe(_ffmpeg(), src)
    p = _request_params(body, src, srcinfo)
    full = dict(p)
    p["long_side"] = min(p["long_side"] or PREVIEW_LONG, PREVIEW_LONG)
    p["max_fps"] = PREVIEW_FPS
    tmp = _tmp_dir()
    key = hashlib.sha1(json.dumps([src, os.path.getmtime(src), p]).encode()).hexdigest()[:16]
    out = os.path.join(tmp, f"preview_{key}{_ext(p)}")
    if os.path.isfile(out):
        info = {**anim_info(out, min(out_fps(p) or PREVIEW_FPS, PREVIEW_FPS)), "bytes": os.path.getsize(out)}
    else:
        info = render(src, out, p, max_seconds=PREVIEW_MAX_S, timeout=60)
        prune_previews(tmp)
    # Estimate of the full size: area x frame rate x duration compared to the preview
    est = None
    dur_src = srcinfo.get("dur") or 0.0
    end = min(full["end"], dur_src) if (full["end"] and dur_src) else (full["end"] or dur_src)
    span = max(end - full["start"], 0.0)
    nth, boom = full["nth"], 2 if full["direction"] == "boomerang" else 1
    if p.get("pre"):   # loader frames: the preview shows all of them when it is shorter than the 8 s window
        covered = info["dur"] * nth / boom
        if covered < PREVIEW_MAX_S - 0.3:
            span = covered
    rate = out_fps(full)
    f_full = min(rate or 24.0, fps_cap(full) or 999)
    dur_full = span / nth * boom
    if info.get("w") and info.get("h") and srcinfo.get("w") and span and info.get("frames"):
        # size ≈ preview bytes per frame × area ratio × frames of the full version
        L = full["long_side"] or max(srcinfo["w"], srcinfo["h"])
        scale = L / max(info["w"], info["h"])
        est = int(info["bytes"] / info["frames"] * scale * scale * dur_full * f_full)
    rel = os.path.relpath(out, folder_paths.get_temp_directory())
    sub, name = os.path.split(rel)
    result = (f"{span:.1f} s → {dur_full:.1f} s" if span else "") + \
        (f" · {nth}× faster" if nth > 1 else "") + \
        (f" · plays {f_full:g} fps" if rate else "") + (f" · ≈ {human(est)}" if est else "")
    return {"ok": True, "filename": name, "subfolder": sub, "type": "temp",
            "message": result.strip(" ·") + (f" · preview: first {PREVIEW_MAX_S:g} s" if span > PREVIEW_MAX_S else "")}


def gif_target(body: dict) -> str:
    """Path the next save writes to (tooltip of the save button). '' = no source yet."""
    src = preview_source(body)
    if not src:
        return ""
    prm = body.get("params") or {}
    return save_target(prm.get("output_folder", "GIF"), prm.get("filename", "GIF#"),
                       _ext(gif_params(format=prm.get("format"))), make=False)


def gif_save(body: dict, local: bool) -> dict:
    """Render the full version with the request's values and save it (like Preview Image MM):
    save_as = full path from the save dialog (only from this computer) or a plain name inside output_folder;
    empty = output_folder / filename; temp_only = only render (browser save picker on another computer
    writes it)."""
    import folder_paths
    src = preview_source(body)
    if not src:
        return {"ok": False, "message": NO_SOURCE}
    p = _request_params(body, src, _probe(_ffmpeg(), src))
    ext = _ext(p)
    name = str(body.get("save_as") or "").strip().strip('"')
    try:
        max_mb = float(body.get("max_mb") or 0)
    except (TypeError, ValueError):
        max_mb = 0.0
    if body.get("temp_only"):
        out = os.path.join(_tmp_dir(), f"save_{int(time.time() * 1000)}{ext}")
        info, note = render_fit(src, out, p, max_mb)
        return {"ok": True, "path": "", "text": describe(info, note), **view_ref(out)}
    if name and os.path.isabs(name):
        if not local and not _inside(name, folder_paths.get_output_directory()):
            return {"ok": False, "message": "From another computer you can only save inside the output folder."}
        target = os.path.splitext(os.path.abspath(name))[0] + ext   # the dialog asked before overwriting
    else:
        prm = body.get("params") or {}
        target = save_target(prm.get("output_folder", "GIF"), name or prm.get("filename", "GIF#"), ext)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    full = os.path.join(_tmp_dir(), f"save_{hashlib.sha1(target.encode()).hexdigest()[:12]}{ext}")
    info, note = render_fit(src, full, p, max_mb)
    shutil.copy2(full, target)
    os.remove(full)
    text = describe(info, note)
    print(f"[InfiniteMovieGif] saved {target}: {text}")
    return {"ok": True, "path": target, "text": text, **view_ref(target)}


# Windows save dialog in front of the browser (ComfyUI runs in the background, Windows refuses focus:
# invisible topmost owner window + ALT tap). Same approach as Preview Image MM.
_WIN_DIALOG_SCRIPT = r'''
import ctypes, json, os, sys
from ctypes import wintypes
start_dir, name = sys.argv[1], sys.argv[2]
user32 = ctypes.WinDLL("user32", use_last_error=True)
comdlg32 = ctypes.WinDLL("comdlg32")
kernel32 = ctypes.WinDLL("kernel32")
user32.CreateWindowExW.restype = wintypes.HWND
user32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                                   ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                   wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
kernel32.GetModuleHandleW.restype = wintypes.HMODULE

class OPENFILENAMEW(ctypes.Structure):
    _fields_ = [("lStructSize", wintypes.DWORD), ("hwndOwner", wintypes.HWND),
                ("hInstance", wintypes.HINSTANCE), ("lpstrFilter", wintypes.LPCWSTR),
                ("lpstrCustomFilter", wintypes.LPWSTR), ("nMaxCustFilter", wintypes.DWORD),
                ("nFilterIndex", wintypes.DWORD), ("lpstrFile", wintypes.LPWSTR),
                ("nMaxFile", wintypes.DWORD), ("lpstrFileTitle", wintypes.LPWSTR),
                ("nMaxFileTitle", wintypes.DWORD), ("lpstrInitialDir", wintypes.LPCWSTR),
                ("lpstrTitle", wintypes.LPCWSTR), ("Flags", wintypes.DWORD),
                ("nFileOffset", wintypes.WORD), ("nFileExtension", wintypes.WORD),
                ("lpstrDefExt", wintypes.LPCWSTR), ("lCustData", wintypes.LPARAM),
                ("lpfnHook", wintypes.LPVOID), ("lpTemplateName", wintypes.LPCWSTR),
                ("pvReserved", wintypes.LPVOID), ("dwReserved", wintypes.DWORD),
                ("FlagsEx", wintypes.DWORD)]

owner = user32.CreateWindowExW(0x88, "STATIC", "Movie to GIF", 0x80000000, 0, 0, 0, 0,
                               None, None, kernel32.GetModuleHandleW(None), None)
user32.keybd_event(0x12, 0, 0, 0)
user32.keybd_event(0x12, 0, 2, 0)
user32.SetForegroundWindow(owner)
first = os.path.basename(name)
if start_dir and os.path.isdir(start_dir):
    first = os.path.join(start_dir, first)   # a full path beats the dialog's remembered folder
buf = ctypes.create_unicode_buffer(first, 32768)
ofn = OPENFILENAMEW()
ofn.lStructSize = ctypes.sizeof(OPENFILENAMEW)
ofn.hwndOwner = owner
ofn.lpstrFilter = "GIF / WebP\0*.gif;*.webp\0All files\0*.*\0\0"
ofn.nFilterIndex = 1
ofn.lpstrFile = ctypes.cast(buf, wintypes.LPWSTR)
ofn.nMaxFile = len(buf)
ofn.lpstrInitialDir = start_dir or None
ofn.Flags = 0x80000 | 0x8 | 0x800 | 0x2   # EXPLORER | NOCHANGEDIR | PATHMUSTEXIST | OVERWRITEPROMPT
ofn.lpstrDefExt = os.path.splitext(name)[1].lstrip(".") or "gif"
ok = comdlg32.GetSaveFileNameW(ctypes.byref(ofn))
user32.DestroyWindow(owner)
sys.stdout.write("\nGIFPATH:" + json.dumps(buf.value if ok else "") + "\n")
'''


def save_dialog(start_dir: str, name: str) -> str:
    """The Windows save dialog on the ComfyUI computer. '' = cancelled."""
    import sys
    r = subprocess.run([sys.executable, "-I", "-c", _WIN_DIALOG_SCRIPT, start_dir or "", name or ""],
                       capture_output=True, text=True, encoding="utf-8", timeout=3600)
    lines = [x[8:] for x in (r.stdout or "").splitlines() if x.startswith("GIFPATH:")]
    if r.returncode != 0 or not lines:
        raise RuntimeError(f"save dialog failed: {(r.stderr or '').strip()[-300:]}")
    return json.loads(lines[-1])


def dialog_start(body: dict) -> tuple:
    """(start folder, suggested name) for save as…: the folder and name the next save would use."""
    t = gif_target(body)
    if not t:
        return "", "movie.gif"
    d = os.path.dirname(t)
    while d and not os.path.isdir(d):   # default folder not created yet -> its parent
        d = os.path.dirname(d) if os.path.dirname(d) != d else ""
    return d, os.path.basename(t)


def _register_routes():
    import asyncio
    try:
        from aiohttp import web
        from server import PromptServer
        from .settings_nodes import _own_addresses

        async def _body(request):
            try:
                return await request.json()
            except Exception:  # noqa: BLE001
                return {}

        @PromptServer.instance.routes.post("/infinite_movie/gif_preview")
        async def _gif_preview(request):
            body = await _body(request)
            try:
                res = await asyncio.to_thread(gif_preview, body)
            except Exception as e:  # noqa: BLE001
                res = {"ok": False, "message": f"preview failed: {e}"}
            return web.json_response(res)

        @PromptServer.instance.routes.post("/infinite_movie/gif_save")
        async def _gif_save(request):
            body = await _body(request)
            local = (request.remote or "") in _own_addresses()
            try:
                res = await asyncio.to_thread(gif_save, body, local)
            except Exception as e:  # noqa: BLE001
                res = {"ok": False, "message": f"save failed: {e}"}
            return web.json_response(res)

        @PromptServer.instance.routes.post("/infinite_movie/gif_target")
        async def _gif_target(request):
            body = await _body(request)
            try:
                return web.json_response({"ok": True, "target": await asyncio.to_thread(gif_target, body)})
            except Exception as e:  # noqa: BLE001
                return web.json_response({"ok": False, "message": str(e)})

        @PromptServer.instance.routes.post("/infinite_movie/gif_dialog")
        async def _gif_dialog(request):
            # only for a browser on the ComfyUI computer (the dialog opens there) and only on Windows
            if (request.remote or "") not in _own_addresses() or os.name != "nt":
                return web.json_response({"ok": False, "local": False})
            body = await _body(request)
            try:
                start, name = await asyncio.to_thread(dialog_start, body)
                path = await asyncio.to_thread(save_dialog, start, name)
                return web.json_response({"ok": True, "path": path})
            except Exception as e:  # noqa: BLE001
                return web.json_response({"ok": False, "message": str(e)})
    except Exception as e:  # noqa: BLE001 - without a server (unit tests) no route
        print(f"[InfiniteMovieGif] routes not registered: {e}")


_register_routes()

GIF_NODE_LIST = [InfiniteMovieGif]
