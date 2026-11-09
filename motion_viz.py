"""Infinite Movie · motion_viz (Auftrag 86): three visualizations of WHERE the motion is.

Pure functions (numpy + PIL only – no ComfyUI imports, no relative imports). Every function
returns an RGB uint8 array (H, W, 3) that is exactly `width` (default 512) pixels wide:

- timeline_heatmap: per shot, change per source frame (band A, LUT) + frame status (band B).
- motion_heatmap:   per-pixel accumulated change of one shot, coloured over the first frame.
- onion_skin:       weighted blend of n used frames (newest strongest) + caption line.
- contact_sheet:    grid of n used frames with frame index + time under each tile.

Design (verbindlich, pixelgenau): background #121212, text #D0D0D0, font
ImageFont.load_default(size=12), margin 8 px, LUT 256×3 below. Claude compares the demo
images afterwards and builds the best variant into Assemble (retime_nodes.py stays untouched).
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# --- fixed design (Auftrag 86) -------------------------------------------------
BG = (18, 18, 18)        # #121212
TEXT = (208, 208, 208)   # #D0D0D0
MARGIN = 8               # px left/right
DROP = (45, 45, 45)      # #2D2D2D  frame not used
USED = (60, 190, 90)     # #3CBE5A  frame used exactly once
DUP = (240, 140, 40)     # #F08C28  frame used >= 2 times (duplicate)
_STATUS = np.array([DROP, USED, DUP], dtype=np.uint8)

_LUT_POS = np.array([0.00, 0.25, 0.50, 0.75, 0.90, 1.00])
_LUT_RGB = np.array([[0, 0, 4], [66, 10, 104], [147, 38, 103],
                     [221, 81, 58], [252, 165, 10], [252, 255, 164]], dtype=np.float64)


def _build_lut() -> np.ndarray:
    """256×3 uint8, linear between the six support points (np.interp per channel)."""
    pos = np.linspace(0.0, 1.0, 256)
    lut = np.empty((256, 3), dtype=np.uint8)
    for c in range(3):
        lut[:, c] = np.interp(pos, _LUT_POS, _LUT_RGB[:, c]).round().astype(np.uint8)
    return lut


LUT = _build_lut()

_FONT = None


def _font() -> ImageFont.FreeTypeFont:
    global _FONT
    if _FONT is None:
        _FONT = ImageFont.load_default(size=12)
    return _FONT


def _text_w(s: str) -> float:
    return ImageDraw.Draw(Image.new("RGB", (1, 1))).textlength(s, font=_font())


def _lut_idx(v: np.ndarray) -> np.ndarray:
    return np.clip((np.asarray(v) * 255).round().astype(int), 0, 255)


def _band_pixels(values: np.ndarray, width_px: int) -> np.ndarray:
    """Pixel x (0..width_px-1) belongs to value index floor(x * m / width_px) (nearest)."""
    m = len(values)
    if m == 0:
        return np.zeros(width_px, dtype=int)
    return np.clip(np.floor(np.arange(width_px) * m / width_px).astype(int), 0, m - 1)


def _legend_bar(width: int) -> np.ndarray:
    """Colour-scale legend, 26 px tall: 4 px gap + bar 496×8 at x=8 (LUT left→right)
    + 2 px gap + 12 px text: 'still' at x=8, 'most change' right-aligned to x=width-8."""
    img = np.full((26, width, 3), BG, dtype=np.uint8)
    bar_w = width - 2 * MARGIN  # 496
    idx = np.clip(np.round(np.arange(bar_w) * 255 / (bar_w - 1)).astype(int), 0, 255)
    img[4:12, MARGIN:MARGIN + bar_w] = LUT[idx]
    pil = Image.fromarray(img)
    draw = ImageDraw.Draw(pil)
    draw.text((MARGIN, 14), "still", font=_font(), fill=TEXT)
    right = "most change"
    draw.text((width - MARGIN - draw.textlength(right, font=_font()), 14), right,
              font=_font(), fill=TEXT)
    return np.asarray(pil)


def _even_idx(idx: np.ndarray, n: int) -> np.ndarray:
    """n evenly distributed values of the sorted unique values of idx
    (np.linspace over the list, rounded, without duplicates)."""
    uniq = np.unique(np.asarray(idx, dtype=int))
    if len(uniq) <= n:
        return uniq
    pos = np.round(np.linspace(0.0, len(uniq) - 1, n)).astype(int)
    return uniq[np.unique(pos)]


# ---------------------------------------------------------------------------
# 1. timeline_heatmap
# ---------------------------------------------------------------------------

def timeline_heatmap(curves: list, picks: list, labels: list = None, width: int = 512,
                     height: int = None) -> np.ndarray:
    """One block per shot: label line (16 px) + band A (16 px, change per source frame
    through the LUT) + 2 px + band B (8 px, frame status) + 10 px. Title 18 px on top,
    status legend 18 px + colour legend 26 px below. Height = 18 + shots*52 + 18 + 26.
    height (optional, 2026-11-09 viewer 4:5): the bands grow so the picture fills this height
    (band A 2/3, band B 1/3 of the extra space per shot); never smaller than the minimum."""
    n_shots = len(curves)
    min_h = 18 + n_shots * 52 + 18 + 26
    extra = max(0, (int(height) - min_h) // max(n_shots, 1)) if height else 0
    a_h, b_h = 16 + extra * 2 // 3, 8 + extra - extra * 2 // 3
    height = max(min_h, int(height or 0))
    img = np.full((height, width, 3), BG, dtype=np.uint8)
    band_w = width - 2 * MARGIN  # 496
    texts: list[tuple[int, int, str]] = [(MARGIN, 3,
                                          "motion per frame (top band) · frames used (bottom band)")]
    y = 18
    for i, (curve, pick) in enumerate(zip(curves, picks)):
        curve = np.asarray(curve, dtype=np.float64)
        pick = np.asarray(pick, dtype=int)
        n = len(curve)
        if labels is not None and i < len(labels) and labels[i]:
            label = str(labels[i])
        else:
            label = f"seg {i + 1} · {n} -> {len(pick)} frames"
        texts.append((MARGIN, y + 2, label))
        y += 16
        # band A (16 px): d = diff(curve), per-shot normalized, gamma 0.6, through the LUT
        if n >= 2:
            d = np.diff(curve)
            dm = d.max()
            v = (d / dm) ** 0.6 if dm > 0 else np.zeros_like(d)
            a_idx = _band_pixels(v, band_w)
            img[y:y + a_h, MARGIN:MARGIN + band_w] = LUT[_lut_idx(v[a_idx])]
        else:
            img[y:y + a_h, MARGIN:MARGIN + band_w] = LUT[0]
        y += a_h + 2
        # band B (8 px): status per source frame (0 dropped / 1 used / >=2 duplicate)
        cnt = np.bincount(pick, minlength=n)
        status = np.where(cnt >= 2, 2, np.where(cnt == 1, 1, 0))
        img[y:y + b_h, MARGIN:MARGIN + band_w] = _STATUS[status[_band_pixels(cnt, band_w)]]
        y += b_h + 10
    # status legend (18 px): 10×10 squares at y+4, 4 px to the text, 16 px between entries
    x = MARGIN
    for color, name in ((DROP, "dropped"), (USED, "used"), (DUP, "duplicate")):
        img[y + 4:y + 14, x:x + 10] = color
        texts.append((x + 14, y + 4, name))
        x += 14 + int(round(_text_w(name))) + 16
    # colour legend (26 px)
    img[height - 26:height] = _legend_bar(width)
    pil = Image.fromarray(img)
    draw = ImageDraw.Draw(pil)
    font = _font()
    for tx, ty, s in texts:
        draw.text((tx, ty), s, font=font, fill=TEXT)
    return np.asarray(pil)


# ---------------------------------------------------------------------------
# 2. motion_heatmap
# ---------------------------------------------------------------------------

def motion_heatmap(frames: np.ndarray, width: int = 512) -> np.ndarray:
    """Per-pixel accumulated change of ONE shot, coloured through the LUT with
    alpha 0.15 + 0.6·v over the first frame (colour, width px wide).
    Height = image height + 26 (legend bar)."""
    frames = np.asarray(frames)
    n, h, w, _ = frames.shape
    th = max(int(round(h * width / w)), 1)
    small = np.empty((n, th, width), dtype=np.float32)
    for t in range(n):
        a = np.asarray(Image.fromarray(frames[t]).resize((width, th), Image.BILINEAR),
                       dtype=np.float32)
        small[t] = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]
    if n >= 2:
        acc = np.abs(np.diff(small, axis=0)).sum(axis=0)
        p99 = float(np.percentile(acc, 99))
        v = np.clip(acc / p99, 0.0, 1.0) ** 0.6 if p99 > 0 else np.zeros_like(acc)
    else:
        v = np.zeros((th, width), dtype=np.float32)
    color = LUT[_lut_idx(v)]
    base = np.asarray(Image.fromarray(frames[0]).resize((width, th), Image.BILINEAR),
                      dtype=np.float32)
    alpha = (0.15 + 0.6 * v)[..., None]
    out = (1.0 - alpha) * base + alpha * color
    img = np.clip(out.round(), 0, 255).astype(np.uint8)
    return np.concatenate([img, _legend_bar(width)], axis=0)


# ---------------------------------------------------------------------------
# 3a. onion_skin
# ---------------------------------------------------------------------------

def onion_skin(frames: np.ndarray, idx: np.ndarray, n: int = 8, width: int = 512) -> np.ndarray:
    """Weighted blend of n used frames (weights 1..n normalized, newest strongest),
    BILINEAR to width px, + caption line 18 px. Height = image height + 18."""
    frames = np.asarray(frames)
    idx = np.asarray(idx, dtype=int)
    sel = _even_idx(idx, n)
    h, w, _ = frames[0].shape
    th = max(int(round(h * width / w)), 1)
    acc = np.zeros((th, width, 3), dtype=np.float32)
    weights = np.arange(1, len(sel) + 1, dtype=np.float32)
    weights /= weights.sum()
    for f, wt in zip(sel, weights):
        a = np.asarray(Image.fromarray(frames[f]).resize((width, th), Image.BILINEAR),
                       dtype=np.float32)
        acc += wt * a
    img = np.clip(acc.round(), 0, 255).astype(np.uint8)
    cap = np.full((18, width, 3), BG, dtype=np.uint8)
    pil = Image.fromarray(cap)
    draw = ImageDraw.Draw(pil)
    draw.text((MARGIN, 3),
              f"onion skin · {n} of {len(set(idx.tolist()))} used frames · newest strongest",
              font=_font(), fill=TEXT)
    cap = np.asarray(pil)
    return np.concatenate([img, cap], axis=0)


# ---------------------------------------------------------------------------
# 3b. contact_sheet
# ---------------------------------------------------------------------------

def contact_sheet(frames: np.ndarray, idx: np.ndarray, n: int = 12, cols: int = 4,
                  fps: float = 24.0, width: int = 512) -> np.ndarray:
    """Grid of n used frames: cols columns, 4 px gap (also outside) -> tile width
    (width - (cols+1)*4) / cols, tile height by aspect ratio (rounded). Caption 14 px
    under each tile: '#<frame>  <t> s'. Height = 4 + rows * (tile_h + 14 + 4)."""
    frames = np.asarray(frames)
    idx = np.asarray(idx, dtype=int)
    sel = _even_idx(idx, n)
    h, w, _ = frames[0].shape
    gap = 4
    tile_w = (width - (cols + 1) * gap) // cols  # (512 - 20) / 4 = 123
    tile_h = max(int(round(tile_w * h / w)), 1)
    rows = int(np.ceil(len(sel) / cols))
    height = gap + rows * (tile_h + 14 + gap)
    img = np.full((height, width, 3), BG, dtype=np.uint8)
    for k, f in enumerate(sel):
        r, c = divmod(k, cols)
        x = gap + c * (tile_w + gap)
        y = gap + r * (tile_h + 14 + gap)
        img[y:y + tile_h, x:x + tile_w] = np.asarray(
            Image.fromarray(frames[f]).resize((tile_w, tile_h), Image.BILINEAR))
    pil = Image.fromarray(img)
    draw = ImageDraw.Draw(pil)
    font = _font()
    for k, f in enumerate(sel):
        r, c = divmod(k, cols)
        x = gap + c * (tile_w + gap)
        y = gap + r * (tile_h + 14 + gap)
        draw.text((x, y + tile_h + 1), f"#{f}  {f / fps:.2f} s", font=font, fill=TEXT)
    return np.asarray(pil)
