"""The Director's storyboard: one JSON list in its ``storyboard`` widget, ``[{"image", "prompt", "own", "cut"}, ...]``.

Row i is an image and the film that starts there (web/im_storyboard_model.js holds the same rules for the UI):
film i runs from image i to image ``next_of(i)``. Importable without a running ComfyUI (headless unit tests),
so ``folder_paths`` / ``node_helpers`` are imported where they are used.
"""
from __future__ import annotations

import json
import os
import re

import numpy as np

from .shot_utils import _to_numpy_image

MAX_IMAGES = 24
DEFAULT_IMAGES = 4


def parse(text) -> list[dict]:
    """Rows from the widget JSON: ``{"image": str, "prompt": str, "prompt_b": str, "prompt_c": str,
    "prompt_d": str, "own": bool, "cut": bool}``, at most MAX_IMAGES. prompt_b/c/d = the prompt of variant
    B/C/D (empty = that variant renders with the same prompt as A).
    cut = a hard cut after that row's image: the row starts no film - unless its prompt (variant A) is not
    empty, then it renders an open film (start image only, no end image) before the cut (is_open).
    Empty or broken JSON -> ``[]``; entries that are not dicts are skipped."""
    try:
        data = json.loads(text or "[]")
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    return [{"image": str(e.get("image") or "").strip(), "prompt": str(e.get("prompt") or ""),
             "prompt_b": str(e.get("prompt_b") or ""), "prompt_c": str(e.get("prompt_c") or ""),
             "prompt_d": str(e.get("prompt_d") or ""), "own": bool(e.get("own")),
             "cut": bool(e.get("cut"))}
            for e in data if isinstance(e, dict)][:MAX_IMAGES]


def is_empty_image(name) -> bool:
    """True for the Director-UI's black placeholder (web/im_storyboard_io.js): a row whose image name is
    ``empty_<W>x<H>.png`` (checked after the last ``/``) is EMPTY - the film runs without that frame
    (expansion kinds 'arrive' / 'text'). The file itself exists (black); only the guidance is dropped."""
    name = str(name or "")
    return re.match(r"^empty_\d+x\d+\.png$", name.rsplit("/", 1)[-1]) is not None


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


def is_open(board, k: int, loop: bool) -> bool:
    """A cut row with a prompt (variant A): it renders an open film - start image k only, no end image -
    and a hard cut follows (user 2026-11-15: "kein Bild ohne Prompt, leer lassen geht immer")."""
    n = len(board)
    return (n > 1 and k < film_count(n, loop) and bool(board[k].get("cut"))
            and str(board[k].get("prompt") or "").strip() != "")


def open_films(board, loop: bool) -> list[int]:
    """All cut rows that render an open film (is_open), by film id."""
    n = len(board)
    return [k for k in range(film_count(n, loop)) if is_open(board, k, loop)]


def film_rows(board, loop: bool) -> list[int]:
    """Films that are rendered, by film id (= the row that starts them). A row marked ``cut`` starts no film
    (user 2026-11-15): its image only ends the film before, a hard cut follows - unless its prompt (variant A)
    is not empty, then it renders an open film (is_open). The row stays the film id, so segment files, seconds
    and seeds of the other films never shift when a cut is toggled."""
    n = len(board)
    return [k for k in range(film_count(n, loop))
            if not (n > 1 and board[row_of(n, k)].get("cut")) or is_open(board, k, loop)]


def hard_cuts(films: list[int], n_films: int, loop: bool, open_films=()) -> list[int]:
    """Positions in ``films`` followed by a hard cut: the next film id (loop: around) is not rendered, or the
    film is an open film (cut row with prompt) and another film follows. No position twice, sorted."""
    kept = set(films)
    opens = set(open_films or ())
    out = [p for p, k in enumerate(films)
           if (k + 1 < n_films and k + 1 not in kept) or (loop and k + 1 == n_films and 0 not in kept)]
    for p, k in enumerate(films):
        if k in opens and (p < len(films) - 1 or (loop and len(films) > 1)) and p not in out:
            out.append(p)
    return sorted(out)


def row_of(n: int, k: int) -> int:
    """Row that owns film k: its own row; the way back of a single image belongs to that image."""
    return min(k, n - 1)


def prompt_list(board, n_segments, key="prompt") -> list[str]:
    """One prompt per rendered film: film k takes row ``row_of(len(board), k)`` — its own row, except the way
    back of a single image, which belongs to that image. An empty prompt stays empty (no fill from the film
    that starts one row earlier); whitespace is collapsed. key="prompt_b": the variant B prompts."""
    out: list[str] = []
    for k in range(max(0, int(n_segments))):
        p = " ".join(str(board[row_of(len(board), k)].get(key) or "").split()) if (k < len(board) or len(board) == 1) else ""
        out.append(p)
    return out


