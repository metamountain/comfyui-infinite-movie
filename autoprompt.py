"""Infinite Movie · Auto Prompt (2026-11-03, user: "choose a local model, via Python instead of a provider").

The prompt is written INSIDE ComfyUI with a local vision model from models/text_encoders
(selection in Settings › prompt_model, e.g. qwen3vl_4b_bf16.safetensors). No LLM server, no
provider, no API keys. Loading/generation like the core node "Generate Text"
(comfy_extras/nodes_textgen.py: clip.tokenize(..., image=, system_prompt=) → clip.generate → clip.decode).

  1. describe: the model describes START and END (both images) as JSON (for the particle rule).
  2. story:    from both images + keywords it writes the transition (instruction from Prompt Style).
Then compose() appends the fixed parts: particle rule, camera (dropdown). (sky_rule removed 2026-11-04.)
No sound sentence (user 2026-11-04: "LTX is as dumb as straw, these prompts only add ballast") – LTX generates the sound itself.

Frontend flow: Regenerate queues ONLY this node (partial execution, hence is_output_node);
the result comes back as ui text and lands in the prompt field. A filled prompt field is
used 1:1; an empty one is generated during the run. After generation the model is unloaded.
"""

from __future__ import annotations

import json
import re
import time

from comfy_api.latest import io, ui

from .post_nodes import _clean_prompt
# Settings: lazy import in the methods (.settings_nodes imports .autoprompt lazily – avoid a cycle).

PARTICLES = ("snow", "rain", "leaves", "petals", "sparks", "dust", "confetti")

DESCRIBE_SYSTEM = (
    "You describe two frames of one short video shot: image 1 = start, image 2 = end. Answer ONLY with JSON:\n"
    '{"start": {"subject": "", "setting": "", "action": "", "framing": "", "light": "", "style": "", '
    '"falling": ""}, "end": {...same keys...}}\n'
    "subject: who/what is in focus (characters, objects, buildings) with look and colours. setting: place, "
    "season, weather, ground, vegetation. action: pose or what is happening. framing: shot size and angle. "
    "light: direction, warmth, time of day. style: photo, 3D, cartoon, painting... "
    "falling: one of none, " + ", ".join(PARTICLES) + " - only if particles are visibly in the air. "
    "Short precise phrases, English."
)

# user 2026-11-03: "short wins" - {words} = max_words; camera comes from the dropdown and is appended by compose()
STORY_SYSTEM = "One sentence, max {words} words: what happens from the first to the last frame. Never mention images or frames."

# user 2026-10-26: camera as a selection; "none" = no camera note in the prompt (2026-11-04 instead of "auto")
CAMERA_OPTIONS = [
    "none",
    "Static camera, locked-off tripod shot.",   # user 2026-11-11: no negations
    "Static camera.",
    "Slow push in.",
    "Slow pull out.",
    "Slow pan left.",
    "Slow pan right.",
    "Slow tilt up.",
    "Slow tilt down.",
    "Slow orbit around the subject.",
    "Tracking shot following the subject.",
    "Handheld camera, slight natural shake.",
    "Aerial drone shot, slowly rising.",
    "Dynamic camera following the action.",
]
MAX_STORY_WORDS = 12  # user 2026-11-04: 12 words, one sentence
NOUN = {"snow": "snowflakes", "rain": "raindrops", "leaves": "leaves", "petals": "petals",
        "sparks": "sparks", "dust": "dust", "confetti": "confetti"}


def _falling(obs: dict, key: str) -> str:
    v = str((obs.get(key) or {}).get("falling", "none")).lower().strip()
    return v if v in PARTICLES else "none"


def particle_rule(obs: dict) -> tuple[str, str]:
    """(Sentence for the prompt, warning) from start/end.falling."""
    s, e = _falling(obs, "start"), _falling(obs, "end")
    if e != "none":
        return (f"The {NOUN[e]} keep falling steadily.",   # user 2026-11-11: never negative phrasing in prompts
                f"WARNING: END image shows {e} in the air - frozen particles likely. "
                f"Use an END image without {e} in the air.")
    if s != "none":
        return (f"The {NOUN[s]} stop early.", "")
    return "", ""


def trim_words(text: str, limit: int = MAX_STORY_WORDS) -> str:
    """Trim to whole sentences up to `limit` words (at least the first sentence stays)."""
    out, n = [], 0
    for x in re.split(r"(?<=[.!?])\s+", text.strip()):
        w = len(x.split())
        if out and n + w > limit:
            break
        out.append(x)
        n += w
    return " ".join(out)


def _sentence(text: str) -> str:
    text = " ".join((text or "").split()).strip(" .")
    return text[0].upper() + text[1:] + "." if text else ""


def compose(story: str, obs: dict, camera: str,
            max_words: int = MAX_STORY_WORDS) -> tuple[str, str]:
    """Append the fixed parts (pure, testable). Order: story, particles, camera."""
    text = _clean_prompt(story)
    text = re.split(r"(?<=[.!?])\s+", text.strip())[0] if text.strip() else text  # user 2026-11-04: only 1 sentence
    text = trim_words(text, max_words)
    rule, warning = particle_rule(obs)
    cam = "" if (camera or "").strip().lower() in ("", "none") else camera
    parts = [_sentence(text), rule, _sentence(cam)]
    return " ".join(p for p in parts if p), warning


def parse_obs(text: str) -> dict:
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    m = re.search(r"\{.*\}", text, flags=re.S)
    if not m:
        return {}
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return {}


# user 2026-11-03: only models that can GENERATE TEXT. The LTX-Gemma encoder
# (gemma4-…-ltx-…-int8-convrot) only produces gibberish letters when generating (test 2026-11-03), pure
# encoders (umt5, clip, llava-fp8, MiniMax-H3-Qwen3-VL without lm_head, truncated to 50 layers) cannot generate at all; partial files (…-00001-of-00005) not loadable.
# "it" = instruct; boundaries without \b because Comfy file names use underscores (gemma4_e4b_it_fp8_scaled).
PROMPT_MODEL_RE = re.compile(r"(qwen3[._-]?vl|qwen3[._-]?5|gemma[-_]?[34](?:.*[^a-z0-9])?it(?:[^a-z0-9]|$))", re.I)
PROMPT_MODEL_SKIP_RE = re.compile(r"(ltx|minimax|with[-_]proj|-of-\d+)", re.I)


def prompt_models(names=None) -> list[str]:
    """Selection for Settings › prompt_model: 'off' + matching files from models/text_encoders."""
    if names is None:
        try:
            import folder_paths
            names = folder_paths.get_filename_list("text_encoders")
        except Exception:  # noqa: BLE001 – without ComfyUI (unit tests)
            names = []
    found = [n for n in names if n.lower().endswith((".safetensors", ".sft"))
             and PROMPT_MODEL_RE.search(n) and not PROMPT_MODEL_SKIP_RE.search(n)]
    return ["off"] + sorted(found, key=str.lower)


def default_prompt_model() -> str:
    m = prompt_models()
    return m[1] if len(m) > 1 else "off"


def _load_model(name: str):
    import comfy.sd
    import folder_paths
    path = folder_paths.get_full_path_or_raise("text_encoders", name)
    # STABLE_DIFFUSION = the type is detected from the weights (sd.py: generic Qwen3-VL/Gemma branch).
    return comfy.sd.load_clip(ckpt_paths=[path], embedding_directory=folder_paths.get_folder_paths("embeddings"),
                              clip_type=comfy.sd.CLIPType.STABLE_DIFFUSION)


def _unload_model():
    try:
        import comfy.model_management as mm
        mm.unload_all_models()
        mm.soft_empty_cache()
    except Exception as e:  # noqa: BLE001
        print(f"[InfiniteMovieAutoPrompt] unload: {e}")


def _gen(clip, text: str, images, system: str, max_length: int, temperature: float, seed: int) -> str:
    """Like comfy_extras/nodes_textgen.py TextGenerate.execute (without the node wrapper)."""
    tokens = clip.tokenize(text, image=images, min_length=1, system_prompt=system)
    ids = clip.generate(tokens, do_sample=True, max_length=max_length, temperature=temperature,
                        top_k=64, top_p=0.95, min_p=0.05, repetition_penalty=1.05, seed=seed)
    out = clip.decode(ids)
    _, sep, rest = out.partition("</think>")
    return (rest if sep else out).strip()


def _pair(image_from, image_to):
    """Both images as ONE batch (image 1 = start, image 2 = end); end resized to the start's size."""
    import torch
    import comfy.utils
    a, b = image_from[:1], image_to[:1]
    if a.shape[1:3] != b.shape[1:3]:
        b = comfy.utils.common_upscale(b.movedim(-1, 1), a.shape[2], a.shape[1], "bilinear", "center").movedim(1, -1)
    return torch.cat([a, b], dim=0)


def _same_image(image_from, image_to) -> bool:
    """True if start and end are the same image (single-image loop)."""
    if image_from is None or image_to is None:
        return False
    if image_from is image_to:
        return True
    try:
        import torch
        a, b = image_from[:1], image_to[:1]
        return a.shape == b.shape and bool(torch.equal(a, b))
    except Exception:  # noqa: BLE001
        return False


def generate(image_from, image_to, model_name: str, keywords: str = "", camera: str = "none",
             instruction: str = STORY_SYSTEM,
             max_words: int = MAX_STORY_WORDS, seed: int = 0, load=None, gen=None, context: str = ""):
    """Describe -> transition -> fixed parts. Returns (prompt, description, warning).
    load/gen are swappable for tests (without GPU)."""
    load = load or _load_model
    gen = gen or _gen
    open_shot = image_to is None                  # 1 image without loop: open shot, no end image
    if open_shot:
        image_to = image_from                     # description: start = end (scene of the single image)
    images = _pair(image_from, image_to) if (gen is _gen or getattr(gen, "needs_images", False)) else None
    hint = f"\nKeywords: {keywords.strip()}" if keywords and keywords.strip() else ""
    frames = "Image 1 is the first frame and image 2 the last frame of one video shot."
    story_frames, story_images = frames, images
    if open_shot:
        story_frames = ("This image is the first frame of one video shot; the shot has no fixed last frame. Invent "
                        "one clear, visible change that happens after this moment (follow the instructions). Never "
                        "say that nothing happens, nothing changes or the scene stays still.")
        story_images = images[:1] if images is not None else None
    elif _same_image(image_from, image_to):
        # single-image loop (user 2026-11-04: "No time-lapse occurs; the two frames are identical" /
        # "A single, unchanging moment of stillness repeats endlessly"): two identical images read to small models
        # as "nothing happens". So for the story only ONE image + an explicit loop instruction.
        story_frames = ("This image is the first AND the last frame of one looping video shot. Invent one clear, "
                        "visible change that happens in between and returns to exactly this frame at the end "
                        "(follow the instructions). Never say that nothing happens, nothing changes or the scene "
                        "stays still.")
        story_images = images[:1] if images is not None else None
    clip = load(model_name)
    try:
        obs = parse_obs(gen(clip, frames + "\nJSON:", images, DESCRIBE_SYSTEM, 450, 0.2, seed))
        system = (instruction or STORY_SYSTEM).replace("{words}", str(max_words))
        story = gen(clip, story_frames + (context or "") + hint, story_images, system, 160, 0.7, seed)
    finally:
        del clip
        _unload_model()
    if not _clean_prompt(story):
        raise ValueError(f"Auto Prompt: the model '{model_name}' returned an empty prompt")
    text, warning = compose(story, obs, camera, max_words)
    desc = json.dumps(obs, ensure_ascii=False, indent=1) + (f"\n{warning}" if warning else "")
    print(f"[InfiniteMovieAutoPrompt] {model_name}: {text}" + (f"\n[InfiniteMovieAutoPrompt] {warning}" if warning else ""))
    return text, desc, warning


class InfiniteMovieAutoPromptV2(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        from .settings_nodes import SETTINGS
        return io.Schema(
            node_id="InfiniteMovieAutoPrompt",
            display_name="Infinite Movie · Auto Prompt",
            search_aliases=["infinite movie", "infinite_movie", "film", "movie", "video", "ltx", "wan", "prompt"],
            category="Infinite Movie/1 Prompt",
            description="Writes the prompt for one transition (image_from → image_to) with the local prompt model "
                        "chosen in Settings – only when you press Regenerate (never on Run). A filled `prompt` is "
                        "used as is; an empty one stays empty.",
            inputs=[
                # All sockets optional: the frontend sets required BEFORE optional – this keeps settings on top.
                SETTINGS.Input("settings", optional=True, display_name="settings",
                               tooltip="Settings chain (prompt model from Settings, style from Prompt Style)."),
                io.Image.Input("image_from", optional=True, tooltip="Start image of the transition."),
                io.Image.Input("image_to", optional=True, tooltip="End image of the transition."),
                io.String.Input("prompt", multiline=True, default="",
                                tooltip="The prompt for this shot, used as is. Or type a few keywords and press "
                                        "Regenerate: the model writes the prompt from both images and replaces this text."),
                # Keywords for Regenerate (set by the frontend, hidden in the node).
                io.String.Input("keywords", default="", advanced=True,
                                tooltip="Keywords for the next generation (set by the Regenerate button)."),
                # Regenerate instruction (set by the frontend, hidden in the node): only then is it generated.
                io.String.Input("regen", default="", advanced=True, optional=True,
                                tooltip="Set by the Regenerate button for one run; empty = never generate."),
            ],
            outputs=[
                # 73: only prompt + settings-chain left (descriptions output removed;
                # the model text stays internal in generate(), no longer output).
                io.String.Output("prompt", tooltip="The final prompt → Director `prompt …`."),
                SETTINGS.Output("settings", display_name="settings ▶ chain",
                                tooltip="The incoming settings, passed on to the next node of the chain."),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.prompt],
            is_output_node=True,
        )

    @classmethod
    def fingerprint_inputs(cls, prompt="", regen="", **kwargs):
        # Regenerate sets a new value every time -> regenerate, even with the same keywords.
        return str(prompt) if str(prompt or "").strip() else f"regen:{regen}"

    @classmethod
    def execute(cls, image_from=None, image_to=None, prompt="", keywords="", regen="", settings=None):
        from .settings_nodes import chain_settings, get_setting
        out_settings = chain_settings(settings)
        if prompt and prompt.strip():
            text = " ".join(prompt.split())
            return io.NodeOutput(text, out_settings, ui=ui.PreviewText(text))
        model_name = get_setting(settings, "prompt_model")
        llm = get_setting(settings, "llm")   # 2026-11-11: Infinite Movie · LLM in the chain -> external server
        use_llm = isinstance(llm, dict) and bool(str(llm.get("endpoint") or "").strip())
        # 72 (user 2026-11-03): only generate on Regenerate, never on Run (also not the upstream
        # Auto Prompts of the settings chain that run along with Regenerate).
        if not str(regen or "").strip() or (not use_llm and (not model_name or model_name == "off")):
            return io.NodeOutput("", out_settings, ui=ui.PreviewText(""))
        if image_from is None:
            raise ValueError("Auto Prompt: connect image_from (and image_to, except for an open shot) "
                             "or write the prompt yourself.")
        instruction = get_setting(settings, "instruction")
        load = gen = None
        context = ""
        if use_llm:
            from .llm_nodes import llm_gen, llm_label
            model_name = llm_label(llm)
            load, gen = (lambda _name: llm), llm_gen
            instruction = str(get_setting(settings, "llm_instruction") or "").strip() or instruction
            from .llm_nodes import film_images, red_thread, shot_context, shot_of, storyboard
            instruction = red_thread(instruction, llm.get("story"))
            if llm.get("story_mode"):
                hid = getattr(cls, "hidden", None)
                api_prompt, uid = getattr(hid, "prompt", None), getattr(hid, "unique_id", None)
                director, k = shot_of(api_prompt, uid)
                files, loop = film_images(api_prompt, director) if director else ([], True)
                if k >= 0 and len(files) >= 2:
                    context = shot_context(storyboard(llm, files, loop, llm.get("story")), k)
                else:
                    print("[InfiniteMovieAutoPrompt] story mode: film images not found (Load Image nodes at the "
                          "Director) - writing this shot from its pair only.")
        # 73: descriptions is no longer output (generate still returns (text, desc, warning)).
        text, _desc, _warning = generate(
            image_from, image_to, model_name, keywords,
            camera=get_setting(settings, "camera"),
            instruction=instruction,
            max_words=int(get_setting(settings, "max_words")), seed=int(time.time()) % 2**31,
            load=load, gen=gen, context=context)
        return io.NodeOutput(text, out_settings, ui=ui.PreviewText(text))


AUTOPROMPT_NODE_LIST = [InfiniteMovieAutoPromptV2]
