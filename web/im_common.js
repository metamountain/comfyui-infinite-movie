import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { fcChooseRender } from "./im_cut.js";
import { fcFilmRender } from "./im_film.js";
import { imToggleWidget } from "./im_settings.js";
// InfiniteMovieRender: labels for the Autogrow slots ("image 1", "prompt 1 -> 2", loop: last "-> 1").
// Nutzer 2026-10-26. The slots are NOT reordered any more: reordering node.inputs broke the
// links on loadApiJson and on page reload (prompts silently on the wrong transition).

// Slider tooltips (user 2026-11-13: "tooltips bei slidern nicht im slide bereich"): the canvas tooltip sits
// 5 px above the cursor and covers the slider while dragging. Over a slider, lift it above the widget's top edge.
{
  const st = document.createElement("style");
  st.textContent = "body.imv-slider-tip .node-tooltip { transform: translate(5px, calc(-100% - 6px - var(--imv-tip-dy, 0px))) !important; }";
  document.head.appendChild(st);
  window.addEventListener("mousemove", () => {
    const c = app.canvas, n = c?.node_over;
    const w = n && !n.flags?.collapsed ? c.getWidgetAtCursor?.() : null;
    const on = !!w && (w.type === "slider" || w.options?.display === "slider") && w.last_y != null;
    document.body.classList.toggle("imv-slider-tip", on);
    if (on) {
      // + canvas top: the tooltip's parent starts there, but its top is the page-relative canvas.mouse
      const dy = (c.graph_mouse[1] - (n.pos[1] + w.last_y)) * (c.ds?.scale || 1) + c.canvas.getBoundingClientRect().top;
      document.body.style.setProperty("--imv-tip-dy", `${Math.max(0, dy)}px`);
    }
  }, { passive: true });
}

export const IMG = "images.image";
export const PR = "shot_prompts.prompt";
// 74: GPU pre-check – min_free_mb is a constant (Python: MIN_FREE_MB), GPU handover fixed.
const MIN_FREE_MB = 20000;

export function slotKey(name) {
  if (name?.startsWith(IMG)) return [parseInt(name.slice(IMG.length), 10), 0];
  if (name?.startsWith(PR)) return [parseInt(name.slice(PR.length), 10), 1];
  return null;
}

// Muted/bypassed LoadImage nodes do not count towards the chain (user 2026-11-04: "only 1 of 7 images
// used"): Ctrl+M on an image removes it from the film, its Auto Prompts get muted along with it and
// keep their text; un-muting restores everything.
export const fcActive = (n) => (n?.mode ?? 0) === 0;

// 2026-11-08 (user: „input images not working if wired via preview image or upscale universal“): the image source of the
// chain is EVERY node connected via an IMAGE output (Load Image, Upscale Crop Universal,
// Assemble › last_frame …), not just LoadImage. Order by the root of the image chain (first node without
// IMAGE input, usually the Load Image) – this keeps the old order "Load Image id ascending".
export const fcImgLink = (g, l) => !!l && (l.type === "IMAGE"
  || g.getNodeById(l.origin_id)?.outputs?.[l.origin_slot]?.type === "IMAGE");
export function fcImgRoot(g, n, depth = 0) {
  const inp = (n?.inputs || []).find((i) => i.type === "IMAGE" && i.link != null);
  if (!inp || depth > 20) return n;
  const l = getLink(g, inp.link);
  const o = l && g.getNodeById(l.origin_id);
  return o ? fcImgRoot(g, o, depth + 1) : n;
}
// 2026-11-11 (user: "insert an image later / swap images"): sort key = root.properties.im_order (saved with the
// workflow), fallback the root id. ▲▼ swap two keys, ➕ insert gives the new image a key between its neighbours.
export function fcOrderKey(g, n) {
  const r = fcImgRoot(g, n);
  const k = r?.properties?.im_order;
  // node ids are strings in the current frontend ("70") – always compare numbers
  return k != null && Number.isFinite(Number(k)) ? Number(k) : Number(r.id);
}
export const fcImgOrder = (g) => (a, b) => (fcOrderKey(g, a) - fcOrderKey(g, b)) || (a.id - b.id);
// Image source active = itself and the root of its image chain not muted/bypassed
export const fcImgActive = (g, n) => fcActive(n) && fcActive(fcImgRoot(g, n));

export function getLink(graph, id) {
  const links = graph?.links;
  if (!links) return null;
  return typeof links.get === "function" ? links.get(id) : links[id];
}

// 82: per-shot seconds – Director-Widget 'shot_seconds' parsen
// ("2, 3,,4" -> [2, 3, 0, 4]; empty/invalid -> 0 = global 'seconds').
export function fcParseShotSeconds(text) {
  if (text == null) return [];
  const out = [];
  for (const part of String(text).split(",")) {
    const p = part.trim();
    if (!p) { out.push(0); continue; }
    const v = parseFloat(p);
    out.push(isNaN(v) ? 0 : v);
  }
  while (out.length && out[out.length - 1] === 0) out.pop();
  return out;
}

// 82: current length of a shot (1-based): entry in 'shot_seconds' or global 'seconds'.
export function fcShotSecondsOf(director, shotNumber) {
  const g = parseFloat(director?.widgets?.find((w) => w.name === "seconds")?.value);
  const global = isNaN(g) || g <= 0 ? 1 : g;
  const entry = fcParseShotSeconds(director?.widgets?.find((w) => w.name === "shot_seconds")?.value)[shotNumber - 1];
  return entry > 0 ? entry : global;
}

export function interleave(node) {
  const slots = (node.inputs || []).filter((inp) => slotKey(inp.name));
  // last wired image loops back to image 1 when "loop" is on
  const nImg = slots.filter((inp) => slotKey(inp.name)[1] === 0 && inp.link != null).length;
  const loop = node.widgets?.find((w) => w.name === "loop")?.value;
  // 82: per-shot seconds from the 'shot_seconds' widget (instead of scene_seconds.*)
  const shotSecs = fcParseShotSeconds(node.widgets?.find((w) => w.name === "shot_seconds")?.value);
  for (const inp of slots) {
    const [i, kind] = slotKey(inp.name);
    const to = loop && nImg > 1 && i + 1 >= nImg ? 1 : i + 2;
    let label = kind === 0 ? `image ${i + 1}` : `prompt ${i + 1} → ${to}`;
    // Append per-shot seconds if set
    if (kind === 1 && shotSecs[i] > 0) {
      label += ` (${shotSecs[i].toFixed(1)}s)`;
    }
    inp.label = label;
  }
  node.setDirtyCanvas?.(true, true);
}

// Auto Prompt · Regenerate (2026-11-03): the prompt is created IN ComfyUI with the local model from
// Settings › prompt_model (autoprompt.py). The button queues ONLY this node (partial execution:
// app.queuePrompt(0, 1, [id]) → partial_execution_targets; the node is therefore an output node).
// The result comes back as ui text (onExecuted) and lands in the prompt field.
// Keywords: the text in the field at the FIRST Regenerate (prompt_hint); further regenerates take them
// again, until the user changes the text by hand.

// Walk the settings chain backwards (… → Prompt Style → Settings, also through reroutes).
function settingsChainOf(node) {
  const res = { settings: null, style: null };
  let n = node, guard = 0;
  while (n && guard++ < 60) {
    const inp = n.comfyClass === "Reroute" ? n.inputs?.[0] : n.inputs?.find((i) => i.name === "settings");
    if (inp?.link == null) break;
    n = n.graph?.getNodeById(getLink(n.graph, inp.link)?.origin_id);
    if (!n) break;
    if (n.comfyClass === "InfiniteMovieStyle" && !res.style) res.style = n;
    if (n.comfyClass === "InfiniteMovieSettings") { res.settings = n; break; }
  }
  return res;
}

export function settingsNodeOf(node) {
  return settingsChainOf(node).settings;
}

// 2026-11-11: Story Mode (LLM) plugged into Settings › "LLM" (input name "llm"), active = not bypassed/muted.
export function storyModeOf(settingsNode) {
  const inp = settingsNode?.inputs?.find((i) => i.name === "llm");
  if (inp?.link == null) return null;
  const src = settingsNode.graph?.getNodeById(getLink(settingsNode.graph, inp.link)?.origin_id);
  return src && (src.mode ?? 0) === 0 ? src : null;
}

export const IM_REGEN = "🔄 Regenerate prompt";

export function addRegenerateButton(node) {
  const btn = node.addWidget("button", IM_REGEN, null, async () => {
    const promptW = node.widgets?.find((w) => w.name === "prompt");
    const kwW = node.widgets?.find((w) => w.name === "keywords");
    if (!promptW || !kwW) return;
    const sNode = settingsNodeOf(node);
    const model = sNode?.widgets?.find((w) => w.name === "prompt_model")?.value;
    if (model === "off" && !storyModeOf(sNode)) {
      btn.name = "⚠ choose a prompt_model in Settings";
      node.setDirtyCanvas(true, true);
      return;
    }
    node.properties = node.properties || {};
    const cur = String(promptW.value ?? "").trim();
    // 2026-11-04 (user: „autoprompt writing dumb stuff“): a text written by the model is not a keyword –
    // otherwise the model just copies itself at the next Regenerate. _fcRegenWrote is lost on reload
    // is lost, hence additionally properties.im_last_generated (saved with the workflow).
    const gen = node.properties.im_last_generated;
    if (gen && node.properties.prompt_hint === gen) node.properties.prompt_hint = null;
    if (cur && !node.properties.prompt_hint && cur !== gen && cur !== node._fcRegenWrote) node.properties.prompt_hint = cur;
    kwW.value = node.properties.prompt_hint ?? "";
    node._fcRegenWrote = "";
    promptW.value = "";   // empty + regen = the node generates anew
    const regenW = node.widgets?.find((w) => w.name === "regen");
    if (regenW) regenW.value = String(Date.now());   // only THIS node generates
    btn.name = "⏳ generating ...";
    node.setDirtyCanvas(true, true);
    try {
      await fcQueueFixedSeeds([String(node.id)]);
    } catch (e) {
      console.error("[InfiniteMovieAutoPrompt]", e);
      btn.name = "⚠ failed – see console, click to retry";
      node.setDirtyCanvas(true, true);
    } finally {
      if (regenW) regenW.value = "";   // the next run generates nothing
    }
  });
  btn.serialize = false;
  node._fcRegenBtn = btn; // the loop switch triggers generation of the closing prompt
  btn.tooltip = "Write the prompt for this transition now with the local prompt model (Settings › prompt_model). " +
    "Runs only this node. The result lands in 'prompt', where you can edit it; press again for a new version.";
  // User changes the text by hand -> reset prompt_hint (next Regenerate takes the new text).
  const promptW = node.widgets?.find((w) => w.name === "prompt");
  if (promptW) {
    const origCb = promptW.callback;
    promptW.callback = function (...args) {
      const r = origCb?.apply(this, args);
      // The text widget reports changes with a delay – hence compare with the self-written value
      // instead of a flag. Clearing does not reset the keywords.
      const v = String(args[0] ?? promptW.value ?? "");
      if (v.trim() && v !== node._fcRegenWrote && v !== node.properties?.im_last_generated) {
        node.properties = node.properties || {};
        node.properties.prompt_hint = null;
      }
      return r;
    };
  }
  // keywords only for Regenerate – hidden in the node
  setTimeout(() => {
    imToggleWidget(node.widgets?.find((w) => w.name === "keywords"), false);
    imToggleWidget(node.widgets?.find((w) => w.name === "regen"), false);
    node.setSize([node.size[0], node.computeSize()[1]]);
  }, 0);
}

// 73 (user 2026-11-03: „they got rendered multiple times on start“): a partial run (Regenerate, ASSEMBLE)
// must not advance any seed – otherwise the director (control before generate: randomize) re-renders all shots
// anew instead of taking them from the cache. Hence all seed controls for this one queue set to "fixed".
export async function fcQueueFixedSeeds(targets) {
  const saved = [];
  for (const n of app.graph?._nodes || []) {
    for (const w of n.widgets || []) {
      if (/^control_(after|before)_generate$/.test(w.name) && w.value !== "fixed") { saved.push([w, w.value]); w.value = "fixed"; }
    }
  }
  try {
    return await app.queuePrompt(0, 1, targets);
  } finally {
    for (const [w, v] of saved) w.value = v;
  }
}

// Remove films/previews of an old run (new shot run or cancel): Film, Assemble, Choose.
export function fcClearFilms({ choose = false } = {}) {
  for (const n of app.graph?._nodes || []) {
    if (n.comfyClass === "InfiniteMovieFilm") { n._fc_film_info = null; fcFilmRender(n); }
    else if (n.comfyClass === "InfiniteMovieAssemble") { n.imgs = undefined; n.images = undefined; n.setDirtyCanvas?.(true, true); }
    else if (n.comfyClass === "InfiniteMovieChooser") {
      if (choose) { n._fc_choose_entries = []; n._fc_redo_pending = null; }
      n._fc_choose_ran = null;
      n._fc_film_done = null;   // no VIDEO READY bar for a removed film
      fcChooseRender(n);
    }
  }
}

export function wrapQueue() {
  if (app._fcQueueWrapped || typeof app.queuePrompt !== "function") return;
  const orig = app.queuePrompt.bind(app);
  app.queuePrompt = async function (...args) {
    // 73 (user 2026-11-03: „the film must not be rendered automatically“): Run only renders the shots up to
    // Choose. FILM in Choose builds the film (partial run on Cut itself + its downstream output nodes).
    const userRun = !(Array.isArray(args[2]) && args[2].length);
    if (userRun) {
      const chooses = (app.graph?._nodes || []).filter((n) => n.comfyClass === "InfiniteMovieChooser"
        && (n.mode ?? 0) === 0 && n.inputs?.[0]?.link != null);
      if (chooses.length) {
        args = [args[0] ?? 0, args[1] ?? 1, chooses.map((n) => String(n.id))];
        window.__fc_shots_run = true;
      }
    }
    // 72 (user 2026-11-03: „prompts automatically filled – prefer manual“): a full run generates no
    // prompts. Empty Auto Prompts -> message, NO queue. Regenerate (partial targets in args[2]) goes through.
    const partial = !userRun;
    if (!partial) {
      const empty = (app.graph?._nodes || []).filter((n) => n.comfyClass === "InfiniteMovieAutoPrompt"
        && (n.mode ?? 0) === 0 && (n.outputs?.[0]?.links || []).length
        && !String(n.widgets?.find((w) => w.name === "prompt")?.value ?? "").trim());
      if (empty.length) {
        const names = empty.map((n) => `#${n.id} ${n.title || "Auto Prompt"}`).join("\n");
        if (!window.confirm(`Empty prompt (nothing is generated on Run):\n${names}\n\nRender without prompt?`)) return false;
      }
    }
    // 65 (user 2026-11-03: „the render must not be sent out!“): check the GPU BEFORE the queue (one measurement,
    // foreign programs are never touched). Not enough free -> message, NO queue.
    const director = (app.graph?._nodes || []).find((n) => n.comfyClass === "InfiniteMovieRender" && (n.mode ?? 0) === 0);
    // 2026-11-11: Regenerate (only Auto Prompts as targets) renders nothing - and an LLM server must hold the GPU
    // while it writes. The render check would block exactly that.
    const promptOnly = partial && args[2].every((id) => app.graph?.getNodeById(Number(id))?.comfyClass === "InfiniteMovieAutoPrompt");
    if (director && !promptOnly && !window.__fc_skip_gpu_preflight) {
      const min = MIN_FREE_MB;   // 74: constant (was the settings widget min_free_mb)
      fcReviewToast("Checking GPU memory ...");
      let res = null;
      try {
        const r = await api.fetchApi("/infinite_movie/gpu_preflight", { method: "POST",
          body: JSON.stringify(min != null ? { min_free_mb: min } : {}) });
        res = r.ok ? await r.json() : null;
      } catch (e) {
        console.warn("[InfiniteMovie] gpu_preflight not reachable – the Director checks again", e);
      }
      if (res && res.ok === false) {
        console.warn("[InfiniteMovie] NOT queued:", res.message);
        imErrorToast("GPU not free – render not started", res.message);
        return false;
      }
      if (res) console.log("[InfiniteMovie] gpu_preflight:", res.message);
    }
    const res = await orig(...args);
    // New shot run: old film no longer fits -> remove from Film/Assemble/Choose
    if (userRun && window.__fc_shots_run) { window.__fc_shots_run = false; fcClearFilms({ choose: true }); }
    return res;
  };
  app._fcQueueWrapped = true;
}

// ---------------------------------------------------------------------------
// Shared helpers: toast + "Rerender marked" (Choose). The review node has been removed since 75.
// ---------------------------------------------------------------------------

export const FC_REVIEW_LINE_COLORS = ["transparent", "#e6c229", "#e68929", "#d93025"];  // Verdachts-Linie (Choose)

// 2026-11-11 (user: "error messages can't be copied - I hate that"): errors as ComfyUI toast (stays until closed,
// text selectable) instead of window.alert; fallback = selectable fixed box.
function imErrorToast(summary, detail) {
  const toast = app.extensionManager?.toast;
  if (toast?.add) { toast.add({ severity: "error", summary, detail }); return; }
  const t = document.createElement("div");
  t.textContent = `${summary}\n\n${detail}`;
  t.title = "click × to close";
  t.style.cssText = "position:fixed;top:60px;right:20px;max-width:480px;white-space:pre-wrap;user-select:text;" +
    "background:#533;color:#fff;padding:12px 16px;border-radius:4px;z-index:9999;font-size:13px;";
  const x = document.createElement("button");
  x.textContent = "×";
  x.style.cssText = "position:absolute;top:2px;right:6px;background:none;border:none;color:#fff;cursor:pointer;";
  x.onclick = () => t.remove();
  t.appendChild(x);
  document.body.appendChild(t);
}

// Film finished: sticky-ish success toast (selectable path) + the Cut status turns into a green VIDEO READY bar.
export function imFilmInfoText(fi) {
  const sec = Number(fi.seconds) || 0;
  return `${fi.name} · ${sec.toFixed(1)} s · ${fi.shots} shot${fi.shots === 1 ? "" : "s"} · ${fi.audio ? "with sound" : "silent"}`;
}
export function imFilmDoneNotice(node, fi) {
  const what = node.comfyClass === "InfiniteMovieAssemble" ? "Even Motion film ready" : "Film ready";
  const toast = app.extensionManager?.toast;
  if (toast?.add) toast.add({ severity: "success", summary: `🎬 ${what}`, detail: `${imFilmInfoText(fi)}\n${fi.path}`, life: 15000 });
  else fcReviewToast(`🎬 ${what}: ${imFilmInfoText(fi)}`, "#1a7f37");
}

export function fcReviewToast(msg, color) {
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);` +
    `background:${color || "#2ea043"};color:#fff;padding:8px 18px;border-radius:4px;` +
    `z-index:9999;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.4);`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// Task 61: SHARED logic for "Rerender marked" (review AND chooser node).
// Writes the marked numbers into the `reseed` widget of the director and
// queues the prompt. Both variants (A/B) get new seeds with that.
// rerenderFn: node-specific re-render (update tiles/button).
// 2026-11-08 (Nutzer: „picked one image to rerender but both turned black … should only new black out“):
// what RERENDER re-renders – whole shot (✗ REDO) = "3", only one rejected variant = "3a"/"3b"
// (the other stays, its segment is reused).
export function fcChooseRedoTokens(node) {
  const marked = (node.properties?.marked || []).slice().sort((a, b) => a - b);
  const out = marked.map(String);
  const rej = node.properties?.rejected || {};
  for (const n of Object.keys(rej).map(Number).sort((a, b) => a - b)) {
    if (marked.includes(n)) continue;
    const r = rej[n] || [];
    if (r.length === 1) out.push(`${n}${r[0]}`);
    else if (r.length > 1) out.push(String(n));
  }
  return out;
}

