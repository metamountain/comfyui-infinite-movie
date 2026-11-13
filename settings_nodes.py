"""Infinite Movie · Settings – shared settings in ONE place (pipe SETTINGS).

Settings → Prompt Style → Auto Prompts → Director → Assemble. Every node passes the dict through
(chain_settings); without a Settings node, settings_defaults() apply.
  - prompt_model: local vision model from models/text_encoders that writes the shot prompts
    (autoprompt.py, runs INSIDE ComfyUI – no LLM server, no provider). 'off' = write the prompts by hand.
  - Format: aspect (classic ratios) + long_side; width/height derived from it, rounded to 32.  - Output: output_folder, film_name.
  - GPU check: fixed (no widget), generic (vram.py) – checks before the render whether enough VRAM is free,
    does not touch other programs. The numbers (MIN_FREE_MB, ACQUIRE_TIMEOUT_S) are constants;
    the derived values (free_vram, min_free_mb, …) stay in the settings dict so that
    Director/Assemble can use get_setting(...).
The prompt style (instruction, max_words, camera) belongs to the Prompt Style node.

Import rule (no cycle): settings_nodes imports only .vram (leaf); .autoprompt only LAZY.
"""

from __future__ import annotations

from comfy_api.latest import io

from . import vram

# Pipe type (model SYNC, nodes.py): a custom type that carries a plain dict.
SETTINGS = io.Custom("SETTINGS")
# 2026-11-11: Story Mode (LLM) -> Settings > prompt model < LLM (here: llm_nodes imports settings_nodes)
STORY_MODE = io.Custom("IM_STORY_MODE")

# Film size (user 2026-11-03): classic aspect ratio + longest side, both sides rounded to 32
# (LTX-2 Model Card: "Width & height settings must be divisible by 32"; Wan needs 16 – that fits too).
ASPECTS = {
    "4:5 · portrait (Instagram)": (4, 5),
    "9:16 · portrait (reel)": (9, 16),
    "2:3 · portrait": (2, 3),
    "3:4 · portrait": (3, 4),
    "1:1 · square": (1, 1),
    "4:3 · landscape": (4, 3),
    "3:2 · landscape": (3, 2),
    "16:9 · landscape": (16, 9),
    "21:9 · cinema": (21, 9),
}
ASPECT_DEFAULT = "4:5 · portrait (Instagram)"
LONG_SIDE_DEFAULT = 960   # 4:5 -> 768×960 = size of the LTX engine template
# 69 (2026-11-03): the aspect ratio comes from the Director's first input image (long_side stays
# the longest side, both sides rounded to 32). The Director computes width/height from image 1.
ASPECT_FROM_IMAGES = "from images"


def _r32(v) -> int:
    return max(32, int(round(float(v) / 32)) * 32)


def resolve_ratio(rw, rh, long_side) -> tuple:
    """(width, height) from ratio rw:rh: longest side = long_side, both rounded to 32.

    69: core of resolve_size – the Director calls it with the ratio of the first image."""
    long = _r32(long_side)
    if rw >= rh:
        return long, _r32(long * rh / rw)
    return _r32(long * rw / rh), long


def resolve_size(aspect, long_side) -> tuple:
    """(width, height): longest side = long_side, short side according to the ratio; both rounded to 32."""
    rw, rh = ASPECTS.get(aspect, ASPECTS[ASPECT_DEFAULT])
    return resolve_ratio(rw, rh, long_side)


# 74 (2026-11-04): GPU values fixed, no widget (user: "dont like after film"). 2026-11-08: no more LLM server code
# (the pack is public). The derived values (free_vram, min_free_mb, …) stay in the settings dict so that
# Director/Assemble can use get_setting(...) unchanged.
MIN_FREE_MB = 20000
ACQUIRE_TIMEOUT_S = 3600
# GPU values: in the settings dict, but NO widgets (fixed constants)
DERIVED_GPU_KEYS = ["min_free_mb", "acquire_timeout_s", "free_vram", "free_ram"]


# Widgets of the Settings node (order = schema).
SETTING_KEYS = [
    "prompt_model", "aspect", "long_side", "output_folder", "film_name", "audio",
]
# Prompt style: widgets of Prompt Style; always present in the dict (defaults).
STYLE_KEYS = ["instruction", "max_words", "camera"]  # no audio (user 2026-11-04: sound in the prompt = dead weight)


def settings_defaults() -> dict:
    """Defaults of all pipe fields (apply without a Settings/Prompt Style node)."""
    from .autoprompt import MAX_STORY_WORDS, STORY_SYSTEM, default_prompt_model
    return {
        "prompt_model": default_prompt_model(),
        "aspect": ASPECT_DEFAULT,
        "long_side": LONG_SIDE_DEFAULT,
        "width": 0,    # without a Settings node: size of the engine (0 = engine default)
        "height": 0,
        "output_folder": "",
        "film_name": "",
        # 2026-11-08 (user: "normally I don't need audio, please disable it! … setting"): sound off = the engine
        # does not decode audio (no audio VAE load), segments and film stay silent.
        "audio": False,
        # no widget (user 2026-11-03): both engines render with CFG 1 (LTX video/audio_cfg 1, Wan Lightning),
        # there the negative conditioning is not computed. The field stays empty in the dict, the Director reads it.
        # GPU fixed (user 2026-11-04: after_film widget gone): after the film, free ComfyUI VRAM.
        "min_free_mb": MIN_FREE_MB,
        "acquire_timeout_s": ACQUIRE_TIMEOUT_S,
        "free_vram": True,
        "free_ram": False,
        "instruction": STORY_SYSTEM,
        "max_words": MAX_STORY_WORDS,
        "camera": "none",
        # 2026-11-11: Infinite Movie · LLM (llm_nodes.py) – None = the Auto Prompts use prompt_model (local, in ComfyUI).
        "llm": None,
        "llm_instruction": "",
    }


def get_setting(settings, key):
    """Value of `key` from a SETTINGS dict; missing (or not a dict) -> default."""
    if isinstance(settings, dict) and key in settings:
        return settings[key]
    return settings_defaults()[key]


def chain_settings(settings) -> dict:
    """What a consumer passes to its settings output: the incoming dict, otherwise the defaults."""
    return settings if isinstance(settings, dict) and settings else settings_defaults()


class InfiniteMovieSettings(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        from .autoprompt import prompt_models, default_prompt_model
        return io.Schema(
            node_id="InfiniteMovieSettings",
            display_name="Settings · Infinite Movie",
            search_aliases=["infinite movie", "infinite_movie", "film", "movie", "video", "settings", "gpu"],
            category="Infinite Movie/0 Setup",
            description="Shared settings for the whole chain: the local prompt model, format and output. "
                        "Connect `settings ▶ chain` to Prompt Style (or the first Auto Prompt).",
            inputs=[
                STORY_MODE.Input("llm", optional=True, display_name="LLM",
                                 tooltip="Plug in Infinite Movie · Story Mode (LLM): a bigger vision LLM on a server "
                                         "writes the shot prompts instead of prompt_model."),
                io.Combo.Input("prompt_model", options=prompt_models(), default=default_prompt_model(),
                               tooltip="Local vision model (models/text_encoders) that writes the shot prompts inside "
                                       "ComfyUI, e.g. qwen3vl_4b_bf16.safetensors. 'off' = write the prompts yourself."),
                io.Combo.Input("aspect", options=[ASPECT_FROM_IMAGES] + list(ASPECTS), default=ASPECT_DEFAULT,
                               tooltip="Classic aspect ratio of the film. Width and height follow from long_side, "
                                       "both rounded to 32 (LTX needs sides divisible by 32). "
                                       "'from images' = take the ratio from the Director's first input image."),
                io.Int.Input("long_side", default=LONG_SIDE_DEFAULT, min=256, max=2048, step=32,
                             tooltip="Longest side in pixels (rounded to 32). 960 with 4:5 = 768×960 (LTX template); "
                                     "1344 with 4:5 = 1088×1344 (≈ Instagram 1080×1350)."),
                io.String.Input("output_folder", default="",
                                tooltip="Folder for the finished film. Empty = next to the shots "
                                        "(ComfyUI output/infinite_movie/<name>). Use 📂 Choose folder."),
                io.String.Input("film_name", default="",
                                tooltip="File name of the finished film (no extension). Empty = 'infinite_movie'."),
                io.Boolean.Input("audio", default=False, label_on="on", label_off="off",
                                 tooltip="Sound from engines that make it (LTX). Off (default) = the audio is not decoded "
                                         "(saves the audio VAE load per shot) and shots and film stay silent."),
            ],
            outputs=[
                SETTINGS.Output("settings", display_name="settings ▶ chain",
                                tooltip="All shared settings as one pipe → Prompt Style / Auto Prompt / Director / Assemble."),
            ],
        )

    @classmethod
    def execute(cls, llm=None, **kw):
        out = settings_defaults()
        out.update({k: kw[k] for k in SETTING_KEYS if k in kw})
        if isinstance(llm, dict) and llm.get("llm"):   # Story Mode plugged in
            out["llm"], out["llm_instruction"] = llm["llm"], llm.get("llm_instruction", "")
        out["free_vram"], out["free_ram"] = True, False
        out["min_free_mb"] = MIN_FREE_MB
        out["acquire_timeout_s"] = ACQUIRE_TIMEOUT_S
        if out["aspect"] == ASPECT_FROM_IMAGES:
            out["width"] = out["height"] = 0   # 69: the Director computes the size from the first image
        else:
            out["width"], out["height"] = resolve_size(out["aspect"], out["long_side"])
        return io.NodeOutput(out)


# 66 (2026-11-03): folder browser IN the browser (a native dialog from the background process stayed
# stuck invisibly – Windows will not bring it to the front).
# browser; the server serves only FOLDER NAMES (no files), and only for requests from this computer
# (loopback or own IP – the user opens ComfyUI via the LAN IP).
def _own_addresses() -> set:
    import socket
    own = {"127.0.0.1", "::1", "localhost"}
    try:
        own.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            own.add(info[4][0])
    except OSError:
        pass
    return own


def list_dirs(path: str) -> dict:
    """Subfolders of `path` (names only, sorted, without hidden ones). Empty = drives + shortcuts."""
    import os
    import string
    path = (path or "").strip()
    if not path:
        drives = [f"{d}:\\" for d in string.ascii_uppercase if os.path.isdir(f"{d}:\\")]
        quick = []
        try:
            import folder_paths
            quick.append(folder_paths.get_output_directory())
        except Exception:  # noqa: BLE001
            pass
        return {"ok": True, "path": "", "parent": None, "dirs": drives,
                "quick": [q for q in quick if os.path.isdir(q)]}
    path = os.path.abspath(path)
    if not os.path.isdir(path):
        return {"ok": False, "error": f"not a folder: {path}"}
    dirs = []
    try:
        with os.scandir(path) as it:
            for e in it:
                try:
                    if e.is_dir() and not e.name.startswith((".", "$")):
                        dirs.append(e.name)
                except OSError:
                    continue
    except OSError as e:
        return {"ok": False, "error": str(e)}
    dirs.sort(key=str.lower)
    parent = os.path.dirname(path)
    if parent == path:
        parent = ""   # drive root -> back to the drive list
    return {"ok": True, "path": path, "parent": parent, "dirs": dirs[:1000]}


def _register_choose_folder_route():
    import asyncio
    try:
        from aiohttp import web
        from server import PromptServer

        @PromptServer.instance.routes.post("/infinite_movie/list_dirs")
        async def _list_dirs(request):
            if (request.remote or "") not in _own_addresses():
                return web.json_response({"ok": False, "error": "folder browsing only from this computer"},
                                         status=403)
            try:
                data = await request.json()
            except Exception:  # noqa: BLE001
                data = {}
            res = await asyncio.to_thread(list_dirs, str(data.get("path", "") or ""))
            return web.json_response(res)
    except Exception as e:  # noqa: BLE001 - without a server (unit tests) no route
        print(f"[InfiniteMovieSettings] list_dirs route not registered: {e}")


_register_choose_folder_route()


# ---------------------------------------------------------------------------
# 65 (user 2026-11-03: "the render must not be sent off!"): preflight check BEFORE the queue.
# The frontend (web/infinite_movie.js wrapQueue) calls it on the Run click when a Director is active in the graph.
# 2026-11-08: ONE measurement (vram.gpu_check), no waiting, no unloading – the route runs in the aiohttp thread
# (unloading there hung the server, /prompt "Fetch timeout"), and the frontend aborts fetchApi after 60 s.
# Other programs are never touched; ok=False -> message who holds the GPU, and NOT queued.
def gpu_preflight(body: dict, queue_remaining: int = 0, check=None) -> dict:
    """Pure function (testable): {"ok": bool, "message": str}."""
    if queue_remaining > 0:
        # A render is already running: free memory says nothing then; the Director checks at start itself.
        return {"ok": True, "message": "queue busy – the Director checks the GPU when its turn comes"}
    check = check or vram.gpu_check
    min_free = body.get("min_free_mb", settings_defaults()["min_free_mb"])
    try:
        ok, avail, need, text = check(int(min_free or 0))
        if ok:
            return {"ok": True, "message": text}
        return {"ok": False, "message": vram.gpu_blocked_message(avail, need)}
    except Exception as e:  # noqa: BLE001 - check broken: do not block, the Director checks again
        return {"ok": True, "message": f"preflight failed ({type(e).__name__}: {e}) – the Director checks again"}


def _register_gpu_preflight_route():
    import asyncio
    try:
        from aiohttp import web
        from server import PromptServer

        @PromptServer.instance.routes.post("/infinite_movie/gpu_preflight")
        async def _gpu_preflight(request):
            try:
                data = await request.json()
            except Exception:  # noqa: BLE001
                data = {}
            try:
                remaining = PromptServer.instance.prompt_queue.get_tasks_remaining()
            except Exception:  # noqa: BLE001
                remaining = 0
            res = await asyncio.to_thread(gpu_preflight, data, remaining)
            return web.json_response(res)
    except Exception as e:  # noqa: BLE001 - without a server (unit tests) no route
        print(f"[InfiniteMovieSettings] gpu_preflight route not registered: {e}")


_register_gpu_preflight_route()


# ---------------------------------------------------------------------------
# 66 (user 2026-11-03: "prompt instruction missing – own node at the top of the prompt stack with text"):
# Prompt Style = system prompt node (common in LLM packs, e.g. LM Studio "System Prompt"). Sits in the
# settings chain (Settings → Prompt Style → Auto Prompts …) and overrides ONLY the prompt style.
class InfiniteMovieStyle(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        from .autoprompt import CAMERA_OPTIONS, STORY_SYSTEM, MAX_STORY_WORDS
        return io.Schema(
            node_id="InfiniteMovieStyle",
            display_name="Prompt Style · Infinite Movie",
            category="Infinite Movie/0 Setup",
            search_aliases=["infinite movie", "prompt style", "system prompt", "instruction"],
            description="What the prompt model is told when it writes the shot prompts (system prompt), plus length "
                        "and camera. Sits in the settings chain: Settings → Prompt Style → Auto Prompts. "
                        "Overrides only these fields.",
            inputs=[
                SETTINGS.Input("settings", optional=True, display_name="settings",
                               tooltip="Settings from Infinite Movie · Settings (prompt model, format, output)."),
                io.String.Input("instruction", multiline=True, default=STORY_SYSTEM,
                                tooltip="What the prompt model is told. {words} = max_words. Camera comes from the camera dropdown (appended). Empty = built-in text."),
                io.Int.Input("max_words", default=MAX_STORY_WORDS, min=5, max=80,
                             tooltip="Length of the story part (camera/rules come on top)."),
                io.Combo.Input("camera", options=CAMERA_OPTIONS, default="none",
                               tooltip="Camera move, appended to every prompt after the generated text. 'none' = no camera line."),
            ],
            outputs=[
                io.Custom("SETTINGS").Output("settings", display_name="settings ▶ chain",
                                             tooltip="Settings with this prompt style. Connect to the first Auto Prompt."),
            ],
        )

    @classmethod
    def execute(cls, settings=None, instruction="", max_words=12, camera="none"):
        return io.NodeOutput(apply_style(settings, instruction, max_words, camera))


def apply_style(settings, instruction, max_words, camera) -> dict:
    """Pure function: settings dict (or defaults) overridden with the prompt style."""
    out = dict(chain_settings(settings))
    out.update({"instruction": instruction, "max_words": max_words, "camera": camera})
    if not str(instruction or "").strip():
        out["instruction"] = settings_defaults()["instruction"]
    return out


SETTINGS_NODE_LIST = [InfiniteMovieSettings, InfiniteMovieStyle]
