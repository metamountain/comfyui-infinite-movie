"""Infinite Movie · Story Mode (LLM) (2026-11-11, user: "node for a local LLM, the small ones are no good for complex prompts;
plugs into settings, holds the LLM settings and the prompt prompt").

Sits in the settings chain (Settings → LLM → Prompt Style → Auto Prompts). With an endpoint set, the Auto Prompts
write their prompt (still per image pair, same two passes as before: JSON description, then the shot text) with any
OpenAI-compatible chat server that can read images instead of the small model ComfyUI loads itself. Empty endpoint
= the node changes nothing. Generic on purpose: no server program, port or path in here - the user enters the URL.
"""

from __future__ import annotations

import base64
import io as _io
import json
import re
import urllib.request

from comfy_api.latest import io

from .settings_nodes import SETTINGS, chain_settings

THINKING = ["off", "low", "medium", "high"]

LLM_SYSTEM = (
    "You write the prompt for one short video shot: image 1 is its first frame, image 2 its last frame. Describe in "
    "present tense what visibly happens and changes from the first to the last frame - motion, light, weather, "
    "materials, atmosphere - so a video model can animate it smoothly. Exactly ONE sentence, max {words} words, "
    "that starts with the first frame and arrives at the last frame. "
    "Describe only what is there and what happens, in positive words (never 'no', 'not', 'none', 'without'). "
    "Never mention images, frames or the camera.")


def _endpoint(cfg: dict) -> str:
    return str(cfg.get("endpoint") or "").strip().rstrip("/")


def _request(cfg: dict, path: str, payload: dict | None = None, timeout: float = 30.0) -> dict:
    url = _endpoint(cfg) + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET",
                                 headers={"Content-Type": "application/json"})
    key = str(cfg.get("api_key") or "").strip()
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"LLM: {url} answered {e.code}: {body}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise RuntimeError(f"LLM: {url} not reachable ({e}). Is the server running?") from None


def pick_model(listing: dict) -> str:
    """Model id from GET /models: the one with status 'loaded' if the server reports a status, else the first."""
    data = listing.get("data") or listing.get("models") or []
    ids = [(m.get("id") or m.get("model") or m.get("name"), str((m.get("status") or {}).get("value", "")).lower()
            if isinstance(m.get("status"), dict) else str(m.get("status") or "").lower()) for m in data]
    ids = [(i, st) for i, st in ids if i]
    for i, st in ids:
        if st == "loaded":
            return i
    return ids[0][0] if ids else ""


def resolve_model(cfg: dict) -> str:
    m = str(cfg.get("model") or "").strip()
    return m or pick_model(_request(cfg, "/models", timeout=15))


def image_urls(images, long_side: int = 1024) -> list[str]:
    """IMAGE batch [B,H,W,3] or a list of file paths -> data URLs (JPEG, long side <= long_side)."""
    if images is None:
        return []
    import numpy as np
    from PIL import Image
    out = []
    for frame in images:
        if isinstance(frame, str):
            im = Image.open(frame).convert("RGB")
        else:
            im = Image.fromarray((frame.clamp(0, 1).cpu().numpy() * 255 + 0.5).astype(np.uint8))
        k = long_side / max(im.size)
        if k < 1:
            im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
        buf = _io.BytesIO()
        im.save(buf, "JPEG", quality=90)
        out.append("data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii"))
    return out


def build_payload(cfg: dict, model: str, system: str, text: str, urls: list[str], max_tokens: int,
                  temperature: float, seed: int) -> dict:
    """Chat-completions request (pure, testable). Thinking via chat_template_kwargs (llama.cpp / vLLM chat templates);
    servers without it ignore the field. Thinking gets extra token budget on top of the answer."""
    content = [{"type": "text", "text": text}] + [{"type": "image_url", "image_url": {"url": u}} for u in urls]
    think = str(cfg.get("thinking") or "off")
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}],
        "max_tokens": int(max_tokens) + (0 if think == "off" else 4096),
        "temperature": float(cfg.get("temperature", temperature) if temperature >= 0.5 else temperature),
        "seed": int(seed),
        "stream": False,
        "chat_template_kwargs": ({"enable_thinking": False} if think == "off" else {"reasoning_effort": think}),
    }
    return payload


def answer_text(resp: dict) -> str:
    try:
        msg = resp["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        raise RuntimeError(f"LLM: unexpected answer {str(resp)[:300]}") from None
    text = msg.get("content") or ""
    if isinstance(text, list):   # some servers return content parts
        text = " ".join(p.get("text", "") for p in text if isinstance(p, dict))
    _, sep, rest = text.partition("</think>")
    text = re.sub(r"<think>.*", "", rest if sep else text, flags=re.S).strip()
    if not text and msg.get("reasoning_content"):
        raise RuntimeError("LLM: the model only thought and gave no answer - raise max tokens or set thinking off.")
    return text


def llm_gen(cfg: dict, text: str, images, system: str, max_length: int, temperature: float, seed: int) -> str:
    """Same signature as autoprompt._gen (clip -> cfg). The describe pass (temperature 0.2) keeps its low temperature,
    the story pass uses the node's temperature."""
    if cfg.get("free_vram", True):
        try:   # ComfyUI's own models off the GPU, so the LLM server has room (own process only)
            import comfy.model_management as mm
            mm.unload_all_models()
            mm.soft_empty_cache()
        except Exception:  # noqa: BLE001
            pass
    model = cfg.get("_model") or resolve_model(cfg)
    cfg["_model"] = model
    payload = build_payload(cfg, model, system, text, image_urls(images), max_length, temperature, seed)
    return answer_text(_request(cfg, "/chat/completions", payload, timeout=float(cfg.get("timeout", 180))))


llm_gen.needs_images = True


# ---------------------------------------------------------------------------
# Story mode (user 2026-11-11: "story mode as a switch, the red thread also as system prompt"):
# pass 1 = storyboard: the LLM sees ALL images of the film in order and writes the arc + one beat per shot (cached per
# film), pass 2 = per shot as before (image pair), with the arc and its beat as context. The red thread (`story`)
# goes into the system prompt of every call.
STORYBOARD_SYSTEM = (
    "You plan a short film made of video shots. You get all key images in film order; shot k runs from image k to "
    "image k+1{loop}. Write a coherent story arc across all shots: a clear progression, variety, and a meaningful "
    "build-up, matching what the images show. Each shot field is ONE sentence saying what HAPPENS during that shot - "
    "the change from its start image to its end image - not what one image shows. Answer ONLY with this JSON:\n"
    "{schema}\nPositive words only, never mention images or frames.")


def storyboard_schema(n: int, total: int | None = None) -> str:
    """Fixed JSON template with one named field per shot (a list made the 27B model put all beats into one string)."""
    # Each placeholder names its transition: with plain "<one sentence>" the 27B model described image k instead of
    # image k -> k+1 (beats shifted by one, test 2026-11-11).
    total = total or n
    fields = ", ".join(f'"shot_{k + 1}": "<what happens from image {k + 1} to image {(k + 1) % total + 1}>"'
                       for k in range(n))
    return '{"arc": "<2-3 sentences>", ' + fields + "}"


def storyboard_system(text, n: int, total: int, loop: bool) -> str:
    """Storyboard system prompt from the (editable) text: {loop} and {schema} are filled in; without {schema} the
    JSON template is appended, so an edited text can never break the parsing."""
    text = str(text or "").strip() or STORYBOARD_SYSTEM
    schema = storyboard_schema(n, total)
    text = text.replace("{loop}", ", the last shot returns to image 1" if loop else "")
    if "{schema}" in text:
        return text.replace("{schema}", schema)
    return f"{text}\nAnswer ONLY with this JSON:\n{schema}"


def red_thread(system: str, story: str) -> str:
    story = str(story or "").strip()
    return f"{system}\n\nThe whole film follows this red thread: {story}" if story else system


def shot_of(prompt: dict, uid) -> tuple:
    """(Director id, shot index k) of the Auto Prompt uid in the API prompt (Director > shot_prompts.prompt<k>)."""
    for nid, node in (prompt or {}).items():
        if node.get("class_type") != "InfiniteMovieRender":
            continue
        for key, val in (node.get("inputs") or {}).items():
            m = re.fullmatch(r"shot_prompts\.prompt(\d+)", key)
            if m and isinstance(val, list) and str(val[0]) == str(uid):
                return nid, int(m.group(1))
    return None, -1


def _image_file(prompt: dict, nid, depth: int = 0):
    """Walk upstream from a node to the image file it loads (Load Image style: a string `image` input)."""
    import os
    node = (prompt or {}).get(str(nid))
    if not node or depth > 12:
        return None
    inputs = node.get("inputs") or {}
    img = inputs.get("image")
    if isinstance(img, str) and img.strip():
        try:
            import folder_paths
            path = folder_paths.get_annotated_filepath(img)
        except Exception:  # noqa: BLE001 - without ComfyUI (tests): plain path
            path = img
        return path if path and os.path.isfile(path) else None
    for key in ("image", "images", "pixels", "image_from", "input"):
        val = inputs.get(key)
        if isinstance(val, list) and len(val) == 2:
            return _image_file(prompt, val[0], depth + 1)
    for val in inputs.values():
        if isinstance(val, list) and len(val) == 2 and isinstance(val[1], int):
            return _image_file(prompt, val[0], depth + 1)
    return None


def film_images(prompt: dict, director_id) -> tuple:
    """Image files of the film in order (Director > images.image<i>) + loop flag. Unresolvable image -> []."""
    node = (prompt or {}).get(str(director_id)) or {}
    inputs = node.get("inputs") or {}
    keyed = []
    for k, v in inputs.items():
        m = re.fullmatch(r"images\.image(\d+)", k)
        if m and isinstance(v, list):
            keyed.append((int(m.group(1)), v))
    keyed.sort(key=lambda t: t[0])
    files = [_image_file(prompt, v[0]) for _, v in keyed]
    return ([] if any(f is None for f in files) else files), bool(inputs.get("loop", True))


def parse_storyboard(text: str, n: int):
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    m = re.search(r"\{.*\}", text, flags=re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    shots = [str(d.get(f"shot_{k + 1}") or "").strip() for k in range(n)]
    if not all(shots):   # also accept the list form
        shots = [str(x).strip() for x in (d.get("shots") or []) if str(x).strip()]
    if len(shots) < n:
        return None
    return {"arc": str(d.get("arc") or "").strip(), "shots": shots[:n]}


def storyboard(cfg: dict, files: list, loop: bool, story: str, seed: int = 0, cache_dir=None, ask=None):
    """Arc + one beat per shot for the whole film, cached by images (path, size, mtime) + red thread + model.
    ask(cfg, text, files, system, max_tokens) is swappable for tests."""
    import hashlib
    import os
    n = len(files) if loop else len(files) - 1
    if n < 1:
        return None
    stat = [(f, os.path.getsize(f), int(os.path.getmtime(f))) for f in files]
    key = hashlib.sha1(json.dumps([stat, loop, str(story or ""), cfg.get("model"), _endpoint(cfg),
                                   str(cfg.get("storyboard_instruction") or "")]).encode()).hexdigest()[:16]
    if cache_dir is None:
        try:
            import folder_paths
            cache_dir = folder_paths.get_temp_directory()
        except Exception:  # noqa: BLE001
            import tempfile
            cache_dir = tempfile.gettempdir()
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, f"im_storyboard_{key}.json")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    system = red_thread(storyboard_system(cfg.get("storyboard_instruction"), n, len(files), loop), story)
    lines = "\n".join(f"Shot {k + 1}: image {k + 1} -> image {(k + 1) % len(files) + 1}" for k in range(n))
    ask = ask or (lambda c, t, fs, sy, mt: llm_gen(c, t, fs, sy, mt, 0.7, seed))
    raw = ask(cfg, f"{len(files)} key images in film order.\n{lines}\nJSON:", files, system, 250 * n + 300)
    sb = parse_storyboard(raw, n)
    if not sb:
        print(f"[InfiniteMovieStoryMode] storyboard unusable (need {n} beats), shots are written from their pairs only:\n"
              f"{str(raw)[:600]}")
    if sb:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(sb, f, ensure_ascii=False, indent=1)
        print(f"[InfiniteMovieStoryMode] storyboard: {sb['arc']}\n" + "\n".join(f"  {k + 1}. {b}" for k, b in enumerate(sb["shots"])))
    return sb


def shot_context(sb, k: int) -> str:
    if not sb or not (0 <= k < len(sb.get("shots", []))):
        return ""
    return (f"\nStory of the whole film: {sb['arc']}\nThis shot ({k + 1} of {len(sb['shots'])}) must show this "
            f"change: {sb['shots'][k]}")


def llm_label(cfg: dict) -> str:
    return f"LLM {str(cfg.get('model') or '').strip() or '(server default)'}"


class InfiniteMovieStoryMode(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieStoryMode",
            display_name="Infinite Movie · Story Mode (LLM)",
            category="Infinite Movie/0 Setup",
            search_aliases=["infinite movie", "story", "story mode", "llm", "openai", "local llm", "vision", "prompt model", "server"],
            description="Story mode: a bigger vision LLM on any OpenAI-compatible server first reads ALL images and "
                        "plans the film (arc + one beat per shot), then every Auto Prompt writes its shot from its two "
                        "images and its beat. The red thread (`story`) goes into every system prompt. Sits in the "
                        "settings chain: Settings → Story Mode → Prompt Style → Auto Prompts (AUTO LAYOUT wires it). "
                        "Empty endpoint = off.",
            inputs=[
                SETTINGS.Input("settings", optional=True, display_name="settings",
                               tooltip="Settings from Infinite Movie · Settings."),
                io.String.Input("endpoint", default="",
                                tooltip="OpenAI-compatible base URL, e.g. http://127.0.0.1:<port>/v1. The model must "
                                        "read images (vision). Empty = off, the small model from Settings writes."),
                io.String.Input("model", default="",
                                tooltip="Model id as the server lists it under /models. Empty = the loaded one "
                                        "(or the first listed)."),
                io.String.Input("story", multiline=True, default="",
                                tooltip="Red thread of the film, goes into every system prompt, e.g. 'one year at the "
                                        "rock house, calm, ends where it began'. Empty = the LLM finds it in the images."),
                io.String.Input("storyboard_instruction", multiline=True, default=STORYBOARD_SYSTEM,
                                tooltip="Pass 1 – what the LLM is told when it reads all images and plans the film. "
                                        "{loop} = loop note, {schema} = the JSON answer template (appended if missing). "
                                        "↺ Restore default prompts brings the original back."),
                io.String.Input("instruction", multiline=True, default=LLM_SYSTEM,
                                tooltip="Pass 2 – what the LLM is told for each shot (system prompt). {words} = "
                                        "max_words from Prompt Style. Overrides the Prompt Style text while this node "
                                        "is active. ↺ Restore default prompts brings the original back."),
                io.Combo.Input("thinking", options=THINKING, default="off",
                               tooltip="Reasoning before answering (servers with chat_template_kwargs, e.g. llama.cpp, "
                                       "vLLM). off = fastest; low/medium for tricky image pairs."),
                io.Float.Input("temperature", default=0.7, min=0.0, max=2.0, step=0.05,
                               tooltip="Creativity of the shot text (the image description pass always runs at 0.2)."),
                io.Int.Input("timeout", advanced=True, default=180, min=10, max=1800,
                             tooltip="Seconds to wait for one answer (a sleeping server may need to load first)."),
                io.String.Input("api_key", advanced=True, default="",
                                tooltip="Only if the server wants one (Bearer token). Saved in the workflow!"),
                io.Boolean.Input("free_vram", advanced=True, default=True,
                                 tooltip="Unload ComfyUI's own models before asking, so the LLM has room on the GPU."),
            ],
            outputs=[
                SETTINGS.Output("settings", display_name="settings ▶ chain",
                                tooltip="Settings with this LLM. Connect to Prompt Style or the first Auto Prompt."),
            ],
        )

    @classmethod
    def execute(cls, settings=None, endpoint="", model="", story="", storyboard_instruction="", instruction="",
                thinking="off", temperature=0.7, timeout=180, api_key="", free_vram=True) -> io.NodeOutput:
        return io.NodeOutput(apply_llm(settings, endpoint, model, instruction, thinking, temperature, timeout,
                                       api_key, free_vram, True, story, storyboard_instruction))


def apply_llm(settings, endpoint, model, instruction, thinking="off", temperature=0.7, timeout=180, api_key="",
              free_vram=True, story_mode=True, story="", storyboard_instruction="") -> dict:
    """Pure function: settings dict (or defaults) with the LLM. Empty endpoint -> llm None (off)."""
    out = dict(chain_settings(settings))
    ep = str(endpoint or "").strip()
    out["llm"] = ({"endpoint": ep, "model": str(model or "").strip(), "thinking": thinking,
                   "temperature": float(temperature), "timeout": int(timeout), "api_key": str(api_key or ""),
                   "free_vram": bool(free_vram), "story_mode": bool(story_mode),
                   "story": str(story or "").strip(),
                   "storyboard_instruction": str(storyboard_instruction or "").strip()} if ep else None)
    out["llm_instruction"] = str(instruction or "").strip() if ep else ""
    return out


LLM_NODE_LIST = [InfiniteMovieStoryMode]
