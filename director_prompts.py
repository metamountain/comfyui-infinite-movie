"""The Director writes the prompts of chosen storyboard rows - no render, no GPU.

↻ Regenerate / ✎ Write all in the storyboard set the Director's ``regen`` widget to a JSON list of row indices
(``"[0, 2]"``) and queue ONLY the Director; it writes those prompts from their image pairs with the LLM settings of
the chain and sends them back as ``ui["im_prompts"]``. Importable without a running ComfyUI (headless unit tests):
folder_paths, the LLM, the prompt model and the settings are imported where they are used.
"""
from __future__ import annotations

import json
import time


def prompt_config(settings) -> dict:
    """The prompt settings for one shot, exactly as InfiniteMovieAutoPromptV2.execute
    reads them (autoprompt.py:314-333): the prompt model (or the LLM from the
    settings chain), the instruction (``llm_instruction`` wins, then the red
    thread), camera and max_words. ``load``/``gen`` are the model loader/generator
    (LLM server or the local prompt model). Extracted here so the Director
    (write_prompts) and the Auto Prompt node share one copy."""
    from .settings_nodes import get_setting

    model_name = get_setting(settings, "prompt_model")
    llm = get_setting(settings, "llm")
    use_llm = isinstance(llm, dict) and bool(str(llm.get("endpoint") or "").strip())
    instruction = get_setting(settings, "instruction")
    load = gen = None
    if use_llm:
        from .llm_nodes import llm_gen, llm_label, red_thread
        model_name = llm_label(llm)
        load, gen = (lambda _name: llm), llm_gen
        instruction = str(get_setting(settings, "llm_instruction") or "").strip() or instruction
        instruction = red_thread(instruction, llm.get("story"))
    return {
        "model_name": model_name,
        "llm": llm,
        "use_llm": use_llm,
        "instruction": instruction,
        "camera": get_setting(settings, "camera"),
        "max_words": int(get_setting(settings, "max_words")),
        "load": load,
        "gen": gen,
    }


def parse_indices(text) -> list[int]:
    """Row indices from the ``regen`` widget (JSON list); anything else -> ``[]``."""
    try:
        data = json.loads(text or "[]")
    except (TypeError, ValueError):
        return []
    return [int(i) for i in data if isinstance(i, int) and not isinstance(i, bool)] if isinstance(data, list) else []


# Progress of prompt writing (user 2026-11-15): event infinite_movie.prompt_progress to the Director's storyboard bar.
# Durations are logged in timing.py (kind "story_plan" per image, "prompt" per film, preset = model) and the next
# estimate is their median - the more runs, the better the estimate. Fallbacks before the first measurement.
PLAN_FALLBACK_S, PROMPT_FALLBACK_S = 8.0, 20.0   # story plan per image, one prompt


def _estimates(model: str, n_images: int) -> tuple[float, float]:
    from . import timing
    plan = timing.estimate("story_plan", 1000, 1000, max(1, n_images), preset=model)
    one = timing.estimate("prompt", 1000, 1000, 1, preset=model)
    return (max(1.0, plan["seconds"]) if plan else PLAN_FALLBACK_S * max(1, n_images),
            max(1.0, one["seconds"]) if one else PROMPT_FALLBACK_S)


def _progress(node_id, **data) -> None:
    if node_id is not None:
        from .media import send_ui
        send_ui("infinite_movie.prompt_progress", {"node": str(node_id), **data})


def write_prompts(board, indices, loop, settings, node_id=None) -> list[dict]:
    """The prompts of the rows ``indices`` (storyboard.parse rows): ``{"i", "prompt", "pair"}`` per film, or
    ``{"i", "error"}`` when its images are missing or the generation fails - the other rows still run. Rows that
    start no film (the last one without loop) are left out. Only the images of these films are loaded."""
    from . import storyboard as sb
    from .autoprompt import generate

    cfg = prompt_config(settings)
    llm = cfg["llm"]
    n = len(board)
    images = {}

    def image(k):
        if k not in images:
            if not board[k]["image"]:
                raise ValueError(f"image {k + 1} is empty")
            images[k] = sb.load_image(board[k]["image"])
        return images[k]

    from . import timing
    films = [i for i in indices if 0 <= i < n and sb.next_of(n, i, loop) >= 0]
    filled = [k for k, row in enumerate(board) if row["image"]]
    model = str(cfg["model_name"] or "")
    planning = isinstance(llm, dict) and bool(llm.get("story_mode")) and len(filled) >= 2
    est_plan, est_prompt = _estimates(model, len(filled))
    _progress(node_id, phase="start", n=len(films), plan=planning, est_plan=round(est_plan, 1), est_prompt=round(est_prompt, 1))

    # Story mode: one plan for the whole film (arc + a beat per image), each film then gets its own beat.
    plan = None
    if planning:
        t0 = time.time()
        import folder_paths
        from .llm_nodes import storyboard
        cuts = [m for m, k in enumerate(filled) if board[k].get("cut") and n > 1]   # cut films: planned as open ends
        plan = storyboard(llm, [folder_paths.get_annotated_filepath(board[k]["image"]) for k in filled], loop,
                          llm.get("story"), cuts=cuts)
        dt = time.time() - t0
        if dt > 1.5:   # below: the plan came from the cache - no measurement
            timing.record("story_plan", 1000, 1000, len(filled), round(dt, 2), preset=model)
        _progress(node_id, phase="plan_done", seconds=round(dt, 1))

    out = []
    for k, i in enumerate(films):
        j = sb.next_of(n, i, loop)
        row = board[i]
        _progress(node_id, phase="prompt", k=k, i=i)
        t0 = time.time()
        # First -> Open (cut): the prompt is written from the start image alone as an OPEN shot (image_to None:
        # "no fixed last frame, one clear change"). The same image twice would read as a single-image loop.
        cut = bool(row.get("cut")) and n > 1
        try:
            context = ""
            if plan is not None and i in filled:
                from .llm_nodes import shot_context
                context = shot_context(plan, filled.index(i))
            text, _desc, _warning = generate(
                image(i), None if cut else image(j), cfg["model_name"], " ".join(row["prompt"].split()) if row["own"] else "",
                camera=cfg["camera"], instruction=cfg["instruction"], max_words=cfg["max_words"],
                seed=int(time.time()) % 2**31, load=cfg["load"], gen=cfg["gen"], context=context)
            out.append({"i": i, "prompt": text, "pair": [row["image"], "open" if cut else board[j]["image"]]})
            timing.record("prompt", 1000, 1000, 1, round(time.time() - t0, 2), preset=model)
        except Exception as e:  # noqa: BLE001 - one broken film must not stop the others
            out.append({"i": i, "error": str(e)})
        _progress(node_id, phase="prompt_done", k=k + 1, i=i, seconds=round(time.time() - t0, 1))
    _progress(node_id, phase="done")
    return out
