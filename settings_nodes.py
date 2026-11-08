"""Infinite Movie · Settings – gemeinsame Einstellungen an EINER Stelle (Pipe SETTINGS).

Settings → Prompt Style → Auto Prompts → Director → Assemble. Jeder Node reicht das Dict weiter
(chain_settings); ohne Settings-Node gelten settings_defaults().
  - prompt_model: lokales Vision-Modell aus models/text_encoders, das die Shot-Prompts schreibt
    (autoprompt.py, läuft IN ComfyUI – kein LLM-Server, kein Provider). 'off' = Prompts von Hand.
  - Format: aspect (klassische Verhältnisse) + long_side; width/height daraus, auf 32 gerundet.  - Ausgabe: output_folder, film_name.
  - GPU-Prüfung: fest (kein Widget), generisch (vram.py) – prüft vor dem Render, ob genug VRAM frei ist,
    fasst keine fremden Programme an. Die Zahlen (MIN_FREE_MB, ACQUIRE_TIMEOUT_S) sind Konstanten;
    die abgeleiteten Werte (free_vram, min_free_mb, …) bleiben im Settings-Dict, damit
    Director/Assemble get_setting(...) nutzen.
Der Prompt-Stil (instruction, max_words, camera) gehört dem Node Prompt Style.

Import-Regel (kein Zirkel): settings_nodes importiert nur .vram (Leaf); .autoprompt nur LAZY.
"""

from __future__ import annotations

from comfy_api.latest import io

from . import vram

# Pipe-Typ (Vorbild SHOTS, nodes.py): ein Custom-Typ, der ein Plain-Dict trägt.
SETTINGS = io.Custom("SETTINGS")

# Filmgröße (Nutzer 2026-11-03): klassisches Seitenverhältnis + längste Seite, beide Seiten auf 32 gerundet
# (LTX-2 Model Card: „Width & height settings must be divisible by 32“; Wan braucht 16 – passt auch).
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
LONG_SIDE_DEFAULT = 960   # 4:5 -> 768×960 = Größe der LTX-Engine-Vorlage
# 69 (2026-11-03): Seitenverhältnis kommt vom ersten Eingangsbild des Directors (long_side bleibt
# die längste Seite, beide Seiten auf 32 gerundet). Der Director rechnet width/height aus Bild 1.
ASPECT_FROM_IMAGES = "from images"


def _r32(v) -> int:
    return max(32, int(round(float(v) / 32)) * 32)


def resolve_ratio(rw, rh, long_side) -> tuple:
    """(width, height) aus Verhältnis rw:rh: längste Seite = long_side, beide auf 32 gerundet.

    69: Kern von resolve_size – der Director ruft ihn mit dem Verhältnis des ersten Bildes auf."""
    long = _r32(long_side)
    if rw >= rh:
        return long, _r32(long * rh / rw)
    return _r32(long * rw / rh), long


def resolve_size(aspect, long_side) -> tuple:
    """(width, height): längste Seite = long_side, kurze Seite nach Verhältnis; beide auf 32 gerundet."""
    rw, rh = ASPECTS.get(aspect, ASPECTS[ASPECT_DEFAULT])
    return resolve_ratio(rw, rh, long_side)


# 74 (2026-11-04): GPU-Werte fest, kein Widget (Nutzer: „dont like after film“). 2026-11-08: kein LLM-Server-Code
# mehr (Pack ist öffentlich). Die abgeleiteten Werte (free_vram, min_free_mb, …) bleiben im Settings-Dict, damit
# Director/Assemble unverändert get_setting(...) nutzen.
MIN_FREE_MB = 20000
ACQUIRE_TIMEOUT_S = 3600
# GPU-Werte: im Settings-Dict, aber KEINE Widgets (feste Konstanten)
DERIVED_GPU_KEYS = ["min_free_mb", "acquire_timeout_s", "free_vram", "free_ram"]


# Widgets des Settings-Nodes (Reihenfolge = Schema).
SETTING_KEYS = [
    "prompt_model", "aspect", "long_side", "output_folder", "film_name",
]
# Prompt-Stil: Widgets von Prompt Style; im Dict immer vorhanden (Defaults).
STYLE_KEYS = ["instruction", "max_words", "camera"]  # kein audio (Nutzer 2026-11-04: Ton im Prompt = Ballast)


def settings_defaults() -> dict:
    """Defaults aller Pipe-Felder (gelten ohne Settings-/Prompt-Style-Node)."""
    from .autoprompt import MAX_STORY_WORDS, STORY_SYSTEM, default_prompt_model
    return {
        "prompt_model": default_prompt_model(),
        "aspect": ASPECT_DEFAULT,
        "long_side": LONG_SIDE_DEFAULT,
        "width": 0,    # ohne Settings-Node: Größe der Engine (0 = Engine-Default)
        "height": 0,
        "output_folder": "",
        "film_name": "",
        # kein Widget (Nutzer 2026-11-03): beide Engines rendern mit CFG 1 (LTX video/audio_cfg 1, Wan Lightning),
        # dort wird die Negativ-Bedingung nicht gerechnet. Feld bleibt leer im Dict, der Director liest es.
        # GPU fest (Nutzer 2026-11-04: after_film-Widget weg): nach dem Film ComfyUI-VRAM frei.
        "min_free_mb": MIN_FREE_MB,
        "acquire_timeout_s": ACQUIRE_TIMEOUT_S,
        "free_vram": True,
        "free_ram": False,
        "instruction": STORY_SYSTEM,
        "max_words": MAX_STORY_WORDS,
        "camera": "none",
    }


def get_setting(settings, key):
    """Wert von `key` aus einem SETTINGS-Dict; fehlt er (oder kein Dict) -> Default."""
    if isinstance(settings, dict) and key in settings:
        return settings[key]
    return settings_defaults()[key]


def chain_settings(settings) -> dict:
    """Was ein Konsument an seinen settings-Ausgang weitergibt: das eingehende Dict, sonst die Defaults."""
    return settings if isinstance(settings, dict) and settings else settings_defaults()


class InfiniteMovieSettings(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        from .autoprompt import prompt_models, default_prompt_model
        return io.Schema(
            node_id="InfiniteMovieSettings",
            display_name="Infinite Movie · Settings",
            search_aliases=["infinite movie", "infinite_movie", "film", "movie", "video", "settings", "gpu"],
            category="Infinite Movie/0 Setup",
            description="Shared settings for the whole chain: the local prompt model, format and output. "
                        "Connect `settings ▶ chain` to Prompt Style (or the first Auto Prompt).",
            inputs=[
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
            ],
            outputs=[
                SETTINGS.Output("settings", display_name="settings ▶ chain",
                                tooltip="All shared settings as one pipe → Prompt Style / Auto Prompt / Director / Assemble."),
            ],
        )

    @classmethod
    def execute(cls, **kw):
        out = settings_defaults()
        out.update({k: kw[k] for k in SETTING_KEYS if k in kw})
        out["free_vram"], out["free_ram"] = True, False
        out["min_free_mb"] = MIN_FREE_MB
        out["acquire_timeout_s"] = ACQUIRE_TIMEOUT_S
        if out["aspect"] == ASPECT_FROM_IMAGES:
            out["width"] = out["height"] = 0   # 69: Director rechnet die Größe aus dem ersten Bild
        else:
            out["width"], out["height"] = resolve_size(out["aspect"], out["long_side"])
        return io.NodeOutput(out)


# 66 (2026-11-03): Ordner-Browser IM Browser (ein nativer Dialog aus dem Hintergrundprozess blieb
# unsichtbar hängen – Windows lässt ihn nicht nach vorne).
# Browser; der Server liefert nur ORDNERNAMEN (keine Dateien), und nur für Anfragen von diesem Rechner
# (Loopback oder eigene IP – der Nutzer öffnet ComfyUI über die LAN-IP).
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
    """Unterordner von `path` (nur Namen, sortiert, ohne versteckte). Leer = Laufwerke + Abkürzungen."""
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
        quick.append(r"D:\AiImages\infinite_movie")
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
        parent = ""   # Laufwerkswurzel -> zurück zur Laufwerksliste
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
    except Exception as e:  # noqa: BLE001 – ohne Server (Unit-Tests) keine Route
        print(f"[InfiniteMovieSettings] list_dirs route not registered: {e}")


_register_choose_folder_route()


# ---------------------------------------------------------------------------
# 65 (Nutzer 2026-11-03: „Render darf nicht losgeschickt werden!“): Vorabprüfung VOR dem Queue.
# Das Frontend (web/infinite_movie.js wrapQueue) ruft das beim Run-Klick auf, wenn ein Director im Graph aktiv ist.
# 2026-11-08: EINE Messung (vram.gpu_check), kein Warten, kein Entladen – die Route läuft im aiohttp-Thread
# (Entladen dort hängte den Server auf, /prompt "Fetch timeout"), und das Frontend bricht fetchApi nach 60 s ab.
# Fremde Programme werden nie angefasst; ok=False -> Meldung, wer die GPU hält, und NICHT gequeued.
def gpu_preflight(body: dict, queue_remaining: int = 0, check=None) -> dict:
    """Reine Funktion (testbar): {"ok": bool, "message": str}."""
    if queue_remaining > 0:
        # Ein Render läuft schon: freier Speicher sagt dann nichts; der Director prüft beim Start selbst.
        return {"ok": True, "message": "queue busy – the Director checks the GPU when its turn comes"}
    check = check or vram.gpu_check
    min_free = body.get("min_free_mb", settings_defaults()["min_free_mb"])
    try:
        ok, avail, need, text = check(int(min_free or 0))
        if ok:
            return {"ok": True, "message": text}
        return {"ok": False, "message": vram.gpu_blocked_message(avail, need)}
    except Exception as e:  # noqa: BLE001 – Prüfung kaputt: nicht blockieren, Director prüft nochmal
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
    except Exception as e:  # noqa: BLE001 – ohne Server (Unit-Tests) keine Route
        print(f"[InfiniteMovieSettings] gpu_preflight route not registered: {e}")


_register_gpu_preflight_route()


# ---------------------------------------------------------------------------
# 66 (Nutzer 2026-11-03: „Prompt-Anweisung fehlt – eigener Node oben im Prompt-Stapel mit Text“):
# Prompt Style = System-Prompt-Node (üblich in LLM-Packs, z. B. LM Studio „System Prompt“). Sitzt in der
# Settings-Kette (Settings → Prompt Style → Auto Prompts …) und überschreibt NUR den Prompt-Stil.
class InfiniteMovieStyle(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        from .autoprompt import CAMERA_OPTIONS, STORY_SYSTEM, MAX_STORY_WORDS
        return io.Schema(
            node_id="InfiniteMovieStyle",
            display_name="Infinite Movie · Prompt Style",
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
    """Reine Funktion: Settings-Dict (oder Defaults) mit dem Prompt-Stil überschrieben."""
    out = dict(chain_settings(settings))
    out.update({"instruction": instruction, "max_words": max_words, "camera": camera})
    if not str(instruction or "").strip():
        out["instruction"] = settings_defaults()["instruction"]
    return out


SETTINGS_NODE_LIST = [InfiniteMovieSettings, InfiniteMovieStyle]
