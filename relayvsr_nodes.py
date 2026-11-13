"""Infinite Movie · RelayVSR Upscale (2026-11-11, user: "cut the films into short parts, with a gigabyte switch").

RelayVSR (core: RelayVSRConditioning -> KSampler 1 step cfg 1 -> VSR Decode) keeps the whole decoded film as float32
in RAM: X4 on 768x960 = 3072x3840 = 141 MB per frame, a 26 s film (624 frames) wanted 88 GB (report 108).
This node is the divider: it cuts the film into segments that fit ram_gb, upscales each segment, scales it down
to longest_side right away (area = calmer texture, measured in 108) and streams it to ffmpeg. Segments overlap and
are cross-faded, loops stay seamless, every segment is cached (a re-run resumes) - the shared loop of LTX Refine
(chunk_upscale_nodes.stream_chunks).
"""

from __future__ import annotations

import hashlib
import json
import os

import numpy as np
import torch

from comfy_api.latest import io

from . import vram
from .chunk_upscale_nodes import (_read_virtual, _resolve_source, output_with_preview, stream_chunks)
from .nodes import _count_frames, _probe_size, _send_progress
from .post_nodes import _probe_fps

KEYFRAME_INTERVAL = 15     # comfy.ldm.wan.model_vsr.RELAY_KEYFRAME_INTERVAL: every 15th frame goes through the model
RAM_FACTOR = 2.0           # bytes in RAM per decoded float32 value incl. headroom (VAE decodes into one preallocated buffer)
MIN_SEGMENT = 16
DEFAULT_RAM_GB = 16.0
DEFAULT_OVERLAP = 8


def model_factor(model) -> int:
    """Upscale factor of the RelayVSR model (latent_stride = 16 // factor, comfy/ldm/wan/model_vsr.py:112)."""
    stride = getattr(getattr(getattr(model, "model", None), "diffusion_model", None), "latent_stride", None)
    if not stride:
        raise ValueError("RelayVSR Upscale: model ist kein RelayVSR-Modell (relayvsr_x2/x4 über UNETLoader laden).")
    return max(1, 16 // int(stride))


def output_size(w: int, h: int, factor: int, longest_side: int) -> tuple[int, int, int, int]:
    """(model width, model height, output width, output height). longest_side 0 = model size; never larger
    than the model output (only scales down), both sides even (H.264 yuv420p)."""
    mw, mh = w * factor, h * factor
    k = 1.0 if longest_side <= 0 else min(1.0, longest_side / max(mw, mh))
    return mw, mh, max(2, int(round(mw * k / 2)) * 2), max(2, int(round(mh * k / 2)) * 2)


def segment_frames(ram_gb: float, model_w: int, model_h: int) -> int:
    """Frames per segment so that the decoded segment fits ram_gb. From 31 frames on snapped to 15n+1
    (keyframes exactly on the RelayVSR grid), minimum 16."""
    per_frame = model_w * model_h * 3 * 4 * RAM_FACTOR
    n = int(float(ram_gb) * 1024 ** 3 // per_frame)
    if n >= 2 * KEYFRAME_INTERVAL + 1:
        return ((n - 1) // KEYFRAME_INTERVAL) * KEYFRAME_INTERVAL + 1
    return max(MIN_SEGMENT, n)


def segment_starts(n_frames: int, seg: int, overlap: int) -> tuple[list[int], int]:
    """Start frames + segment length. Whole film fits -> one segment of n_frames. Otherwise all segments
    are seg long, the last one ends exactly at the end; every frame lies in at most two segments."""
    if n_frames <= seg:
        return [0], n_frames
    stride = seg - overlap
    starts = sorted(set(list(range(0, n_frames - seg, stride)) + [n_frames - seg]))
    while len(starts) >= 3 and starts[-1] < starts[-3] + seg:
        del starts[-2]
    return starts, seg


def _relay_segment(frames: np.ndarray, model, vae, detail: float, seed: int, tw: int, th: int) -> np.ndarray:
    """One segment through the core RelayVSR graph (template utility_relayvsr_video_x2_upscale), then area
    down to tw x th on the GPU in small batches. Returns uint8 [F,th,tw,3]."""
    import comfy.model_management as mm
    import nodes as comfy_nodes
    from comfy_extras.nodes_wan import RelayVSRConditioning, VSRDecode

    images = torch.from_numpy(frames).float() / 255.0
    positive, latent = RelayVSRConditioning.execute(model=model, images=images).args
    sampled = comfy_nodes.common_ksampler(model, int(seed), 1, 1.0, "euler", "simple", positive, positive, latent,
                                          denoise=1.0)[0]
    decoded = VSRDecode.execute(vae=vae, samples=sampled, images=images, detail=float(detail)).args[0]
    n = len(frames)
    if decoded.shape[0] < n:
        raise RuntimeError(f"RelayVSR Upscale: Decoder lieferte {decoded.shape[0]} statt {n} Frames.")
    out = np.empty((n, th, tw, 3), np.uint8)
    dev = mm.get_torch_device()
    for k in range(0, n, 4):
        piece = decoded[k:min(n, k + 4)].to(dev, torch.float32)
        if piece.shape[1] != th or piece.shape[2] != tw:
            piece = torch.nn.functional.interpolate(piece.movedim(-1, 1), size=(th, tw), mode="area").movedim(1, -1)
        out[k:k + piece.shape[0]] = (piece.clamp(0, 1) * 255.0 + 0.5).byte().cpu().numpy()
    del decoded
    return out


class InfiniteMovieRelayVSRUpscale(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieRelayVSRUpscale",
            display_name="RelayVSR Upscale · Infinite Movie",
            category="Infinite Movie/5 Upscale",
            is_output_node=True,
            description=("Upscales a whole film of any length with RelayVSR (x2 or x4), segment by segment: ram_gb sets "
                         "how big a segment may get, so long films no longer run out of RAM. Each segment is scaled "
                         "down to longest_side right away (x4 -> 1920 = calmest and sharpest, report 108), segments "
                         "overlap and are cross-faded, loops stay seamless, a re-run resumes."),
            inputs=[
                io.Model.Input("model", tooltip="UNETLoader: relayvsr_x2_… or relayvsr_x4_… (the model decides the factor)."),
                io.Vae.Input("vae", tooltip="VAELoader: the matching relayvsr_flash_vae_x2/x4."),
                io.Float.Input("ram_gb", default=DEFAULT_RAM_GB, min=2.0, max=256.0, step=1.0,
                               tooltip="Divider: RAM one segment may use (decoded at model size, float32). Segment "
                                       "length follows from it, e.g. x4 on 768x960: 16 GB = 46 frames, x2: 241 frames. "
                                       "Lower it when RAM runs out, raise it for fewer seams."),
                io.Int.Input("longest_side", default=1920, min=0, max=8192, step=2,
                             tooltip="Scale each segment down (area) to this long side right away. 0 = keep model size "
                                     "(x4 on 768x960 = 3840, huge files). Never scales up."),
                io.Float.Input("detail", default=1.0, min=0.0, max=1.0, step=0.01,
                               tooltip="VSR Decode detail. 1.0 = full model detail (lower costs sharpness, barely "
                                       "less flicker, report 108)."),
                io.Boolean.Input("loop", default=True,
                                 tooltip="Film is a loop: the seam end->start is cross-faded like every segment border."),
                io.Int.Input("overlap", advanced=True, default=DEFAULT_OVERLAP, min=2, max=32,
                             tooltip="Frames shared by neighbouring segments, cross-faded linearly."),
                io.Int.Input("seed", advanced=True, default=0, min=0, max=2 ** 31 - 1),
                io.Int.Input("crf", advanced=True, default=16, min=0, max=40),
                io.String.Input("filename_prefix", default="infinite_movie/relayvsr",
                                tooltip="Only without video_path. With video_path the film is saved next to it "
                                        "as <name>_upscale.mp4."),
                io.Image.Input("images", optional=True, tooltip="Frames, e.g. VHS Load Video (priority 1)."),
                io.Audio.Input("audio", optional=True, tooltip="Sound for images, e.g. VHS Load Video audio."),
                io.Float.Input("fps", optional=True, default=0.0, min=0.0, max=120.0, step=0.001,
                               tooltip="Frame rate for images (0 = 24)."),
                io.String.Input("video_path", optional=True, default="",
                                tooltip="File path (priority 2), read segment by segment - long films never sit in "
                                        "RAM as a whole. Also names the result: <name>_upscale.mp4."),
            ],
            hidden=[io.Hidden.unique_id],
            outputs=[io.String.Output("video_path")],
        )

    @classmethod
    def execute(cls, model, vae, ram_gb, longest_side, detail, loop, overlap, seed, crf, filename_prefix,
                images=None, audio=None, fps=0.0, video_path="") -> io.NodeOutput:
        import folder_paths

        uid = getattr(getattr(cls, "hidden", None), "unique_id", None)
        name_src = (video_path or "").strip().strip('"')
        if name_src:
            out_dir = os.path.dirname(os.path.abspath(name_src))
            out_path = os.path.join(out_dir, os.path.splitext(os.path.basename(name_src))[0] + "_upscale.mp4")
        else:
            out_dir, fname, counter, _sub, _ = folder_paths.get_save_image_path(
                filename_prefix, folder_paths.get_output_directory())
            out_path = os.path.join(out_dir, f"{fname}_{counter:05}_.mp4")
        os.makedirs(out_dir, exist_ok=True)
        cache_root = os.path.join(folder_paths.get_output_directory(), "_chunk_upscale_cache")
        os.makedirs(cache_root, exist_ok=True)

        src = _resolve_source(video_path, cache_root, images, audio, fps)
        n_src = _count_frames(src)
        if n_src <= 0:
            raise ValueError(f"RelayVSR Upscale: keine Frames in {src}")
        fps = _probe_fps(src)
        sw, sh = _probe_size(src)
        factor = model_factor(model)
        mw, mh, tw, th = output_size(sw, sh, factor, int(longest_side))
        seg = segment_frames(ram_gb, mw, mh)
        ov = max(1, min(int(overlap), seg // 2))
        loop = bool(loop) and n_src > ov
        n_virt = n_src + ov if loop else n_src
        starts, seg = segment_starts(n_virt, seg, ov)

        st = os.stat(src)
        key = hashlib.sha1(json.dumps(["relayvsr", os.path.abspath(src), st.st_size, int(st.st_mtime), factor, tw, th,
                                       seg, ov, float(detail), int(seed), loop]).encode()).hexdigest()[:16]
        cache = os.path.join(cache_root, key)
        os.makedirs(cache, exist_ok=True)

        vram.wait_acquire(min_free_mb=6000, timeout_s=3600)
        _send_progress(f"x{factor} {sw}x{sh} -> {tw}x{th}: {len(starts)} segments of {seg} frames "
                       f"({ram_gb:g} GB), overlap {ov}", uid)

        def upscale(i, s):
            _send_progress(f"segment {i + 1}/{len(starts)} (frames {s}-{s + seg - 1})", uid)
            frames = _read_virtual(src, s, seg, sw, sh, n_src, loop)
            return _relay_segment(frames, model, vae, detail, seed, tw, th)

        stream_chunks(src, n_src, starts, seg, ov, loop, fps, tw, th, crf, out_path, cache, upscale, "RelayVSR Upscale")
        _send_progress(f"done {tw}x{th}, {len(starts)} segments", uid)
        return output_with_preview(out_path)


RELAYVSR_NODE_LIST = [InfiniteMovieRelayVSRUpscale]
