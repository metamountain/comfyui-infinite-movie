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

import os
import re

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
    "prompt_model", "aspect", "long_side", "output_folder", "film_name", "raw", "audio",
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
        "output_folder": "Infinite Movie",
        "film_name": "",
        # 116b1: raw = the chosen shots are saved one by one to <output_folder>/raw/ as well.
        "raw": False,
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


def film_folder(settings) -> str:
    """116b1: film folder from settings > output_folder.

    Empty -> "Infinite Movie"; a relative name lies inside ComfyUI/output
    (one that escapes it raises ValueError), an absolute path stays as is.
    """
    import os

    import folder_paths
    folder = str(get_setting(settings, "output_folder") or "").strip()
    if not folder:
        folder = "Infinite Movie"
    if not os.path.isabs(folder):
        folder = os.path.join(folder_paths.get_output_directory(), folder)
        from .media import _inside
        if not _inside(folder, folder_paths.get_output_directory()):
            raise ValueError(f"output_folder must stay inside the ComfyUI output folder, got '{folder}'")
    return folder


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
                        "Connect `settings` to the Director (one link; from there everything travels in `sync`).",
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
                io.String.Input("output_folder", default="Infinite Movie",
                                tooltip="Folder for the films. A relative name lies inside ComfyUI/output. "
                                        "Inside it: cache_movies/<film_name>/ = rendered shots (render cache, "
                                        "safe to delete), raw/ = the chosen shots when raw is on. Use 📂 Choose folder."),
                io.String.Input("film_name", default="",
                                tooltip="File name of the finished film (no extension). Empty = 'infinite_movie'."),
                io.Boolean.Input("raw", default=False, label_on="on", label_off="off",
                                 tooltip="Also save the chosen shots one by one to <output_folder>/raw/ "
                                         "(<film_name>_shot01.mp4 …, in film order, with sound) - for cutting them yourself."),
                io.Boolean.Input("audio", default=False, label_on="on", label_off="off",
                                 tooltip="Sound from engines that make it (LTX). Off (default) = the audio is not decoded "
                                         "(saves the audio VAE load per shot) and shots and film stay silent."),
            ],
            outputs=[
                SETTINGS.Output("settings", display_name="settings",
                                tooltip="All shared settings as one pipe → Director (optional Prompt Style in between)."),
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


# Addresses of this computer: the folder dialog opens only for a browser on the ComfyUI computer
# (loopback or own IP - the user opens ComfyUI via the LAN IP).
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


# user 2026-11-15: no folder browser in the page - the normal Windows folder dialog (like Preview Image MM's
# "save as..."). Own process: a small topmost owner window + ALT tap bring the dialog to the front.
_WIN_FOLDER_SCRIPT = r'''
import ctypes, json, os, sys
from ctypes import wintypes
start_dir = sys.argv[1]
user32 = ctypes.WinDLL("user32", use_last_error=True)
shell32 = ctypes.WinDLL("shell32")
ole32 = ctypes.WinDLL("ole32")
kernel32 = ctypes.WinDLL("kernel32")
user32.CreateWindowExW.restype = wintypes.HWND
user32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                                   ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                   wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
kernel32.GetModuleHandleW.restype = wintypes.HMODULE
BFFCALLBACK = ctypes.WINFUNCTYPE(ctypes.c_int, wintypes.HWND, wintypes.UINT, wintypes.LPARAM, wintypes.LPARAM)


class BROWSEINFOW(ctypes.Structure):
    _fields_ = [("hwndOwner", wintypes.HWND), ("pidlRoot", ctypes.c_void_p), ("pszDisplayName", wintypes.LPWSTR),
                ("lpszTitle", wintypes.LPCWSTR), ("ulFlags", wintypes.UINT), ("lpfn", BFFCALLBACK),
                ("lParam", wintypes.LPARAM), ("iImage", ctypes.c_int)]


start_buf = ctypes.create_unicode_buffer(start_dir if os.path.isdir(start_dir) else "")


def _cb(hwnd, msg, lp, data):
    if msg == 1 and start_buf.value:   # BFFM_INITIALIZED -> BFFM_SETSELECTIONW
        user32.SendMessageW(hwnd, 0x467, 1, ctypes.addressof(start_buf))
    return 0


cb = BFFCALLBACK(_cb)
ole32.CoInitialize(None)
owner = user32.CreateWindowExW(0x88, "STATIC", "Infinite Movie", 0x80000000, 0, 0, 0, 0,
                               None, None, kernel32.GetModuleHandleW(None), None)
user32.keybd_event(0x12, 0, 0, 0)
user32.keybd_event(0x12, 0, 2, 0)
user32.SetForegroundWindow(owner)
name = ctypes.create_unicode_buffer(260)
bi = BROWSEINFOW(owner, None, ctypes.cast(name, wintypes.LPWSTR), "Output folder for the finished film",
                 0x1 | 0x40, cb, 0, 0)   # RETURNONLYFSDIRS | NEWDIALOGSTYLE
shell32.SHBrowseForFolderW.restype = ctypes.c_void_p
shell32.SHGetPathFromIDListW.argtypes = [ctypes.c_void_p, wintypes.LPWSTR]
pidl = shell32.SHBrowseForFolderW(ctypes.byref(bi))
out = ""
if pidl:
    path = ctypes.create_unicode_buffer(32768)
    if shell32.SHGetPathFromIDListW(pidl, path):
        out = path.value
    ole32.CoTaskMemFree(ctypes.c_void_p(pidl))
user32.DestroyWindow(owner)
sys.stdout.write("\nIMFOLDER:" + json.dumps(out) + "\n")
'''


def folder_dialog(start_dir: str) -> str:
    """The Windows folder dialog on the ComfyUI computer, starting in start_dir. '' = cancelled."""
    import json
    import subprocess
    import sys
    r = subprocess.run([sys.executable, "-I", "-c", _WIN_FOLDER_SCRIPT, start_dir or ""],
                       capture_output=True, text=True, encoding="utf-8", timeout=3600)
    lines = [x[9:] for x in (r.stdout or "").splitlines() if x.startswith("IMFOLDER:")]
    if r.returncode != 0 or not lines:
        raise RuntimeError(f"folder dialog failed: {(r.stderr or '').strip()[-300:]}")
    return json.loads(lines[-1])


def _register_choose_folder_route():
    import asyncio
    import os
    try:
        from aiohttp import web
        from server import PromptServer

        @PromptServer.instance.routes.post("/infinite_movie/folder_dialog")
        async def _folder_dialog(request):
            # only for a browser on the ComfyUI computer (the dialog opens there) and only on Windows
            if (request.remote or "") not in _own_addresses() or os.name != "nt":
                return web.json_response({"ok": False, "local": False})
            try:
                data = await request.json()
            except Exception:  # noqa: BLE001
                data = {}
            start = str(data.get("path", "") or "").strip().strip('"')
            if start and not os.path.isabs(start):
                try:
                    import folder_paths
                    start = os.path.join(folder_paths.get_output_directory(), start)
                except Exception:  # noqa: BLE001
                    start = ""
            while start and not os.path.isdir(start) and os.path.dirname(start) != start:
                start = os.path.dirname(start)   # not created yet -> its parent
            try:
                return web.json_response({"ok": True, "path": await asyncio.to_thread(folder_dialog, start)})
            except Exception as e:  # noqa: BLE001
                return web.json_response({"ok": False, "message": str(e)})
    except Exception as e:  # noqa: BLE001 - without a server (unit tests) no route
        print(f"[InfiniteMovieSettings] folder_dialog route not registered: {e}")


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
                io.Custom("SETTINGS").Output("settings", display_name="settings",
                                             tooltip="Settings with this prompt style → Director."),
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
