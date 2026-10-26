"""Expansion graph builder for FilmChain.

Builds the per-segment sub-graphs from the verified API templates
(wan22_flf2v_lightning / ltx25_flf2v) and wires in the FilmChain-specific
output nodes (FilmSegmentSave, FilmConcat, VRAMAcquire, VRAMRelease).

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

import json
import os

from comfy_execution.graph_utils import is_link

# ---------------------------------------------------------------------------
# Preset configuration
# ---------------------------------------------------------------------------

_HERE = os.path.dirname(os.path.abspath(__file__))
_TEMPLATES_DIR = os.path.join(_HERE, "templates")

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
    },
}


def load_template(preset: str) -> dict:
    """Load the API-format template dict for the given preset."""
    cfg = PRESET_CONFIGS[preset]
    path = os.path.join(_TEMPLATES_DIR, cfg["template"])
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


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


def _find_negative_node(graph: dict, marker: str) -> str | None:
    """The CLIPTextEncode node whose text is NOT the positive marker."""
    for nid, n in graph.items():
        if n.get("class_type") == "CLIPTextEncode" and n.get("inputs", {}).get("text") != marker:
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


def build_segment(template: dict, cfg: dict, prefix: str,
                  start_tensor, end_tensor,
                  prompt: str, negative: str,
                  seed: int, width: int, height: int, length: int) -> dict:
    """Build one segment graph (prefixed copy of the template) with the
    LoadImage outputs replaced by literal tensors and the SaveImage node
    replaced by a FilmSegmentSave node.

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
        raise ValueError(f"Template missing LoadImage markers for preset")
    _replace_links_to(seg, prefix + start_src, start_tensor)
    _replace_links_to(seg, prefix + end_src, end_tensor)

    # 3. Set prompt / negative.
    prompt_src = _find_prompt_node(template, cfg["prompt_marker"])
    neg_src = _find_negative_node(template, cfg["prompt_marker"])
    if prompt_src is not None:
        seg[prefix + prompt_src]["inputs"]["text"] = prompt
    if neg_src is not None:
        seg[prefix + neg_src]["inputs"]["text"] = negative

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

    # 6. Replace SaveImage with FilmSegmentSave.
    save_src = _find_nodes_by_class(template, cfg["save_class_type"])
    if not save_src:
        raise ValueError("Template missing SaveImage node")
    save_id = prefix + save_src[0]
    # The SaveImage node's 'images' input is a link to the VAEDecode output.
    # FilmSegmentSave keeps that link and adds path/index/trigger inputs.
    images_link = seg[save_id]["inputs"].get("images")
    seg[save_id] = {
        "class_type": "FilmSegmentSave",
        "inputs": {
            "frames": images_link,
            "path": "",          # filled in by the caller
            "index": 0,          # filled in by the caller
            "total": 1,          # filled in by the caller
            "fps": cfg["fps"],
            "trigger": "",       # dependency link (ignored)
        },
    }

    return seg, save_id


# ---------------------------------------------------------------------------
# Full expansion
# ---------------------------------------------------------------------------

def build_expansion_graph(unique_id: str, preset: str,
                          images: list,
                          prompts: list[str],
                          negative: str,
                          seed: int, width: int, height: int, length: int,
                          loop: bool,
                          output_dir: str,
                          film_name: str,
                          acquire_kwargs: dict,
                          release_kwargs: dict,
                          copy_to: str = "",
                          concat_inside: bool = False) -> dict:
    """Build the full expansion graph for FilmChain.

    Args:
        unique_id: the FilmChain node's unique ID (used as ID prefix root).
        preset: one of PRESET_CONFIGS.
        images: list of image tensors (each a torch tensor, HWC or CHW as
            produced by the image loader / preprocessing).
        prompts: one prompt per transition (len == len(images) if loop else
            len(images) - 1). The caller pads/repeats as needed.
        negative: negative prompt.
        seed: base seed (per-segment seed = seed + segment_index).
        width, height, length: render size / frame count.
        loop: whether to add the closing N->1 segment.
        output_dir: directory for segment files (also the film save_folder).
        film_name: name of the final film (without extension, the save_name).
        acquire_kwargs: kwargs for the VRAMAcquire node (llm_url, min_free_mb,
            timeout_s).
        release_kwargs: kwargs for the cleanup switches on the (internal)
            FilmConcat (free_vram, free_ram, wake_llm, min_free_mb, llm_url).
        copy_to: optional directory to copy the final film to.
        concat_inside: True = build an internal FilmConcat (with the cleanup
            switches) after the collector. False = no internal FilmConcat and
            no VRAMRelease; the user attaches a visible FilmConcat node and
            connects FilmChain's segment_paths / save_folder / save_name to it.

    Ordering note: a FilmSegmentPaths collector is ALWAYS built and links one
    Autogrow input per segment to the corresponding FilmSegmentSave output, so
    it depends on every segment. FilmChain's segment_paths output links to the
    collector, which blocks the parent until all segments finish
    (execution.py:600-613 strong links). The expansion NEVER appends a
    VRAMRelease node; the cleanup switches live on the FilmConcat (internal or
    visible).

    Returns:
        The expansion graph dict (same format as GraphBuilder.finalize()).
    """
    cfg = PRESET_CONFIGS[preset]
    template = load_template(preset)

    n_images = len(images)
    n_segments = n_images if loop else n_images - 1
    if n_segments < 1:
        raise ValueError("FilmChain needs at least 2 images (or 1 with loop off "
                         "is invalid; use at least 2 images)")

    graph: dict = {}
    save_ids: list[str] = []

    # --- Per-segment graphs ---
    for i in range(n_segments):
        start_idx = i
        end_idx = (i + 1) % n_images   # wraps to 0 for the loop segment
        seg_prompt = prompts[i] if i < len(prompts) else prompts[-1]
        seg_seed = seed + i

        prefix = f"{unique_id}_s{i}_"
        seg, save_id = build_segment(
            template, cfg, prefix,
            start_tensor=images[start_idx],
            end_tensor=images[end_idx],
            prompt=seg_prompt,
            negative=negative,
            seed=seg_seed,
            width=width, height=height, length=length,
        )
        # Add the segment to the graph, then fill in the save path / index.
        graph.update(seg)
        seg_path = os.path.join(output_dir, f"seg_{i:03d}.mp4")
        graph[save_id]["inputs"]["path"] = seg_path
        graph[save_id]["inputs"]["index"] = i
        graph[save_id]["inputs"]["total"] = n_segments
        save_ids.append(save_id)

    # --- VRAMAcquire (before the first segment) ---
    acquire_id = f"{unique_id}_acquire"
    graph[acquire_id] = {
        "class_type": "VRAMAcquire",
        "inputs": {k: v for k, v in acquire_kwargs.items()},
    }
    # Link acquire -> first segment's FilmSegmentSave.trigger (forces ordering).
    graph[save_ids[0]]["inputs"]["trigger"] = [acquire_id, 0]

    # --- Collector (FilmSegmentPaths): depends on ALL segments ---
    # Always built. Links one Autogrow input per segment to the corresponding
    # FilmSegmentSave output, so the collector (and therefore the parent
    # FilmChain, whose segment_paths output links to it) is blocked until every
    # segment has finished (execution.py:600-613 strong links).
    collector_id = f"{unique_id}_collector"
    collector_inputs = {}
    for j, sid in enumerate(save_ids):
        collector_inputs[f"segments.segment{j}"] = [sid, 0]  # Autogrow flach: name.prefixN
    graph[collector_id] = {"class_type": "FilmSegmentPaths",
                           "inputs": collector_inputs}

    if concat_inside:
        # --- Internal FilmConcat (after all segments, via the collector) ---
        # segments is a LINK to the collector's combined path string, so the
        # concat depends on every segment. The cleanup switches live here
        # (no separate VRAMRelease node is appended).
        concat_id = f"{unique_id}_concat"
        concat_inputs = {
            "segments": [collector_id, 0],
            "save_folder": output_dir,
            "save_name": film_name,
            "loop": loop,
            "free_vram": release_kwargs.get("free_vram", True),
            "free_ram": release_kwargs.get("free_ram", False),
            "wake_llm": release_kwargs.get("wake_llm", True),
            "llm_url": release_kwargs.get("llm_url", "http://127.0.0.1:8080"),
            "min_free_mb": release_kwargs.get("min_free_mb", 18000),
        }
        if copy_to:
            concat_inputs["copy_to"] = copy_to
        graph[concat_id] = {"class_type": "FilmConcat", "inputs": concat_inputs}

    # concat_inside=False: no internal FilmConcat, no VRAMRelease. The user
    # attaches a visible FilmConcat node and connects FilmChain's
    # segment_paths / save_folder / save_name outputs to it.

    return graph
