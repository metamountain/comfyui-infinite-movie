"""124a: shot-list helpers for the Director (Auftrag 124a).

The Director's storyboard is one JSON list in the ``storyboard`` widget:
``[{"image": "<file>", "prompt": "<text>", "own": true}, ...]``.
This module parses the list, loads the per-shot images and maps shots to
segment prompts. It must stay importable without a running ComfyUI server
(the unit tests run headless), so ``folder_paths`` / ``node_helpers`` are
imported inside the functions that need them.
"""
from __future__ import annotations

import json
import os

import numpy as np

from .shot_utils import _to_numpy_image

MAX_IMAGES = 24
DEFAULT_IMAGES = 4


def parse(text) -> list[dict]:
    """Parse the storyboard JSON list from the ``storyboard`` widget.

    Every entry is normalised to ``{"image": str, "prompt": str, "own": bool}``.
    Empty text, broken JSON or a non-list result yields ``[]``. Entries that
    are not dicts are skipped, the list is truncated to ``MAX_IMAGES``.
    """
    if not text:
        return []
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    shots: list[dict] = []
    for entry in data:
        if len(shots) >= MAX_IMAGES:
            break
        if not isinstance(entry, dict):
            continue
        shots.append({
            "image": str(entry.get("image") or ""),
            "prompt": str(entry.get("prompt") or ""),
            "own": bool(entry.get("own") or False),
        })
    return shots


def load_images(shots) -> list[np.ndarray]:
    """Load the per-shot images (H×W×3 uint8 arrays) from the shot list.

    Entries with an empty ``image`` are skipped (empty storyboard slots).
    Missing files raise ``ValueError``.
    """
    import folder_paths
    import node_helpers
    from PIL import Image, ImageOps

    images: list[np.ndarray] = []
    for shot in shots:
        name = (shot.get("image") or "").strip()
        if not name:
            continue
        path = folder_paths.get_annotated_filepath(name)
        # get_annotated_filepath resolves the path but does not check existence
        # (ComfyUI core nodes.py:1764-1782 relies on Image.open raising).
        if not path or not os.path.isfile(path):
            raise ValueError(f"Director: image not found: {name}")
        img = node_helpers.pillow(Image.open, path)
        img = node_helpers.pillow(ImageOps.exif_transpose, img)
        img = img.convert("RGB")
        images.append(np.asarray(img, dtype=np.uint8))
    return images


def prompt_list(board, n_segments) -> list[str]:
    """One prompt per segment: entry ``i`` with an image -> segment ``i``.

    Entries without an image do not count (same filter as :func:`load_images`).
    An empty prompt takes the previous one (also past the end of the list),
    a leading empty one stays ``""``. Whitespace is collapsed.
    """
    prompts = [" ".join(str(e.get("prompt") or "").split()) for e in board if str(e.get("image") or "").strip()]
    out: list[str] = []
    for i in range(max(0, int(n_segments))):
        p = prompts[i] if i < len(prompts) else ""
        out.append(p or (out[-1] if out else ""))
    return out


def images_from_batch(images) -> list[np.ndarray]:
    """Convert an IMAGE tensor (B,H,W,C) float [0,1] to B uint8 HWC arrays."""
    if images is None:
        return []
    t = images.detach().cpu() if hasattr(images, "detach") else images
    if not len(t):
        return []
    return [_to_numpy_image(t[i]) for i in range(len(t))]
