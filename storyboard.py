"""The Director's storyboard: one JSON list in its ``storyboard`` widget, ``[{"image", "prompt", "own"}, ...]``.

Row i is an image and the film that starts there (web/im_storyboard_model.js holds the same rules for the UI):
film i runs from image i to image ``next_of(i)``. Importable without a running ComfyUI (headless unit tests),
so ``folder_paths`` / ``node_helpers`` are imported where they are used.
"""
from __future__ import annotations

import json
import os

import numpy as np

from .shot_utils import _to_numpy_image

MAX_IMAGES = 24
DEFAULT_IMAGES = 4


def parse(text) -> list[dict]:
    """Rows from the widget JSON: ``{"image": str, "prompt": str, "own": bool}``, at most MAX_IMAGES.
    Empty or broken JSON -> ``[]``; entries that are not dicts are skipped."""
    try:
        data = json.loads(text or "[]")
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    return [{"image": str(e.get("image") or "").strip(), "prompt": str(e.get("prompt") or ""), "own": bool(e.get("own"))}
            for e in data if isinstance(e, dict)][:MAX_IMAGES]


def next_of(n: int, i: int, loop: bool) -> int:
    """End image of film i: the next one, with loop the last one back to the first. A single image is an open
    film (no end image), so it is its own "next". -1 = row i starts no film."""
    return 0 if n == 1 else i + 1 if i < n - 1 else 0 if loop else -1


def film_count(n: int, loop: bool) -> int:
    """Films rendered: one per row that starts one; a single image with loop also gets the way back."""
    return 0 if n < 1 else (2 if loop else 1) if n == 1 else n if loop else n - 1


def load_image(name: str) -> np.ndarray:
    """One image from ComfyUI's input folder as an H×W×3 uint8 array; a missing file raises ``ValueError``."""
    import folder_paths
    import node_helpers
    from PIL import Image, ImageOps

    path = folder_paths.get_annotated_filepath(name)
    # get_annotated_filepath does not check existence (ComfyUI core LoadImage relies on Image.open raising).
    if not path or not os.path.isfile(path):
        raise ValueError(f"Director: image not found: {name}")
    img = node_helpers.pillow(ImageOps.exif_transpose, node_helpers.pillow(Image.open, path))
    return np.asarray(img.convert("RGB"), dtype=np.uint8)


def load_images(board) -> list[np.ndarray]:
    """The image of every row. An empty row raises: the UI counts it as a film position, so skipping it would
    shift every later prompt onto the wrong film."""
    empty = [str(i + 1) for i, row in enumerate(board) if not row["image"]]
    if empty:
        raise ValueError(f"Director: storyboard image {', '.join(empty)} is empty - load an image or remove the row")
    return [load_image(row["image"]) for row in board]


def row_of(n: int, k: int) -> int:
    """Row that owns film k: its own row; the way back of a single image belongs to that image."""
    return min(k, n - 1)


def prompt_list(board, n_segments) -> list[str]:
    """One prompt per rendered film: film k takes row ``row_of(len(board), k)`` — its own row, except the way
    back of a single image, which belongs to that image. An empty prompt stays empty (no fill from the film
    that starts one row earlier); whitespace is collapsed."""
    out: list[str] = []
    for k in range(max(0, int(n_segments))):
        p = " ".join(board[row_of(len(board), k)]["prompt"].split()) if (k < len(board) or len(board) == 1) else ""
        out.append(p)
    return out


def images_from_batch(images) -> list[np.ndarray]:
    """An IMAGE tensor (B,H,W,C) float [0,1] as B uint8 H×W×C arrays."""
    if images is None:
        return []
    t = images.detach().cpu() if hasattr(images, "detach") else images
    return [_to_numpy_image(t[i]) for i in range(len(t))]
