"""124b: the Director writes the prompts for selected shots (no render, no GPU).

Since 124c the storyboard (the Director's ``storyboard`` widget, a JSON list of
``{"image", "prompt", "own", "pair"}``) holds one prompt per shot. When the user
presses Regenerate in the storyboard, the frontend sets the Director's ``regen``
widget to a JSON list of 0-based shot indices (e.g. ``"[0, 2]"``) and queues ONLY
the Director. The Director then writes the prompts for exactly those shots (from
their image pairs, with the LLM settings from the chain) and renders nothing.
The result goes back to the frontend as ``ui["im_prompts"]``.

Like storyboard.py this module must stay importable without a running ComfyUI
server (the unit tests run headless), so folder_paths / the LLM / the prompt
model / the settings are imported inside the functions that need them.
"""
from __future__ import annotations

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


def write_prompts(board, indices, loop, settings) -> list[dict]:
    """Write the prompts for the listed shots ONLY (no render, no GPU).

    ``board`` = the shot list from storyboard.parse; ``indices`` = 0-based shot
    indices (from the Director's ``regen`` widget, e.g. ``[0, 2]``). For shot i
    the pair is image i -> image i+1 (with ``loop``: the last shot -> image 0;
    without loop the last shot has no film and is skipped). A shot (or its
    partner) without an image is skipped. A shot whose generation fails becomes
    ``{"i": i, "error": ...}``; the other shots still run.
    """
    from . import storyboard as _sb
    from .autoprompt import generate

    cfg = prompt_config(settings)
    llm = cfg["llm"]
    story_on = isinstance(llm, dict) and bool(llm.get("story_mode"))

    # Loaded image per shot index (shots without an image stay absent).
    with_image = [i for i, s in enumerate(board) if str(s.get("image") or "").strip()]
    try:
        images = _sb.load_images(board)
        img_by_shot = dict(zip(with_image, images))
    except ValueError:
        # A missing file must not kill the whole run: load shot by shot, the broken
        # ones stay absent and are skipped below.
        img_by_shot = {}
        for i in with_image:
            try:
                img_by_shot[i] = _sb.load_images([board[i]])[0]
            except ValueError:
                pass

    # Story mode: one plan for the whole film (arc + a beat per shot with an image),
    # then each shot gets its own beat (k = its position among the shots with an image).
    sb = None
    if story_on and len(with_image) >= 2:
        import folder_paths
        from .llm_nodes import storyboard
        files = [folder_paths.get_annotated_filepath(str(board[i]["image"]).strip()) for i in with_image]
        sb = storyboard(llm, files, loop, llm.get("story"))

    out = []
    n = len(board)
    for i in indices:
        try:
            i = int(i)
        except (TypeError, ValueError):
            continue
        if not (0 <= i < n):
            continue
        j = i + 1 if i < n - 1 else (0 if loop else None)
        if j is None:
            continue  # without loop the last shot has no film
        a, b = img_by_shot.get(i), img_by_shot.get(j)
        if a is None or b is None:
            continue  # missing image in the pair -> skip
        shot = board[i]
        keywords = " ".join(str(shot.get("prompt") or "").split()) if shot.get("own") else ""
        context = ""
        if sb is not None:   # a has an image, so i is in with_image
            from .llm_nodes import shot_context
            context = shot_context(sb, with_image.index(i))
        try:
            text, _desc, _warning = generate(
                a, b, cfg["model_name"], keywords,
                camera=cfg["camera"], instruction=cfg["instruction"],
                max_words=cfg["max_words"], seed=int(time.time()) % 2**31,
                load=cfg["load"], gen=cfg["gen"], context=context)
            out.append({"i": i, "prompt": text, "pair": [shot["image"], board[j]["image"]]})
        except Exception as e:  # noqa: BLE001 - one broken shot must not kill the rest
            out.append({"i": i, "error": str(e)})
    return out
