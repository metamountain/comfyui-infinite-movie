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
    """57a: guarded import (pattern ALT __init__.py:18-33) - a broken module
    must not kill the pack load. Each node_id must occur exactly once."""
    try:
        m = importlib.import_module(f".{mod}", __name__)
        return getattr(m, attr)
    except Exception as e:  # noqa: BLE001
        print(f"[InfiniteMovie] failed to import {mod} ({attr}): {e}")
        return []


# 57a: every import except .nodes is guarded.
_POST_NODE_LIST = _import_node_list("post_nodes", "POST_NODE_LIST")
_AUTOPROMPT_NODE_LIST = _import_node_list("autoprompt", "AUTOPROMPT_NODE_LIST")
# 75: ghost_nodes.py moved to tools/ghost_check.py (nodes unregistered).
_RETIME_NODE_LIST = _import_node_list("retime_nodes", "RETIME_NODE_LIST")
_REVIEW_NODE_LIST = _import_node_list("review_nodes", "REVIEW_NODE_LIST")
_ENGINE_NODE_LIST = _import_node_list("engine_nodes", "ENGINE_NODE_LIST")
# 57d: settings node (shared settings). settings_nodes only imports .vram
# (leaf) + lazy .autoprompt, so no cycle with .nodes.
_SETTINGS_NODE_LIST = _import_node_list("settings_nodes", "SETTINGS_NODE_LIST")
# 2026-11-02: LTX Chunk Upscale (whole film chunk by chunk with the pixel upscaler IC-LoRA).
_CHUNK_UPSCALE_NODE_LIST = _import_node_list("chunk_upscale_nodes", "CHUNK_UPSCALE_NODE_LIST")
# 2026-11-11: RelayVSR Upscale (divider: segments sized by ram_gb, long films no longer run out of RAM).
_RELAYVSR_NODE_LIST = _import_node_list("relayvsr_nodes", "RELAYVSR_NODE_LIST")
_AUDIO_NODE_LIST = _import_node_list("audio_nodes", "AUDIO_NODE_LIST")
# 2026-11-03: film display at the end of the chain (preview + "Saved" status).
_FILM_NODE_LIST = _import_node_list("film_nodes", "FILM_NODE_LIST")
# 2026-11-08: Movie to GIF (GIF/WebP with live preview).
_GIF_NODE_LIST = _import_node_list("gif_nodes", "GIF_NODE_LIST")
_LOOP_NODE_LIST = _import_node_list("loop_nodes", "LOOP_NODE_LIST")

# 91: model check (routes only, no nodes – nothing to add to the node list).
try:
    importlib.import_module(".model_check", __name__)
except Exception as e:  # noqa: BLE001
    print(f"[InfiniteMovie] failed to import model_check: {e}")

# Update hint (route /infinite_movie/version, registry vs. pyproject).
try:
    importlib.import_module(".version_check", __name__)
except Exception as e:  # noqa: BLE001
    print(f"[InfiniteMovie] failed to import version_check: {e}")


def _register_upscale_universal_copy():
    """Copy of "Upscale Crop Universal" (metamountain/upscale-universal, user 2026-11-02: "always use my upscale
    universal, copy it into this repo too"). V1 node in a V3 pack: ComfyUI reads NODE_CLASS_MAPPINGS OR
    comfy_entrypoint, never both (ComfyUI nodes.py:2305/2316) - therefore register directly in nodes.NODE_CLASS_MAPPINGS.
    Only when the standalone pack is NOT installed; otherwise the original wins (no duplicate node_id)."""
    try:
        import os

        import folder_paths
        import nodes as _comfy_nodes

        # Is the original installed? The folder name depends on the path (git: upscale-universal, Manager/Registry:
        # comfyui-upscale-crop-universal) - therefore look for the module file, not the name.
        here = os.path.dirname(os.path.abspath(__file__))
        for base in folder_paths.get_folder_paths("custom_nodes"):
            try:
                subs = os.listdir(base)
            except OSError:
                continue
            for sub in subs:
                p = os.path.join(base, sub)
                if os.path.normcase(os.path.realpath(p)) == os.path.normcase(os.path.realpath(here)):
                    continue
                if sub.endswith(".disabled") or not os.path.isfile(os.path.join(p, "upscale_crop_universal.py")):
                    continue
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
        # 57c2: v1 InfiniteMovieAutoPrompt (post_nodes.py) removed - the active
        # auto prompt is InfiniteMovieAutoPromptV2 (autoprompt.py, same node_id).
        # POST_NODE_LIST only contains the (new) upscale.
        return (NODE_LIST + _POST_NODE_LIST + _AUTOPROMPT_NODE_LIST +
                _RETIME_NODE_LIST + _REVIEW_NODE_LIST + _ENGINE_NODE_LIST +
                _SETTINGS_NODE_LIST + _CHUNK_UPSCALE_NODE_LIST + _RELAYVSR_NODE_LIST + _AUDIO_NODE_LIST + _FILM_NODE_LIST +
                _GIF_NODE_LIST + _LOOP_NODE_LIST)


async def comfy_entrypoint():
    return InfiniteMovieExtension()
