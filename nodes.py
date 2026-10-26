"""FilmChain custom nodes (V3 ComfyNode API).

Nodes:
- FilmChain: the main node. Takes a sequence of images + per-transition
  prompts, expands into per-segment FLF2V sub-graphs, and returns the final
  film path + segment paths.
- FilmSegmentSave: writes one segment's frames to an mp4 file (ffmpeg).
- FilmConcat: concatenates segment mp4s into one film, removing duplicate
  seam frames.
- FramePairSwitch: standalone helper that selects one (first, last, prompt)
  transition from a sequence of images.
- VRAMAcquire: waits until the GPU is free for ComfyUI rendering.
- VRAMRelease: frees GPU memory and (optionally) wakes the local LLM.

All names are English (package, classes, node_id, display_name, inputs,
outputs, category, log).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile

import numpy as np
import torch

from comfy_api.latest import io

from . import vram
from .expansion import PRESET_CONFIGS, build_expansion_graph

# Image slots: Autogrow starts with one, the next appears once one is connected
# (Nutzer 2026-10-26: max. 12). Keep in sync with MAX_IMAGES in web/filmchain.js.
MAX_IMAGES = 12

# ---------------------------------------------------------------------------
# ffmpeg (imageio_ffmpeg binary, see guide 04)
# ---------------------------------------------------------------------------

_FFMPEG_CANDIDATES = [
    r"D:\ComfyUI_windows_portable\python_embeded\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe",
    "ffmpeg",
]


def _ffmpeg() -> str:
    for cand in _FFMPEG_CANDIDATES:
        if os.path.isabs(cand):
            if os.path.exists(cand):
                return cand
        else:
            if shutil.which(cand):
                return cand
    # Fallback: try to import imageio_ffmpeg.
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        raise RuntimeError("ffmpeg not found (tried imageio_ffmpeg + PATH)")


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


def _load_folder_images(folder: str) -> list[np.ndarray]:
    """Load all images from a folder, sorted by filename."""
    from PIL import Image
    exts = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
    files = sorted(
        f for f in os.listdir(folder)
        if f.lower().endswith(exts)
    )
    if not files:
        raise ValueError(f"No images found in folder: {folder}")
    out = []
    for f in files:
        with Image.open(os.path.join(folder, f)) as im:
            out.append(np.asarray(im.convert("RGB")))
    return out


def _collect_images(images, folder: str) -> list[np.ndarray]:
    """Collect images from the Autogrow inputs or a folder.

    The Autogrow input arrives at execute() as a DICT keyed by slot name
    (image_0, image_1, ...) - see comfy_api/latest/_io.py build_nested_inputs
    (line 2095) and the core usage in comfy_api_nodes/nodes_bfl.py:1038
    (`(images or {}).values()`). A plain list is also accepted (direct calls
    from the offline test).
    """
    if folder:
        return _load_folder_images(folder)
    if isinstance(images, dict):
        tensors = [v for v in images.values() if v is not None]
    else:
        tensors = [t for t in (images or []) if t is not None]
    if not tensors:
        raise ValueError("FilmChain: no images provided (use images or folder)")
    return [_to_numpy_image(t) for t in tensors]


def _parse_prompt_list(prompts: str) -> list[str] | None:
    """Per-image prompts from the web extension (web/filmchain.js): a JSON list,
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


# ---------------------------------------------------------------------------
# ffmpeg helpers
# ---------------------------------------------------------------------------

def _write_frames_to_dir(frames: torch.Tensor, tmp_dir: str, fps: int) -> None:
    """Write a frames tensor (B, H, W, C) float [0,1] to PNG files in tmp_dir."""
    from PIL import Image
    img = _to_numpy_image(frames)
    # img is (B, H, W, C)
    for i in range(img.shape[0]):
        Image.fromarray(img[i]).save(os.path.join(tmp_dir, f"frame_{i:05d}.png"))


def _encode_dir_to_mp4(frame_dir: str, out_path: str, fps: int) -> None:
    """Encode a directory of frame_*.png into an mp4 (crf 17, yuv420p)."""
    ff = _ffmpeg()
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    cmd = [
        ff, "-y",
        "-framerate", str(fps),
        "-i", os.path.join(frame_dir, "frame_%05d.png"),
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-crf", "17",
        out_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _count_frames(video_path: str) -> int:
    """Return the number of frames in a video file, or -1 on error.

    Tries ffprobe first (fast, no decode). imageio_ffmpeg does not ship
    ffprobe, so it falls back to decoding with ffmpeg and reading the final
    frame counter from the progress output.
    """
    ff = _ffmpeg()
    # 1. Try ffprobe (fast path, no decode).
    ffprobe = ff.replace("ffmpeg", "ffprobe")
    if os.path.exists(ffprobe):
        try:
            out = subprocess.run(
                [ffprobe, "-v", "error", "-count_packets",
                 "-select_streams", "v:0", "-show_entries", "packet=pts",
                 "-of", "csv=p=0", video_path],
                capture_output=True, text=True, timeout=60,
            ).stdout.strip().splitlines()
            n = len([ln for ln in out if ln.strip()])
            if n > 0:
                return n
        except Exception:
            pass
    # 2. Fall back to decoding with ffmpeg and reading the frame counter.
    try:
        res = subprocess.run(
            [ff, "-i", video_path, "-map", "0:v:0", "-f", "null", "-"],
            capture_output=True, text=True, timeout=300,
        )
        out = res.stderr.replace("\r", "\n")
        matches = re.findall(r"frame=\s*(\d+)", out)
        if matches:
            return int(matches[-1])
        return -1
    except Exception:
        return -1


def _segment_is_complete(mp4_path: str, expected_frames: int) -> bool:
    """A segment is complete if the file exists and has the expected frames."""
    if not os.path.exists(mp4_path):
        return False
    if expected_frames <= 0:
        return True
    count = _count_frames(mp4_path)
    if count < 0:
        # Cannot count; assume complete if file is non-empty.
        return os.path.getsize(mp4_path) > 0
    return count >= expected_frames


def _snap_length(length: int, mod: int) -> int:
    """Round length to the nearest value of the form (mod*n + 1).

    Wan uses mod=4 (4n+1), LTX uses mod=8 (8n+1).
    """
    if length <= 1:
        return 1
    k = int((length - 1) / mod + 0.5)  # round half up
    return k * mod + 1


def _seconds_to_frames(seconds: float, fps: float, length_mod: int) -> int:
    """seconds -> frames (Auftrag 21, Änderung 3): frames = round(seconds*fps)+1,
    minimum 1*length_mod+1.

    Matches the task's explicit Sollwerte (LTX 24 fps: 0.5 s=13, 1 s=25,
    1.5 s=37, 2 s=49, 5 s=121). NOTE: for half-second values this is NOT on the
    (mod*n+1) grid (13 and 37 are not 8n+1); execute() snaps the final length
    via _snap_length for grid validity, so the rendered length may differ from
    this raw conversion for off-grid values.
    """
    frames = int(round(seconds * fps)) + 1
    return max(frames, 1 * length_mod + 1)


def _unique_output_path(folder: str, name: str, ext: str = ".mp4") -> str:
    """Return <folder>/<name><ext>, appending _001, _002, ... if it exists.

    NEVER overwrites an existing file (Auftrag 16, point 1). The folder is
    created if it does not exist.
    """
    folder = (folder or "").strip()
    if not folder:
        raise ValueError("FilmConcat: save_folder is empty")
    name = (name or "film").strip() or "film"
    os.makedirs(folder, exist_ok=True)
    base = os.path.join(folder, name)
    candidate = base + ext
    i = 1
    while os.path.exists(candidate):
        candidate = f"{base}_{i:03d}{ext}"
        i += 1
    return candidate


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


def _display_node_id(cls) -> str | None:
    """Return the VISIBLE node id to send in-node text to.

    For nodes that run inside a FilmChain expansion the engine assigns an
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
    print(f"[FilmChain] {text}")
    return status


# ---------------------------------------------------------------------------
# Node: FilmChain
# ---------------------------------------------------------------------------

class FilmChain(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        images_template = io.Autogrow.TemplatePrefix(
            io.Image.Input("image", tooltip="One input image. Images are used pairwise (1->2, 2->3, ...)."),
            prefix="image",
            min=1,
            max=MAX_IMAGES,
        )
        return io.Schema(
            node_id="FilmChain",
            display_name="FilmChain",
            category="FilmChain",
            description="Turns a sequence of images into a looping film: renders one FLF2V video per transition, saves each segment, and concatenates them into a single film. Handles GPU handoff to/from the local LLM.",
            is_output_node=True,
            enable_expand=True,
            inputs=[
                io.Combo.Input(
                    "preset",
                    options=list(PRESET_CONFIGS.keys()),
                    default="ltx25_flf2v",
                    tooltip="Render preset (determines template, fps, length grid, default size).",
                ),
                io.Autogrow.Input(
                    "images",
                    template=images_template,
                    tooltip="Input images, used pairwise for transitions.",
                ),
                # Wired prompt per image (prompt i = transition image i -> i+1). web/filmchain.js
                # shows prompt i directly below image i. Wired prompts override `prompts`.
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
                io.String.Input(
                    "folder",
                    optional=True,
                    tooltip="Optional: load all images from this folder (sorted by filename) instead of the image inputs.",
                ),
                io.String.Input(
                    "prompts",
                    multiline=True,
                    default="",
                    tooltip="One prompt per transition (one per line). Fewer lines than transitions -> the last line is repeated.",
                ),
                io.String.Input(
                    "style_prompt",
                    optional=True,
                    tooltip="Optional style suffix appended to every transition prompt.",
                ),
                io.String.Input(
                    "negative",
                    default="",
                    tooltip="Negative prompt applied to every segment.",
                ),
                io.Boolean.Input(
                    "loop",
                    default=True,
                    tooltip="Add the closing transition (last image -> first image) so the film loops seamlessly.",
                ),
                io.Int.Input(
                    "width",
                    default=0,
                    min=0,
                    max=2048,
                    step=8,
                    tooltip="Render width (must match the preset's aspect ratio). 0 = use the preset default.",
                ),
                io.Int.Input(
                    "height",
                    default=0,
                    min=0,
                    max=2048,
                    step=8,
                    tooltip="Render height. 0 = use the preset default.",
                ),
                io.Float.Input(
                    "seconds",
                    default=1.0,
                    min=0.5,
                    step=0.5,
                    tooltip="Segment length in seconds (converted to frames via the preset fps; 1 s = 25 frames at LTX 24 fps). Ignored when 'length' > 0.",
                ),
                io.Int.Input(
                    "length",
                    default=0,
                    min=0,
                    max=400,
                    advanced=True,
                    tooltip="Frames per segment (overrides 'seconds'). 0 = use 'seconds'. Snapped to the preset grid (Wan: 4n+1, LTX: 8n+1).",
                ),
                io.Int.Input(
                    "seed",
                    default=42,
                    control_after_generate=True,
                    tooltip="Base seed (per-segment seed = seed + index).",
                ),
                io.String.Input(
                    "name",
                    default="film",
                    tooltip="Output name. Segments and the final film are written to <output>/filmchain/<name>/.",
                ),
                io.String.Input(
                    "copy_to",
                    optional=True,
                    tooltip="Optional directory to copy the final film to (e.g. the Desktop).",
                ),
                io.String.Input(
                    "llm_url",
                    default=vram.DEFAULT_LLM_URL,
                    tooltip="Local LLM (BeeLlama) base URL for the GPU handoff.",
                    advanced=True,
                ),
                io.Int.Input(
                    "min_free_mb",
                    default=20000,
                    min=0,
                    tooltip="Minimum free GPU memory (MB) required before rendering.",
                    advanced=True,
                ),
                io.Int.Input(
                    "acquire_timeout_s",
                    default=3600,
                    min=0,
                    tooltip="Timeout (s) for waiting to acquire the GPU.",
                    advanced=True,
                ),
                io.Int.Input(
                    "release_min_free_mb",
                    default=18000,
                    min=0,
                    tooltip="Minimum free GPU memory (MB) required before waking the LLM.",
                    advanced=True,
                ),
                io.Boolean.Input(
                    "wake_llm",
                    default=True,
                    tooltip="Wake the local LLM after the film is done.",
                    advanced=True,
                ),
                io.Boolean.Input(
                    "concat_inside",
                    default=False,
                    tooltip="True = FilmChain concatenates internally (single node). False (default) = the node only renders the segments; attach a visible FilmConcat node and connect segment_paths, save_folder and save_name to it.",
                ),
                io.Boolean.Input(
                    "free_vram",
                    default=True,
                    tooltip="Only used when concat_inside=true: unload ComfyUI models + empty the CUDA cache after the film is written.",
                    advanced=True,
                ),
                io.Boolean.Input(
                    "free_ram",
                    default=False,
                    tooltip="Only used when concat_inside=true: additionally free RAM (gc.collect). The core /free also resets the node cache (PromptExecutor.reset, execution.py:675) which a running node cannot do.",
                    advanced=True,
                ),
            ],
            outputs=[
                io.String.Output("film_path", tooltip="Path to the final concatenated film (mp4). Empty when concat_inside is false (the visible FilmConcat produces it)."),
                io.String.Output("segment_paths", tooltip="One segment path per line."),
                io.String.Output("save_folder", tooltip="Absolute output folder <output>/filmchain/<name>/ (for the visible FilmConcat)."),
                io.String.Output("save_name", tooltip="Film file name without extension (for the visible FilmConcat)."),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.dynprompt],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("NaN")

    @classmethod
    def execute(cls, preset, images=None, folder=None, prompts="", shot_prompts=None,
                style_prompt=None, negative="", loop=True,
                width=0, height=0, seconds=1.0, length=0, seed=42,
                name="film", copy_to=None,
                llm_url=vram.DEFAULT_LLM_URL, min_free_mb=20000,
                acquire_timeout_s=3600, release_min_free_mb=18000,
                wake_llm=True, concat_inside=False,
                free_vram=True, free_ram=False):
        unique_id = cls.hidden.unique_id
        cfg = PRESET_CONFIGS[preset]

        # Memory display: "before" reading (visible while the job runs).
        _display_memory(cls, "before")

        # 0 means "use the preset default"; snap length to the preset grid.
        if width <= 0:
            width = cfg["default_width"]
        if height <= 0:
            height = cfg["default_height"]
        if length > 0:
            pass  # explicit length (old workflows) takes priority over seconds
        else:
            length = _seconds_to_frames(seconds, cfg["fps"], cfg["length_mod"])
            print(f"[FilmChain] {seconds:g} s -> {length} Frames "
                  f"(fps {cfg['fps']}, grid {cfg['length_mod']}n+1)")
        snapped = _snap_length(length, cfg["length_mod"])
        if snapped != length:
            print(f"[FilmChain] length {length} snapped to {snapped} "
                  f"(grid {cfg['length_mod']}n+1)")
        length = snapped

        # 1. Collect + preprocess images.
        raw_images = _collect_images(images or [], folder or "")
        if len(raw_images) < 2:
            raise ValueError("FilmChain needs at least 2 images")
        images_np = [center_crop_resize(im, width, height) for im in raw_images]
        # Convert to the tensor format the segment nodes expect (B, H, W, C).
        image_tensors = [
            torch.from_numpy(np.ascontiguousarray(im)).unsqueeze(0).float() / 255.0
            for im in images_np
        ]

        # 2. Build per-transition prompts.
        n_images = len(image_tensors)
        n_segments = n_images if loop else n_images - 1
        # Wired per-image prompts (shot_prompts.prompt0..) win over the text field.
        wired = _wired_prompts(shot_prompts)
        seg_prompts = _build_prompts(json.dumps(wired) if wired else prompts,
                                     style_prompt, n_segments)

        # 3. Output directory.
        import folder_paths
        output_root = folder_paths.get_output_directory()
        output_dir = os.path.join(output_root, "filmchain", name)
        os.makedirs(output_dir, exist_ok=True)

        # 4. Acquire the GPU (synchronously, BEFORE building the expansion so
        #    it is guaranteed to run before the first loader).
        vram.wait_acquire(
            llm_url=llm_url,
            min_free_mb=min_free_mb,
            timeout_s=acquire_timeout_s,
        )

        # 5. Build the expansion graph.
        # save_folder = the output dir; save_name = the film name (no ext).
        # The collector node (FilmSegmentPaths) is always built and depends on
        # ALL segments, so the parent (this node) is blocked until every
        # segment has finished (execution.py:600-613 strong links).
        graph = build_expansion_graph(
            unique_id=unique_id,
            preset=preset,
            images=image_tensors,
            prompts=seg_prompts,
            negative=negative or "",
            seed=seed,
            width=width, height=height, length=length,
            loop=loop,
            output_dir=output_dir,
            film_name=name,
            concat_inside=concat_inside,
            acquire_kwargs={
                "llm_url": llm_url,
                "min_free_mb": min_free_mb,
                "timeout_s": acquire_timeout_s,
            },
            release_kwargs={
                "llm_url": llm_url,
                "wake_llm": wake_llm,
                "min_free_mb": release_min_free_mb,
                "free_vram": free_vram,
                "free_ram": free_ram,
            },
            copy_to=copy_to or "",
        )

        collector_id = f"{unique_id}_collector"
        concat_id = f"{unique_id}_concat"
        print(f"[FilmChain] built expansion: {n_segments} segments, "
              f"preset={preset}, size={width}x{height}, length={length}, "
              f"loop={loop}, concat_inside={concat_inside}, out={output_dir}")

        # segment_paths is ALWAYS a link to the collector (depends on all
        # segments -> blocks the parent until every segment is done).
        # film_path is a link to the internal FilmConcat only when
        # concat_inside; otherwise it is empty (the visible FilmConcat
        # produces the film).
        film_path_out = [concat_id, 0] if concat_inside else ""
        # "after" reading (the heavy work happens in the expansion; this is
        # the state right after the graph is built / acquire finished).
        _display_memory(cls, "after")
        return io.NodeOutput(
            film_path_out,
            [collector_id, 0],
            output_dir,
            name,
            expand=graph,
        )


# ---------------------------------------------------------------------------
# Node: FilmSegmentSave
# ---------------------------------------------------------------------------

class FilmSegmentSave(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="FilmSegmentSave",
            display_name="Film Segment Save",
            category="FilmChain",
            description="Writes one segment's frames to an mp4 file (ffmpeg). Skips if the segment already exists and is complete (resume).",
            is_output_node=True,
            inputs=[
                io.Image.Input("frames", tooltip="Frames tensor (B, H, W, C) float [0,1]."),
                io.String.Input("path", tooltip="Output mp4 path for this segment."),
                io.Int.Input("index", default=0, tooltip="Segment index (for logging/progress)."),
                io.Int.Input("total", default=1, tooltip="Total number of segments (for progress)."),
                io.Int.Input("fps", default=16, tooltip="Frame rate for the segment."),
                io.String.Input("trigger", optional=True,
                                tooltip="Dependency input (value ignored). Used to force execution order."),
            ],
            outputs=[
                io.String.Output("path", tooltip="Path to the written segment mp4."),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, frames, path, index=0, total=1, fps=16, trigger=None):
        # cls.hidden is set by the ComfyUI engine at runtime; it is None when
        # execute() is called directly (e.g. from the offline test).
        unique_id = None
        try:
            unique_id = cls.hidden.unique_id
        except AttributeError:
            pass
        expected_frames = frames.shape[0] if isinstance(frames, torch.Tensor) else -1
        _send_progress(f"segment {index}/{total}", unique_id)
        if _segment_is_complete(path, expected_frames):
            print(f"[FilmSegmentSave] segment {index} already complete, skipping: {path}")
            return io.NodeOutput(path)

        with tempfile.TemporaryDirectory(prefix="filmchain_seg_") as tmp:
            _write_frames_to_dir(frames, tmp, fps)
            _encode_dir_to_mp4(tmp, path, fps)
        print(f"[FilmSegmentSave] wrote segment {index}: {path} ({expected_frames} frames)")
        return io.NodeOutput(path)


# ---------------------------------------------------------------------------
# Node: FilmSegmentPaths (collector)
# ---------------------------------------------------------------------------

class FilmSegmentPaths(io.ComfyNode):
    """Joins the per-segment mp4 paths into one multiline string.

    Primary use: an internal collector inside the FilmChain expansion. The
    expansion links one Autogrow input per segment to the corresponding
    FilmSegmentSave output, so this node DEPENDS ON EVERY segment. Because
    FilmChain's segment_paths output is a link to this collector, the parent
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
            node_id="FilmSegmentPaths",
            display_name="Film Segment Paths",
            category="FilmChain",
            description="Joins the segment mp4 paths (one per input) into a single multiline string. Inside FilmChain it acts as the ordering collector that depends on every segment.",
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
            # numerisch sortieren (segment10 nicht vor segment2)
            def _idx(k):
                d = "".join(c for c in str(k) if c.isdigit())
                return int(d) if d else 0
            values = [segments[k] for k in sorted(segments, key=_idx)]
        else:
            values = list(segments or [])
        paths = [str(v).strip() for v in values if v is not None and str(v).strip()]
        if not paths:
            raise ValueError("FilmSegmentPaths: no segment paths provided")
        return io.NodeOutput("\n".join(paths))


# ---------------------------------------------------------------------------
# Node: FilmConcat
# ---------------------------------------------------------------------------

class FilmConcat(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="FilmConcat",
            display_name="Film Concat",
            category="FilmChain",
            description="Concatenates segment mp4s into one film, removing duplicate seam frames (first frame of each segment after the first; last frame of the last segment when looping). Writes to <save_folder>/<save_name>.mp4 and NEVER overwrites (appends _001, _002, ...). Performs the GPU/RAM cleanup switches (replaces the separate VRAMRelease node when attached to a FilmChain with concat_inside=false).",
            is_output_node=True,
            inputs=[
                io.String.Input(
                    "segments",
                    multiline=True,
                    tooltip="One segment mp4 path per line, in order.",
                ),
                io.String.Input(
                    "save_folder",
                    tooltip="Output folder for the film (e.g. FilmChain's save_folder output).",
                ),
                io.String.Input(
                    "save_name",
                    default="film",
                    tooltip="Film file name without extension. The file is written to <save_folder>/<save_name>.mp4; if it exists, _001, _002, ... is appended (never overwrites).",
                ),
                io.Boolean.Input("loop", default=True,
                                 tooltip="If true, also drop the last frame of the last segment (seamless loop)."),
                io.String.Input("copy_to", optional=True,
                                tooltip="Optional directory to copy the final film to (e.g. the Desktop)."),
                io.String.Input("trigger", optional=True,
                                tooltip="Dependency input (value ignored). Used to force execution order."),
                io.Boolean.Input("free_vram", default=True,
                                 tooltip="After writing the film: unload ComfyUI models + empty the CUDA cache (model_management.unload_all_models + soft_empty_cache).",
                                 advanced=True),
                io.Boolean.Input("free_ram", default=False,
                                 tooltip="Additionally free RAM (gc.collect). The core /free also resets the node cache (PromptExecutor.reset, execution.py:675) which a running node cannot do.",
                                 advanced=True),
                io.Boolean.Input("wake_llm", default=True,
                                 tooltip="Wake the local LLM after freeing VRAM (only effective when free_vram is true).",
                                 advanced=True),
                io.String.Input("llm_url", default=vram.DEFAULT_LLM_URL,
                                tooltip="Local LLM (BeeLlama) base URL for the GPU handoff.",
                                advanced=True),
                io.Int.Input("min_free_mb", default=18000, min=0,
                             tooltip="Minimum free GPU memory (MB) required before waking the LLM.",
                             advanced=True),
            ],
            outputs=[
                io.String.Output("film_path", tooltip="Path to the final film."),
                io.String.Output("segment_paths", tooltip="One segment path per line."),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.dynprompt],
        )

    @classmethod
    def execute(cls, segments, save_folder, save_name="film", loop=True,
                copy_to=None, trigger=None,
                free_vram=True, free_ram=False, wake_llm=True,
                llm_url=vram.DEFAULT_LLM_URL, min_free_mb=18000):
        # Memory display: "before" reading (visible while the work runs).
        _display_memory(cls, "before")

        seg_paths = [ln.strip() for ln in (segments or "").splitlines() if ln.strip()]
        if not seg_paths:
            raise ValueError("FilmConcat: no segments provided")
        for p in seg_paths:
            if not os.path.exists(p):
                raise ValueError(f"FilmConcat: segment not found: {p}")

        # Build the output path: <save_folder>/<save_name>.mp4, never overwrite.
        film_path = _unique_output_path(save_folder, save_name, ".mp4")

        ff = _ffmpeg()

        # Count the frames in each segment (ffmpeg decode; imageio_ffmpeg
        # ships no ffprobe). Needed because the ffmpeg `trim` filter rejects
        # a negative end_frame, so the seam frames are addressed by index.
        counts = []
        for p in seg_paths:
            n = _count_frames(p)
            if n <= 0:
                raise ValueError(f"FilmConcat: could not count frames in {p}")
            counts.append(n)

        # Single-pass concat: trim each input (drop duplicate seam frames)
        # and concatenate in ONE ffmpeg call (one re-encode, no quality loss
        # from a second encode).
        #   - segments after the first drop their first frame (it duplicates
        #     the previous segment's last frame).
        #   - the last segment drops its last frame when looping (it
        #     duplicates the first segment's first frame).
        n_seg = len(seg_paths)
        inputs: list[str] = []
        for p in seg_paths:
            inputs += ["-i", p]
        # NOTE: do NOT add setpts=PTS-STARTPTS here. Empirically (ffmpeg 7.1,
        # 2026-10-25) setpts=PTS-STARTPTS after a trim that keeps all frames
        # drops the last frame; the concat filter renumbers timestamps on its
        # own, so setpts is unnecessary and harmful.
        filter_parts = []
        for i in range(n_seg):
            n = counts[i]
            start = 1 if i > 0 else 0
            # trim is 0-based, start inclusive, end exclusive: keep [start, end).
            end = (n - 1) if (loop and i == n_seg - 1) else n
            if end <= start:
                raise ValueError(
                    f"FilmConcat: segment {i} has only {n} frames; "
                    f"trimming to [start={start}, end={end}) is empty")
            filter_parts.append(
                f"[{i}:v]trim=start_frame={start}:end_frame={end}[v{i}]")
        concat_in = "".join(f"[v{i}]" for i in range(n_seg))
        filter_complex = ";".join(filter_parts) + \
            f";{concat_in}concat=n={n_seg}:v=1:a=0[vout]"

        cmd = [ff, "-y", *inputs,
               "-filter_complex", filter_complex,
               "-map", "[vout]",
               "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17",
               film_path]
        subprocess.run(cmd, check=True, capture_output=True)

        if copy_to:
            os.makedirs(copy_to, exist_ok=True)
            dest = os.path.join(copy_to, os.path.basename(film_path))
            shutil.copy2(film_path, dest)
            print(f"[FilmConcat] copied film to {dest}")

        total = sum(counts) - (n_seg - 1) - (1 if loop else 0)
        print(f"[FilmConcat] wrote film: {film_path} ({n_seg} segments, "
              f"frames={counts} -> {total})")

        # Cleanup switches (Auftrag 16, point 3): free_vram / free_ram / wake_llm.
        # When FilmConcat is the visible node attached to a FilmChain with
        # concat_inside=false, this replaces the separate VRAMRelease node.
        status = vram.do_cleanup(
            free_vram=free_vram,
            free_ram=free_ram,
            wake_llm=wake_llm,
            llm_url=llm_url,
            min_free_mb=min_free_mb,
        )
        print(f"[FilmConcat] {status}")

        # Memory display: "after" reading.
        _display_memory(cls, "after")
        return io.NodeOutput(film_path, "\n".join(seg_paths))


# ---------------------------------------------------------------------------
# Node: FramePairSwitch
# ---------------------------------------------------------------------------

class FramePairSwitch(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        images_template = io.Autogrow.TemplatePrefix(
            io.Image.Input("image"),
            prefix="image",
            min=2,
            max=24,
        )
        return io.Schema(
            node_id="FramePairSwitch",
            display_name="Frame Pair Switch",
            category="FilmChain",
            description="Selects one transition (first frame, last frame, prompt) from a sequence of images by index. Standalone helper; FilmChain uses the same logic internally.",
            inputs=[
                io.Autogrow.Input("images", template=images_template,
                                  tooltip="Input images, used pairwise."),
                io.String.Input("folder", optional=True,
                                tooltip="Optional: load images from this folder instead."),
                io.String.Input("prompts", multiline=True, default="",
                                tooltip="One prompt per transition (one per line)."),
                io.Int.Input("index", default=0, min=0,
                             tooltip="Transition index (0 = image1->image2, 1 = image2->image3, ...)."),
                io.Boolean.Input("loop", default=True,
                                 tooltip="If true, the last index wraps to imageN->image1."),
            ],
            outputs=[
                io.Image.Output("first_frame", tooltip="First frame of the selected transition."),
                io.Image.Output("last_frame", tooltip="Last frame of the selected transition."),
                io.String.Output("prompt", tooltip="Prompt for the selected transition."),
                io.Int.Output("pair_count", tooltip="Total number of transitions."),
                io.Boolean.Output("is_last", tooltip="True if this is the last transition."),
            ],
        )

    @classmethod
    def execute(cls, images=None, folder=None, prompts="", index=0, loop=True):
        raw = _collect_images(images or [], folder or "")
        n = len(raw)
        if n < 2:
            raise ValueError("FramePairSwitch needs at least 2 images")
        pair_count = n if loop else n - 1
        idx = index % pair_count
        first_idx = idx
        last_idx = (idx + 1) % n
        lines = [ln.strip() for ln in (prompts or "").splitlines() if ln.strip()]
        prompt = lines[idx] if idx < len(lines) else (lines[-1] if lines else "")
        is_last = idx == pair_count - 1

        def _to_tensor(im: np.ndarray):
            return torch.from_numpy(np.ascontiguousarray(im)).unsqueeze(0).float() / 255.0

        return io.NodeOutput(
            _to_tensor(raw[first_idx]),
            _to_tensor(raw[last_idx]),
            prompt,
            pair_count,
            is_last,
        )


# ---------------------------------------------------------------------------
# Node: VRAMAcquire
# ---------------------------------------------------------------------------

class VRAMAcquire(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="VRAMAcquire",
            display_name="VRAM Acquire",
            category="FilmChain",
            description="Waits until the local LLM is sleeping and enough GPU memory is free, then lets execution continue. Unloads ComfyUI models if needed. Never kills the LLM.",
            is_output_node=True,
            inputs=[
                io.String.Input("llm_url", default=vram.DEFAULT_LLM_URL,
                                tooltip="Local LLM base URL."),
                io.Int.Input("min_free_mb", default=20000, min=0,
                             tooltip="Minimum free GPU memory (MB)."),
                io.Int.Input("timeout_s", default=3600, min=0,
                             tooltip="Timeout in seconds."),
            ],
            outputs=[
                io.String.Output("status", tooltip="Acquire status message."),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.dynprompt],
        )

    @classmethod
    def execute(cls, llm_url=vram.DEFAULT_LLM_URL, min_free_mb=20000, timeout_s=3600):
        _display_memory(cls, "before")
        status = vram.wait_acquire(llm_url=llm_url, min_free_mb=min_free_mb,
                                   timeout_s=timeout_s)
        _display_memory(cls, "after")
        return io.NodeOutput(status)


# ---------------------------------------------------------------------------
# Node: VRAMRelease
# ---------------------------------------------------------------------------

class VRAMRelease(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="VRAMRelease",
            display_name="VRAM Release",
            category="FilmChain",
            description="Frees GPU memory (unloads ComfyUI models + empties cache) and optionally wakes the local LLM. Never kills the LLM. Cleanup switches: free_vram / free_ram / wake_llm.",
            is_output_node=True,
            inputs=[
                io.String.Input("trigger", optional=True,
                                tooltip="Dependency input (value ignored). Used to force execution order."),
                io.String.Input("llm_url", default=vram.DEFAULT_LLM_URL,
                                tooltip="Local LLM base URL."),
                io.Boolean.Input("free_vram", default=True,
                                 tooltip="Unload ComfyUI models + empty the CUDA cache (model_management.unload_all_models + soft_empty_cache)."),
                io.Boolean.Input("free_ram", default=False,
                                 tooltip="Additionally free RAM (gc.collect). The core /free also resets the node cache (PromptExecutor.reset, execution.py:675) which a running node cannot do."),
                io.Boolean.Input("wake_llm", default=True,
                                 tooltip="Wake the local LLM after freeing VRAM (only effective when free_vram is true)."),
                io.Int.Input("min_free_mb", default=18000, min=0,
                             tooltip="Minimum free GPU memory (MB) before waking the LLM."),
            ],
            outputs=[
                io.String.Output("status", tooltip="Release status message."),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.dynprompt],
        )

    @classmethod
    def execute(cls, trigger=None, llm_url=vram.DEFAULT_LLM_URL,
                free_vram=True, free_ram=False, wake_llm=True,
                min_free_mb=18000):
        _display_memory(cls, "before")
        status = vram.do_cleanup(free_vram=free_vram, free_ram=free_ram,
                                 wake_llm=wake_llm, llm_url=llm_url,
                                 min_free_mb=min_free_mb)
        _display_memory(cls, "after")
        return io.NodeOutput(status)


# ---------------------------------------------------------------------------
# Node: MemoryStatus
# ---------------------------------------------------------------------------

class MemoryStatus(io.ComfyNode):
    """Standalone node that only displays the current VRAM / RAM status.

    No functional inputs (an optional `trigger` is available purely to force
    execution order). The status string is both returned as the `status`
    output and shown on the node as in-node text.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MemoryStatus",
            display_name="Memory Status",
            category="FilmChain",
            description="Displays the current VRAM and RAM usage as in-node text and as a string output. VRAM is read from comfy.model_management (torch view) and nvidia-smi (OS view, includes BeeLlama); RAM from psutil.",
            is_output_node=True,
            inputs=[
                io.String.Input("trigger", optional=True,
                                tooltip="Dependency input (value ignored). Used to force execution order."),
            ],
            outputs=[
                io.String.Output("status",
                                 tooltip="One-line VRAM/RAM status string."),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.dynprompt],
        )

    @classmethod
    def execute(cls, trigger=None):
        status = _display_memory(cls)
        return io.NodeOutput(status)


# ---------------------------------------------------------------------------
# Node list
# ---------------------------------------------------------------------------

NODE_LIST = [FilmChain, FilmSegmentSave, FilmSegmentPaths, FilmConcat,
             FramePairSwitch, VRAMAcquire, VRAMRelease, MemoryStatus]
