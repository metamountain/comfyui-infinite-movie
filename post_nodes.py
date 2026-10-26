"""FilmChain building blocks around the render (Nutzer 2026-10-26):

  FilmAutoPrompt  - a small vision LLM looks at one image pair and writes the
                    transition prompt (one node per transition, wired into the
                    FilmChain prompt slot between the two images).
  FilmFinish      - quality/length on the finished film: scale to the target
                    size (Lanczos + light sharpen, bt709), optional RIFE x2.

Rendering stays in FilmChain, stitching in FilmConcat; both of these run
cheaply on their inputs and can be repeated without re-rendering.
"""

from __future__ import annotations

import base64
import io as _bio
import json
import os
import re
import subprocess
import tempfile
import urllib.request

import numpy as np
import torch
from PIL import Image

from comfy_api.latest import io, ui

from .nodes import _count_frames, _ffmpeg, _send_progress, _unique_output_path

VISION_MODEL = "Qwen3.5-4B-UD-Q4_K_XL-vision"
STATIC_TAIL = "Static camera, the house does not move."

AUTOPROMPT_SYSTEM = (
    "You write prompts for an image-to-video model that morphs from a START image to an END "
    "image of the same scene (first/last frame). Describe in one or two sentences (max 50 words) "
    "how the scene changes from START to END: season, vegetation, weather, sky and light, and "
    "the motion that carries the change (e.g. snow begins to fall, leaves turn, clouds drift). "
    "Never describe the camera moving. Never add people, animals or text. Answer with the prompt "
    "only, in English, no quotes, no preamble."
)


def _image_b64(t: torch.Tensor, max_side: int = 640) -> str:
    """IMAGE [B,H,W,C] float 0..1 -> base64 JPEG of the first frame."""
    arr = (t[0].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
    im = Image.fromarray(arr)
    im.thumbnail((max_side, max_side))
    buf = _bio.BytesIO()
    im.save(buf, format="JPEG", quality=88)
    return base64.b64encode(buf.getvalue()).decode()


def _post_json(url: str, payload: dict, timeout: int) -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
    return json.loads(body) if body else {}


def _clean_prompt(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    text = " ".join(text.replace('"', "").split())
    return text


class FilmAutoPrompt(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="FilmAutoPrompt",
            display_name="Film Auto Prompt",
            category="FilmChain",
            description="A small local vision LLM (BeeLlama router) looks at the START and END image of one transition and writes the video prompt. Wire the output into the FilmChain prompt slot between the two images. A filled 'override' is used as-is (to correct a prompt without calling the LLM).",
            inputs=[
                io.Image.Input("image_from", tooltip="Start image of the transition."),
                io.Image.Input("image_to", tooltip="End image of the transition."),
                io.String.Input("hint", default="", optional=True,
                                tooltip="Optional hint for the LLM, e.g. 'spring to summer, snow should fall'."),
                io.String.Input("override", multiline=True, default="", optional=True,
                                tooltip="If not empty: used as the prompt, the LLM is not called."),
                io.Boolean.Input("static_camera", default=True,
                                 tooltip=f"Append '{STATIC_TAIL}'."),
                io.String.Input("llm_url", default="http://127.0.0.1:8080", advanced=True,
                                tooltip="BeeLlama router base URL."),
                io.String.Input("model", default=VISION_MODEL, advanced=True,
                                tooltip="Vision model id in the router."),
                io.Boolean.Input("unload_after", default=True, advanced=True,
                                 tooltip="Unload the vision model afterwards (frees VRAM for the render)."),
            ],
            outputs=[io.String.Output("prompt", tooltip="Transition prompt.")],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, image_from, image_to, hint="", override="", static_camera=True,
                llm_url="http://127.0.0.1:8080", model=VISION_MODEL, unload_after=True):
        uid = getattr(getattr(cls, "hidden", None), "unique_id", None)
        if override and override.strip():
            text = _clean_prompt(override)
        else:
            _send_progress("asking vision LLM ...", uid)
            user = [
                {"type": "text", "text": "START image:"},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + _image_b64(image_from)}},
                {"type": "text", "text": "END image:"},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + _image_b64(image_to)}},
                {"type": "text", "text": "Write the transition prompt." + (f" Hint: {hint.strip()}" if hint and hint.strip() else "")},
            ]
            base = llm_url.rstrip("/")
            try:
                res = _post_json(f"{base}/v1/chat/completions", {
                    "model": model,
                    "messages": [{"role": "system", "content": AUTOPROMPT_SYSTEM},
                                 {"role": "user", "content": user}],
                    "max_tokens": 160, "temperature": 0.4,
                    "chat_template_kwargs": {"enable_thinking": False},
                }, timeout=600)
                text = _clean_prompt(res["choices"][0]["message"]["content"])
            finally:
                if unload_after:
                    try:
                        _post_json(f"{base}/models/unload", {"model": model}, timeout=60)
                    except Exception as e:  # noqa: BLE001
                        print(f"[FilmAutoPrompt] unload {model}: {e}")
            if not text:
                raise ValueError("FilmAutoPrompt: LLM returned an empty prompt")
        if static_camera and STATIC_TAIL.lower() not in text.lower():
            text = f"{text.rstrip('.')}. {STATIC_TAIL}"
        print(f"[FilmAutoPrompt] {text}")
        return io.NodeOutput(text, ui=ui.PreviewText(text))


# ---------------------------------------------------------------------------
# FilmFinish: quality / length
# ---------------------------------------------------------------------------

def _probe_fps(path: str) -> float:
    out = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path], capture_output=True, text=True).stderr
    m = re.search(r"(\d+(?:\.\d+)?) fps", out)
    return float(m.group(1)) if m else 24.0


def _probe_size(path: str) -> tuple[int, int]:
    out = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path], capture_output=True, text=True).stderr
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", out)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def _rife_x2(src: str, dst: str, fps: float, chunk: int = 96) -> None:
    """RIFE x2 via the installed 'RIFE VFI' node (comfyui-frame-interpolation),
    in chunks (RAM), chunks overlap by one frame so no transition is lost."""
    import nodes as comfy_nodes
    rife_cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("RIFE VFI")
    if rife_cls is None:
        raise ValueError("FilmFinish: 'RIFE VFI' node not installed (comfyui-frame-interpolation)")
    w, h = _probe_size(src)
    n = _count_frames(src)
    with tempfile.TemporaryDirectory(prefix="filmfinish_") as tmp:
        raw = subprocess.Popen([_ffmpeg(), "-v", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                               stdout=subprocess.PIPE)
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
                        "-pix_fmt", "yuv420p", dst], check=True)


class FilmFinish(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="FilmFinish",
            display_name="Film Finish (Quality / Length)",
            category="FilmChain",
            description="Post-processing of the finished film, no re-render: optional RIFE x2 (double length at the same fps, or smoother at double fps), then scale to the target size (Lanczos + light sharpen, bt709 tags) as H.264. Never overwrites.",
            is_output_node=True,
            inputs=[
                io.String.Input("film_path", tooltip="Finished film (e.g. FilmConcat film_path)."),
                io.Int.Input("width", default=1080, min=16, max=4096, step=2, tooltip="Target width (Instagram 4:5: 1080)."),
                io.Int.Input("height", default=1350, min=16, max=4096, step=2, tooltip="Target height (Instagram 4:5: 1350)."),
                io.Float.Input("sharpen", default=0.4, min=0.0, max=1.5, step=0.05, tooltip="unsharp amount after scaling (0 = off)."),
                io.Combo.Input("rife", options=["off", "x2 longer", "x2 smoother"], default="off",
                               tooltip="RIFE x2: 'longer' keeps the fps (film twice as long, slow motion); 'smoother' doubles the fps (same length)."),
                io.Int.Input("crf", default=16, min=0, max=40, tooltip="H.264 quality (lower = better)."),
                io.String.Input("suffix", default="_insta", tooltip="Appended to the file name."),
                io.String.Input("copy_to", optional=True, tooltip="Optional directory to copy the result to (e.g. the Desktop)."),
            ],
            outputs=[io.String.Output("film_path", tooltip="Path to the finished file.")],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, film_path, width=1080, height=1350, sharpen=0.4, rife="off", crf=16,
                suffix="_insta", copy_to=None):
        uid = getattr(getattr(cls, "hidden", None), "unique_id", None)
        src = (film_path or "").strip()
        if not src or not os.path.exists(src):
            raise ValueError(f"FilmFinish: film not found: {src!r}")
        fps = _probe_fps(src)
        folder, base = os.path.split(src)
        stem = os.path.splitext(base)[0]
        out = _unique_output_path(folder, f"{stem}{suffix}", ".mp4")
        work = src
        out_fps = fps
        with tempfile.TemporaryDirectory(prefix="filmfinish_rife_") as tmp:
            if rife != "off":
                _send_progress("RIFE x2 ...", uid)
                work = os.path.join(tmp, "rife.mp4")
                _rife_x2(src, work, fps)
                out_fps = fps * 2 if rife == "x2 smoother" else fps
            _send_progress(f"scaling to {width}x{height} ...", uid)
            vf = f"scale={width}:{height}:flags=lanczos"
            if sharpen > 0:
                vf += f",unsharp=5:5:{sharpen:g}"
            # Integer-Enums (bt709=1): die String-Form "bt709" schreibt nur
            # color_space, wenn der Input keine Farb-Metadaten hat (tmp/20-bericht.md Bug 3).
            vf += ",setparams=colorspace=1:color_primaries=1:color_trc=1"
            cmd = [_ffmpeg(), "-y", "-v", "error", "-r", f"{out_fps:g}", "-i", work, "-vf", vf,
                   "-c:v", "libx264", "-crf", str(crf), "-preset", "slow", "-pix_fmt", "yuv420p",
                   "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
                   "-movflags", "+faststart", "-an", out]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError(f"FilmFinish ffmpeg: {r.stderr[-800:]}")
        if copy_to and copy_to.strip():
            import shutil
            dst = _unique_output_path(copy_to.strip(), os.path.splitext(os.path.basename(out))[0], ".mp4")
            shutil.copy2(out, dst)
        n = _count_frames(out)
        msg = f"{os.path.basename(out)}: {width}x{height}, {n} frames @ {out_fps:g} fps = {n / out_fps:.1f} s"
        print(f"[FilmFinish] {msg}")
        return io.NodeOutput(out, ui=ui.PreviewText(msg))


POST_NODE_LIST = [FilmAutoPrompt, FilmFinish]
