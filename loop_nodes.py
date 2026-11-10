"""Infinite Movie · H3 Loop – seamless loops with MiniMax H3 (circular padding).

Technique (re-implemented here, idea after pxl-pshr/ComfyUI-MiniMaxH3-Loop): the sampler works on a loop of
k 17-frame clips. On every model call the latent is extended with `pad` clips of its own END before the start and
`pad` clips of its own START after the end, the model denoises that longer sequence, and only the middle (the loop)
is kept. The end->start join therefore gets denoised with real context on both sides, like any other clip border,
and the sequence edges fall into padding that is thrown away.

- Padding copies carry the loop's starting noise; distilled models (4/8-step LoRAs) draw specks where they see the
  same noise twice, so the padding gets fresh noise (sampler wrapper stores fresh - noise, scaled by sigma).
- First/last-frame anchors (MiniMax H3 Image To Video) are moved to their loop position inside the padded
  sequence; a last-frame anchor wraps onto the start and is dropped when the start is already anchored.
- Decode: the loop is decoded with wrapped context on both sides and cut to exactly one loop (17k frames).

H3 latent layout: 17k+5 pixel frames = 5k+2 latent frames (clips of 5 latents = 17 frames, plus a 2-latent tail
shaped like the first two latents). Audio: 40 latents/s at 24 fps -> 17*40/24 per clip.
"""

from __future__ import annotations

import torch

from comfy_api.latest import io

CLIP_LAT = 5           # latent frames per 17-frame clip
TAIL_LAT = 2           # latent tail of a 17k+5 video
CLIP_FRAMES = 17
AUDIO_PER_CLIP = CLIP_FRAMES * 40 / 24
_KEY = "infinite_movie_h3_loop"


def audio_len(clips: int) -> int:
    return round(clips * AUDIO_PER_CLIP)


def wrap(x: torch.Tensor, before: int, after: int, dim: int) -> torch.Tensor:
    """x periodic along dim, extended by `before` entries of its end and `after` entries of its start
    (tiled when the padding is longer than x)."""
    n = x.shape[dim]
    if n == 0:
        raise ValueError("H3 Loop: the video needs at least one full 17-frame clip (length >= 22)")
    idx = torch.arange(-before, n + after, device=x.device) % n
    return x.index_select(dim, idx)


def loop_keyframes(keyframes, loop_frames: int, pad_frames: int):
    """Anchors -> positions inside the padded sequence; duplicates (last frame wrapping onto the start) dropped."""
    out, seen = [], set()
    for kf in keyframes or ():
        pos = int(kf["resolved_frame_index"])
        if pos >= loop_frames:                         # the 5-frame tail repeats the start: anchors there wrap onto 0
            pos = 0
        if pos in seen:
            continue
        seen.add(pos)
        out.append(dict(kf, resolved_frame_index=pad_frames + pos))
    return out


def _model_wrapper(executor, x, timestep, context, transformer_options, **kwargs):
    video, audio = x[0], x[1]
    n = video.shape[2] - TAIL_LAT                      # loop latents (5k)
    clips = n // CLIP_LAT
    pad = int(transformer_options[_KEY + "_pad"])
    pv, pa = pad * CLIP_LAT, audio_len(pad)
    na = audio_len(clips)
    a_tail = audio.shape[-1] - na

    args = dict(kwargs)
    payload = kwargs.get("minimax_payload")
    if payload and payload.get("keyframes"):
        p = dict(payload, keyframes=loop_keyframes(payload["keyframes"], clips * CLIP_FRAMES, pad * CLIP_FRAMES))
        p.pop("layout", None)                          # rebuilt by the model for the padded shape
        args["minimax_payload"] = p
    if kwargs.get("denoise_mask") is not None:
        args["denoise_mask"] = wrap(kwargs["denoise_mask"][:, :, :n], pv, pv + TAIL_LAT, 2)
    if kwargs.get("audio_denoise_mask") is not None:
        args["audio_denoise_mask"] = wrap(kwargs["audio_denoise_mask"][..., :na], pa, pa + a_tail, -1)

    v = wrap(video[:, :, :n], pv, pv + TAIL_LAT, 2)
    fresh = transformer_options.get(_KEY + "_fresh")
    if fresh is not None:
        # x_t = sigma*noise + (1-sigma)*x0  ->  + sigma*(fresh - noise) swaps the padding's noise, keeps its content
        f = wrap(fresh[:, :, :n], pv, pv + TAIL_LAT, 2).to(v.dtype)
        f[:, :, pv:pv + n] = 0
        if args.get("denoise_mask") is not None:
            f = f * args["denoise_mask"]
        sigma = transformer_options["sigmas"].reshape(-1, 1, 1, 1, 1).to(v.dtype)
        v = v + sigma * f.repeat(v.shape[0] // f.shape[0], 1, 1, 1, 1)
    a = wrap(audio[..., :na], pa, pa + a_tail, -1)

    out = executor([v, a], timestep, context, transformer_options, **args)
    ov = out[0][:, :, pv:pv + n]
    oa = out[1][..., pa:pa + na]
    return [wrap(ov, 0, TAIL_LAT, 2), wrap(oa, 0, a_tail, -1)]


def _sampler_wrapper(executor, guider, sigmas, extra_args, callback, noise, *args, **kwargs):
    opts = extra_args["model_options"]["transformer_options"]
    shapes = getattr(guider.inner_model, "latent_shapes", None)
    if shapes and len(shapes) > 1:
        import comfy.utils
        vnoise = comfy.utils.unpack_latents(noise, shapes)[0]
    else:
        vnoise = noise
    if torch.count_nonzero(vnoise) == 0:                # no noise (staged sampling): keep the padding as is
        opts.pop(_KEY + "_fresh", None)
    else:
        gen = torch.Generator().manual_seed((int(extra_args.get("seed") or 0) + 7919) % 2 ** 63)
        opts[_KEY + "_fresh"] = (torch.randn(vnoise.shape, generator=gen, dtype=torch.float32)
                                 .to(vnoise.device, vnoise.dtype) - vnoise)
    return executor(guider, sigmas, extra_args, callback, noise, *args, **kwargs)


class InfiniteMovieH3Loop(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieH3Loop",
            display_name="Infinite Movie · H3 Loop",
            category="Infinite Movie/engine",
            description="Seamless loop for MiniMax H3: samples the video with its end wrapped around to its start "
                        "(circular padding), so the last frame flows into the first. Put it between the model "
                        "(after the LoRA) and BasicScheduler / BasicGuider; decode with Infinite Movie · H3 Loop "
                        "Decode. Length 17k+5 frames gives a loop of 17k frames.",
            inputs=[
                io.Model.Input("model"),
                io.Int.Input("pad_clips", default=1, min=1, max=4,
                             tooltip="17-frame clips of wrapped context on each side of the loop. More = smoother "
                                     "join, slower (1 clip ≈ +30 % at 107 frames)."),
            ],
            outputs=[io.Model.Output(display_name="model")],
        )

    @classmethod
    def execute(cls, model, pad_clips=1):
        import comfy.patcher_extension as pe
        m = model.clone()
        m.model_options.setdefault("transformer_options", {})[_KEY + "_pad"] = int(pad_clips)
        m.add_wrapper_with_key(pe.WrappersMP.DIFFUSION_MODEL, _KEY, _model_wrapper)
        m.add_wrapper_with_key(pe.WrappersMP.SAMPLER_SAMPLE, _KEY, _sampler_wrapper)
        return io.NodeOutput(m)


class InfiniteMovieH3LoopDecode(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieH3LoopDecode",
            display_name="Infinite Movie · H3 Loop Decode",
            category="Infinite Movie/engine",
            description="Decodes an H3 Loop latent with wrapped context on both sides and returns exactly one loop "
                        "(17k frames) – the last frame flows into the first without a jump.",
            inputs=[
                io.Latent.Input("samples"),
                io.Vae.Input("vae"),
                io.Vae.Input("audio_vae", optional=True, tooltip="Optional: also decode the loop's audio."),
                io.Int.Input("pad_clips", default=1, min=1, max=4,
                             tooltip="17-frame clips of wrapped latent decoded on each side."),
            ],
            outputs=[io.Image.Output(display_name="images"), io.Audio.Output(display_name="audio")],
        )

    @classmethod
    def execute(cls, samples, vae, audio_vae=None, pad_clips=1):
        lat = samples["samples"]
        if getattr(lat, "is_nested", False):
            video, audio = lat.unbind()
        else:
            video, audio = lat, None
        n = video.shape[2] - TAIL_LAT
        clips = n // CLIP_LAT
        pv = pad_clips * CLIP_LAT
        imgs = vae.decode(wrap(video[:, :, :n], pv, pv + TAIL_LAT, 2))
        imgs = imgs.reshape(-1, imgs.shape[-3], imgs.shape[-2], imgs.shape[-1])
        imgs = imgs[CLIP_FRAMES * pad_clips:CLIP_FRAMES * (pad_clips + clips)]
        out_audio = None
        if audio_vae is not None and audio is not None:
            from comfy_extras.nodes_audio import vae_decode_audio
            na, pa = audio_len(clips), audio_len(pad_clips)
            a = wrap(audio[..., :na], pa, pa, -1)
            out_audio = vae_decode_audio(audio_vae, {"samples": a})
            per = out_audio["waveform"].shape[-1] // a.shape[-1]
            out_audio["waveform"] = out_audio["waveform"][..., pa * per:(pa + na) * per]
        return io.NodeOutput(imgs, out_audio)


def last_frame_of(path: str) -> torch.Tensor:
    """Last frame of a video file, streamed frame by frame -> (1, H, W, 3) float 0..1."""
    import av
    import numpy as np
    last = None
    with av.open(path) as c:
        for frame in c.decode(video=0):
            last = frame
    if last is None:
        raise ValueError("Last Frame: the video has no frames")
    return torch.from_numpy(np.ascontiguousarray(last.to_ndarray(format="rgb24"))).unsqueeze(0).float() / 255.0


class InfiniteMovieLastFrame(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieLastFrame",
            display_name="Infinite Movie · Last Frame",
            category="Infinite Movie/tools",
            description="The last frame of a film – e.g. the start image for the next shot "
                        "(loop in two passes: shot 1 runs free, its last frame -> shot 2 back to the first image). "
                        "Videos are read frame by frame, never loaded whole.",
            inputs=[
                # 109: video/images inputs removed (not used in any workflow).
                io.String.Input("video_path", optional=True, default="",
                                tooltip="Path to a video file."),
            ],
            outputs=[io.Image.Output(display_name="last_frame")],
        )

    @classmethod
    def execute(cls, video_path="") -> io.NodeOutput:
        p = (video_path or "").strip().strip('"')
        if p:
            import os
            if not os.path.isfile(p):
                raise ValueError(f"Last Frame: file not found: {p}")
            return io.NodeOutput(last_frame_of(p))
        raise ValueError("Last Frame: connect video_path.")


LOOP_NODE_LIST = [InfiniteMovieH3Loop, InfiniteMovieH3LoopDecode, InfiniteMovieLastFrame]
