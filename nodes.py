"""InfiniteMovieRender custom nodes (V3 ComfyNode API).

Nodes:
- InfiniteMovieRender: the main node. Takes a sequence of images + per-transition
  prompts, expands into per-segment FLF2V sub-graphs, and returns the final
  film path + segment paths.
- InfiniteMovieSegmentSave: writes one segment's frames to an mp4 file (ffmpeg).
- InfiniteMovieAssemble: concatenates segment mp4s into one film, removing duplicate
  seam frames.
- InfiniteMovieFramePairSwitch: standalone helper that selects one (first, last, prompt)
  transition from a sequence of images.
- InfiniteMovieVRAMAcquire: waits until the GPU is free for ComfyUI rendering.
- InfiniteMovieVRAMRelease: frees GPU memory and (optionally) wakes the local LLM.

All names are English (package, classes, node_id, display_name, inputs,
outputs, category, log).
"""

from __future__ import annotations

import json
import math
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
from .expansion import build_expansion_graph
from .media import (_count_frames, _encode_dir_to_mp4, _ffmpeg, _no_window, _segment_is_complete, _write_audio_to_wav, _write_frames_to_dir)
# 57d: SETTINGS pipe + get_setting (settings_nodes imports only .vram + lazy .autoprompt,
# no cycle). The settings input goes at the END of the schema so the slot indices of the
# Autogrow inputs (images/shot_prompts) do NOT shift (RAG: links hang off the index).
from .settings_nodes import SETTINGS, get_setting, chain_settings, ASPECT_FROM_IMAGES, resolve_ratio

# Image slots: Autogrow starts with one, the next appears once one is connected
# (user 2026-11-13: max. 8 - ~40 s film, Cut fits one screen). Single source: the frontend reads it from
# /object_info (images template max) via fcMaxImages() in web/im_images.js.
MAX_IMAGES = 8

# Auftrag 32: sync pipe - a "pipe" type (like rgthree-Context /
# Efficiency-Pipes). Content: dict with segments, save_folder, save_name, fps,
# loop, width, height, frames_per_segment, seed, render_id.
# 57b2 (2026-11-01): type renamed (the pipe was called "shots" everywhere -
# ID, display AND type; the old type name is in tools/migrate_workflows.py).
# 116a (2026-11-13): renamed again - the pipe is called "sync" everywhere
# (ID, display AND type); no load migration (user decision, no users yet).
SYNC = io.Custom("SYNC")


# ---------------------------------------------------------------------------
# 88: per-segment timing marks. InfiniteMovieRender stamps the wall-clock start
# (keyed by its own unique_id) right before building the expansion; each
# InfiniteMovieSegmentSave measures the time since the previous mark of the same
# render and appends one line to the timings JSONL (timing.py). Reused segments
# (PrimitiveString) never run SegmentSave, so they are not logged (intended).
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


# ---------------------------------------------------------------------------
# Image helpers
# ---------------------------------------------------------------------------

def _to_numpy_image(tensor) -> np.ndarray:
    """Convert a ComfyUI image tensor (B, H, W, C) float [0,1] to HWC uint8."""
    if isinstance(tensor, torch.Tensor):
        t = tensor.detach().cpu().float()
    else:
        t = torch.as_tensor(np.asarray(tensor), dtype=torch.float32)
    if t.dim() == 4 and t.shape[0] == 1:
        t = t[0]
    if t.dim() == 3 and t.shape[-1] in (1, 3, 4):
        img = t.numpy()
    elif t.dim() == 3 and t.shape[0] in (1, 3, 4):
        img = t.permute(1, 2, 0).numpy()  # (C,H,W) -> (H,W,C)
    else:
        img = t.numpy()
    img = np.clip(img * 255.0, 0, 255).astype(np.uint8)
    if img.shape[-1] == 1:
        img = np.repeat(img, 3, axis=-1)
    if img.shape[-1] == 4:
        img = img[..., :3]
    return img


def center_crop_resize(img: np.ndarray, width: int, height: int) -> np.ndarray:
    """Center-crop to the target aspect ratio, then resize to width x height.

    Mirrors tools/loop_prepare.py center_crop_45 (LANCZOS resize).
    """
    from PIL import Image
    h, w = img.shape[:2]
    target_ratio = width / height
    src_ratio = w / h
    if abs(src_ratio - target_ratio) < 1e-6:
        cropped = img
    elif src_ratio > target_ratio:
        # Source is wider -> crop width.
        new_w = int(round(h * target_ratio))
        x0 = (w - new_w) // 2
        cropped = img[:, x0:x0 + new_w]
    else:
        # Source is taller -> crop height.
        new_h = int(round(w / target_ratio))
        y0 = (h - new_h) // 2
        cropped = img[y0:y0 + new_h, :]
    pil = Image.fromarray(cropped)
    pil = pil.resize((width, height), Image.LANCZOS)
    return np.asarray(pil)


def _collect_images(images) -> list[np.ndarray]:
    """Collect images from the Autogrow inputs (2026-11-04: folder input removed).

    The Autogrow input arrives at execute() as a DICT keyed by slot name
    (image_0, image_1, ...) - see comfy_api/latest/_io.py build_nested_inputs
    (line 2095) and the core usage in comfy_api_nodes/nodes_bfl.py:1038
    (`(images or {}).values()`). A plain list is also accepted (direct calls
    from the offline test).
    """
    if isinstance(images, dict):
        tensors = [v for v in images.values() if v is not None]
    else:
        tensors = [t for t in (images or []) if t is not None]
    if not tensors:
        raise ValueError("InfiniteMovieRender: no images provided (connect images)")
    return [_to_numpy_image(t) for t in tensors]


def _parse_prompt_list(prompts: str) -> list[str] | None:
    """Per-image prompts from the web extension (web/infinite_movie.js): a JSON list,
    one entry per image (entry i = transition image i -> i+1). Empty entries
    take the previous prompt. None if `prompts` is plain multiline text."""
    text = (prompts or "").strip()
    if not text.startswith("["):
        return None
    try:
        items = json.loads(text)
    except ValueError:
        return None
    if not isinstance(items, list):
        return None
    out: list[str] = []
    for it in items:
        s = " ".join(str(it or "").split())
        out.append(s if s else (out[-1] if out else ""))
    return out


def _wired_prompts(shot_prompts) -> list[str]:
    """Autogrow dict {prompt0: str, prompt1: str, ...} -> list ordered by slot
    number; [] if nothing is wired or all entries are empty."""
    if not isinstance(shot_prompts, dict):
        return []
    def idx(k: str) -> int:
        m = re.search(r"(\d+)$", k)
        return int(m.group(1)) if m else 0
    vals = [str(shot_prompts[k] or "") for k in sorted(shot_prompts, key=idx)]
    return vals if any(v.strip() for v in vals) else []


def _clean_prompt(text: str, max_words: int = 350) -> str:
    """Clean an LLM-generated prompt: remove think blocks, Markdown, and
    truncate to max_words at a word boundary."""
    import re
    # Remove think...think and think.../think blocks (case-insensitive).
    text = re.sub(r"think.*?/think", "", text, flags=re.DOTALL | re.IGNORECASE)
    # Remove Markdown formatting: **bold**, *italic*, # headers, `code`.
    text = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
    text = re.sub(r"\*(.*?)\*", r"\1", text)
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"`(.*?)`", r"\1", text)
    # Truncate to max_words at a word boundary.
    words = text.split()
    if len(words) > max_words:
        text = " ".join(words[:max_words])
    return text.strip()


def _build_prompts(prompts: str, style_prompt: str, n_segments: int) -> list[str]:
    """Split the prompts into one per transition, repeating the last if there
    are fewer entries than segments. Accepts plain multiline text (one line per
    transition) or the per-image JSON list. Append the style prompt."""
    per_image = _parse_prompt_list(prompts)
    if per_image is not None:
        # keep positions (entry i = segment i); leading empties stay "" (no shift)
        lines = per_image[:n_segments] or [""]
    else:
        lines = [ln.strip() for ln in (prompts or "").splitlines() if ln.strip()]
    if not lines:
        lines = [""]
    if style_prompt and style_prompt.strip():
        lines = [ln + ", " + style_prompt.strip() for ln in lines]
    out = []
    for i in range(n_segments):
        out.append(lines[i] if i < len(lines) else lines[-1])
    return out


def _parse_reseed(text: str) -> dict:
    """'2' / '2,4' / '2,2' -> {segment number: bumps}. Each mention adds one bump.
    2026-11-08 (user: only re-render the chosen variant): '2a' / '2b' -> {"2a": bumps} / {"2b": bumps}
    = only variant A or B of this shot gets a new seed, the other stays (the file is reused)."""
    bumps: dict = {}
    for tok in re.split(r"[,;\s]+", text or ""):
        tok = tok.strip().lower()
        if tok.isdigit() and int(tok) > 0:
            bumps[int(tok)] = bumps.get(int(tok), 0) + 1
        elif len(tok) > 1 and tok[-1] in "ab" and tok[:-1].isdigit() and int(tok[:-1]) > 0:
            key = f"{int(tok[:-1])}{tok[-1]}"
            bumps[key] = bumps.get(key, 0) + 1
    return bumps


def _snap_length(length: int, mod: int) -> int:
    """Round length to the nearest value of the form (mod*n + 1).

    Wan uses mod=4 (4n+1), LTX uses mod=8 (8n+1).
    """
    if length <= 1:
        return 1
    k = int((length - 1) / mod + 0.5)  # round half up
    return k * mod + 1


def _seconds_to_frames(seconds: float, fps: float, length_mod: int) -> int:
    """seconds -> frames (Auftrag 21, change 3 + fix 2026-10-26):
    frames = floor(seconds*fps/length_mod + 0.5) * length_mod + 1  (round half up,
    NOT Banker's rounding like Python's round()), minimum 1*length_mod+1.

    The result always lands on the (mod*n+1) grid of the preset.
    Target values LTX (24 fps, mod 8): 0.5 s=17, 1 s=25, 1.5 s=41, 2 s=49, 5 s=121.
    """
    k = int(math.floor(seconds * fps / length_mod + 0.5))
    return max(k * length_mod + 1, 1 * length_mod + 1)


# ---------------------------------------------------------------------------
# Auftrag 41: Per-scene length + max length estimate + tail
# ---------------------------------------------------------------------------

def _scene_frames(seconds_list: list, fps: float, length_mod: int, default_frames: int) -> list:
    """Auftrag 41A: Per-scene frame counts.

    seconds_list: one entry per scene (transition i -> i+1). Empty/0 = use the
    global length (default_frames, already snapped to the grid).
    Returns: list of frame counts L_i, each on the (mod*n+1) grid.
    """
    n = len(seconds_list)
    result = []
    for i in range(n):
        s = seconds_list[i] if i < len(seconds_list) else 0
        if s is None or s <= 0:
            result.append(default_frames)   # 82: 0 = global length (frames, not seconds)
        else:
            result.append(_seconds_to_frames(s, fps, length_mod))
    return result


def _parse_shot_seconds(text) -> list:
    """82: Per-shot length from the Director 'shot_seconds' widget.

    "2, 3,,4" -> [2.0, 3.0, 0.0, 4.0]; empty or invalid entries -> 0.0
    (0 = use the global 'seconds'); trailing zeros are stripped.
    """
    if not text:
        return []
    result = []
    for part in str(text).split(","):
        part = part.strip()
        if not part:
            result.append(0.0)
            continue
        try:
            v = float(part)
        except (TypeError, ValueError):
            v = 0.0
        result.append(v)
    while result and result[-1] == 0.0:
        result.pop()
    return result


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
    try:
        from server import PromptServer
        inst = PromptServer.instance
        if inst is not None:
            inst.send_sync("infinite_movie.render_plan", data)
    except Exception:  # noqa: BLE001
        pass
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
    return n

class InfiniteMovieRender(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        images_template = io.Autogrow.TemplatePrefix(
            io.Image.Input("image", tooltip="One input image. Images are used pairwise (1->2, 2->3, ...)."),
            prefix="image",
            min=1,
            max=MAX_IMAGES,
        )
        return io.Schema(
            node_id="InfiniteMovieRender",
            display_name="Director · Infinite Movie",
            search_aliases=["infinite movie", "infinite_movie", "film", "movie", "video", "ltx", "wan",
                            "render", "director"],
            category="Infinite Movie/2 Render",
            description="Stage 2 (Render) of the Infinite Movie: turns a sequence of images into FLF2V video segments, "
                        "one per transition. Typically: images from Load Image nodes, shot_prompts from Infinite Movie · "
                        "Auto Prompt nodes; segment_paths goes to Infinite Movie · Normalize Time or Infinite Movie · Concat. "
                        "Handles GPU handoff to/from the local LLM. While rendering, a progress bar with "
                        "segment/step/elapsed/ETA is drawn at the bottom of the node.",
            is_output_node=True,
            enable_expand=True,
            inputs=[
                # 66 (user 2026-11-03: "logical order, wire it cleanly"): sockets on top in
                # reading order: settings, engine, images, shot_prompts; then the widgets.
                # All sockets optional - the frontend sets required BEFORE optional, that is
                # why images is optional too (execute reports "no images provided" when nothing comes in).
                SETTINGS.Input("settings", optional=True, display_name="settings",
                               tooltip="Settings chain (format, film name, GPU handoff). Without it the built-in defaults apply."),
                # 57e: the engine input is optional + lazy.
                # lazy=True: the chain does NOT run directly (graph.py add_node does not create
                #   lazy inputs as strong links) - no double run. The Director reads the
                #   connection from the dynprompt, not from the engine value.
                # optional=True: automatic. Unconnected -> the SINGLE non-muted
                #   Engine Out in the prompt. Connected -> exactly that one.
                io.String.Input(
                    "engine",
                    force_input=True,
                    lazy=True,
                    optional=True,
                    tooltip="Engine (INFINITE_ENGINE) – the video model chain (Engine Start → model chain → Engine Result). "
                            "Optional: when unconnected, the single non-muted engine group in the workflow is used. "
                            "Connect exactly one Engine Result to use a specific engine group.",
                ),
                io.Autogrow.Input(
                    "images",
                    template=images_template,
                    optional=True,
                    tooltip="Input images, used pairwise for transitions.",
                ),
                # Wired prompt per image (prompt i = transition image i -> i+1). web/infinite_movie.js
                # lays the Auto Prompt nodes out between the images.
                io.Autogrow.Input(
                    "shot_prompts",
                    template=io.Autogrow.TemplatePrefix(
                        io.String.Input("prompt", force_input=True,
                                        tooltip="Prompt for the transition from this image to the next."),
                        prefix="prompt",
                        min=1,
                        max=MAX_IMAGES,
                    ),
                    optional=True,
                    tooltip="One wired prompt per image (transition to the next image).",
                ),
                # 82: per-shot length, edited in Infinite Movie · Choose (⏱ button).
                # optional=True + declared last -> last widget in the UI
                # and old saved workflows keep their positional widgets_values.
                # No Autogrow: Autogrow sub-inputs become required (see comment below).
                io.String.Input(
                    "shot_seconds",
                    default="",
                    optional=True,
                    advanced=True,
                    tooltip="Per-shot length in seconds, comma separated (shot 1, shot 2, …); empty or 0 = global 'seconds'. Set from Choose › ⏱.",
                ),
                io.Boolean.Input(
                    "loop",
                    default=True,
                    tooltip="true = add the closing transition (last image -> first image) so the film loops "
                            "seamlessly; false = the film ends on the last image (no closing transition).",
                ),
                io.Float.Input(
                    "seconds",
                    default=2.0,
                    min=0.5,
                    step=0.5,
                    tooltip="Default scene length in seconds, snapped to the preset grid (LTX 24 fps 8n+1: 1 s = 25, 2 s = 49 frames). "
                            "Per-shot lengths can be set in Choose › ⏱.",
                ),

                io.Int.Input(
                    "seed",
                    default=42,
                    control_after_generate=True,
                    tooltip="Base seed (per-segment seed = seed + index; 'reseed' adds 1000 for single segments).",
                ),
                io.String.Input(
                    "reseed",
                    default="",
                    tooltip="Segments to re-render with a new seed, e.g. '2' or '2,4' (numbers as in the Concat check report). "
                            "Each mention adds 1000 to that segment's seed ('2,2' = second try); all other segments keep theirs.",
                ),
                # mode widget removed (Auftrag 72): segment render only.
                # 61: variants (Variants-Builder). AT THE END of the widgets (after reseed, before the
                # engine/settings sockets) so saved workflows do not shift anything
                # (widgets_values is positional). "2" renders every transition twice
                # (seed A and seed A+500) for the Infinite Movie · Choose node.
                io.Combo.Input(
                    "variants", advanced=True,
                    options=["1", "2"],
                    default="1",
                    tooltip="Variants (Auftrag 61): '2' renders every transition TWICE (variant A with the "
                            "normal seed, variant B with seed+500) so Infinite Movie · Choose can pick the "
                            "better one per transition. '1' (default) renders once, as before.",
                ),
                # scene_seconds removed (2026-10-27): optional=True did not work for
                # Autogrow sub-inputs -> validation demanded seconds0/seconds1 as required.
                # The global 'seconds' widget is used for all scenes.
            ],
            outputs=[
                # 71 (user 2026-11-03: "less is more"): exactly 2 outputs -
                # sync = slot 0 (pipe to Cut), settings = slot 1 (chain).
                # film_path / segment_paths / save_folder / save_name / images
                # removed (no migration). Blocking: sync is a link to the
                # internal node InfiniteMovieShotsOut, which hangs on the collector
                # (execution.py 599-612: strong link from link values) - the Director
                # thereby waits for all segments without a visible output.
                SYNC.Output("sync",
                          display_name="sync ▶ Cut",
                          tooltip="Pipe mit allen Shots (Segment-Pfade, Ordner, Name, fps, loop …) von "
                                  "Infinite Movie · Director."),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.dynprompt],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("NaN")

    @classmethod
    def check_lazy_status(cls, *args, **kwargs):
        # 57e: the engine input is lazy (schema lazy=True) - the chain is not
        # executed directly (no strong link). The Director reads the engine from
        # the dynprompt. check_lazy_status=[] confirms: wait for nothing.
        return []

    @classmethod
    def execute(cls, images=None, shot_prompts=None,
                loop=True, seconds=2.0,
                seed=42,
                reseed="", engine=None,
                shot_seconds="", settings=None, variants="1"):
        # Format, name and GPU handoff from the settings chain; without it -> defaults.
        # 73: negative is gone (Engine In no longer has a negative output).
        width = get_setting(settings, "width")
        height = get_setting(settings, "height")
        min_free_mb = get_setting(settings, "min_free_mb")
        acquire_timeout_s = get_setting(settings, "acquire_timeout_s")
        name = _resolve_film_name(settings)
        # Concatenating, copying and the cleanup switches live on the visible InfiniteMovieAssemble
        # (2026-10-26 cleanup: the chain only renders segments).
        unique_id = cls.hidden.unique_id
        # Model inputs: the engine template already contains the model loaders
        # (Auftrag 29). External model override is not supported via the render
        # node – the engine subgraph defines the model chain.
        model_inputs = {}
        # 61: variants (Variants-Builder). Normalize to int.
        try:
            variants_int = int(variants)
        except (TypeError, ValueError):
            variants_int = 1
        if variants_int not in (1, 2):
            variants_int = 1
        # 57e: engine-based template – read the motor graph via dynprompt.
        # The engine input is optional: when unconnected, engine_to_template
        # resolves the single non-muted Engine Out in the prompt (or raises).
        from .expansion import engine_to_template
        _dynprompt = getattr(cls.hidden, "dynprompt", None)
        template, cfg = engine_to_template(_dynprompt, unique_id)
        cfg = dict(cfg, audio=bool(get_setting(settings, "audio")))   # Settings › audio (default off)
        preset = cfg.get("preset", "ltx25_flf2v")

        # Memory display: "before" reading (visible while the job runs).
        _display_memory(cls, "before")

        # 0 means "use the preset default"; snap length to the preset grid.
        if width <= 0:
            width = cfg["default_width"]
        if height <= 0:
            height = cfg["default_height"]
        length = _seconds_to_frames(seconds, cfg["fps"], cfg["length_mod"])
        print(f"[InfiniteMovie] {seconds:g} s -> {length} Frames "
              f"(fps {cfg['fps']}, grid {cfg['length_mod']}n+1)")
        snapped = _snap_length(length, cfg["length_mod"])
        if snapped != length:
            print(f"[InfiniteMovie] length {length} snapped to {snapped} "
                  f"(grid {cfg['length_mod']}n+1)")
        length = snapped
        # 71: intro/outro removed (user 2026-11-03: "less is more") -
        # no more intro/outro frames, prompts or segments.

        # 82: per-shot seconds from the 'shot_seconds' widget
        # ("2, 3,,4" -> [2.0, 3.0, 0.0, 4.0]; 0 = global 'seconds').
        scene_seconds_list = _parse_shot_seconds(shot_seconds)
        if scene_seconds_list:
            print(f"[InfiniteMovie] per-shot seconds: {scene_seconds_list}")

        # 1. Collect + preprocess images.
        raw_images = _collect_images(images or [])
        # 1 image: open shot (start image + prompt, no end image); loop on adds a second shot
        # from that shot's last frame back to the image. See expansion._segment_plan (2026-11-09).
        # 69: size from the first input image (Settings › aspect = "from images");
        # raw_images are H×W×C (np.uint8) -> shape[:2] = (h, w).
        if get_setting(settings, "aspect") == ASPECT_FROM_IMAGES:
            h0, w0 = raw_images[0].shape[:2]
            width, height = resolve_ratio(w0, h0, get_setting(settings, "long_side"))
            print(f"[InfiniteMovie] size from image 1 ({w0}x{h0}) -> {width}x{height}")
        images_np = [center_crop_resize(im, width, height) for im in raw_images]
        # Convert to the tensor format the segment nodes expect (B, H, W, C).
        image_tensors = [
            torch.from_numpy(np.ascontiguousarray(im)).unsqueeze(0).float() / 255.0
            for im in images_np
        ]

        # 2. Build per-transition prompts.
        n_images = len(image_tensors)
        n_segments = (2 if loop else 1) if n_images == 1 else (n_images if loop else n_images - 1)
        # Wired per-image prompts (shot_prompts.prompt0..) win over the text field.
        wired = _wired_prompts(shot_prompts)
        seg_prompts = _build_prompts(json.dumps(wired) if wired else "", None, n_segments)
        # Clean LLM-generated prompts (think blocks, Markdown, word limit).
        seg_prompts = [_clean_prompt(p) for p in seg_prompts]

        # Auftrag 48G.1: log the prompt used per scene (first 80 characters)
        for _si, _sp in enumerate(seg_prompts):
            print(f"[InfiniteMovie] scene {_si} prompt: {_sp[:80]}")

        # 3. Output directory. 116b1: shots go to <film_folder>/cache_movies/<name> (render cache).
        from .settings_nodes import film_folder
        output_dir = os.path.join(film_folder(settings), "cache_movies", name)
        os.makedirs(output_dir, exist_ok=True)

        # 3b. Skip mechanism (Auftrag 61): if all segments (A+B) already exist
        # and no reseed is set, do not request the GPU and only pass the paths
        # through (collector graph without render). This keeps mtime stable.
        # 57a: total segment count (scenes + loop); computed before the skip check, which needs it.
        # 71: intro/outro removed - only scenes + optional loop segment.
        from .expansion import segment_path, segment_path_b
        n_scenes = n_images - 1 if n_images > 1 else 1  # 1 image: open shot (+ loop shot back if loop)
        total_segments = n_scenes + (1 if loop else 0)
        _skip_render = False
        # 76 (user 2026-11-03: "not rendering when I press Run … old images"): reuse existing segments only
        # if they were made with EXACTLY these settings (seed, prompts, images,
        # format, length, variants, loop). Signature file in the output folder; every segment must be younger
        # than the signature (aborted run -> older leftovers -> render again).
        import hashlib
        _h = hashlib.sha1()
        _h.update(json.dumps([int(seed), seg_prompts, width, height, length,
                              bool(loop), variants_int,
                              str(engine)[:200]], default=str).encode("utf-8"))
        for _t in image_tensors:
            _h.update(str(tuple(_t.shape)).encode())
            _h.update(_t[:, ::16, ::16, :].contiguous().numpy().tobytes())
        _sig = _h.hexdigest()
        _sig_path = os.path.join(output_dir, "render_signature.txt")
        _seg_files = [segment_path(output_dir, i) for i in range(total_segments)]
        if variants_int >= 2:
            _seg_files += [segment_path_b(output_dir, i) for i in range(total_segments)]
        if not reseed:
            try:
                _old_sig = open(_sig_path, encoding="utf-8").read().strip()
                _sig_t = os.path.getmtime(_sig_path)
            except OSError:
                _old_sig, _sig_t = "", 0.0
            if _old_sig == _sig and all(os.path.exists(f) and os.path.getmtime(f) >= _sig_t for f in _seg_files):
                _skip_render = True
                print(f"[InfiniteMovie] all {len(_seg_files)} segments match this run, skipping render")
            elif all(os.path.exists(f) for f in _seg_files):
                print("[InfiniteMovie] segments exist but were made with other settings/seed -> render")
        if not _skip_render and not reseed:
            # New signature BEFORE the render: the new segments will then be younger than this file.
            with open(_sig_path, "w", encoding="utf-8") as _f:
                _f.write(_sig)

        # 4. Acquire the GPU (synchronously, BEFORE building the expansion so
        #    it is guaranteed to run before the first loader).
        # 2026-11-05 (user: "ASSEMBLE … strong delay"): acquire only AFTER building the expansion and only
        # if it actually renders - if all segments are reused (PrimitiveString), no
        # waiting for 20 GB / unloading. The expansion runs only after return, the order before the loader is kept.

        # 5. Build the expansion graph.
        # save_folder = the output dir; save_name = the film name (no ext).
        # The collector node always depends on the render output(s), so the
        # parent (this node) is blocked until the work is finished
        # (execution.py:600-613 strong links).
        acquire_kwargs = {
            "min_free_mb": min_free_mb,
            "timeout_s": acquire_timeout_s,
        }
        # segments mode (as before): one render per transition, collector
        # (InfiniteMovieSegmentPaths) depends on ALL segments.
        if _skip_render:
            # Skip graph: only the collector with hardcoded paths (no render).
            collector_id = f"{unique_id}_collector"
            _seg_inputs = {}
            for i in range(total_segments):
                # Autogrow flat like in the expansion's collector (expansion.py:1021)
                _seg_inputs[f"segments.segment{i}"] = segment_path(output_dir, i)
            graph = {collector_id: {"class_type": "InfiniteMovieSegmentPaths",
                                    "inputs": _seg_inputs}}
            print(f"[InfiniteMovie] skip-render: {total_segments} segments, "
                  f"variants={variants_int}, out={output_dir}")
        else:
            # 88: stamp the render start (wall clock) right before building the
            # expansion; each SegmentSave measures time since the previous mark.
            _SEG_MARK[str(unique_id)] = time.time()
            _SEG_META[str(unique_id)] = {
                "width": width, "height": height, "length": length,
                "preset": preset, "variants": variants_int,
            }
            graph = build_expansion_graph(
                unique_id=unique_id,
                preset=preset,
                images=image_tensors,
                prompts=seg_prompts,
                seed=seed,
                width=width, height=height, length=length,
                loop=loop,
                output_dir=output_dir,
                film_name=name,
                concat_inside=False,
                acquire_kwargs=acquire_kwargs,
                release_kwargs={},
                seed_bumps=_parse_reseed(reseed),
                model_inputs=model_inputs,
                template=template,
                cfg=cfg,
                scene_seconds=scene_seconds_list or None,
                variants=variants_int,
            )
            collector_id = f"{unique_id}_collector"
            print(f"[InfiniteMovie] built expansion: {n_segments} segments, "
                  f"preset={preset}, size={width}x{height}, length={length}, "
                  f"loop={loop}, variants={variants_int}, out={output_dir}")

        _cheap = {"PrimitiveString", "InfiniteMovieSegmentPaths", "InfiniteMovieShotsOut"}
        if not _skip_render and any(v.get("class_type") not in _cheap for v in graph.values()):
            # 65: GPU occupied by another program -> clear abort BEFORE the render (vram.py, generic)
            vram.wait_acquire(
                min_free_mb=min_free_mb,
                timeout_s=acquire_timeout_s,
            )
            # 88: reset the mark after the GPU wait - the wait time does not belong to the segment duration
            if str(unique_id) in _SEG_MARK:
                _SEG_MARK[str(unique_id)] = time.time()
            _send_render_plan(_display_node_id(cls) or unique_id, total_segments, width, height, length, preset)
        elif not _skip_render:
            print("[InfiniteMovie] all segments reused -> no GPU acquire")

        # 71: images output and film_path removed - the frames collector
        # (InfiniteMovieFramesCollect) is no longer attached here.
        # "after" reading (the heavy work happens in the expansion; this is
        # the state right after the graph is built / acquire finished).
        _display_memory(cls, "after")
        # SYNC dict (a "pipe")
        # 57a: total segment count (intro/outro/loop) + per-segment frame counts.
        # Build the segment paths (the collector output is a link, not a direct value)
        seg_paths_str = "\n".join(
            segment_path(output_dir, i) for i in range(total_segments)
        )
        # Per-segment frame counts (order: scenes…, loop?). 71: intro/outro removed.
        if scene_seconds_list:
            scene_lengths = _scene_frames(scene_seconds_list, cfg["fps"], cfg["length_mod"], length)
        else:
            scene_lengths = [length] * n_scenes
        scene_frames_list = []
        for k in range(n_scenes):
            scene_frames_list.append(scene_lengths[k] if k < len(scene_lengths) else length)
        if loop:
            scene_frames_list.append(length)
        film_dict = {
            "segments": [ln.strip() for ln in (seg_paths_str or "").splitlines() if ln.strip()],
            "save_folder": film_folder(settings),
            "save_name": name,
            "fps": cfg.get("fps", 24.0),
            "loop": loop,
            "width": width,
            "height": height,
            "frames_per_segment": length,
            "seed": seed,
            "render_id": unique_id,  # the uid line was dropped in package 71 (NameError 2026-11-04)
            "scene_frames": scene_frames_list,
            # 2026-11-13 (user: "settings in sync absorbieren"): behind the Director the settings travel inside sync
            "settings": chain_settings(settings),
        }
        # 61: variants (Variants-Builder). Only present when variants=2 (segments mode).
        # segments stays the A list, so Assemble without a Chooser works unchanged.
        if variants_int == 2:
            film_dict["variants"] = [
                [segment_path(output_dir, i), segment_path_b(output_dir, i)]
                for i in range(total_segments)
            ]
        # 71: blocking bridge - the sync output is a link to
        # InfiniteMovieShotsOut, which hangs on the collector (segment_paths).
        # The Director thereby waits for all segments without needing a visible
        # output (execution.py:599-612).
        shots_id = f"{unique_id}_shots"
        graph[shots_id] = {
            "class_type": "InfiniteMovieShotsOut",
            "inputs": {"segment_paths": [collector_id, 0], "sync": film_dict},
        }
        return io.NodeOutput(
            [shots_id, 0],      # 71: sync = slot 0 (link to InfiniteMovieShotsOut); carries the settings
            expand=graph,
        )


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
# Node: InfiniteMovieFramesCollect
# ---------------------------------------------------------------------------

def _collect_frame_ranges(seg_paths: list[str], counts: list[int], loop: bool) -> list[tuple[int, int]]:
    """Per-segment frame ranges [start, end) - the exact InfiniteMovieAssemble convention:
    segments after the first drop their first frame (seam duplicate), the last
    segment drops its last frame when looping."""
    n = len(seg_paths)
    out = []
    for i in range(n):
        start = 1 if i > 0 else 0
        end = (counts[i] - 1) if (loop and i == n - 1) else counts[i]
        if end <= start:
            raise ValueError(
                f"InfiniteMovieFramesCollect: segment {i} has only {counts[i]} frames; "
                f"range [start={start}, end={end}) is empty")
        out.append((start, end))
    return out


def _output_connected(dynprompt, node_id: str, slot: int) -> bool:
    """True if any node in the prompt has an input linked to (node_id, slot).

    Used to run the (RAM-hungry) InfiniteMovieFramesCollect only when the InfiniteMovieRender
    `images` output is actually connected. A subgraph output that is a link
    would force the source node to run unconditionally (execution.py:612-613,
    comfy_execution/graph.py add_strong_link 145-151), so the node is added to
    the expansion conditionally instead.
    """
    if dynprompt is None:
        return False
    try:
        ids = dynprompt.all_node_ids()
    except Exception:  # noqa: BLE001
        return False
    for nid in ids:
        if nid == node_id:
            continue
        try:
            inputs = dynprompt.get_node(nid).get("inputs", {})
        except Exception:  # noqa: BLE001
            continue
        for v in inputs.values():
            if isinstance(v, list) and len(v) == 2 and v[0] == node_id and v[1] == slot:
                return True
    return False


def _collect_frames_tensor(path: str, width: int, height: int,
                           max_images_gb: float = 0.0) -> "torch.Tensor":
    """Read ALL frames from a single video file into one IMAGE tensor (B,H,W,C).

    Frames are read chunk by chunk (ffmpeg rawvideo pipe) into a pre-allocated
    tensor (no list-concat). RAM estimate: frames*H*W*3*4 bytes (float32);
    above 8 GB the output is float16. Logs the estimate (Auftrag 30, RAM-Schutz).

    max_images_gb (Auftrag 39D): if > 0 and the estimated RAM usage exceeds
    this limit, raise a RuntimeError with the estimated size.
    """
    n = _count_frames(path)
    if n <= 0:
        raise ValueError(f"could not count frames in {path}")
    est = n * width * height * 3 * 4
    est_gb = est / 1024 ** 3
    if max_images_gb > 0 and est_gb > max_images_gb:
        raise RuntimeError(
            f"images output would need ~{est_gb:.1f} GB but max_images_gb is "
            f"{max_images_gb:.1f} GB. Reduce the number of frames, the resolution, "
            f"or increase max_images_gb.")
    use_f16 = est > 8 * 1024 ** 3
    print(f"[InfiniteMovie] images output: {n} frames ({width}x{height}), "
          f"~{est_gb:.1f} GB float32"
          + (" -> using float16 (> 8 GB)" if use_f16 else ""))
    dtype = torch.float16 if use_f16 else torch.float32
    out = torch.empty(n, height, width, 3, dtype=dtype)
    ff = _ffmpeg()
    frame_bytes = width * height * 3
    proc = subprocess.Popen(
        [ff, "-v", "error", "-nostdin", "-i", path, "-f", "rawvideo",
         "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE, stdin=subprocess.DEVNULL, **_no_window())
    try:
        for i in range(n):
            data = proc.stdout.read(frame_bytes)
            if len(data) < frame_bytes:
                break
            arr = np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3)
            out[i] = torch.from_numpy(np.ascontiguousarray(arr)).to(dtype).div_(255.0)
    finally:
        proc.stdout.close()
        proc.wait()
    return out


def _images_output(dynprompt, node_id: str, slot: int, path: str,
                   width: int, height: int):
    """Return the images output value for a video node (Auftrag 30, RAM-Schutz).

    If the images output is connected (via _output_connected), read all frames
    from the video file into a tensor (RAM-hungry, only when needed). Otherwise
    return a 1x1x1x3 placeholder (never consumed).
    """
    if _output_connected(dynprompt, node_id, slot):
        return _collect_frames_tensor(path, width, height)
    return torch.zeros(1, 1, 1, 3)


class InfiniteMovieFramesCollect(io.ComfyNode):
    """Internal: reads the segment mp4s in order, removes the seam duplicates
    (same convention as InfiniteMovieAssemble) and returns ALL film frames as one IMAGE
    batch. Added to the InfiniteMovieRender expansion only when the `images` output is
    connected, so it never runs for nothing. Frames are read chunk by chunk
    (ffmpeg rawvideo pipe), but the final batch is held in RAM:
    frames*H*W*3*4 bytes (float32) - above 8 GB the output is float16."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieFramesCollect", is_dev_only=True,
            display_name="Frames Collect (internal) · Infinite Movie",
            search_aliases=["infinite movie", "infinite_movie", "film", "movie", "video", "ltx", "wan"],
            category="Infinite Movie/9 Internal",
            description="Reads the segment mp4s in order, removes the seam duplicates (same convention as "
                        "InfiniteMovieAssemble) and returns all film frames as one IMAGE batch. Internal node: InfiniteMovieRender "
                        "adds it to the expansion only when its `images` output is connected. The whole batch "
                        "is held in RAM (float32, float16 above 8 GB).",
            is_output_node=True,
            inputs=[
                io.String.Input("paths", multiline=True,
                                tooltip="Segment mp4 paths, one per line, in order."),
                io.Boolean.Input("loop", default=True,
                                 tooltip="true = also drop the last frame of the last segment (seamless loop); "
                                         "false = keep it."),
                io.Int.Input("width", default=768, min=1, tooltip="Segment width (pixels)."),
                io.Int.Input("height", default=960, min=1, tooltip="Segment height (pixels)."),
                io.Float.Input("max_images_gb", default=0.0, min=0.0, advanced=True,
                               tooltip="Maximum RAM (in GB) for the images output. 0 = no limit. "
                                       "If the estimated RAM usage exceeds this limit, an error is raised."),
            ],
            outputs=[
                io.Image.Output("images",
                                tooltip="All film frames as an IMAGE batch (seams removed). ~1.7 GB for 4×49 frames at "
                                        "768×960; long films need much more RAM – prefer segment_paths for "
                                        "long films."),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, paths, loop=True, width=768, height=960, max_images_gb=0.0):
        seg_paths = [ln.strip() for ln in (paths or "").splitlines() if ln.strip()]
        if not seg_paths:
            raise ValueError("InfiniteMovieFramesCollect: no segments provided")
        counts = []
        for p in seg_paths:
            if not os.path.exists(p):
                raise ValueError(f"InfiniteMovieFramesCollect: segment not found: {p}")
            n = _count_frames(p)
            if n <= 0:
                raise ValueError(f"InfiniteMovieFramesCollect: could not count frames in {p}")
            counts.append(n)
        ranges = _collect_frame_ranges(seg_paths, counts, loop)
        total = sum(end - start for start, end in ranges)
        est = total * width * height * 3 * 4
        est_gb = est / 1024 ** 3
        if max_images_gb > 0 and est_gb > max_images_gb:
            raise RuntimeError(
                f"InfiniteMovieFramesCollect: images output would need ~{est_gb:.1f} GB but "
                f"max_images_gb is {max_images_gb:.1f} GB. Reduce the number of frames, the "
                f"resolution, or increase max_images_gb.")
        use_f16 = est > 8 * 1024 ** 3
        print(f"[InfiniteMovieFramesCollect] {total} frames ({width}x{height}), ~{est_gb:.1f} GB float32"
              + (" -> using float16 (> 8 GB)" if use_f16 else ""))
        dtype = torch.float16 if use_f16 else torch.float32
        out = torch.empty(total, height, width, 3, dtype=dtype)
        ff = _ffmpeg()
        frame_bytes = width * height * 3
        i = 0
        for p, (start, end) in zip(seg_paths, ranges):
            proc = subprocess.Popen(
                [ff, "-v", "error", "-nostdin", "-i", p, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                stdout=subprocess.PIPE, stdin=subprocess.DEVNULL, **_no_window())
            try:
                for f in range(end):
                    data = proc.stdout.read(frame_bytes)
                    if len(data) < frame_bytes:
                        break
                    if f >= start:
                        arr = np.frombuffer(data, dtype=np.uint8).reshape(height, width, 3)
                        out[i] = torch.from_numpy(np.ascontiguousarray(arr)).to(dtype).div_(255.0)
                        i += 1
            finally:
                proc.stdout.close()
                proc.wait()
        if i != total:
            raise RuntimeError(f"InfiniteMovieFramesCollect: read {i} of {total} expected frames")
        return io.NodeOutput(out)


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

NODE_LIST = [InfiniteMovieRender, InfiniteMovieSegmentSave, InfiniteMovieSegmentPaths, InfiniteMovieShotsOut,
             InfiniteMovieFramesCollect]


# ---------------------------------------------------------------------------
# Route: /infinite_movie/video_info (Auftrag 39D)
# ---------------------------------------------------------------------------

def _register_video_info_route():
    """Register the /infinite_movie/video_info route (Auftrag 39D).

    Returns video info (duration, fps, width, height, frame count) for a given
    video file. Used by the AutoBatch JS to calculate the batch size.
    """
    try:
        from server import PromptServer
        from aiohttp import web

        _ps = getattr(PromptServer, "instance", None)
        if _ps is None:
            return
        @_ps.routes.get("/infinite_movie/video_info")
        async def video_info(request):
            path = request.query.get("path", "")
            if not path or not os.path.exists(path):
                return web.json_response({"error": f"file not found: {path}"}, status=404)
            ff = _ffmpeg()
            r = subprocess.run([ff, "-hide_banner", "-i", path],
                               capture_output=True, text=True, timeout=10, **_no_window())
            stderr = r.stderr or ""
            info = {"path": path}
            m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.?\d*)", stderr)
            if m:
                h, mi, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
                info["duration"] = h * 3600 + mi * 60 + s
            m = re.search(r"(\d{2,5})x(\d{2,5})", stderr)
            if m:
                info["width"] = int(m.group(1))
                info["height"] = int(m.group(2))
            m = re.search(r"(\d+\.?\d*)\s*fps", stderr)
            if m:
                info["fps"] = float(m.group(1))
            n = _count_frames(path)
            info["frames"] = n
            return web.json_response(info)
    except Exception as e:
        print(f"[InfiniteMovie] Failed to register video_info route: {e}")


_register_video_info_route()


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
