# Infinite Movie (ComfyUI)

<p align="center"><img src="assets/a4_nosun.gif" width="320" alt="Four seasons in one film: summer, autumn, winter, spring"></p>

<p align="center"><sub>Four stills, one LTX 2.5 render pass (737 frames, 24 fps), shown at 2x speed.</sub></p>

ComfyUI custom nodes that turn a sequence of stills into a (looping) film:
pairwise first/last-frame video segments (LTX 2.5 / Wan 2.2 FLF2V), stitched and finished.
Built for a single GPU that may be shared with a local LLM server (VRAM handoff before every render).

![Workflow: stills and prompts → render → assemble](assets/workflow.png)
<sub>Example workflow (four seasons): images + prompts → Infinite Movie · Director → Assemble.</sub>

## Engine

The video model is **always visible** in the workflow as an *engine group*:

```
Infinite Movie · Engine Start (from Director)  →  your model chain  →  Infinite Movie · Engine Result (to Director)
```

You build the model chain yourself between *Engine Start* and *Engine Result* (any loaders / samplers),
for example inside a group. The example workflow ships one engine group, **1 · Engine: LTX 2.5** (24 fps, 8n+1 frame grid),
at the top, above the row Settings → Images → Prompts → Director → Choose → Assemble. **Infinite Movie - Engine Wan 2.2** contains only the
**ENGINE: Wan 2.2** group (16 fps, 4n+1 frame grid) – copy it into your workflow and mute the LTX group. Other engines work the same way: build the chain between *Engine Start* and *Engine Result*.

- **Leave images out = mute them.** Select *Load Image* nodes and press Ctrl+M: the Director skips them, their Auto Prompts are muted too and keep their text (one image + `loop` = a shot that returns to its image; one image without `loop` = an open shot: start image + prompt, no end image). Unmute to get everything back.
- **Switching engines = muting groups.** If you build a second engine group, keep ONE active and mute the other (Ctrl+M).
  Muted nodes are excluded from the prompt, so the muted engine never runs.
- **Director · engine input is optional.** When connected, exactly that *Engine Result* is used.
  When unconnected, the single non-muted *Engine Result* in the workflow is used automatically.
  No engine group → clear error; several active groups without a connection → error listing the node IDs.
- The *Director* reads the engine from the graph (not from a preset). There are no hidden presets:
  what you see between *Engine Start* and *Engine Result* is what renders.

| Node | Purpose |
|---|---|
| **Infinite Movie · Director** | 1–12 images (dynamic inputs) + one prompt per transition → renders all segments. Length in seconds (snapped to the engine's frame grid, 8n+1 for LTX / 4n+1 for Wan). `variants` combo (`1`/`2`): with `2` each transition renders twice (A + B, see *Variants*). Outputs a `shots` pipe (SHOTS: segment paths, folder, name, fps, loop, variants, …) for one-connection wiring to Choose/Assemble. Outputs: `shots ▶ Assemble`, `settings ▶ chain`. Optional `engine` input (see *Engine* above). |
| **Infinite Movie · Engine Start (from Director)** | Left edge of an engine group. Outputs `start_image`, `end_image`, `prompt`, `seed`, `width`, `height`, `length` — the per-segment values the *Director* feeds into your model chain. |
| **Infinite Movie · Engine Result (to Director)** | Right edge of an engine group. Takes the decoded `images` (or `video`) from your chain plus `fps`, `length_grid` and optional `audio`, and hands the engine to the *Director* via its `engine` output. |
| **Infinite Movie · Prompt Style** | What the prompt model is told (system prompt, prefilled: *One sentence, max {words} words: what happens from the first to the last frame. Never mention images or frames.*) plus `max_words`, `camera` (dropdown, appended after the text; `none` = no camera sentence). Sits in the settings chain: Settings → Prompt Style → Auto Prompts. Overrides only these fields. |
| **Infinite Movie · Settings** | Shared settings for the whole chain in ONE node; its `settings ▶ chain` output is passed along: Settings → Prompt Style → Auto Prompts → Director → Assemble. Without it the built-in defaults apply. `prompt_model`: the **local vision model** that writes the shot prompts inside ComfyUI – any generating model in `models/text_encoders` (e.g. `qwen3vl_4b_bf16.safetensors`); `off` = write the prompts yourself. No LLM server, no provider, no API key. `aspect` (classic ratios: 4:5, 9:16, 2:3, 3:4, 1:1, 4:3, 3:2, 16:9, 21:9) + `long_side` (longest side): both sides are rounded to 32 (Lightricks LTX needs sides divisible by 32), the result shows next to `long_side` (4:5 + 960 = 768×960, the LTX template; 4:5 + 1344 = 1088×1344 ≈ Instagram 1080×1350); `output_folder` (**📂 Choose folder** opens a folder browser inside ComfyUI, folder names only, only from this computer; empty = next to the shots), `film_name` (empty = `film`). All fields are always shown. No negative prompt: both engines sample with CFG 1 (LTX distilled, Wan Lightning), where a negative prompt has no effect. **GPU check on Run:** before anything is queued, other LLMs on the GPU are unloaded (local llama.cpp router on :8080, Ollama, LM Studio via `lms`); if the GPU does not have enough free memory, nothing is queued and a message says which program holds it. After the film, ComfyUI frees its VRAM and wakes the local LLM again (fixed, no setting). |
| **Infinite Movie · Auto Prompt** | Writes the prompt for one transition with the local `prompt_model`: it looks at both images (start + end), follows the Prompt Style instruction and your keywords, then camera, particle rule and sky rule are appended. Type keywords into `prompt` and press **🔄 Regenerate prompt** – only this one node writes (about 20 s with Qwen3-VL 4B; the other Auto Prompts of the chain stay as they are), the result replaces the text and you can edit it; press again for a new version (the keywords are kept until you edit the text). Prompts are **never** written on Run: a filled `prompt` is used as is, an empty one asks first (*Render without prompt?*). The model is unloaded afterwards. Outputs: `prompt`, `settings ▶ chain`. |
| **Infinite Movie · Assemble** | Joins the shots into one film; `even_motion` evens out their motion (frames re-picked so each carries about the same change). `keep` = share of each shot's rendered length that stays: `1` (default) keeps the full length – where a shot stands still, the time is filled with repeated frames; `0` = auto: per shot as many frames as possible without repeats, the still parts are dropped and the film gets shorter; `0.05–0.95` = fixed share. Made for time-lapses, architecture and morphs between stills; not for real-time action, lip sync or music with a fixed length. Below the widgets a viewer shows the last run: **Graph** (timing per shot), **Timeline** (change per frame; grey = dropped, green = used, orange = duplicate), **Heatmap** (where the picture changes) and **Frames** (slider through the used frames – all up to 64, above that every x-th –, ▶ play, onion skin with 3 ghosts), **Particles** (detected image points tracked through the shot draw glowing trails with sparks; sliders for frame and trail length; small motion is magnified around each spark, the factor is shown) and **Sheet** (contact sheet of the used frames, grid 3×3 … 8×8 by slider; click a tile to open it in Frames). The viewer is square with a fixed height, so portrait and landscape films fit without the node jumping. `interpolate` defaults to **RIFE x2** (needs *ComfyUI-Frame-Interpolation*): twice the frames to pick from, so evening out leaves fewer duplicate frames; `off` is faster. Takes the `shots` pipe (one connection) or a film via `video`/`images`/`video_path`/`file`. `output_size`: `as rendered`, `Instagram 4:5 1080×1350`, `Reel 9:16 1080×1920` or `2× rendered` (scaled + centre-cropped, H.264 yuv420p, faststart). Sound from the engine (LTX) is carried into the film – only without `even_motion` (it changes the timing, so the film stays silent then). The film mp4 contains the prompt and the workflow (drag it onto ComfyUI to load it). Outputs: `video_path`, `video`. Runs only when you press **ASSEMBLE** in *Choose* (not on Run). Folder and name come from Settings. |
| **Infinite Movie · Choose** | Shows every shot (one column per transition, variant **A** above **B** when `variants` = 2). **Hover** plays a shot. **Click** a variant to use it (green frame + **✓ A**/**✓ B** badge, the other one is dimmed); click the chosen one again to reject it (**✗**) – reject both and the shot is marked **✗ REDO**. Without variants, a click toggles KEEP/REDO; the big **✓ KEEP / ✗ REDO** switch under each shot does the same. Below every tile the check result in plain words and colour: green *✓ smooth*, yellow *△ slight flicker / frozen particles*, red *⚠ HARD CUT / HARD JUMP* (jerk ≥ 7); red *⚠ HARD SEAM → next* when the last frame of a shot does not match the first frame of the next one. An **AUTO** pick is only made on a strong indication (one variant clearly bad, the other clearly better); otherwise A stays and the choice is yours. Status line with the steps **1 Prompts › 2 Run › 3 Pick › 4 ASSEMBLE** and a **progress bar with remaining time** while rendering. **✎ prompt** under a shot opens its prompt: edit it, save, and the shot is marked REDO – RERENDER renders only this shot with the new prompt. **⏱ 2 s** sets the length of this shot (or back to the global `seconds`); it is stored in the Director (hidden field `shot_seconds`), marks the shot REDO and RERENDER renders only this shot. Output: `shots`. The big button: **ASSEMBLE ▶** builds the film from your picks (Director + Choose come from cache, seeds stay fixed), **RERENDER n ↻** re-renders only the marked shots with new seeds (unchanged shots are reused, not rendered again). |
| **Infinite Movie · Film** | Shows the finished film (looping preview) and confirms where it was saved. Takes the `video` (VIDEO, priority 1) or the `video_path` string (e.g. Assemble → `video_path`). Remembers the last three films: **new / -1 / -2** switch the preview. No outputs. |

Nodes marked *(internal)* are used by the engine groups and are not meant to be placed by hand: Infinite Movie · Frames Collect (internal), Infinite Movie · Segment Paths (internal), Infinite Movie · Segment Save (internal), Infinite Movie · Shots Out (internal).

## Choose, variants and Assemble

The *Director* has a `variants` combo (`1` or `2`, default `1`). With `2`, every transition is rendered **twice**:

- **A** — the usual seed, saved as `seg_XXX.mp4`.
- **B** — seed A + 500, saved as `seg_XXX_b.mp4`.

Both are separate renders (separate keys), so the *Director* blocks until all of them finish. The `shots`
pipe then carries a `variants` list (`[[a_path, b_path], …]`); `segments` stays the A list. With `1` nothing changes.

The *Choose* node sits between the *Director* and the *Assemble* (already wired in the example workflow; it also works with `variants` = 1 – one tile per shot):

```
Director  →  Infinite Movie · Choose  →  Assemble
```

![Choose: one tile per shot, quality line, KEEP / REDO](assets/choose.png)

**Run** renders the shots and stops at *Choose* – the film is not built yet. Pick per shot (or reject
shots and press **RERENDER**), then press **ASSEMBLE**: only *Assemble* runs, with your picks. The *Choose*
node checks each variant (cheap CUT/FLICKER/PARTICLES level + a jerk metric) and pre-selects the other
variant only when one is clearly bad. Changing only the choice never re-renders. A new Run (new seed)
renders all shots again; RERENDER re-seeds only the marked shots and reuses the others unchanged.
**Cancel** removes the half-finished film from *Assemble*/*Film*/*Choose*.

## Upscale

The main workflow has the same chain as group **8 · Upscale (optional)** right after *Assemble* – muted by default. Select the group and press **Ctrl+M** to turn it on: **ASSEMBLE** then also renders the upscaled film (input = *Assemble* › `video_path`, with the film's sound) and shows it in its own *Film* node. The result lands next to the film as `<name>_upscale.mp4`.


`example_workflows/Infinite Movie - LTX Upscale.json` — the same two stages as a separate workflow for any film:

```
VHS Load Video  →  Upscale Crop Universal (video upscale model, ×1.3334, multiple of 64)  →  Infinite Movie · LTX Refine (1:1)
```

| Node | Purpose |
|---|---|
| **Infinite Movie · LTX Refine** | Re-renders a film of any length with LTX 2.5 in overlapping chunks (default 49 frames, 17 overlap, crossfaded), so it fits in VRAM. Mode `refine 1:1` (default): partial denoise at the same size to bring back detail on top of a soft upscale; mode `ic-lora upscale x2` (optional, needs the IC-LoRA pixel upscaler). Seamless loops (`loop`), size modes as in Upscale Crop Universal, saves the film itself (H.264), keeps the source audio. With `video_path` connected it saves next to that file as `<name>_upscale.mp4`, otherwise under `filename_prefix`. Frees the GPU (VRAM handoff) before it starts. |

- Prompt `photographic, 4k`, negative empty. Sigmas `0.421875, 0.0` — higher values soften and flicker more.
- Base upscale model: [2x-LiveActionV1-SPAN](https://openmodeldb.info/models/2x-LiveActionV1-SPAN) by jcj83429 (CC-BY-NC-SA-4.0) – [download `2xLiveActionV1_SPAN_490000.pth`](https://raw.githubusercontent.com/jcj83429/upscaling/f73a3a02874360ec6ced18f8bdd8e43b5d7bba57/2xLiveActionV1_SPAN/2xLiveActionV1_SPAN_490000.pth) (9 MB) into `models/upscale_models/`.
- Upscale Crop Universal is shipped in `upscale_universal/`.
- **Silent films:** VHS Load Video fails as soon as its `audio` output is used on a film without sound.
  `python tools/patch_vhs_silent_audio.py` patches VideoHelperSuite to return silence instead (re-run after VHS updates,
  `--check` to test).

Requires ComfyUI with the V3 node API and **ffmpeg**: either `imageio-ffmpeg` (`pip install imageio-ffmpeg`, comes with
[VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite)) or an ffmpeg on PATH
([Windows builds](https://www.gyan.dev/ffmpeg/builds/), [ffmpeg.org](https://ffmpeg.org/download.html)).
RIFE via [ComfyUI-Frame-Interpolation](https://github.com/Fannovel16/ComfyUI-Frame-Interpolation) (optional).

Install: clone into `ComfyUI/custom_nodes/` and restart ComfyUI.

Example workflows live in `example_workflows/`; each carries a README note (top left) with the model links.
