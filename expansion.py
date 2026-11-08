"""Expansion graph builder for InfiniteMovieRender.

Builds the per-segment sub-graphs from the verified API templates
(wan22_flf2v_lightning / ltx25_flf2v) and wires in the InfiniteMovieRender-specific
output nodes (InfiniteMovieSegmentSave, InfiniteMovieAssemble, InfiniteMovieVRAMAcquire, InfiniteMovieVRAMRelease).

Key mechanics (verified against core source, v0.42):
- The expand graph is a plain dict (same format as GraphBuilder.finalize()).
- Literal tensor values in node inputs work at execution time
  (execution.py:164-195, get_input_data wraps non-link inputs in a list).
- Nodes with literal tensor inputs get an unhashable (NaN) cache key and are
  therefore always re-executed (caching.py:55, to_hashable).
- Loader nodes (scalar inputs only) get hashable cache keys and are executed
  once, then cached (caching.py:83-149, CacheKeySetInputSignature).
- Output nodes (is_output_node=True -> OUTPUT_NODE=True) in the expansion are
  added to the execution list and DO run (execution.py:581-615).
- The LoadImage nodes' outputs are replaced with literal tensor values so the
  segment nodes consume the actual image tensors instead of loading from disk.
"""

from __future__ import annotations

import hashlib
import json
import os

from comfy_execution.graph_utils import is_link

# ---------------------------------------------------------------------------
# Preset configuration
# ---------------------------------------------------------------------------

_HERE = os.path.dirname(os.path.abspath(__file__))
_TEMPLATES_DIR = os.path.join(_HERE, "templates")


def segment_path(output_dir, index):
    """Single source of truth for segment file names (Auftrag 54)."""
    return os.path.join(output_dir, f"seg_{index:03d}.mp4")


def segment_path_b(output_dir, index):
    """Variant B file name (Auftrag 61): seg_XXX_b.mp4 next to seg_XXX.mp4."""
    return os.path.join(output_dir, f"seg_{index:03d}_b.mp4")


def _segment_plan(n_images: int, loop: bool, scene_lengths: list, length: int) -> list:
    """Ordered segment plan: scene0..scene(n-2), then loop (last image -> first) if loop.

    Returns (start_idx, end_idx, seg_length, kind) tuples; kind is 'scene', 'loop' or 'open'.
    One image + loop = a single loop shot (image -> itself). One image without loop = an
    'open' shot: start image + prompt, no end image (end_idx None). Intro/outro removed in 71.
    """
    if n_images == 1 and not loop:
        return [(0, None, scene_lengths[0] if scene_lengths else length, "open")]
    plan = []
    for i in range(n_images - 1):
        seg_length = scene_lengths[i] if i < len(scene_lengths) else length
        plan.append((i, i + 1, seg_length, "scene"))
    if loop and n_images >= 1:
        plan.append((n_images - 1, 0, length, "loop"))
    return plan


PRESET_CONFIGS = {
    "wan22_flf2v_lightning": {
        "template": "wan22_flf2v_lightning_api.json",
        "fps": 16,
        "default_width": 576,
        "default_height": 720,
        "default_length": 81,
        "length_mod": 4,        # valid lengths: 4n + 1
        "start_image_marker": "START_IMAGE.png",
        "end_image_marker": "END_IMAGE.png",
        "prompt_marker": "PROMPT_POSITIVE",
        "seed_class_types": ("KSamplerAdvanced",),
        "size_class_type": "WanFirstLastFrameToVideo",
        "size_inputs": ("width", "height", "length"),
        "save_class_type": "SaveImage",
        # Optional model inputs (Auftrag 29): InfiniteMovieRender input -> (loader class,
        # consumer class, consumer input) resolved via the CONSUMER (the API
        # JSON declares no output types). None = not applicable / ambiguous.
        "loader_map": {
            "model": None,  # two UNETLoader (high/low) -> ambiguous, ValueError
            "clip": ("CLIPLoader", "CLIPTextEncode", "clip"),
            "vae": ("VAELoader", "WanFirstLastFrameToVideo", "vae"),
            "audio_vae": None,  # Wan has no audio VAE
        },
    },
    "ltx25_flf2v": {
        "template": "ltx25_flf2v_api.json",
        "fps": 24,
        "default_width": 768,
        "default_height": 960,
        "default_length": 121,
        "length_mod": 8,        # valid lengths: 8n + 1
        "start_image_marker": "START_IMAGE.png",
        "end_image_marker": "END_IMAGE.png",
        "prompt_marker": "PROMPT_POSITIVE",
        "seed_class_types": ("RandomNoise",),
        "size_class_type": "EmptyLTXVLatentVideo",
        "size_inputs": ("width", "height", "length"),
        "save_class_type": "SaveImage",
        # Optional model inputs (Auftrag 29): InfiniteMovieRender input -> (loader class,
        # consumer class, consumer input) resolved via the CONSUMER (the API
        # JSON declares no output types). None = not applicable / ambiguous.
        "loader_map": {
            "model": ("UNETLoader", "LTXVDualCFGGuider", "model"),
            "clip": ("CLIPLoader", "CLIPTextEncode", "clip"),
            "vae": ("VAELoader", "LTXVAddGuide", "vae"),
            "audio_vae": ("VAELoader", "LTXVEmptyLatentAudio", "audio_vae"),
        },
    },
}


def load_template(preset: str) -> dict:
    """Load the API-format template dict for the given preset."""
    cfg = PRESET_CONFIGS[preset]
    path = os.path.join(_TEMPLATES_DIR, cfg["template"])
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def engine_to_template(dynprompt, director_id) -> tuple[dict, dict]:
    """Extract the engine graph from the dynprompt and return (template, cfg).

    The engine graph is the chain between an InfiniteMovieEngineIn and an
    InfiniteMovieEngineOut, either flat on the canvas or inside a subgraph
    (Auftrag 57e: flache Kette UND Subgraph-Präfix).

    Resolution of the Engine Out (Auftrag 57e, Nutzer-Entscheidung 2026-11-01):
    - If the Director's `engine` input is a link in the dynprompt, EXACTLY that
      Engine Out is used (the connected one).
    - Otherwise, the single non-muted InfiniteMovieEngineOut in the prompt is
      used (muted nodes, mode=2, are absent from the API prompt).
    - If none -> error "Add an engine group ...".
    - If several active and none connected -> error with the node IDs.

    The chain is converted to a template with the marker structure that
    build_segment expect (see _chain_to_template).

    Returns (template, cfg) where template is the extracted engine graph
    (API-format dict) and cfg is the configuration derived from the graph.
    """
    # Convert DynamicPrompt to dict if needed (Auftrag 41: dynprompt ist ein
    # DynamicPrompt-Objekt, kein dict – original_prompt + ephemeral_prompt + node_overrides)
    if hasattr(dynprompt, 'original_prompt'):
        _dp: dict = {}
        _dp.update(dynprompt.original_prompt)
        _dp.update(dynprompt.ephemeral_prompt)
        _dp.update(dynprompt.node_overrides)
        dynprompt = _dp

    # All Engine Out nodes in the prompt (muted ones are absent).
    outs = {nid: n for nid, n in dynprompt.items()
            if n.get("class_type") == "InfiniteMovieEngineOut"}

    # Resolve the connected Engine Out via the Director's `engine` input link.
    # Muted EngineOuts are absent from the dynprompt, so a link to a muted one
    # is NOT in `outs` -> hard error (no silent fallback to another engine).
    out_nid = None
    connected = False
    director = dynprompt.get(str(director_id))
    if director is not None:
        eng = (director.get("inputs") or {}).get("engine")
        if is_link(eng):
            connected = True
            src = str(eng[0])
            if src in outs:
                out_nid = src
    if out_nid is None:
        if connected:
            raise ValueError(
                "InfiniteMovieRender: the connected engine (Director · engine) is muted or "
                "missing – unmute it or connect an active Engine Result (to Director).")
        if not outs:
            raise ValueError(
                "InfiniteMovieRender: Add an engine group (Engine In → model chain → "
                "Engine Out), see example workflows.")
        if len(outs) > 1:
            ids = ", ".join(sorted(outs))
            raise ValueError(
                f"InfiniteMovieRender: multiple engine groups active ({ids}) – mute all "
                f"but one engine group or connect one to Director · engine.")
        out_nid = next(iter(outs))
    out_node = dynprompt[out_nid]

    # Extract the chain: flat (reverse BFS from the Engine Out) or subgraph prefix.
    if ":" in out_nid:
        prefix = out_nid.split(":")[0]
        chain = {}
        for nid, n in dynprompt.items():
            if nid.startswith(prefix + ":"):
                chain[nid.split(":", 1)[1]] = n
    else:
        chain = _extract_flat_chain(dynprompt, out_nid)

    # Convert the chain to a template with the marker structure.
    template = _chain_to_template(chain)

    # Derive the cfg from the template + the Engine Out node.
    cfg = _derive_cfg_from_graph(template, out_node)

    return template, cfg


def _extract_flat_chain(dynprompt: dict, out_nid: str) -> dict:
    """Extract the flat engine chain (Auftrag 57e, Befund 1): all nodes reachable
    backwards from the Engine Out until the Engine In (inclusive).

    Follows input links backwards (towards the sources). The Engine In has no
    inputs, so the traversal stops there. The Director is NOT reached (it is fed
    by the Engine Out's output, not the other way around).
    """
    chain: dict = {}
    visited: set = set()
    stack = [out_nid]
    while stack:
        nid = stack.pop()
        if nid in visited:
            continue
        visited.add(nid)
        node = dynprompt.get(nid)
        if node is None:
            continue
        chain[nid] = node
        for key, value in (node.get("inputs") or {}).items():
            if is_link(value):
                src = str(value[0])
                if src not in visited:
                    stack.append(src)
    return chain


def _chain_to_template(chain: dict) -> dict:
    """Convert the engine chain (with Engine In/Out) to a template with the
    marker structure that build_segment expect (Auftrag 57e,
    Befund 3).

    - Engine In start_image/end_image (slots 0/1) -> LoadImage nodes with the
      marker file names (START_IMAGE.png / END_IMAGE.png).
    - Engine In prompt (slot 2) -> marker text on the connected
      CLIPTextEncode node (PROMPT_POSITIVE).
    - Engine In seed/width/height/length (slots 3-6) -> literals on the
      connected nodes (overwritten per segment by build_segment).
    - Engine Out -> a SaveImage fed by whatever fed its images/video input.

    The result has the same marker structure as the verified API templates, so
    build_segment (LoadImage markers -> literal tensors, prompt text,
    seed, size/length, SaveImage -> InfiniteMovieSegmentSave) works unchanged.
    """
    template = {nid: {"class_type": n["class_type"],
                      "inputs": dict(n.get("inputs") or {})}
                for nid, n in chain.items()}

    in_id = next((nid for nid, n in template.items()
                  if n.get("class_type") == "InfiniteMovieEngineIn"), None)
    out_id = next((nid for nid, n in template.items()
                   if n.get("class_type") == "InfiniteMovieEngineOut"), None)

    # --- Engine In: replace each output with a marker / literal ---
    if in_id is not None:
        # slot -> (kind, payload). kind "image" inserts a LoadImage with the
        # marker filename; "text" sets the consumer's text; "literal" sets the
        # consumer's input to a literal (overwritten per segment).
        replacements = {
            0: ("image", "START_IMAGE.png"),
            1: ("image", "END_IMAGE.png"),
            2: ("text", "PROMPT_POSITIVE"),
            # 73: negative (Slot 3) gestrichen – seed/width/height/length rücken
            # auf Slots 3-6 (Engine In hat keinen negative-Ausgang mehr).
            3: ("literal", 42),
            4: ("literal", 768),
            5: ("literal", 960),
            6: ("literal", 121),
        }
        for slot, (kind, payload) in replacements.items():
            consumers = []  # (nid, key)
            for nid, n in template.items():
                if nid == in_id:
                    continue
                for key, value in (n.get("inputs") or {}).items():
                    if is_link(value) and str(value[0]) == in_id and value[1] == slot:
                        consumers.append((nid, key))
            if not consumers:
                continue
            if kind == "image":
                li_id = f"_li_{slot}"
                template[li_id] = {"class_type": "LoadImage",
                                   "inputs": {"image": payload}}
                for nid, key in consumers:
                    template[nid]["inputs"][key] = [li_id, 0]
            else:
                for nid, key in consumers:
                    template[nid]["inputs"][key] = payload
        template.pop(in_id, None)

    # --- Engine Out: replace with a SaveImage ---
    if out_id is not None:
        out_node = template[out_id]
        images_src = None
        for key in ("images", "video"):
            value = (out_node.get("inputs") or {}).get(key)
            if is_link(value):
                images_src = (str(value[0]), value[1])
                break
        # 76: Audio-Quelle erfassen (wenn an EngineOut.audio verbunden), damit
        # build_segment sie an SegmentSave.audio weiterreichen kann.
        audio_src = None
        audio_value = (out_node.get("inputs") or {}).get("audio")
        if is_link(audio_value):
            audio_src = (str(audio_value[0]), audio_value[1])
        # Remove links to the Engine Out.
        for nid, n in list(template.items()):
            if nid == out_id:
                continue
            for key, value in list((n.get("inputs") or {}).items()):
                if is_link(value) and str(value[0]) == out_id:
                    del n["inputs"][key]
        template.pop(out_id, None)
        if images_src is not None:
            save_inputs = {"images": [images_src[0], images_src[1]],
                           "filename_prefix": "infinite_movie"}
            if audio_src is not None:
                save_inputs["audio"] = [audio_src[0], audio_src[1]]
            template["_save"] = {"class_type": "SaveImage", "inputs": save_inputs}

    return template


def _derive_cfg_from_graph(template: dict, out_node: dict) -> dict:
    """Derive the cfg from the extracted engine graph (Auftrag 57e, Schritt 2).

    The cfg is derived FROM THE CHAIN, not from a preset selection:
    - fps (from the Engine Out's fps widget)
    - length_mod (from the Engine Out's length_grid, PRIORITY; else the size node)
    - default_width/height/length (from the size node)
    - family = "ltx" | "wan" | "other" (from the node classes)
    - preset (a label derived from the family, used in the segment key)
    - seed_class_types, size_class_type, size_inputs, save_class_type
    - start_image_marker, end_image_marker, prompt_marker
    - loader_map (from the loader nodes)

    PRESET_CONFIGS is NOT used here as a fallback – it stays an internal
    knowledge table for the example groups and the tests only (Auftrag 57e).
    """
    fps = out_node.get("inputs", {}).get("fps", 24)
    length_grid = out_node.get("inputs", {}).get("length_grid", 0)

    # Family detection from the node classes.
    classes = {n.get("class_type", "") for n in template.values()}
    if "EmptyLTXVLatentVideo" in classes or "LTXVAddGuide" in classes:
        family = "ltx"
    elif "WanFirstLastFrameToVideo" in classes:
        family = "wan"
    else:
        family = "other"
    preset = {"ltx": "ltx25_flf2v", "wan": "wan22_flf2v_lightning"}.get(family, "other")

    # Find the size node.
    size_class = None
    for nid, n in template.items():
        ct = n.get("class_type", "")
        if ct in ("EmptyLTXVLatentVideo", "WanFirstLastFrameToVideo"):
            size_class = ct
            break

    # length_mod: Engine Out's length_grid has PRIORITY, else the size node.
    if length_grid:
        length_mod = int(length_grid)
    elif size_class == "EmptyLTXVLatentVideo":
        length_mod = 8
    elif size_class == "WanFirstLastFrameToVideo":
        length_mod = 4
    else:
        length_mod = 8 if family == "ltx" else (4 if family == "wan" else 8)

    cfg = {
        "preset": preset,
        "family": family,
        "fps": fps,
        "length_mod": length_mod,
        "default_width": 768,
        "default_height": 960,
        "default_length": 121,
        "start_image_marker": "START_IMAGE.png",
        "end_image_marker": "END_IMAGE.png",
        "prompt_marker": "PROMPT_POSITIVE",
        "seed_class_types": ("RandomNoise",),
        "size_class_type": size_class,
        "size_inputs": ("width", "height", "length"),
        "save_class_type": "SaveImage",
        "loader_map": {},
    }

    # Size / length defaults from the size node.
    if size_class is not None:
        for nid, n in template.items():
            if n.get("class_type") == size_class:
                inputs = n.get("inputs", {})
                cfg["default_width"] = inputs.get("width", cfg["default_width"])
                cfg["default_height"] = inputs.get("height", cfg["default_height"])
                cfg["default_length"] = inputs.get("length", cfg["default_length"])
                break

    # Find the seed node
    for nid, n in template.items():
        ct = n.get("class_type", "")
        if ct in ("RandomNoise", "KSamplerAdvanced"):
            cfg["seed_class_types"] = (ct,)
            break

    # Find the save node
    for nid, n in template.items():
        ct = n.get("class_type", "")
        if ct == "SaveImage":
            cfg["save_class_type"] = "SaveImage"
            break

    # Find the LoadImage nodes
    for nid, n in template.items():
        if n.get("class_type") == "LoadImage":
            img = n.get("inputs", {}).get("image", "")
            img = img if isinstance(img, str) else ""   # Link/Zahl (verrutschte Widgets) -> kein Marker
            if "START" in img:
                cfg["start_image_marker"] = img
            elif "END" in img:
                cfg["end_image_marker"] = img

    # Find the prompt node
    for nid, n in template.items():
        if n.get("class_type") == "CLIPTextEncode":
            text = n.get("inputs", {}).get("text", "")
            text = text if isinstance(text, str) else ""  # Link/Zahl -> kein Marker (Fehler 2026-11-04: int not iterable)
            if "PROMPT" in text or "POSITIVE" in text:
                cfg["prompt_marker"] = text

    # Derive loader_map
    loader_map = {}
    for nid, n in template.items():
        ct = n.get("class_type", "")
        if ct == "UNETLoader":
            # Find the consumer (LTXVDualCFGGuider or similar)
            for cnid, cn in template.items():
                if cn.get("class_type") in ("LTXVDualCFGGuider", "BasicGuider", "CFGGuider"):
                    val = cn.get("inputs", {}).get("model")
                    if is_link(val) and val[0] == nid:
                        loader_map["model"] = (ct, cn.get("class_type"), "model")
                        break
        elif ct == "CLIPLoader":
            for cnid, cn in template.items():
                if cn.get("class_type") == "CLIPTextEncode":
                    val = cn.get("inputs", {}).get("clip")
                    if is_link(val) and val[0] == nid:
                        loader_map["clip"] = (ct, "CLIPTextEncode", "clip")
                        break
        elif ct == "VAELoader":
            for cnid, cn in template.items():
                cct = cn.get("class_type", "")
                if cct in ("LTXVAddGuide", "WanFirstLastFrameToVideo", "LTXVEmptyLatentAudio"):
                    for inp in ("vae", "audio_vae"):
                        val = cn.get("inputs", {}).get(inp)
                        if is_link(val) and val[0] == nid:
                            loader_map["vae" if inp == "vae" else "audio_vae"] = (ct, cct, inp)
                            break
                    if "vae" in loader_map or "audio_vae" in loader_map:
                        break

    cfg["loader_map"] = loader_map

    return cfg


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _find_nodes_by_class(graph: dict, class_type: str) -> list[str]:
    return [nid for nid, n in graph.items() if n.get("class_type") == class_type]


def _find_loadimage_by_marker(graph: dict, marker: str) -> str | None:
    for nid, n in graph.items():
        if n.get("class_type") == "LoadImage" and n.get("inputs", {}).get("image") == marker:
            return nid
    return None


def _find_prompt_node(graph: dict, marker: str) -> str | None:
    for nid, n in graph.items():
        if n.get("class_type") == "CLIPTextEncode" and n.get("inputs", {}).get("text") == marker:
            return nid
    return None


def _replace_links_to(graph: dict, source_id: str, new_value):
    """Replace every link [source_id, idx] in the graph with new_value,
    and remove the source node itself."""
    for nid, n in list(graph.items()):
        for key, value in list(n.get("inputs", {}).items()):
            if is_link(value) and value[0] == source_id:
                n["inputs"][key] = new_value
    graph.pop(source_id, None)


# Open shot (1 image, loop off): image nodes between the end-image loader and the
# conditioning node are dropped with it; the conditioning node loses the end image.
_END_PASSTHROUGH = {"LTXVPreprocess", "ImageScale", "ImageScaleBy", "ImageScaleToTotalPixels",
                    "ImageResizeKJv2", "UpscaleCropUniversal", "ImageResize+"}
# class -> optional end-image input (deleted -> the node runs without an end frame)
_END_OPTIONAL = {"WanFirstLastFrameToVideo": "end_image", "WanFunInpaintToVideo": "end_image",
                 "Wan22FunControlToVideo": "end_image"}
# class -> {output slot: input to pass through} (node bypassed, its guide disappears)
_END_BYPASS = {"LTXVAddGuide": {0: "positive", 1: "negative", 2: "latent"}}


def _drop_end_image(graph: dict, source_id: str) -> None:
    """Remove the end-image loader and everything that only exists to feed the end
    frame into the model (open shot: start image + prompt, end not defined)."""
    for nid, n in list(graph.items()):
        if nid not in graph:
            continue
        for key, value in list(n.get("inputs", {}).items()):
            if not (is_link(value) and value[0] == source_id):
                continue
            cls = n["class_type"]
            if cls in _END_PASSTHROUGH:
                _drop_end_image(graph, nid)
            elif _END_OPTIONAL.get(cls) == key:
                del n["inputs"][key]
            elif cls in _END_BYPASS:
                bypass = _END_BYPASS[cls]
                for cid, c in graph.items():
                    for ck, cv in list(c.get("inputs", {}).items()):
                        if is_link(cv) and cv[0] == nid:
                            c["inputs"][ck] = n["inputs"][bypass[cv[1]]]
                graph.pop(nid, None)
            else:
                raise ValueError(
                    f"InfiniteMovieRender: 1 image without loop needs an engine that can run "
                    f"without an end image; '{cls}.{key}' needs it. Turn loop on or add an image.")
    graph.pop(source_id, None)


def _find_loader_by_consumer(template: dict, loader_class: str,
                             consumer_class: str, consumer_input: str) -> str | None:
    """Find the loader node whose output is consumed by a specific consumer.

    The API JSON declares no output types, so the loader is resolved via the
    CONSUMER (which node pulls the loader's output), not the loader's class
    alone. Returns the loader node ID, or None if not found.
    """
    for nid, n in template.items():
        if n.get("class_type") != consumer_class:
            continue
        val = n.get("inputs", {}).get(consumer_input)
        if is_link(val):
            src = val[0]
            if template.get(src, {}).get("class_type") == loader_class:
                return src
    return None


def _apply_model_inputs(seg: dict, template: dict, cfg: dict, prefix: str,
                        model_inputs: dict) -> list[str]:
    """Replace template loader nodes with the connected model inputs (literal).

    For each connected model input (model/clip/vae/audio_vae), find the
    corresponding template loader (via cfg['loader_map'], resolved by consumer)
    and replace all links to it with the input value, then remove the loader.
    The template loader ID is unprefixed; the seg node ID is prefix + loader_id.
    Returns a list of log notes (e.g. which loaders were replaced).

    Raises ValueError if a connected input has no matching loader in the
    template (None in loader_map) or the loader cannot be found.
    """
    notes: list[str] = []
    loader_map = cfg.get("loader_map", {})
    for name, value in (model_inputs or {}).items():
        if value is None:
            continue
        mapping = loader_map.get(name)
        if mapping is None:
            raise ValueError(
                f"InfiniteMovieRender: input '{name}' is not applicable for this preset "
                f"(no matching loader in the template). Leave it unconnected.")
        loader_class, consumer_class, consumer_input = mapping
        loader_id = _find_loader_by_consumer(
            template, loader_class, consumer_class, consumer_input)
        if loader_id is None:
            raise ValueError(
                f"InfiniteMovieRender: could not find a {loader_class} consumed by "
                f"{consumer_class}.{consumer_input} in the template for "
                f"input '{name}'.")
        _replace_links_to(seg, prefix + loader_id, value)
        notes.append(f"{name}: {loader_class}({loader_id}) -> literal")
    return notes


def _model_inputs_tag(model_inputs: dict | None) -> str:
    """Stable identifier for connected model inputs (for the resume key).

    Uses the class name + a name abbreviation (model_name/clip_name/vae_name or
    a short repr). No id() (that changes per run). Returns an empty string if
    no model inputs are connected. The tag is NOT guaranteed to uniquely
    identify the external model (logged by the caller); it only ensures a model
    swap invalidates the cached segment.
    """
    if not model_inputs:
        return ""
    parts = []
    for name in sorted(model_inputs):
        value = model_inputs[name]
        if value is None:
            continue
        cls = type(value).__name__
        short = ""
        for attr in ("model_name", "clip_name", "vae_name", "name"):
            v = getattr(value, attr, None)
            if isinstance(v, str) and v:
                short = v
                break
        if not short:
            try:
                short = repr(value)[:50]
            except Exception:  # noqa: BLE001
                short = "?"
        parts.append(f"{name}={cls}:{short}")
    return "|".join(parts)


def _reusable_segment(path: str, key: str) -> bool:
    """78 (Nutzer 2026-11-03: RERENDER rechnete alle Shots neu und warf die unveränderten weg): Datei mit genau
    diesem Schlüssel (Seed/Prompt/Bilder/Länge) vorhanden -> gar nicht erst sampeln."""
    try:
        return (os.path.getsize(path) > 0
                and open(path + ".key", encoding="utf-8").read().strip() == key)
    except OSError:
        return False


def _reuse_node(graph: dict, nid: str, path: str) -> str:
    """Statt Sampler-Graph nur den Pfad liefern (Core PrimitiveString, Ausgang 0 = STRING wie SegmentSave)."""
    graph[nid] = {"class_type": "PrimitiveString", "inputs": {"value": path}}
    print(f"[InfiniteMovie] segment unchanged, reusing {os.path.basename(path)}")
    return nid


def _set_trigger(graph: dict, nid: str, src: str) -> None:
    if graph[nid]["class_type"] == "InfiniteMovieSegmentSave":
        graph[nid]["inputs"]["trigger"] = [src, 0]


def build_segment(template: dict, cfg: dict, prefix: str,
                  start_tensor, end_tensor,
                  prompt: str,
                  seed: int, width: int, height: int, length: int,
                  model_inputs: dict | None = None) -> dict:
    """Build one segment graph (prefixed copy of the template) with the
    LoadImage outputs replaced by literal tensors and the SaveImage node
    replaced by a InfiniteMovieSegmentSave node.

    model_inputs: optional dict of connected model inputs (model/clip/vae/
    audio_vae -> live object). Each connected input replaces the template's
    loader node with the literal value (Auftrag 29).

    Returns (segment_graph, save_node_id).
    """
    # 1. Prefix all node IDs and remap internal links.
    seg = {}
    for nid, n in template.items():
        new_id = prefix + nid
        new_inputs = {}
        for key, value in n.get("inputs", {}).items():
            if is_link(value):
                new_inputs[key] = [prefix + value[0], value[1]]
            else:
                new_inputs[key] = value
        seg[new_id] = {"class_type": n["class_type"], "inputs": new_inputs}

    # 2. Replace LoadImage outputs with literal tensors.
    start_src = _find_loadimage_by_marker(template, cfg["start_image_marker"])
    end_src = _find_loadimage_by_marker(template, cfg["end_image_marker"])
    if start_src is None or end_src is None:
        raise ValueError("Template missing LoadImage markers for preset")
    _replace_links_to(seg, prefix + start_src, start_tensor)
    if end_tensor is None:
        _drop_end_image(seg, prefix + end_src)
    else:
        _replace_links_to(seg, prefix + end_src, end_tensor)

    # 2b. Replace template loader nodes with connected model inputs (Auftrag 29).
    # The loader IDs in the template are unprefixed; _apply_model_inputs resolves
    # the loader via the (unprefixed) template and replaces links in the
    # (prefixed) seg using prefix + loader_id.
    if model_inputs:
        _apply_model_inputs(seg, template, cfg, prefix, model_inputs)

    # 3. Set prompt. (73: negative wird nicht mehr gesetzt – der Negativ-Encoder
    # bleibt leer; Engine In hat keinen negative-Ausgang mehr.)
    prompt_src = _find_prompt_node(template, cfg["prompt_marker"])
    if prompt_src is not None:
        seg[prefix + prompt_src]["inputs"]["text"] = prompt

    # 4. Set seed on all sampler / noise nodes.
    for nid, n in seg.items():
        if n["class_type"] in cfg["seed_class_types"]:
            if "noise_seed" in n["inputs"]:
                n["inputs"]["noise_seed"] = seed

    # 5. Set size / length.
    for nid, n in seg.items():
        if n["class_type"] == cfg["size_class_type"]:
            for field in cfg["size_inputs"]:
                if field in n["inputs"]:
                    n["inputs"][field] = {"width": width, "height": height,
                                          "length": length}[field]

    # 6. Replace SaveImage with InfiniteMovieSegmentSave.
    save_src = _find_nodes_by_class(template, cfg["save_class_type"])
    if not save_src:
        raise ValueError("Template missing SaveImage node")
    save_id = prefix + save_src[0]
    # The SaveImage node's 'images' input is a link to the VAEDecode output.
    # InfiniteMovieSegmentSave keeps that link and adds path/index/trigger inputs.
    images_link = seg[save_id]["inputs"].get("images")
    # 76: Audio-Quelle (aus EngineOut.audio, in _chain_to_template als "audio"
    # am SaveImage-Platzhalter mitgeführt) an SegmentSave.audio verdrahten.
    # Ohne Audio-Quelle (z. B. Wan) bleibt der Eingang leer.
    audio_link = seg[save_id]["inputs"].get("audio")
    seg_save_inputs = {
        "frames": images_link,
        "path": "",          # filled in by the caller
        "index": 0,          # filled in by the caller
        "total": 1,          # filled in by the caller
        "fps": cfg["fps"],
        "trigger": "",       # dependency link (ignored)
    }
    if is_link(audio_link):
        seg_save_inputs["audio"] = audio_link
    seg[save_id] = {
        "class_type": "InfiniteMovieSegmentSave",
        "inputs": seg_save_inputs,
    }

    return seg, save_id


# ---------------------------------------------------------------------------
# Full expansion
# ---------------------------------------------------------------------------

def build_expansion_graph(unique_id: str, preset: str,
                          images: list,
                          prompts: list[str],
                          seed: int, width: int, height: int, length: int,
                          loop: bool,
                          output_dir: str,
                          film_name: str,
                          acquire_kwargs: dict,
                          release_kwargs: dict,
                          concat_inside: bool = False,
                          seed_bumps: dict | None = None,
                          model_inputs: dict | None = None,
                          template: dict | None = None,
                          cfg: dict | None = None,
                          scene_seconds: list | None = None,
                           variants: int = 1) -> dict:
    """Build the full expansion graph for InfiniteMovieRender.

    Args:
        unique_id: the InfiniteMovieRender node's unique ID (used as ID prefix root).
        preset: a label (the family name) used in the segment key.
        images: list of image tensors (each a torch tensor, HWC or CHW as
            produced by the image loader / preprocessing).
        prompts: one prompt per transition (len == len(images) if loop else
            len(images) - 1). The caller pads/repeats as needed.
        seed: base seed (per-segment seed = seed + segment_index
            + 1000 * seed_bumps.get(segment_number, 0)).
        width, height, length: render size / frame count.
        loop: whether to add the closing N->1 segment.
        output_dir: directory for segment files (also the film save_folder).
        film_name: name of the final film (without extension, the save_name).
        acquire_kwargs: GPU check kwargs (min_free_mb, timeout_s).
        release_kwargs: kwargs for the cleanup switches on the (internal)
            InfiniteMovieAssemble (free_vram, free_ram).
        concat_inside: True = build an internal InfiniteMovieAssemble (with the cleanup
            switches) after the collector. False = no internal InfiniteMovieAssemble and
            no InfiniteMovieVRAMRelease; the user attaches a visible InfiniteMovieAssemble node and
            connects InfiniteMovieRender's shots output to it.
        seed_bumps: {segment number (1-based): bump count} from InfiniteMovieRender.reseed;
            each bump adds 1000 to that segment's seed, the others keep theirs.

    Ordering note: a InfiniteMovieSegmentPaths collector is ALWAYS built and links one
    Autogrow input per segment to the corresponding InfiniteMovieSegmentSave output, so
    it depends on every segment. InfiniteMovieRender's segment_paths output links to the
    collector, which blocks the parent until all segments finish
    (execution.py:600-613 strong links). The expansion NEVER appends a
    InfiniteMovieVRAMRelease node; the cleanup switches live on the InfiniteMovieAssemble (internal or
    visible).

    Returns:
        The expansion graph dict (same format as GraphBuilder.finalize()).

    template/cfg (Auftrag 57e): the engine graph extracted from the workflow
    (engine_to_template) and the cfg derived from it. No load_template /
    PRESET_CONFIGS fallback – the engine chain is the single source of truth.
    """
    if template is None or cfg is None:
        raise ValueError("build_expansion_graph requires template and cfg (Auftrag 57e)")

    n_images = len(images)
    # --- Per-segment graphs ---
    # Auftrag 41A: per-scene lengths (n_scenes Eintraege)
    n_scenes = n_images - 1 if n_images > 1 else (0 if loop else 1)
    if scene_seconds:
        from .nodes import _scene_frames
        scene_lengths = _scene_frames(scene_seconds, cfg["fps"], cfg["length_mod"], length)
    else:
        scene_lengths = [length] * n_scenes
    plan = _segment_plan(n_images, loop, scene_lengths, length)
    n_segments = len(plan)
    if n_segments < 1:
        raise ValueError("InfiniteMovieRender needs at least 1 image.")

    graph: dict = {}
    save_ids: list[str] = []      # Variant A save nodes (the collector links to these)
    save_ids_b: list[str] = []    # Variant B save nodes (Auftrag 61, only when variants >= 2)

    for i, (start_idx, end_idx, seg_length, kind) in enumerate(plan):
        end_tensor = images[end_idx] if end_idx is not None else None
        if kind == "loop":
            seg_prompt = prompts[-1] if prompts else ""
        else:  # scene (start_idx == scene index)
            seg_prompt = prompts[start_idx] if start_idx < len(prompts) else (prompts[-1] if prompts else "")
        seg_seed = seed + i + 1000 * (seed_bumps or {}).get(i + 1, 0)

        # Key of everything that shapes the segment (shared by A and B except the seed):
        # InfiniteMovieSegmentSave only reuses an existing file when the key matches
        # (seed / prompt / preset / images / length). 73: negative entfällt.
        h = hashlib.md5(seg_prompt.encode("utf-8"))
        h.update(preset.encode("utf-8"))
        for t in (images[start_idx], end_tensor):
            h.update(t.cpu().numpy().tobytes() if t is not None else b"open")
        # Modell-Bezeichner (Auftrag 29): stabil (Klasse + Name-Kurzform), kein
        # id() (das aendert sich je Lauf). Ohne Bezeichner wuerde bei neu
        # verbundenem Modell das alte Segment stillschweigend wiederverwendet.
        model_tag = _model_inputs_tag(model_inputs)
        if model_tag:
            h.update(model_tag.encode("utf-8"))
        base_hash = h.hexdigest()

        # --- Variant A (seed as before, seg_XXX.mp4) ---
        prefix_a = f"{unique_id}_s{i}_"
        key_a = f"seed={seg_seed};len={seg_length};{base_hash}"
        if _reusable_segment(segment_path(output_dir, i), key_a):
            save_id_a = _reuse_node(graph, f"{prefix_a}reuse", segment_path(output_dir, i))
        else:
            seg_a, save_id_a = build_segment(
                template, cfg, prefix_a,
                start_tensor=images[start_idx],
                end_tensor=end_tensor,
                prompt=seg_prompt,
                seed=seg_seed,
                width=width, height=height, length=seg_length,
                model_inputs=model_inputs,
            )
            # Add the segment to the graph, then fill in the save path / index.
            graph.update(seg_a)
            graph[save_id_a]["inputs"]["path"] = segment_path(output_dir, i)
            graph[save_id_a]["inputs"]["index"] = i
            graph[save_id_a]["inputs"]["total"] = n_segments
            graph[save_id_a]["inputs"]["key"] = key_a
        save_ids.append(save_id_a)

        # --- Variant B (seed A + 500, seg_XXX_b.mp4) – only when variants >= 2 ---
        if variants >= 2:
            prefix_b = f"{unique_id}_s{i}b_"
            key_b = f"seed={seg_seed + 500};len={seg_length};{base_hash}"
            if _reusable_segment(segment_path_b(output_dir, i), key_b):
                save_id_b = _reuse_node(graph, f"{prefix_b}reuse", segment_path_b(output_dir, i))
            else:
                seg_b, save_id_b = build_segment(
                    template, cfg, prefix_b,
                    start_tensor=images[start_idx],
                    end_tensor=end_tensor,
                    prompt=seg_prompt,
                    seed=seg_seed + 500,
                    width=width, height=height, length=seg_length,
                    model_inputs=model_inputs,
                )
                graph.update(seg_b)
                graph[save_id_b]["inputs"]["path"] = segment_path_b(output_dir, i)
                graph[save_id_b]["inputs"]["index"] = i
                graph[save_id_b]["inputs"]["total"] = n_segments
                graph[save_id_b]["inputs"]["key"] = key_b
            save_ids_b.append(save_id_b)
            # 2026-11-03 Fix: der Parent wartet NICHT auf unverbundene Output-Nodes der Expansion –
            # Assemble lief los, bevor seg_001_b.mp4 existierte (Smoke varianten_095500). Darum
            # B[i] -> A[i].trigger: jedes A wartet auf sein B, der Collector auf alle A, seine
            # Ausgabe (segment_paths) bleibt die A-Liste.
            _set_trigger(graph, save_id_a, save_id_b)

    # 75: InfiniteMovieVRAMAcquire removed from the expansion.
    # InfiniteMovieRender.execute calls vram.wait_acquire() directly before
    # building the expansion, so the acquire node is redundant.

    # --- Collector (InfiniteMovieSegmentPaths): depends on ALL segments ---
    # Always built. Links one Autogrow input per segment to the corresponding
    # InfiniteMovieSegmentSave output, so the collector (and therefore the parent
    # InfiniteMovieRender, whose segment_paths output links to it) is blocked until every
    # segment has finished (execution.py:600-613 strong links).
    collector_id = f"{unique_id}_collector"
    collector_inputs = {}
    for j, sid in enumerate(save_ids):
        collector_inputs[f"segments.segment{j}"] = [sid, 0]  # Autogrow flach: name.prefixN
    graph[collector_id] = {"class_type": "InfiniteMovieSegmentPaths",
                           "inputs": collector_inputs}

    if concat_inside:
        # --- Internal InfiniteMovieShotsOut + InfiniteMovieAssemble (after all segments, via the collector) ---
        # 73: Assemble hat keine segments/save_folder/save_name/copy_to Inputs mehr –
        # die Daten kommen ueber die shots-Pipe (SHOTS). InfiniteMovieShotsOut kombiniert
        # die Collector-Pfade (Link) mit dem shots-Dict (Literal) und gibt das Dict mit
        # den echten Segment-Pfaden zurueck. Die Cleanup-Schalter liegen in settings.
        concat_shots_id = f"{unique_id}_concat_shots"
        concat_shots_dict = {
            "save_folder": output_dir,
            "save_name": film_name,
            "fps": cfg.get("fps", 24.0),
            "loop": loop,
        }
        graph[concat_shots_id] = {
            "class_type": "InfiniteMovieShotsOut",
            "inputs": {"segment_paths": [collector_id, 0], "shots": concat_shots_dict},
        }
        concat_id = f"{unique_id}_concat"
        concat_inputs = {
            "shots": [concat_shots_id, 0],
            "even_motion": False,
            "loop": loop,
            "settings": {
                "free_vram": release_kwargs.get("free_vram", True),
                "free_ram": release_kwargs.get("free_ram", False),
            },
        }
        graph[concat_id] = {"class_type": "InfiniteMovieAssemble", "inputs": concat_inputs}

    # concat_inside=False: no internal Assemble, no InfiniteMovieVRAMRelease. The user
    # attaches a visible Assemble node and connects InfiniteMovieRender's
    # segment_paths / save_folder / save_name outputs to it.

    return graph
