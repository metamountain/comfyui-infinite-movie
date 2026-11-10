"""Infinite Movie · LTX Refine (2026-11-02, user: "upscale sampler that always rotates 30-50 frames").

Standard (measurement 2026-11-02, weather loop): upscale model 2xLiveActionV1_SPAN via Upscale Crop Universal first,
then here "refine 1:1" with sigma 0.42 -> sharpness x1.72, texture calmer than the original, fidelity 0.99.
Mode "ic-lora upscale x2" (pixel upscaler LoRA) stays selectable, but it invents more (max x1.25 without boiling).

LTX-2.5 IC-LoRA pixel spatial upscaler x2 on a whole film, piece by piece:
- Cut the video into chunks of chunk_frames (8n+1) with an overlap of (8n+1) frames; stride
  = chunk_frames - overlap is a multiple of 8 -> the latent grids of the chunks align.
- Each chunk: lanczos to target size -> VAEEncode -> LTXAddVideoICLoRAGuide -> CFGGuider (cfg 1)
  -> SamplerCustomAdvanced (ManualSigmas) -> LTXVCropGuides -> VAEDecodeTiled. Exactly the graph from
  tmp/messung_ltx_upscale.py (121 frames at once = OOM on 24 GB, 49 frames fit).
- Noise per ABSOLUTE latent frame (generator seed = seed + index): the same position in the film gets the
  same noise in both chunks -> the invented details match in the overlap.
- Cross-fade the overlap linearly, send finished frames to ffmpeg immediately (keep RAM small), each chunk
  cached as .npy (a restart after a crash continues at the next chunk), take the audio from the source.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess

import numpy as np
import torch

from comfy_api.latest import InputImpl, io, ui

from . import vram
from .nodes import _count_frames, _ffmpeg, _no_window, _probe_size, _send_progress
from .post_nodes import _probe_fps
from .upscale_universal.upscale_crop_universal import _scale_for, _snap as _snap_mult

DEFAULT_SIGMAS = "0.421875, 0.0"   # refine 1:1; ic-lora: "0.725, 0.421875, 0.0"
ICLORA_SIGMAS = "0.725, 0.421875, 0.0"   # texture as calm as the source, sharpness x1.17 (measurement 2026-11-02; 0.909 boils)
DEFAULT_POSITIVE_HINT = "LTXVConditioning: look/style only, e.g. 'photographic, 4k' – no objects (they stamp into every chunk)"
MODES = ["refine 1:1", "ic-lora upscale x2"]
REFINE_SIGMAS = "0.421875, 0.0"
TARGET_MODES = ["scale_factor", "scale_percent", "shortest_side", "longest_side", "megapixels"]  # like Upscale Crop Universal, without custom (crop)
MAX_SIDE = 2560


def _snap(n: int, m: int = 64) -> int:
    return max(m, int(n // m) * m)


def _snap_8n1(n: int, lo: int) -> int:
    n = max(lo, int(n))
    return ((n - 1) // 8) * 8 + 1


def target_size(w: int, h: int, mode: str = "scale_factor", scale_factor: float = 1.5, scale_percent: float = 150.0,
                shortest_side: int = 1024, longest_side: int = 1280, megapixels: float = 1.3,
                multiple_of: int = 64) -> tuple[int, int]:
    """Target size with the same calculation as Upscale Crop Universal (_scale_for + _snap: next multiple).
    multiple_of at least 32 (LTX); 64 for the factor-2 LoRA (1440 -> rearrange error)."""
    k = _scale_for(w, h, mode, scale_percent, scale_factor, shortest_side, longest_side, megapixels)
    m = max(32, int(multiple_of))
    tw, th = _snap_mult(w * k, m), _snap_mult(h * k, m)
    if max(tw, th) > MAX_SIDE:
        raise ValueError(f"LTX Refine: Ziel {tw}x{th} ist zu groß (lange Seite max {MAX_SIDE}).")
    return tw, th


def chunk_starts(n_frames: int, chunk: int, overlap: int) -> tuple[list[int], int]:
    """Start frames of the chunks + padded length (8n+1). Stride = chunk - overlap (multiple of 8).
    The last chunk ends exactly at the end; if it displaces the second-to-last, the overlap there gets smaller (>= 9)."""
    n_pad = _snap_8n1(n_frames + 7, 1) if (n_frames - 1) % 8 else n_frames
    if n_pad <= chunk:
        return [0], n_pad
    stride = chunk - overlap
    starts = list(range(0, n_pad - chunk, stride))
    starts.append(n_pad - chunk)
    starts = sorted(set(starts))
    # Each frame may be in at most TWO chunks (cross-fade always only predecessor/successor):
    # the short last chunk displaces the second-to-last if necessary.
    while len(starts) >= 3 and starts[-1] < starts[-3] + chunk:
        del starts[-2]
    return starts, n_pad


def frame_noise(shape, seed: int, abs_latent0: int, n_video: int, device="cpu") -> torch.Tensor:
    """Noise [B,C,T,H,W]: video latent frame k gets the noise of absolute frame abs_latent0+k,
    appended guide frames (k >= n_video) get their own, also absolute, noise."""
    b, c, t, h, w = shape
    out = torch.empty(shape, dtype=torch.float32)
    for k in range(t):
        idx = abs_latent0 + k if k < n_video else 1_000_000 + abs_latent0 + (k - n_video)
        g = torch.Generator(device="cpu").manual_seed((int(seed) * 1_000_003 + idx) % (2 ** 63))
        out[:, :, k] = torch.randn((b, c, h, w), generator=g, dtype=torch.float32)
    return out.to(device)


class _AbsNoise:
    """NOISE object like comfy_extras Noise_RandomNoise, but position-bound."""

    def __init__(self, seed: int, abs_latent0: int, n_video: int):
        self.seed, self.abs_latent0, self.n_video = seed, abs_latent0, n_video

    def generate_noise(self, input_latent):
        s = input_latent["samples"]
        return frame_noise(tuple(s.shape), self.seed, self.abs_latent0, self.n_video)


def _read_frames(src: str, start: int, count: int, w: int, h: int, n_src: int) -> np.ndarray:
    """count frames from start (lanczos to w×h) as uint8 [F,H,W,3]; beyond the end = last frame."""
    real = max(0, min(count, n_src - start))
    frames = np.zeros((0, h, w, 3), np.uint8)
    if real > 0:
        cmd = [_ffmpeg(), "-v", "error", "-i", src, "-vf",
               f"select='between(n\\,{start}\\,{start + real - 1})',scale={w}:{h}:flags=lanczos",
               "-vsync", "0", "-frames:v", str(real), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        raw = subprocess.run(cmd, capture_output=True, check=True, **_no_window()).stdout
        frames = np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)
    if len(frames) < count:
        last = frames[-1:] if len(frames) else _read_frames(src, n_src - 1, 1, w, h, n_src)
        frames = np.concatenate([frames, np.repeat(last, count - len(frames), axis=0)])
    return frames


def _read_virtual(src: str, start: int, count: int, w: int, h: int, n_src: int, loop: bool) -> np.ndarray:
    """Like _read_frames, but in loop mode the time axis runs past the end into the start
    (virtual frame v = source frame v mod n_src)."""
    if not loop or start + count <= n_src:
        return _read_frames(src, start, count, w, h, n_src)
    parts, v, left = [], start, count
    while left > 0:
        a = v % n_src
        k = min(left, n_src - a)
        parts.append(_read_frames(src, a, k, w, h, n_src))
        v, left = v + k, left - k
    return np.concatenate(parts)


def _encoder(path: str, w: int, h: int, fps: float, crf: int) -> subprocess.Popen:
    return subprocess.Popen([_ffmpeg(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                             "-s", f"{w}x{h}", "-r", f"{fps:g}", "-i", "-", "-c:v", "libx264",
                             "-crf", str(int(crf)), "-pix_fmt", "yuv420p", "-color_primaries", "bt709",
                             "-color_trc", "bt709", "-colorspace", "bt709", path],
                            stdin=subprocess.PIPE, **_no_window())


def _upscale_chunk(frames: np.ndarray, model, vae, positive, negative, ldf: float, sigmas: torch.Tensor,
                   seed: int, abs_latent0: int, use_guide: bool = True) -> np.ndarray:
    import comfy.samplers
    import nodes as comfy_nodes
    from comfy_extras.nodes_custom_sampler import CFGGuider, SamplerCustomAdvanced
    from comfy_extras.nodes_lt import LTXVCropGuides

    LTXAddVideoICLoRAGuide = comfy_nodes.NODE_CLASS_MAPPINGS.get("LTXAddVideoICLoRAGuide")
    if use_guide and LTXAddVideoICLoRAGuide is None:
        raise RuntimeError("LTX Refine: ComfyUI-LTXVideo (LTXAddVideoICLoRAGuide) ist nicht installiert.")

    pixels = torch.from_numpy(frames).float() / 255.0
    latent = comfy_nodes.VAEEncode().encode(vae, pixels)[0]
    n_video = latent["samples"].shape[2]
    if use_guide:
        pos, neg, lat = LTXAddVideoICLoRAGuide.execute(
            positive=positive, negative=negative, vae=vae, latent=latent, image=pixels, frame_idx=0, strength=1.0,
            latent_downscale_factor=float(ldf), crop="disabled", use_tiled_encode=False, tile_size=256,
            tile_overlap=64, use_streaming=False, tile_frames=0).args
    else:   # refine 1:1: nur Rauschen drauf und wenige Schritte zurück (kein IC-LoRA-Guide)
        pos, neg, lat = positive, negative, latent
    guider = CFGGuider.execute(model=model, positive=pos, negative=neg, cfg=1.0).args[0]
    sampler = comfy.samplers.sampler_object("euler")
    out = SamplerCustomAdvanced.execute(noise=_AbsNoise(seed, abs_latent0, n_video), guider=guider,
                                        sampler=sampler, sigmas=sigmas, latent_image=lat).args[0]
    cropped = LTXVCropGuides.execute(positive=pos, negative=neg, latent=out).args[2] if use_guide else out
    images = comfy_nodes.VAEDecodeTiled().decode(vae, cropped, 768, 64, 64, 16)[0]
    images = images.reshape(-1, images.shape[-3], images.shape[-2], images.shape[-1])
    return (images.clamp(0, 1) * 255.0 + 0.5).byte().cpu().numpy()[: len(frames)]


def _images_to_file(images, audio, fps: float, tmp: str) -> str:
    """Write an IMAGE batch (e.g. VHS Load Video) losslessly to a file, so the rest reads it
    chunk by chunk like a file. Name from shape + sample -> same images = same file (resume)."""
    n, h, w = images.shape[0], images.shape[1], images.shape[2]
    probe = images[:: max(1, n // 8)].float().mean().item()
    key = hashlib.sha1(json.dumps([n, h, w, round(probe, 6), fps]).encode()).hexdigest()[:16]
    path = os.path.join(tmp, f"images_{key}.mkv")
    if os.path.isfile(path):
        return path
    part = path + ".part.mkv"
    enc = subprocess.Popen([_ffmpeg(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
                            "-r", f"{fps:g}", "-i", "-", "-c:v", "libx264", "-qp", "0", "-preset", "veryfast",
                            "-pix_fmt", "yuv444p", part], stdin=subprocess.PIPE, **_no_window())
    for i in range(0, n, 16):
        enc.stdin.write((images[i:i + 16].clamp(0, 1) * 255 + 0.5).byte().cpu().numpy().tobytes())
    enc.stdin.close()
    enc.wait()
    from .audio_nodes import audio_or_none
    audio = audio_or_none(audio)   # VHS-LazyAudioMap raises on silent films -> continue without audio
    if audio is not None:
        wav = audio["waveform"][0].float().cpu().numpy().T.copy()        # [S, C]
        apath = path + ".f32"
        wav.astype(np.float32).tofile(apath)
        subprocess.run([_ffmpeg(), "-y", "-v", "error", "-i", part, "-f", "f32le", "-ar", str(int(audio["sample_rate"])),
                        "-ac", str(wav.shape[1]), "-i", apath, "-c:v", "copy", "-c:a", "flac", "-shortest", path],
                       check=True, **_no_window())
        os.remove(apath)
        os.remove(part)
    else:
        os.replace(part, path)
    return path


def _resolve_source(video, video_path: str, tmp: str, images=None, audio=None, fps: float = 0.0) -> str:
    if video is None and images is not None:
        return _images_to_file(images, audio, fps or 24.0, tmp)
    if video is not None:
        src = video.get_stream_source()
        if not isinstance(src, str):
            src = os.path.join(tmp, "source.mp4")
            video.save_to(src)
        return src
    p = (video_path or "").strip().strip('"')
    if p and os.path.isfile(p):
        return p
    raise ValueError("LTX Refine: video, images oder video_path anschließen.")


class InfiniteMovieLTXRefine(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieLTXRefine",
            display_name="Infinite Movie · LTX Refine",
            category="Infinite Movie/5 Upscale",
            is_output_node=True,
            description=("Refines a whole film with LTX-2.5, chunk by chunk (fits 24 GB). Typical: upscale with "
                         "Upscale Crop Universal (2xLiveActionV1_SPAN) first, then 'refine 1:1' at sigma 0.42 – "
                         "calms the per-frame flicker and keeps the sharpness. Chunks overlap and are cross-faded, "
                         "loops stay seamless, each chunk is cached (a re-run resumes)."),
            inputs=[
                io.Model.Input("model", tooltip="LTX-2.5 UNETLoader. For ic-lora upscale x2: through LTXICLoRALoaderModelOnly "
                                                "(pixel spatial upscaler x2)."),
                io.Combo.Input("mode", options=MODES, default=MODES[0],
                               tooltip="ic-lora upscale: pixel upscaler LoRA, guide = source. refine 1:1: no guide, "
                                       "plain V2V denoise (e.g. after a model upscaler like 2xVHS2HD), use the model "
                                       "WITHOUT the LoRA, scale_factor 1.0 and low sigmas."),
                io.Float.Input("latent_downscale_factor", advanced=True, default=2.0, min=1.0, max=10.0, step=1.0,
                               tooltip="Only for ic-lora upscale x2: LTXICLoRALoaderModelOnly output 1."),
                io.Vae.Input("vae"),
                io.Conditioning.Input("positive", tooltip=DEFAULT_POSITIVE_HINT),
                io.Conditioning.Input("negative"),
                io.Combo.Input("target_mode", options=TARGET_MODES, default="scale_factor",
                               tooltip="How to ask for the size (same as Upscale Crop Universal). Aspect ratio is kept."),
                io.Int.Input("multiple_of", advanced=True, default=64, min=32, max=256, step=32,
                             tooltip="Snap both sides to the nearest multiple. 64 for the LTX x2 upscaler LoRA."),
                io.Float.Input("scale_factor", default=1.0, min=1.0, max=2.0, step=0.05),
                io.Float.Input("scale_percent", default=100.0, min=100.0, max=200.0, step=5.0),
                io.Int.Input("shortest_side", default=1024, min=256, max=MAX_SIDE, step=32),
                io.Int.Input("longest_side", default=1280, min=256, max=MAX_SIDE, step=32),
                io.Float.Input("megapixels", default=1.3, min=0.2, max=6.0, step=0.05),
                io.Int.Input("chunk_frames", advanced=True, default=49, min=17, max=257, step=8,
                             tooltip="Frames per chunk (8n+1). 49 fits 1024x1280 on 24 GB."),
                io.Int.Input("overlap", advanced=True, default=17, min=9, max=65, step=8,
                             tooltip="Overlapping frames (8n+1), cross-faded."),
                io.String.Input("sigmas", default=DEFAULT_SIGMAS,
                                tooltip="ManualSigmas. refine 1:1: 0.421875, 0.0 (higher = softer + more flicker). "
                                        "ic-lora upscale x2: 0.725, 0.421875, 0.0 (0.8+ invents texture)."),
                io.Int.Input("seed", advanced=True, default=43, min=0, max=2 ** 31 - 1, control_after_generate=True),
                io.Boolean.Input("loop", default=True,
                                 tooltip="Film is a loop: the last chunk runs on into the start and the seam "
                                         "end->start is cross-faded like every other chunk border."),
                io.Int.Input("crf", advanced=True, default=16, min=0, max=40),
                io.String.Input("filename_prefix", default="infinite_movie/refine",
                                tooltip="Only without video_path. With video_path the film is saved next to it "
                                        "as <name>_upscale.mp4."),
                io.Video.Input("video", optional=True, tooltip="Film to upscale (priority 1)."),
                io.Image.Input("images", optional=True, tooltip="Frames, e.g. VHS Load Video (priority 2). Whole film in RAM."),
                io.Audio.Input("audio", optional=True, tooltip="Sound for images, e.g. VHS Load Video audio."),
                io.Float.Input("fps", optional=True, default=0.0, min=0.0, max=120.0, step=0.001,
                               tooltip="Frame rate for images (0 = 24). VHS Video Info fps."),
                io.String.Input("video_path", optional=True, default="",
                                tooltip="File path (priority 3). Also names the result: same folder, "
                                        "<name>_upscale.mp4 (e.g. from Assemble › video_path)."),
            ],
            hidden=[io.Hidden.unique_id],
            outputs=[
                io.Video.Output("video"),
                io.String.Output("video_path"),
            ],
        )

    @classmethod
    def execute(cls, model, mode, latent_downscale_factor, vae, positive, negative, target_mode, multiple_of, scale_factor,
                scale_percent, shortest_side, longest_side, megapixels, chunk_frames, overlap, sigmas, seed, loop,
                crf, filename_prefix, video=None, images=None, audio=None, fps=0.0, video_path="") -> io.NodeOutput:
        import comfy.utils
        import folder_paths

        uid = getattr(getattr(cls, "hidden", None), "unique_id", None)
        # video_path set -> same folder, same name + _upscale (user 2026-11-04),
        # also when the frames come via images (group 8: Assemble > video_path).
        name_src = (video_path or "").strip().strip('"')
        if name_src:
            out_dir = os.path.dirname(os.path.abspath(name_src))
            out_path = os.path.join(out_dir, os.path.splitext(os.path.basename(name_src))[0] + "_upscale.mp4")
        else:
            out_dir, fname, counter, subfolder, _ = folder_paths.get_save_image_path(
                filename_prefix, folder_paths.get_output_directory())
            out_path = os.path.join(out_dir, f"{fname}_{counter:05}_.mp4")
        os.makedirs(out_dir, exist_ok=True)
        cache_root = os.path.join(folder_paths.get_output_directory(), "_chunk_upscale_cache")
        os.makedirs(cache_root, exist_ok=True)

        src = _resolve_source(video, video_path, cache_root, images, audio, fps)
        n_src = _count_frames(src)
        if n_src <= 0:
            raise ValueError(f"LTX Refine: keine Frames in {src}")
        fps = _probe_fps(src)
        sw, sh = _probe_size(src)
        tw, th = target_size(sw, sh, target_mode, scale_factor, scale_percent, shortest_side, longest_side,
                             megapixels, multiple_of)
        chunk = _snap_8n1(chunk_frames, 17)
        ov = min(_snap_8n1(overlap, 9), _snap_8n1(chunk // 2, 9))   # overlap <= chunk/2 (siehe chunk_starts)
        loop = bool(loop) and n_src > ov
        n_virt = n_src + ov if loop else n_src     # loop: ov frames past the end (= start)
        starts, n_pad = chunk_starts(n_virt, chunk, ov)
        sig = torch.tensor([float(x) for x in str(sigmas).replace(";", ",").split(",") if x.strip()])

        st = os.stat(src)
        key = hashlib.sha1(json.dumps([os.path.abspath(src), st.st_size, int(st.st_mtime), tw, th, chunk, ov,
                                       str(sigmas), int(seed), float(latent_downscale_factor), loop, mode]).encode()).hexdigest()[:16]
        cache = os.path.join(cache_root, key)
        os.makedirs(cache, exist_ok=True)

        vram.wait_acquire(min_free_mb=8000, timeout_s=3600)
        tmp_video = out_path + ".noaudio.mp4"
        enc = _encoder(tmp_video, tw, th, fps, crf)
        head, wrap = {}, {}   # loop: start (frames 0..ov-1) and continuation (n_src..n_src+ov-1) for the seam

        def emit(f, arr):
            arr = np.clip(arr + 0.5, 0, 255).astype(np.uint8) if arr.dtype != np.uint8 else arr
            if loop and f < ov:
                head[f] = arr           # cross-faded with the continuation only at the end
            elif loop and n_src <= f < n_virt:
                wrap[f - n_src] = arr
            elif f < n_src:
                enc.stdin.write(arr.tobytes())

        pbar = comfy.utils.ProgressBar(len(starts))
        written, tail = 0, None   # tail = (start frame, frames) of the previous chunk from the next start
        try:
            for i, s in enumerate(starts):
                cpath = os.path.join(cache, f"chunk_{s:06d}.npy")
                if os.path.isfile(cpath):
                    up = np.load(cpath)
                else:
                    _send_progress(f"chunk {i + 1}/{len(starts)} (frames {s}-{s + chunk - 1})", uid)
                    frames = _read_virtual(src, s, chunk, tw, th, n_src, loop)
                    up = _upscale_chunk(frames, model, vae, positive, negative, latent_downscale_factor, sig,
                                        seed, s // 8, use_guide=(mode == "ic-lora upscale x2"))
                    np.save(cpath + ".part.npy", up)
                    os.replace(cpath + ".part.npy", cpath)
                # Cross-fade the overlap with the previous chunk linearly.
                if tail is not None:
                    t0, prev = tail
                    n_ov = len(prev)
                    for j in range(n_ov):
                        a = (j + 1) / (n_ov + 1)
                        emit(t0 + j, prev[j].astype(np.float32) * (1 - a) + up[t0 - s + j].astype(np.float32) * a)
                    written = t0 + n_ov
                nxt = starts[i + 1] if i + 1 < len(starts) else None
                end = (nxt if nxt is not None else s + chunk)
                for f in range(written, end):
                    emit(f, up[f - s])
                written = max(written, end)
                tail = (nxt, up[nxt - s:]) if nxt is not None else None
                pbar.update(1)
        finally:
            enc.stdin.close()
            enc.wait()
        if enc.returncode != 0:
            raise RuntimeError("LTX Refine: ffmpeg-Encode fehlgeschlagen")
        if loop:
            # Seam end -> start: cross-fade the continuation of the last chunk into the start of chunk 1,
            # encode it as a separate head chunk and prepend it to the rest (concat without re-encoding).
            head_video = out_path + ".head.mp4"
            henc = _encoder(head_video, tw, th, fps, crf)
            for f in range(ov):
                a = (f + 1) / (ov + 1)
                arr = wrap[f].astype(np.float32) * (1 - a) + head[f].astype(np.float32) * a
                henc.stdin.write(np.clip(arr + 0.5, 0, 255).astype(np.uint8).tobytes())
            henc.stdin.close()
            henc.wait()
            lst = out_path + ".concat.txt"
            with open(lst, "w", encoding="utf-8") as fh:
                for p_ in (head_video, tmp_video):
                    fh.write("file '" + p_.replace("\\", "/").replace("'", "'\\''") + "'\n")
            joined = out_path + ".joined.mp4"
            subprocess.run([_ffmpeg(), "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy",
                            joined], check=True, **_no_window())
            for p_ in (head_video, lst, tmp_video):
                os.remove(p_)
            os.replace(joined, tmp_video)
        # Take the audio from the source (if present), faststart.
        subprocess.run([_ffmpeg(), "-y", "-v", "error", "-i", tmp_video, "-i", src, "-map", "0:v", "-map", "1:a?",
                        "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart", out_path],
                       check=True, **_no_window())
        os.remove(tmp_video)
        if not os.environ.get("IM_CHUNK_KEEP"):   # measurement: keep the chunks (overlap comparison)
            shutil.rmtree(cache, ignore_errors=True)
        _send_progress(f"done {tw}x{th}, {len(starts)} chunks", uid)
        # Preview only when the file is in the ComfyUI output (otherwise the film node behind shows it).
        outd = os.path.abspath(folder_paths.get_output_directory())
        if os.path.abspath(out_path).lower().startswith(outd.lower() + os.sep):
            sub_ = os.path.relpath(os.path.dirname(os.path.abspath(out_path)), outd)
            return io.NodeOutput(InputImpl.VideoFromFile(out_path), out_path,
                                 ui=ui.PreviewVideo([ui.SavedResult(os.path.basename(out_path),
                                                                    "" if sub_ == "." else sub_,
                                                                    io.FolderType.output)]))
        return io.NodeOutput(InputImpl.VideoFromFile(out_path), out_path)


CHUNK_UPSCALE_NODE_LIST = [InfiniteMovieLTXRefine]
