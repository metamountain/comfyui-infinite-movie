"""117e: image/prompt/length helpers extracted from nodes.py (Auftrag 117e).

Shared by nodes.py (re-export) and the *_nodes.py modules. shot_utils.py must
NOT import .nodes or .media (no cycle); it only needs numpy/torch + stdlib.
"""
from __future__ import annotations

import json
import math
import re

import numpy as np
import torch

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
