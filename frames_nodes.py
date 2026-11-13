"""117e: InfiniteMovieFramesCollect extracted from nodes.py (Auftrag 117e).

The internal node reads the segment mp4s in order and returns all film frames
as one IMAGE batch. It imports .media (ffmpeg helpers); nothing from .nodes may
be imported at module level (cycle: nodes.py imports frames_nodes for NODE_LIST).
"""
from __future__ import annotations

import os
import subprocess

import numpy as np
import torch

from comfy_api.latest import io

from .media import _count_frames, _ffmpeg, _no_window

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
