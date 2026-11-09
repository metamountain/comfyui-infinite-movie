"""comfyui-infinite-movie: one node that turns a sequence of images into a
looping film (pairwise FLF2V segments + concat), with GPU handoff to/from the
local LLM.

V3 ComfyNode API (comfy_entrypoint).
"""

import importlib

from comfy_api.latest import ComfyExtension

from .nodes import NODE_LIST

WEB_DIRECTORY = "./web"


def _import_node_list(mod: str, attr: str) -> list:
    """57a: guarded import (Muster ALT __init__.py:18-33) – ein kaputtes Modul
    darf den Pack-Load nicht killen. Jede node_id muss genau einmal vorkommen."""
    try:
        m = importlib.import_module(f".{mod}", __name__)
        return getattr(m, attr)
    except Exception as e:  # noqa: BLE001
        print(f"[InfiniteMovie] failed to import {mod} ({attr}): {e}")
        return []


# 57a: jeder Import ausser .nodes ist abgesichert.
_POST_NODE_LIST = _import_node_list("post_nodes", "POST_NODE_LIST")
_AUTOPROMPT_NODE_LIST = _import_node_list("autoprompt", "AUTOPROMPT_NODE_LIST")
# 75: ghost_nodes.py moved to tools/ghost_check.py (nodes unregistered).
_RETIME_NODE_LIST = _import_node_list("retime_nodes", "RETIME_NODE_LIST")
_REVIEW_NODE_LIST = _import_node_list("review_nodes", "REVIEW_NODE_LIST")
_ENGINE_NODE_LIST = _import_node_list("engine_nodes", "ENGINE_NODE_LIST")
# 57d: Settings-Node (gemeinsame Einstellungen). settings_nodes importiert nur .vram
# (Leaf) + lazy .autoprompt, darum kein Zirkel mit .nodes.
_SETTINGS_NODE_LIST = _import_node_list("settings_nodes", "SETTINGS_NODE_LIST")
# 2026-11-02: LTX Chunk Upscale (ganzer Film stückweise mit der Pixel-Upscaler-IC-LoRA).
_CHUNK_UPSCALE_NODE_LIST = _import_node_list("chunk_upscale_nodes", "CHUNK_UPSCALE_NODE_LIST")
_AUDIO_NODE_LIST = _import_node_list("audio_nodes", "AUDIO_NODE_LIST")
# 2026-11-03: Film-Anzeige am Ende der Kette (Vorschau + „Saved“-Status).
_FILM_NODE_LIST = _import_node_list("film_nodes", "FILM_NODE_LIST")
# 2026-11-08: Movie to GIF (GIF/WebP mit Live-Vorschau).
_GIF_NODE_LIST = _import_node_list("gif_nodes", "GIF_NODE_LIST")
_LOOP_NODE_LIST = _import_node_list("loop_nodes", "LOOP_NODE_LIST")

# 91: model check (routes only, no nodes – nothing to add to the node list).
try:
    importlib.import_module(".model_check", __name__)
except Exception as e:  # noqa: BLE001
    print(f"[InfiniteMovie] failed to import model_check: {e}")


def _register_upscale_universal_copy():
    """Kopie von „Upscale Crop Universal“ (metamountain/upscale-universal, Nutzer 2026-11-02: „benutze immer upscale
    universal von mir, kopiere es auch in diese rep“). V1-Node in einem V3-Pack: ComfyUI liest NODE_CLASS_MAPPINGS ODER
    comfy_entrypoint, nie beides (ComfyUI nodes.py:2305/2316) – darum direkt in nodes.NODE_CLASS_MAPPINGS eintragen.
    Nur wenn das eigenständige Pack NICHT installiert ist; sonst gewinnt das Original (keine doppelte node_id)."""
    try:
        import os

        import folder_paths
        import nodes as _comfy_nodes

        for base in folder_paths.get_folder_paths("custom_nodes"):
            if os.path.isfile(os.path.join(base, "upscale-universal", "__init__.py")):
                return
        if "UpscaleCropUniversal" in _comfy_nodes.NODE_CLASS_MAPPINGS:
            return
        m = importlib.import_module(".upscale_universal.upscale_crop_universal", __name__)
        cls = m.UpscaleCropUniversal
        cls.RELATIVE_PYTHON_MODULE = f"custom_nodes.{os.path.basename(os.path.dirname(os.path.abspath(__file__)))}"
        _comfy_nodes.NODE_CLASS_MAPPINGS["UpscaleCropUniversal"] = cls
        _comfy_nodes.NODE_DISPLAY_NAME_MAPPINGS["UpscaleCropUniversal"] = "Upscale Crop Universal"
    except Exception as e:  # noqa: BLE001
        print(f"[InfiniteMovie] Upscale Crop Universal (Kopie) nicht registriert: {e}")


_register_upscale_universal_copy()


class InfiniteMovieExtension(ComfyExtension):
    async def get_node_list(self):
        # 57c2: v1 InfiniteMovieAutoPrompt (post_nodes.py) gelöscht – der aktive
        # Auto Prompt ist InfiniteMovieAutoPromptV2 (autoprompt.py, gleiche node_id).
        # POST_NODE_LIST enthält nur noch den (neuen) Upscale.
        return (NODE_LIST + _POST_NODE_LIST + _AUTOPROMPT_NODE_LIST +
                _RETIME_NODE_LIST + _REVIEW_NODE_LIST + _ENGINE_NODE_LIST +
                _SETTINGS_NODE_LIST + _CHUNK_UPSCALE_NODE_LIST + _AUDIO_NODE_LIST + _FILM_NODE_LIST +
                _GIF_NODE_LIST + _LOOP_NODE_LIST)


async def comfy_entrypoint():
    return InfiniteMovieExtension()
