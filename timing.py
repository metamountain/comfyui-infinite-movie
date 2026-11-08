"""Timing logging + estimation for Infinite Movie segments (Auftrag 88).

Stdlib only. No ComfyUI imports at module level (folder_paths is imported
lazily inside _user_dir so the module also loads in the offline test, where
folder_paths is not on the path).

Every rendered segment appends one JSON line to a JSONL file. estimate() reads
that history and predicts the duration (seconds) of a future segment:

  a) exact  – same kind, preset, width, height, frames  -> median of last 10
  b) scaled – same kind (+ preset, else kind only)      -> median of
                (seconds / mpx_frames) of last 20, times the request mpx_frames
  c) no data -> None

Outliers above 3x the median are discarded before the median is taken.
"""

from __future__ import annotations

import json
import os
import statistics
from datetime import datetime

# Fallback ComfyUI user dir when folder_paths is not importable (offline test).
# custom_nodes/<pack>/timing.py -> <ComfyUI>/user (no machine-specific paths: the pack is public)
_FALLBACK_USER_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "user"))
_FILENAME = "infinite_movie_timings.jsonl"


def _user_dir() -> str:
    """ComfyUI user dir via folder_paths (lazy), else the portable fallback."""
    try:
        import folder_paths  # noqa: PLC0415  (lazy on purpose)
        return folder_paths.get_user_directory()
    except Exception:
        return _FALLBACK_USER_DIR


def timings_path(path: str | None = None) -> str:
    """Path of the timings JSONL file. Override with path= (tests, backfill)."""
    if path:
        return path
    return os.path.join(_user_dir(), _FILENAME)


def _mpx_frames(width: int, height: int, frames: int) -> float:
    """Megapixels * frames – the size proxy the scaled estimate normalizes on."""
    return width * height * frames / 1e6


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def record(kind, width, height, frames, seconds,
           preset="", variants=1, extra=None, path=None) -> None:
    """Append one JSON line to the timings file.

    Never raises: any failure (missing dir, permission, bad value) is logged
    and swallowed, so a timing bug can never break a render.
    """
    try:
        p = timings_path(path)
        d = os.path.dirname(p)
        if d:
            os.makedirs(d, exist_ok=True)
        entry = {
            "t": datetime.now().isoformat(timespec="seconds"),
            "kind": kind,
            "preset": preset,
            "width": width,
            "height": height,
            "frames": frames,
            "variants": variants,
            "seconds": seconds,
            "mpx_frames": _mpx_frames(width, height, frames),
        }
        if extra:
            entry.update(extra)
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as e:  # noqa: BLE001
        print(f"[timing] record failed (ignored): {e}")


def _read_entries(path: str | None = None) -> list[dict]:
    """Read all JSONL entries; malformed lines are skipped, missing file -> []."""
    p = timings_path(path)
    entries: list[dict] = []
    try:
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except Exception:  # noqa: BLE001
                    continue
                if isinstance(e, dict):
                    entries.append(e)
    except OSError:
        return []
    return entries


def _by(entries: list[dict], kind, preset=None,
        width=None, height=None, frames=None) -> list[dict]:
    """Filter entries. preset=None means 'ignore preset'; preset='' matches only empty."""
    out = []
    for e in entries:
        if e.get("kind") != kind:
            continue
        if preset is not None and e.get("preset") != preset:
            continue
        if width is not None and e.get("width") != width:
            continue
        if height is not None and e.get("height") != height:
            continue
        if frames is not None and e.get("frames") != frames:
            continue
        out.append(e)
    return out


def _median_outlier(values: list[float]) -> tuple[float | None, int]:
    """Median of values after discarding outliers above 3x the median.

    Returns (median, count_kept). (None, 0) when there is no usable value.
    """
    vals = [float(v) for v in values if _is_num(v)]
    if not vals:
        return None, 0
    med = statistics.median(vals)
    if med > 0:
        kept = [v for v in vals if v <= 3 * med]
        if not kept:
            kept = vals
    else:
        kept = vals
    return statistics.median(kept), len(kept)


def estimate(kind, width, height, frames, preset="", path=None):
    """Estimate the duration (seconds) of a segment from the recorded history.

    Returns {"seconds": x, "n": k, "match": "exact"|"scaled"} or None.
    """
    entries = _read_entries(path)
    if not entries:
        return None
    mpx = _mpx_frames(width, height, frames)

    # a) exact: same kind, preset, width, height, frames -> median of last 10
    exact = _by(entries, kind, preset=preset, width=width, height=height, frames=frames)
    if exact:
        vals = [e["seconds"] for e in exact[-10:] if _is_num(e.get("seconds"))]
        if vals:
            med, n = _median_outlier(vals)
            if med is not None:
                return {"seconds": med, "n": n, "match": "exact"}

    # b) scaled: same kind + preset, else kind only -> median of seconds/mpx of last 20
    pools = [_by(entries, kind, preset=preset)]
    if preset:
        pools.append(_by(entries, kind))  # fallback: kind only
    for pool in pools:
        rates = []
        for e in pool:
            em = e.get("mpx_frames")
            sec = e.get("seconds")
            if _is_num(em) and em > 0 and _is_num(sec):
                rates.append(sec / em)
        if not rates:
            continue
        med, n = _median_outlier(rates[-20:])
        if med is not None and n > 0:
            return {"seconds": med * mpx, "n": n, "match": "scaled"}

    # c) no data
    return None
