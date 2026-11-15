"""InfiniteMovieRender custom nodes (V3 ComfyNode API).

Nodes:
- InfiniteMovieRender (Director): the storyboard (images + one prompt per film) expands into one
  engine render per film and returns the sync pipe (films + settings) for Cut.
- InfiniteMovieSegmentSave: writes one segment's frames to an mp4 file (ffmpeg).
- InfiniteMovieSegmentPaths / InfiniteMovieShotsOut: internal collector + blocking
  bridge to the sync output.

All names are English (package, classes, node_id, display_name, inputs,
outputs, category, log).
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import time

import numpy as np
import torch

from comfy_api.latest import io

from . import vram
from .expansion import build_expansion_graph, engine_to_template, segment_path, segment_path_b
from .media import (_count_frames, _encode_dir_to_mp4, _ffmpeg, _no_window, _segment_is_complete, _write_audio_to_wav, _write_frames_to_dir,
                    send_ui)
from .shot_utils import (_clean_prompt, _parse_reseed, _parse_shot_seconds, _scene_frames, _seconds_to_frames,
                           center_crop_resize)
# settings_nodes imports only .vram + lazy .autoprompt - no cycle
from .settings_nodes import SETTINGS, get_setting, chain_settings, ASPECT_FROM_IMAGES, film_folder, resolve_ratio

from . import storyboard as _storyboard

# The pipe from the Director to Cut and Even Motion: films, folder, name, fps, loop, size, … and the settings.
SYNC = io.Custom("SYNC")


# ---------------------------------------------------------------------------
# 88: per-segment timing marks. InfiniteMovieRender stamps the wall-clock start
# (keyed by its own unique_id) after the GPU wait, only when something renders;
# each InfiniteMovieSegmentSave measures the time since the previous mark of the
# same render and appends one line to the timings JSONL (timing.py). Reused
# segments (PrimitiveString) never run SegmentSave, so they are not logged (intended).
# ---------------------------------------------------------------------------

_SEG_MARK: dict = {}   # render unique_id (str) -> time.time() of last mark
_SEG_META: dict = {}   # render unique_id (str) -> {width, height, length, preset, variants}


def _render_id_from(unique_id) -> str | None:
    """88: the render node's unique_id is the prefix of a SegmentSave node's own
    unique_id before the first '_' or '.'.

    SegmentSave IDs are built as f"{render_uid}_s{i}_" + template_save_id
    (expansion.py:856 prefix_a, :880 prefix_b, :724 save_id = prefix + save_src).
    The render node's own ID is a plain ComfyUI node id (e.g. "4" in
    example_workflows/Infinite Movie.json), so the prefix before the first
    separator is exactly the render unique_id.
    """
    if not unique_id:
        return None
    s = str(unique_id)
    for i, ch in enumerate(s):
        if ch == "_" or ch == ".":
            s = s[:i]
            break
    return s or None


def _log_segment_timing(unique_id, frames) -> None:
    """88: measure the time since the previous mark of this render and append
    one line to the timings JSONL. No mark (offline test, reused segment) -> no-op.
    Never raises: a timing bug must never break a render.
    """
    if not unique_id:
        return
    render_id = _render_id_from(unique_id)
    if render_id is None or render_id not in _SEG_MARK:
        return
    meta = _SEG_META.get(render_id, {})
    now = time.time()
    elapsed = now - _SEG_MARK[render_id]
    _SEG_MARK[render_id] = now  # reset the mark for the next segment
    try:
        from . import timing  # lazy: timing.py is stdlib-only, no cycle
        timing.record(
            "segment",
            width=meta.get("width"),
            height=meta.get("height"),
            frames=frames,
            seconds=elapsed,
            preset=meta.get("preset", ""),
            variants=meta.get("variants", 1),
        )
    except Exception as e:  # noqa: BLE001
        print(f"[InfiniteMovieSegmentSave] timing record failed (ignored): {e}")


def _send_progress(text: str, node_id: str) -> None:
    """Send progress text to the browser (no-op if the server is not running).

    Signature: PromptServer.send_progress_text(text, node_id, sid=None)
    (ComfyUI/server.py:1588). Usage pattern: nodes_loop.py:304.

    The frontend renders this as a READ-ONLY widget on the node (the
    `$$node-text-preview` widget, type `progressText`); it is visible while the
    job runs and cleared when the job resets.
    """
    try:
        from server import PromptServer
        inst = PromptServer.instance
        if inst is not None and node_id is not None:
            inst.send_progress_text(text, node_id)
    except Exception:
        pass


def _send_render_plan(node_id, segments: int, width: int, height: int, frames: int, preset: str) -> dict:
    """Render plan for the progress bar on the Render node (user 2026-11-10: "make a progress bar").

    Sends `infinite_movie.render_plan` {node, segments, frames, width, height, seg_seconds, n, match}; seg_seconds is
    the per-shot estimate from the recorded timings of THIS machine (timing.estimate, Auftrag 88) or None (no history
    yet -> the bar falls back to sampler progress). Never raises. Returns the payload (for tests).
    """
    est = None
    try:
        from . import timing
        est = timing.estimate("segment", width, height, frames, preset=preset)
    except Exception:  # noqa: BLE001
        est = None
    data = {"node": str(node_id), "segments": int(segments), "frames": int(frames),
            "width": int(width), "height": int(height),
            "seg_seconds": (est or {}).get("seconds"), "n": (est or {}).get("n", 0),
            "match": (est or {}).get("match", "")}
    send_ui("infinite_movie.render_plan", data)
    return data


def _send_segment_done(unique_id, index, total, frames):
    """119: notify the Cut node that segment `index` of this render is done.

    Sends `infinite_movie.segment_done` {node, index, total, seconds, view}:
    `node` is the render node's id (the Cut node's Director), `index` is 0-based
    (expansion.py:877 `for i, (...) in enumerate(plan)` -> `inputs["index"] = i`),
    `seconds` is the wall-clock time since the previous segment of this render
    (read from `_SEG_MARK` BEFORE `_log_segment_timing` resets the mark), and
    `view` is the middle frame as a JPEG (long side <= 512) in the temp
    directory. Never raises: a side-channel bug must never break a render.
    Returns the payload (for tests).
    """
    data = {"node": _render_id_from(unique_id), "index": int(index), "total": int(total),
            "seconds": None, "view": None}
    try:
        mark = _SEG_MARK.get(data["node"])
        if mark is not None:
            data["seconds"] = round(time.time() - mark, 3)
        if isinstance(frames, torch.Tensor) and frames.shape[0] > 0:
            from PIL import Image
            import folder_paths
            mid = frames[frames.shape[0] // 2]
            arr = np.clip(mid.detach().cpu().numpy(), 0.0, 1.0)
            if arr.ndim == 3 and arr.shape[-1] == 1:
                arr = np.repeat(arr, 3, axis=-1)
            img = Image.fromarray((arr * 255).astype(np.uint8))
            w, h = img.size
            scale = min(1.0, 512.0 / max(w, h))
            if scale < 1.0:
                img = img.resize((max(1, int(round(w * scale))), max(1, int(round(h * scale)))), Image.LANCZOS)
            name = f"im_seg_{data['node']}_{data['index']}.jpg"
            img.save(os.path.join(folder_paths.get_temp_directory(), name), quality=85)
            data["view"] = {"filename": name, "subfolder": "", "type": "temp"}
    except Exception:  # noqa: BLE001
        pass
    send_ui("infinite_movie.segment_done", data)
    return data


def _display_node_id(cls) -> str | None:
    """Return the VISIBLE node id to send in-node text to.

    For nodes that run inside a InfiniteMovieRender expansion the engine assigns an
    ephemeral id; the text must be sent to the DISPLAY id (the visible parent
    node) so it lands on the right node on the canvas.
    dynprompt.get_display_node_id walks the ephemeral_display map
    (comfy_execution/graph.py:64-67). Falls back to the plain unique_id for
    top-level (non-expanded) nodes.
    """
    try:
        hid = cls.hidden
        if hid is None:
            return None
        uid = hid.unique_id
        dp = getattr(hid, "dynprompt", None)
        if dp is not None and hasattr(dp, "get_display_node_id"):
            return dp.get_display_node_id(uid) or uid
        return uid
    except Exception:
        return None


def _display_memory(cls, tag: str = "") -> str:
    """Show the current VRAM/RAM status on the node and return the string.

    tag is a short prefix such as "before" / "after" so the user can tell the
    two readings apart (the widget shows the latest message only).
    """
    status = vram.get_memory_status()
    text = f"{tag} {status}".strip() if tag else status
    _send_progress(text, _display_node_id(cls))
    print(f"[InfiniteMovie] {text}")
    return status


# ---------------------------------------------------------------------------
# Node: InfiniteMovieRender
# ---------------------------------------------------------------------------


def _resolve_film_name(settings):
    """Settings › film_name (empty = "film"); Windows-safe, without .mp4."""
    n = str(get_setting(settings, "film_name") or "").strip() or "film"
    n = re.sub(r'[<>:"/\\|?*]', "_", n).strip() or "film"
    if n.lower().endswith(".mp4"):
        n = n[:-4] or "film"
    if n in (".", ".."):
        n = "film"
    return n

class InfiniteMovieRender(io.ComfyNode):
    """The Director: storyboard (images + one prompt per film) -> one engine render per film -> sync for Cut."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieRender",
            display_name="Director · Infinite Movie",
            search_aliases=["infinite movie", "infinite_movie", "film", "movie", "video", "ltx", "wan",
                            "render", "director", "storyboard"],
            category="Infinite Movie/2 Render",
            description="Turns the storyboard (images, one prompt per film between two images) into one video per "
                        "film with the engine group, and hands them to Cut over sync (the settings travel along). "
                        "Writes the prompts with the LLM from the settings chain (Regenerate / Write all prompts).",
            is_output_node=True,
            enable_expand=True,
            inputs=[
                # Sockets first (all optional - the frontend sorts required ones above optional ones), then widgets.
                SETTINGS.Input("settings", optional=True, display_name="settings",
                               tooltip="Settings chain (format, film name, LLM, GPU handoff). Without it the built-in defaults apply."),
                # lazy: the engine chain is not executed as an input - the Director reads the engine group from the
                # dynprompt (expansion.engine_to_template). Unconnected = the single non-muted engine group.
                io.String.Input("engine", force_input=True, lazy=True, optional=True,
                                tooltip="Engine Result of the engine group to use. Unconnected: the single non-muted engine group."),
                io.String.Input("storyboard", default="[]", advanced=True, optional=True,
                                tooltip="Storyboard JSON (image, prompt per row) - edited in the Director's storyboard."),
                io.String.Input("regen", default="", advanced=True, optional=True,
                                tooltip="Set by the storyboard: rows whose prompt gets written (no render). Empty = render."),
                io.String.Input("shot_seconds", default="", advanced=True, optional=True,
                                tooltip="Length of each film in seconds, comma separated; empty or 0 = 'seconds'. "
                                        "Set with ⏱ in the storyboard or in Cut."),
                io.Boolean.Input("loop", default=True,
                                 tooltip="true = one more film from the last image back to the first, so the film loops."),
                io.Float.Input("seconds", default=2.0, min=0.5, step=0.5,
                               tooltip="Default length of a film in seconds, snapped to the engine's frame grid "
                                       "(LTX 24 fps 8n+1: 1 s = 25, 2 s = 49 frames)."),
                # fixed, not randomize: a new base seed re-renders EVERY film (night debug 120, 2026-11-13)
                io.Int.Input("seed", default=42, control_after_generate=io.ControlAfterGenerate.fixed,
                             tooltip="Base seed (film i: seed + i). Changing it re-renders all films; "
                                     "✗ REDO in Cut gives single films a new seed."),
                io.String.Input("reseed", default="",
                                tooltip="Films to render again with a new seed, e.g. '2' or '2,4' (written by ✗ REDO in Cut). "
                                        "Each mention adds 1000 to that film's seed."),
                io.Combo.Input("variants", options=["1", "2"], default="1", advanced=True,
                               tooltip="'2' renders every film twice (seed and seed + 500) - pick A or B per film in Cut."),
            ],
            outputs=[
                # sync is a link to the internal ShotsOut node hanging on the collector of all films: the Director
                # thereby waits for every film without a visible output (execution.py strong links).
                SYNC.Output("sync", display_name="sync",
                            tooltip="All films (paths, folder, name, fps, loop …) and the settings, for Cut."),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.dynprompt],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("NaN")   # NaN != NaN: always run (the films decide themselves what is reused)

    @classmethod
    def check_lazy_status(cls, *args, **kwargs):
        return []   # the lazy engine input is never awaited (read from the dynprompt)

    @classmethod
    def execute(cls, storyboard="[]", loop=True, seconds=2.0, seed=42, reseed="", engine=None,
                shot_seconds="", settings=None, variants="1", regen=""):
        board = _storyboard.parse(storyboard)
        if str(regen).strip():   # ↻ Regenerate / ✎ Write all: write these prompts, render nothing
            from .director_prompts import parse_indices, write_prompts
            return io.NodeOutput(None, ui={"im_prompts": write_prompts(board, parse_indices(regen), loop, settings,
                                                                       node_id=getattr(getattr(cls, "hidden", None), "unique_id", None))})

        uid = cls.hidden.unique_id
        template, cfg = engine_to_template(getattr(cls.hidden, "dynprompt", None), uid)
        cfg = dict(cfg, audio=bool(get_setting(settings, "audio")))
        preset = cfg["preset"]
        _display_memory(cls, "before")

        raw = _storyboard.load_images(board)   # images and prompts only from the storyboard (user 2026-11-15)
        if not raw:
            raise ValueError("Director: no images - add images in the storyboard")
        width, height = _film_size(settings, cfg, raw[0])
        tensors = [torch.from_numpy(np.ascontiguousarray(center_crop_resize(im, width, height))).unsqueeze(0).float() / 255.0
                   for im in raw[:_storyboard.MAX_IMAGES]]
        # _seconds_to_frames already lands on the engine's (mod*n+1) grid - no extra snap.
        length = _seconds_to_frames(seconds, cfg["fps"], cfg["length_mod"])
        n = len(tensors)
        n_films = _storyboard.film_count(n, loop)
        prompts = [_clean_prompt(p) for p in _storyboard.prompt_list(board, n_films)]
        film_seconds = _parse_shot_seconds(shot_seconds)
        own = _scene_frames(film_seconds, cfg["fps"], cfg["length_mod"], length)
        # Film k takes the length of its row (storyboard.row_of); the way back of a
        # single image belongs to that image, so both films share the one row.
        frames = [own[_storyboard.row_of(n, k)] if _storyboard.row_of(n, k) < len(own) else length for k in range(n_films)]
        variants = 2 if str(variants) == "2" else 1
        name = _resolve_film_name(settings)
        folder = film_folder(settings)
        output_dir = os.path.join(folder, "cache_movies", name)
        try:
            os.makedirs(output_dir, exist_ok=True)
        except OSError as e:
            # A non-writable location must not surface as a raw PermissionError/FileExistsError traceback.
            raise ValueError(f"Director: cannot create output folder '{output_dir}': {e}") from e
        print(f"[InfiniteMovie] {n_films} films, {width}x{height}, {length} frames ({seconds:g} s), "
              f"own lengths {film_seconds or '-'}, variants {variants}, preset {preset}, out {output_dir}")
        for k, p in enumerate(prompts):
            print(f"[InfiniteMovie] film {k + 1} prompt: {p[:80]}")

        films = _storyboard.film_rows(board, loop)   # rows marked cut start no film: hard cut after the one before
        if not films:
            raise ValueError("Director: every film is cut - remove a cut")
        graph, renders = build_expansion_graph(
            unique_id=uid, preset=preset, images=tensors, prompts=prompts, seed=seed,
            width=width, height=height, length=length, loop=loop, output_dir=output_dir,
            frames=frames, seed_bumps=_parse_reseed(reseed), template=template, cfg=cfg,
            variants=variants, films=films)
        # GPU only when something renders (all films reused -> no waiting, no unloading)
        if renders:
            vram.wait_acquire(min_free_mb=get_setting(settings, "min_free_mb"),
                              timeout_s=get_setting(settings, "acquire_timeout_s"))
            _SEG_MARK[str(uid)] = time.time()   # the GPU wait is not part of the first film's time
            _SEG_META[str(uid)] = {"width": width, "height": height, "length": length, "preset": preset, "variants": variants}
            _send_render_plan(_display_node_id(cls) or uid, len(films), width, height, length, preset)
        else:
            print("[InfiniteMovie] all films reused -> no GPU acquire")
        _display_memory(cls, "after")

        paths = [segment_path(output_dir, k) for k in films]
        sync = {
            "segments": paths,
            "save_folder": folder,
            "save_name": name,
            "fps": cfg.get("fps", 24.0),
            "loop": loop,
            "width": width,
            "height": height,
            "frames_per_segment": length,
            "seed": seed,
            "render_id": uid,
            "scene_frames": [frames[k] for k in films],
            "films": films,   # film id (storyboard row) of each segment
            "settings": chain_settings(settings),   # behind the Director the settings travel in sync
            "hard_cuts": _storyboard.hard_cuts(films, n_films, loop),   # segment positions followed by a hard cut
        }
        if variants == 2:   # segments stays the A list: Even Motion without Cut works unchanged
            sync["variants"] = [[a, segment_path_b(output_dir, k)] for k, a in zip(films, paths)]
        out_id = f"{uid}_shots"
        graph[out_id] = {"class_type": "InfiniteMovieShotsOut",
                         "inputs": {"segment_paths": [f"{uid}_collector", 0], "sync": sync}}
        return io.NodeOutput([out_id, 0], expand=graph)


def _film_size(settings, cfg, first_image) -> tuple[int, int]:
    """Film size from Settings (0 = the engine default); aspect "from images" = the shape of image 1."""
    if get_setting(settings, "aspect") == ASPECT_FROM_IMAGES:
        h0, w0 = first_image.shape[:2]
        return resolve_ratio(w0, h0, get_setting(settings, "long_side"))
    width, height = get_setting(settings, "width"), get_setting(settings, "height")
    return width if width > 0 else cfg["default_width"], height if height > 0 else cfg["default_height"]


# ---------------------------------------------------------------------------
# Node: InfiniteMovieSegmentSave
# ---------------------------------------------------------------------------

class InfiniteMovieSegmentSave(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieSegmentSave", is_dev_only=True,
            display_name="Segment Save (internal) · Infinite Movie",
            search_aliases=["infinite movie", "infinite_movie", "film", "movie", "video", "ltx", "wan"],
            category="Infinite Movie/9 Internal",
            description="Writes one segment's frames to an mp4 file (ffmpeg). Skips if the segment already exists and is complete (resume).",
            is_output_node=True,
            inputs=[
                io.Image.Input("frames", tooltip="Frames tensor (B, H, W, C) float [0,1]."),
                io.String.Input("path", tooltip="Output mp4 path for this segment."),
                io.Int.Input("index", default=0, tooltip="Segment index (for logging/progress)."),
                io.Int.Input("total", default=1, tooltip="Total number of segments (for progress)."),
                io.Int.Input("fps", default=16, tooltip="Frame rate for the segment."),
                io.String.Input("key", optional=True,
                                tooltip="Render key (seed/prompt/images/length). An existing file is reused only when its key matches."),
                io.String.Input("trigger", optional=True,
                                tooltip="Dependency input (value ignored). Used to force execution order."),
                io.Audio.Input("audio", optional=True,
                               tooltip="Optional audio (AUDIO) to mux into the segment mp4 as AAC (LTX 2.5)."),
            ],
            outputs=[
                io.String.Output("path", tooltip="Path to the written segment mp4."),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, frames, path, index=0, total=1, fps=16, trigger=None, key=None, audio=None):
        # cls.hidden is set by the ComfyUI engine at runtime; it is None when
        # execute() is called directly (e.g. from the offline test).
        unique_id = None
        try:
            unique_id = cls.hidden.unique_id
        except AttributeError:
            pass
        expected_frames = frames.shape[0] if isinstance(frames, torch.Tensor) else -1
        _send_progress(f"segment {index}/{total}", unique_id)
        key_file = path + ".key"
        old_key = open(key_file, encoding="utf-8").read().strip() if os.path.exists(key_file) else None
        if _segment_is_complete(path, expected_frames) and (key is None or key == old_key):
            print(f"[InfiniteMovieSegmentSave] segment {index} already complete, skipping: {path}")
            # 119: the Cut node sees reused segments too (no timing mark is reset
            # here - _log_segment_timing is not called for skipped segments).
            _send_segment_done(unique_id, index, total, frames)
            return io.NodeOutput(path)
        if os.path.exists(path):
            # Never overwrite: keep the previous render under old/ (seg_001_01.mp4, ...).
            old_dir = os.path.join(os.path.dirname(path), "old")
            os.makedirs(old_dir, exist_ok=True)
            stem, ext = os.path.splitext(os.path.basename(path))
            n = 1
            while os.path.exists(os.path.join(old_dir, f"{stem}_{n:02d}{ext}")):
                n += 1
            shutil.move(path, os.path.join(old_dir, f"{stem}_{n:02d}{ext}"))
            print(f"[InfiniteMovieSegmentSave] moved previous segment {index} to old/{stem}_{n:02d}{ext}")

        with tempfile.TemporaryDirectory(prefix="infinite_movie_seg_") as tmp:
            _write_frames_to_dir(frames, tmp, fps)
            audio_wav = None
            if audio is not None:
                audio_wav = os.path.join(tmp, "audio.wav")
                _write_audio_to_wav(audio, audio_wav)
            _encode_dir_to_mp4(tmp, path, fps, audio_wav)
        if key:
            with open(key_file, "w", encoding="utf-8") as f:
                f.write(key)
        print(f"[InfiniteMovieSegmentSave] wrote segment {index}: {path} ({expected_frames} frames)")
        # 119: live segment tile in the Cut node (middle frame + per-shot render
        # time). MUST run BEFORE _log_segment_timing: that resets the _SEG_MARK
        # mark (see above), so the seconds delta is only valid up to this line.
        _send_segment_done(unique_id, index, total, frames)
        # 88: log the per-segment duration (time since the previous mark of this
        # render). Reused segments (PrimitiveString) never run execute(), so they
        # are not logged (intended). The early "already complete" skip returns
        # before this line, so resumed segments are not logged either.
        _log_segment_timing(unique_id, expected_frames)
        return io.NodeOutput(path)


# ---------------------------------------------------------------------------
# Node: InfiniteMovieSegmentPaths (collector)
# ---------------------------------------------------------------------------

class InfiniteMovieSegmentPaths(io.ComfyNode):
    """Joins the per-segment mp4 paths into one multiline string.

    Primary use: an internal collector inside the InfiniteMovieRender expansion. The
    expansion links one Autogrow input per segment to the corresponding
    InfiniteMovieSegmentSave output, so this node DEPENDS ON EVERY segment. Because
    InfiniteMovieRender's segment_paths output is a link to this collector, the parent
    node is blocked until all segments have finished (execution.py:600-613).
    It is also usable standalone to combine segment paths.
    """

    @classmethod
    def define_schema(cls):
        segment_template = io.Autogrow.TemplatePrefix(
            io.String.Input("segment", optional=True,
                            tooltip="One segment mp4 path."),
            prefix="segment",
            min=1,
            max=24,
        )
        return io.Schema(
            node_id="InfiniteMovieSegmentPaths", is_dev_only=True,
            display_name="Segment Paths (internal) · Infinite Movie",
            search_aliases=["infinite movie", "infinite_movie", "film", "movie", "video", "ltx", "wan"],
            category="Infinite Movie/9 Internal",
            description="Joins the segment mp4 paths (one per input) into a single multiline string. Inside InfiniteMovieRender it acts as the ordering collector that depends on every segment.",
            is_output_node=True,
            inputs=[
                io.Autogrow.Input(
                    "segments",
                    template=segment_template,
                    tooltip="One segment mp4 path per input, in order.",
                ),
            ],
            outputs=[
                io.String.Output("segment_paths",
                                 tooltip="All segment paths, one per line."),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.dynprompt],
        )

    @classmethod
    def execute(cls, segments=None):
        # Autogrow arrives as a dict {segment_0: path, segment_1: path, ...}
        # (comfy_api/latest/_io.py build_nested_inputs, line 2095). A plain
        # list is also accepted (offline test).
        if isinstance(segments, dict):
            # sort numerically (segment10 not before segment2)
            def _idx(k):
                d = "".join(c for c in str(k) if c.isdigit())
                return int(d) if d else 0
            values = [segments[k] for k in sorted(segments, key=_idx)]
        else:
            values = list(segments or [])
        paths = [str(v).strip() for v in values if v is not None and str(v).strip()]
        if not paths:
            raise ValueError("InfiniteMovieSegmentPaths: no segment paths provided")
        return io.NodeOutput("\n".join(paths))


# ---------------------------------------------------------------------------
# Node: InfiniteMovieShotsOut (internal, Auftrag 71)
# ---------------------------------------------------------------------------

class InfiniteMovieShotsOut(io.ComfyNode):
    """71: internal blocking bridge for the Director.

    The Director returns its `sync` output as a link to this node.
    This node hangs on the collector (`segment_paths`, link) and takes the
    shots dict as a literal; it returns the dict with the real
    segment paths (from the collector). The Director thereby waits for
    all segments without needing a visible output
    (execution.py:599-612: strong link from link values).
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieShotsOut", is_dev_only=True,
            display_name="Shots Out (internal) · Infinite Movie",
            search_aliases=["infinite movie", "infinite_movie", "film", "movie", "video", "ltx", "wan"],
            category="Infinite Movie/9 Internal",
            description="Internal bridge: takes the shots dict (literal) and the collector's segment_paths (link) and returns the shots dict with the real segment paths. Used by InfiniteMovieRender to block on the expansion without a visible output.",
            is_output_node=True,
            inputs=[
                io.String.Input("segment_paths",
                                tooltip="All segment paths, one per line (link to the segment collector)."),
                SYNC.Input("sync",
                            tooltip="The shots dict (literal) from the Director."),
            ],
            outputs=[
                SYNC.Output("sync",
                             tooltip="The shots dict with the real segment paths."),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.dynprompt],
        )

    @classmethod
    def execute(cls, segment_paths="", sync=None):
        d = dict(sync) if isinstance(sync, dict) else {}
        d["segments"] = [ln.strip() for ln in (segment_paths or "").splitlines() if ln.strip()]
        return io.NodeOutput(d)


# ---------------------------------------------------------------------------
# Node: InfiniteMovieAssemble (REMOVED in Auftrag 32 - logic now in _concat_segments)
# ---------------------------------------------------------------------------

# InfiniteMovieAssemble was removed in Auftrag 32 - the logic now lives in
# _concat_segments (above). The node has been removed from NODE_LIST.


# 75: InfiniteMovieFramePairSwitch removed (not used by any workflow).


# 75: InfiniteMovieVRAMAcquire / InfiniteMovieVRAMRelease / InfiniteMovieMemoryStatus removed.
# The vram.py functions (wait_acquire, do_cleanup, get_memory_status) remain -
# InfiniteMovieRender calls vram.wait_acquire() directly before building the expansion.


# ---------------------------------------------------------------------------
# Node list
# ---------------------------------------------------------------------------

NODE_LIST = [InfiniteMovieRender, InfiniteMovieSegmentSave, InfiniteMovieSegmentPaths, InfiniteMovieShotsOut]


# ---------------------------------------------------------------------------
# Route: /infinite_movie/time_estimate (Auftrag 88)
# ---------------------------------------------------------------------------

def _register_time_estimate_route():
    """Register the /infinite_movie/time_estimate route (Auftrag 88).

    GET /infinite_movie/time_estimate?kind=segment&width=768&height=960&frames=121&preset=...
    -> JSON from timing.estimate(...) or {"seconds": null} when there is no data.
    Used by the Director/Choose progress bars to show an ETA before the first
    finished segment exists.
    """
    try:
        from server import PromptServer
        from aiohttp import web
        from . import timing

        _ps = getattr(PromptServer, "instance", None)
        if _ps is None:
            return

        @_ps.routes.get("/infinite_movie/time_estimate")
        async def time_estimate(request):
            kind = request.query.get("kind", "segment")
            preset = request.query.get("preset", "")
            try:
                width = int(request.query.get("width", 0))
                height = int(request.query.get("height", 0))
                frames = int(request.query.get("frames", 0))
            except (TypeError, ValueError):
                return web.json_response({"seconds": None})
            if width <= 0 or height <= 0 or frames <= 0:
                return web.json_response({"seconds": None})
            est = timing.estimate(kind, width, height, frames, preset=preset)
            if est is None:
                return web.json_response({"seconds": None})
            return web.json_response(est)
    except Exception as e:
        print(f"[InfiniteMovie] Failed to register time_estimate route: {e}")


_register_time_estimate_route()
