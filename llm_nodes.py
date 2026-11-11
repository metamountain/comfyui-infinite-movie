"""Infinite Movie · Story Mode (LLM) (2026-11-11, user: "node for a local LLM, the small ones are no good for complex prompts;
plugs into settings, holds the LLM settings and the prompt prompt").

Plugs into Settings › `prompt model ◀ LLM` (user: "threading it into the chain is counterintuitive, let story mode
flow into prompt model"): connected, the Auto Prompts write their prompt (still per image pair: JSON description,
then the shot text) with a vision LLM on a server instead of the small model ComfyUI loads itself. `provider` fills
endpoint/model/key name with the usual defaults (local server, Ollama, LM Studio, OpenAI, Gemini, OpenRouter); all
of them speak the OpenAI chat API. The API key is never stored in the workflow: only the NAME of an environment
variable. Nothing here starts, stops or unloads another program.
"""

from __future__ import annotations

import base64
import io as _io
import json
import os
import re
import urllib.request

from comfy_api.latest import io

from .settings_nodes import STORY_MODE

THINKING = ["off", "low", "medium", "high"]

# provider -> endpoint, model, api_key_env, local (local = OpenAI-compatible server that takes chat_template_kwargs
# for thinking and a seed; cloud APIs reject unknown fields). Ports are the programs' documented defaults.
PROVIDERS = {
    "local server (llama.cpp, vLLM)": {"endpoint": "http://127.0.0.1:8080/v1", "model": "", "api_key_env": "", "local": True},
    "Ollama": {"endpoint": "http://127.0.0.1:11434/v1", "model": "", "api_key_env": "", "local": True},
    "LM Studio": {"endpoint": "http://127.0.0.1:1234/v1", "model": "", "api_key_env": "", "local": True},
    "OpenAI": {"endpoint": "https://api.openai.com/v1", "model": "gpt-4o", "api_key_env": "OPENAI_API_KEY", "local": False},
    "Gemini": {"endpoint": "https://generativelanguage.googleapis.com/v1beta/openai", "model": "gemini-2.5-flash",
               "api_key_env": "GEMINI_API_KEY", "local": False},
    "OpenRouter": {"endpoint": "https://openrouter.ai/api/v1", "model": "", "api_key_env": "OPENROUTER_API_KEY",
                   "local": False},
    "custom": {"endpoint": "", "model": "", "api_key_env": "", "local": True},
}

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
    env = str(cfg.get("api_key_env") or "").strip()
    key = os.environ.get(env, "").strip() if env else ""
    if env and not key:
        raise RuntimeError(f"LLM: environment variable {env} is not set - set it to your API key and restart "
                           f"ComfyUI (the key itself is never stored in the workflow).")
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
    if not m and not cfg.get("local", True):
        raise RuntimeError("LLM: enter a vision model id in Story Mode › model (cloud APIs list many models).")
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
        "stream": False,
    }
    if cfg.get("local", True):   # cloud APIs reject unknown fields; thinking there is the model's own business
        payload["seed"] = int(seed)
        payload["chat_template_kwargs"] = ({"enable_thinking": False} if think == "off" else {"reasoning_effort": think})
    else:
        payload["max_tokens"] = int(max_tokens)
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
            search_aliases=["infinite movie", "story", "story mode", "llm", "openai", "ollama", "lm studio", "gemini",
                            "openrouter", "local llm", "vision", "prompt model", "server"],
            description="Story mode: a bigger vision LLM (local server, Ollama, LM Studio or a cloud API) first reads "
                        "ALL images and plans the film (arc + one beat per shot), then every Auto Prompt writes its "
                        "shot from its two images and its beat. The red thread (`story`) goes into every system "
                        "prompt. Plug `LLM ▶ prompt model` into Settings › `prompt model ◀ LLM`: it replaces the "
                        "small prompt model. Unplugged or bypassed = off.",
            inputs=[
                io.Combo.Input("provider", options=list(PROVIDERS), default=next(iter(PROVIDERS)),
                               tooltip="Fills endpoint, model and api_key_env with the usual values; change them "
                                       "freely afterwards. All providers speak the OpenAI chat API."),
                io.String.Input("endpoint", default=PROVIDERS[next(iter(PROVIDERS))]["endpoint"],
                                tooltip="Base URL of the OpenAI-compatible API, ending in /v1 (Ollama: "
                                        "http://127.0.0.1:11434/v1). The model must read images (vision)."),
                io.String.Input("model", default="",
                                tooltip="Model id as the server lists it under /models. Empty (local servers only) = "
                                        "the loaded one, else the first listed."),
                io.String.Input("api_key_env", default="",
                                tooltip="NAME of the environment variable that holds your API key, e.g. "
                                        "OPENAI_API_KEY. The key itself is never stored in the workflow. Empty = no key "
                                        "(local servers)."),
                io.String.Input("story", multiline=True, default="",
                                tooltip="Red thread of the film, goes into every system prompt, e.g. 'one year at the "
                                        "rock house, calm, ends where it began'. Empty = the LLM finds it in the images."),
                io.String.Input("storyboard_instruction", multiline=True, default=STORYBOARD_SYSTEM,
                                tooltip="Pass 1 - what the LLM is told when it reads all images and plans the film. "
                                        "{loop} = loop note, {schema} = the JSON answer template (appended if missing). "
                                        "Restore default prompts brings the original back."),
                io.String.Input("instruction", multiline=True, default=LLM_SYSTEM,
                                tooltip="Pass 2 - what the LLM is told for each shot (system prompt). {words} = "
                                        "max_words from Prompt Style. Replaces the Prompt Style text while Story Mode "
                                        "is plugged in. Restore default prompts brings the original back."),
                io.Combo.Input("thinking", options=THINKING, default="off",
                               tooltip="Reasoning before answering (local servers with chat_template_kwargs, e.g. "
                                       "llama.cpp, vLLM). off = fastest; low/medium for tricky image pairs."),
                io.Float.Input("temperature", default=0.7, min=0.0, max=2.0, step=0.05,
                               tooltip="Creativity of the shot text (the image description pass always runs at 0.2)."),
                io.Int.Input("timeout", advanced=True, default=180, min=10, max=1800,
                             tooltip="Seconds to wait for one answer (a sleeping server may need to load first)."),
                io.Boolean.Input("free_vram", advanced=True, default=True,
                                 tooltip="Unload ComfyUI's own models before asking, so a local LLM has room on the GPU."),
            ],
            outputs=[
                STORY_MODE.Output("llm", display_name="LLM ▶ prompt model",
                                  tooltip="Plug into Infinite Movie · Settings › prompt model ◀ LLM."),
            ],
        )

    @classmethod
    def execute(cls, provider="custom", endpoint="", model="", api_key_env="", story="", storyboard_instruction="",
                instruction="", thinking="off", temperature=0.7, timeout=180, free_vram=True) -> io.NodeOutput:
        return io.NodeOutput(story_mode(provider, endpoint, model, api_key_env, story, storyboard_instruction,
                                        instruction, thinking, temperature, timeout, free_vram))


def story_mode(provider="custom", endpoint="", model="", api_key_env="", story="", storyboard_instruction="",
               instruction="", thinking="off", temperature=0.7, timeout=180, free_vram=True) -> dict:
    """Pure function: what Story Mode hands to Settings. Empty endpoint -> llm None (off)."""
    ep = str(endpoint or "").strip()
    llm = None
    if ep:
        llm = {"provider": provider, "endpoint": ep, "model": str(model or "").strip(),
               "api_key_env": str(api_key_env or "").strip(),
               "local": PROVIDERS.get(provider, PROVIDERS["custom"])["local"],
               "thinking": thinking, "temperature": float(temperature), "timeout": int(timeout),
               "free_vram": bool(free_vram), "story_mode": True, "story": str(story or "").strip(),
               "storyboard_instruction": str(storyboard_instruction or "").strip()}
    return {"llm": llm, "llm_instruction": str(instruction or "").strip() if ep else ""}


LLM_NODE_LIST = [InfiniteMovieStoryMode]


def _register_routes():
    """GET /infinite_movie/llm_providers -> the PROVIDERS table, so the provider combo fills the fields in the browser
    (one table, not duplicated in JS)."""
    try:
        from aiohttp import web
        from server import PromptServer

        @PromptServer.instance.routes.get("/infinite_movie/llm_providers")
        async def _providers(request):
            return web.json_response(PROVIDERS)
    except Exception as e:  # noqa: BLE001
        print(f"[InfiniteMovieStoryMode] provider route not registered: {e}")


_register_routes()
