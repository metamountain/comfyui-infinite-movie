"""117e: image/prompt/length helpers extracted from nodes.py (Auftrag 117e).

Shared by nodes.py (re-export) and the *_nodes.py modules. shot_utils.py must
NOT import .nodes or .media (no cycle); it only needs numpy/torch + stdlib.
"""
from __future__ import annotations

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


def _clean_prompt(text: str, max_words: int = 350) -> str:
    """Clean an LLM-generated prompt: remove think blocks, quotes, Markdown,
    collapse whitespace, and truncate to max_words at a word boundary."""
    # Remove <think>...</think> blocks and stray tags (case-insensitive). 2026-11-13: the old pattern had no angle
    # brackets: "<think>x</think>Prompt" became "<>Prompt", and plain text between a word "think" and a later
    # "/think" was cut out.
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"</?think>", "", text, flags=re.IGNORECASE)
    # Remove quotes and Markdown formatting: **bold**, *italic*, # headers, `code`.
    text = text.replace('"', "")
    text = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
    text = re.sub(r"\*(.*?)\*", r"\1", text)
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"`(.*?)`", r"\1", text)
    # Collapse whitespace, truncate to max_words at a word boundary.
    words = text.split()
    if len(words) > max_words:
        words = words[:max_words]
    return " ".join(words).strip()


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
