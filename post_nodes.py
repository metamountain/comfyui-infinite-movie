"""Hilfsfunktionen rund um Render/Assemble: Prompt säubern, ffmpeg-Probe, RIFE x2."""

from __future__ import annotations

import os
import re
import subprocess
import tempfile

import numpy as np
import torch
from PIL import Image

from .media import _count_frames, _ffmpeg, _no_window


def _clean_prompt(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    text = " ".join(text.replace('"', "").split())
    return text


# ---------------------------------------------------------------------------
# ffmpeg-Probe / RIFE
# ---------------------------------------------------------------------------

def _probe_fps(path: str) -> float:
    out = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path], capture_output=True, text=True,
                         **_no_window()).stderr
    m = re.search(r"(\d+(?:\.\d+)?) fps", out)
    return float(m.group(1)) if m else 24.0


def _probe_size(path: str) -> tuple[int, int]:
    out = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path], capture_output=True, text=True,
                         **_no_window()).stderr
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", out)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def _rife_x2(src: str, dst: str, fps: float, chunk: int = 96) -> None:
    """RIFE x2 via the installed 'RIFE VFI' node (comfyui-frame-interpolation),
    in chunks (RAM), chunks overlap by one frame so no transition is lost."""
    import nodes as comfy_nodes
    rife_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("RIFE VFI")
    if rife_cls is None:
        raise ValueError("InfiniteMovieUpscale: 'RIFE VFI' node not installed (comfyui-frame-interpolation)")
    w, h = _probe_size(src)
    n = _count_frames(src)
    with tempfile.TemporaryDirectory(prefix="infinite_movie_finish_") as tmp:
        raw = subprocess.Popen([_ffmpeg(), "-v", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                               stdout=subprocess.PIPE, **_no_window())
        frame_bytes = w * h * 3
        out_idx = 0
        prev_last = None
        done = 0
        while done < n:
            buf = []
            if prev_last is not None:
                buf.append(prev_last)
            while len(buf) < chunk + (1 if prev_last is not None else 0):
                b = raw.stdout.read(frame_bytes)
                if len(b) < frame_bytes:
                    break
                buf.append(np.frombuffer(b, np.uint8).reshape(h, w, 3))
                done += 1
            if len(buf) < 2:
                break
            t = torch.from_numpy(np.stack(buf)).float() / 255.0
            res = rife_cls().vfi("rife49.pth", t, multiplier=2, fast_mode=True, ensemble=True)[0]
            frames = res if prev_last is None else res[1:]  # first frame = previous chunk's last
            for f in frames:
                Image.fromarray((f.clamp(0, 1).numpy() * 255).astype(np.uint8)).save(
                    os.path.join(tmp, f"{out_idx:06d}.png"), compress_level=1)
                out_idx += 1
            prev_last = buf[-1]
            if done >= n:
                break
        raw.stdout.close()
        raw.wait()
        subprocess.run([_ffmpeg(), "-y", "-v", "error", "-framerate", f"{fps * 2:g}",
                        "-i", os.path.join(tmp, "%06d.png"), "-c:v", "libx264", "-crf", "12",
                        "-pix_fmt", "yuv420p", dst], check=True, **_no_window())


# 2026-11-02: InfiniteMovieUpscale gelöscht (Nutzer: "seh immer noch den upscale node") – Skalieren mit
# Upscale Crop Universal (upscale_universal/) bzw. LTX-IC-LoRA-Workflow. Sicherung tmp/alt/2026-11-02-upscale-node/.
POST_NODE_LIST = []
