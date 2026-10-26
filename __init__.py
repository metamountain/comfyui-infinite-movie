"""comfyui-filmchain: one node that turns a sequence of images into a
looping film (pairwise FLF2V segments + concat), with GPU handoff to/from the
local LLM.

V3 ComfyNode API (comfy_entrypoint).
"""

from comfy_api.latest import ComfyExtension

from .nodes import NODE_LIST
from .post_nodes import POST_NODE_LIST

WEB_DIRECTORY = "./web"


class FilmChainExtension(ComfyExtension):
    async def get_node_list(self):
        return NODE_LIST + POST_NODE_LIST


async def comfy_entrypoint():
    return FilmChainExtension()
