// InfiniteMovieRender: labels for the Autogrow slots ("image 1", "prompt 1 -> 2", loop: last "-> 1").
// Nutzer 2026-10-26. The slots are NOT reordered any more: reordering node.inputs broke the
// links on loadApiJson and on page reload (prompts silently on the wrong transition).
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const IMG = "images.image";
const PR = "shot_prompts.prompt";
// 74: GPU pre-check – min_free_mb is a constant (Python: MIN_FREE_MB), GPU handover fixed.
const MIN_FREE_MB = 20000;

function slotKey(name) {
  if (name?.startsWith(IMG)) return [parseInt(name.slice(IMG.length), 10), 0];
  if (name?.startsWith(PR)) return [parseInt(name.slice(PR.length), 10), 1];
  return null;
}

// Muted/bypassed LoadImage nodes do not count towards the chain (user 2026-11-04: "only 1 of 7 images
// used"): Ctrl+M on an image removes it from the film, its Auto Prompts get muted along with it and
// keep their text; un-muting restores everything.
const fcActive = (n) => (n?.mode ?? 0) === 0;

// 2026-11-08 (user: „input images not working if wired via preview image or upscale universal“): the image source of the
// chain is EVERY node connected via an IMAGE output (Load Image, Upscale Crop Universal,
// Assemble › last_frame …), not just LoadImage. Order by the root of the image chain (first node without
// IMAGE input, usually the Load Image) – this keeps the old order "Load Image id ascending".
const fcImgLink = (g, l) => !!l && (l.type === "IMAGE"
  || g.getNodeById(l.origin_id)?.outputs?.[l.origin_slot]?.type === "IMAGE");
function fcImgRoot(g, n, depth = 0) {
  const inp = (n?.inputs || []).find((i) => i.type === "IMAGE" && i.link != null);
  if (!inp || depth > 20) return n;
  const l = getLink(g, inp.link);
  const o = l && g.getNodeById(l.origin_id);
  return o ? fcImgRoot(g, o, depth + 1) : n;
}
const fcImgOrder = (g) => (a, b) => (fcImgRoot(g, a).id - fcImgRoot(g, b).id) || (a.id - b.id);
// Image source active = itself and the root of its image chain not muted/bypassed
const fcImgActive = (g, n) => fcActive(n) && fcActive(fcImgRoot(g, n));

function getLink(graph, id) {
  const links = graph?.links;
  if (!links) return null;
  return typeof links.get === "function" ? links.get(id) : links[id];
}

// 82: per-shot seconds – Director-Widget 'shot_seconds' parsen
// ("2, 3,,4" -> [2, 3, 0, 4]; empty/invalid -> 0 = global 'seconds').
function fcParseShotSeconds(text) {
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
function fcShotSecondsOf(director, shotNumber) {
  const g = parseFloat(director?.widgets?.find((w) => w.name === "seconds")?.value);
  const global = isNaN(g) || g <= 0 ? 1 : g;
  const entry = fcParseShotSeconds(director?.widgets?.find((w) => w.name === "shot_seconds")?.value)[shotNumber - 1];
  return entry > 0 ? entry : global;
}

function interleave(node) {
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

function settingsNodeOf(node) {
  return settingsChainOf(node).settings;
}

// 2026-11-11: Story Mode (LLM) plugged into Settings › "LLM" (input name "llm"), active = not bypassed/muted.
function storyModeOf(settingsNode) {
  const inp = settingsNode?.inputs?.find((i) => i.name === "llm");
  if (inp?.link == null) return null;
  const src = settingsNode.graph?.getNodeById(getLink(settingsNode.graph, inp.link)?.origin_id);
  return src && (src.mode ?? 0) === 0 ? src : null;
}

const IM_REGEN = "🔄 Regenerate prompt";

function addRegenerateButton(node) {
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
async function fcQueueFixedSeeds(targets) {
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
function fcClearFilms({ choose = false } = {}) {
  for (const n of app.graph?._nodes || []) {
    if (n.comfyClass === "InfiniteMovieFilm") { n._fc_film_info = null; fcFilmRender(n); }
    else if (n.comfyClass === "InfiniteMovieAssemble") { n.imgs = undefined; n.images = undefined; n.setDirtyCanvas?.(true, true); }
    else if (n.comfyClass === "InfiniteMovieChooser") {
      if (choose) { n._fc_choose_entries = []; n._fc_redo_pending = null; }
      n._fc_choose_ran = null;
      fcChooseRender(n);
    }
  }
}

function wrapQueue() {
  if (app._fcQueueWrapped || typeof app.queuePrompt !== "function") return;
  const orig = app.queuePrompt.bind(app);
  app.queuePrompt = async function (...args) {
    // 73 (user 2026-11-03: „the film must not be rendered automatically“): Run only renders the shots up to
    // Choose. ASSEMBLE in Choose builds the film first (partial run on Film/Assemble).
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

app.registerExtension({
  name: "InfiniteMovie.GpuPreflight",
  setup() {
    wrapQueue();
  },
});

app.registerExtension({
  name: "InfiniteMovie.AutoPromptRegenerate",
  nodeCreated(node) {
    if (node.comfyClass === "InfiniteMovieAutoPrompt") addRegenerateButton(node);
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "InfiniteMovieAutoPrompt") return;
    const origExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      origExecuted?.apply(this, arguments);
      const text = Array.isArray(message?.text) ? message.text.join("") : message?.text;
      const pw = this.widgets?.find((w) => w.name === "prompt");
      if (pw && typeof text === "string" && text.trim() && text !== pw.value) {
        this._fcRegenWrote = text;   // keep prompt_hint (result, not user)
        this.properties = this.properties || {};
        this.properties.im_last_generated = text;
        pw.value = text;
        pw.callback?.(pw.value);
      }
      if (this._fcRegenBtn) this._fcRegenBtn.name = IM_REGEN;
      this.setDirtyCanvas?.(true, true);
    };
  },
});

// Settings: everything always open (user 2026-11-03: „settings always open, no all settings button“).
// Size = aspect + long_side (rounded to 32, like settings_nodes.resolve_size); the result is shown
// in the label of long_side („long_side → 768×960“).
function imToggleWidget(w, show) {
  if (!w) return;
  if (w._imOrigComputeSize === undefined) w._imOrigComputeSize = w.computeSize ?? null;
  w.hidden = !show;
  if (show) {
    if (w._imOrigComputeSize) w.computeSize = w._imOrigComputeSize;
    else delete w.computeSize;
    delete w.computedHeight;
  } else {
    w.computeSize = () => [0, -4];
    w.computedHeight = 0;
  }
}

function imResolveSize(aspect, longSide) {
  const m = /^(\d+):(\d+)/.exec(String(aspect ?? "")) || [0, 4, 5];   // old/invalid value -> 4:5
  const rw = +m[1], rh = +m[2];
  const r32 = (v) => Math.max(32, Math.round(v / 32) * 32);
  const long = r32(longSide || 960);
  return rw >= rh ? [long, r32(long * rh / rw)] : [r32(long * rw / rh), long];
}

function imSettingsSizeLabel(node) {
  const a = node.widgets?.find((w) => w.name === "aspect");
  const l = node.widgets?.find((w) => w.name === "long_side");
  if (!a || !l) return;
  // 69: "from images" – the ratio comes from the director's first image, no calculation here.
  if (a.value === "from images") {
    l.label = "long_side → from image 1";
    node.setDirtyCanvas?.(true, true);
    return;
  }
  const [w, h] = imResolveSize(a.value, l.value);
  l.label = `long_side → ${w}×${h}`;
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "InfiniteMovie.SettingsSize",
  nodeCreated(node) {
    if (node.comfyClass !== "InfiniteMovieSettings") return;
    for (const name of ["aspect", "long_side"]) {
      const w = node.widgets?.find((x) => x.name === name);
      if (!w || w._imSizeHooked) continue;
      w._imSizeHooked = true;
      const prevCb = w.callback;
      w.callback = function (...a) {
        const r = prevCb?.apply(this, a);
        imSettingsSizeLabel(node);
        return r;
      };
    }
    const prevConf = node.onConfigure;
    node.onConfigure = function (...args) {
      const r = prevConf?.apply(this, args);
      setTimeout(() => imSettingsSizeLabel(node), 0);
      return r;
    };
    setTimeout(() => imSettingsSizeLabel(node), 0);
  },
});

// 66 (2026-11-03): folder browser as an in-page dialog. The server only delivers folder names
// (POST /infinite_movie/list_dirs, only from this machine). Grayscale, ComfyUI color variables.
function fcPickFolder(start) {
  return new Promise((resolve) => {
    const bg = document.createElement("div");
    bg.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center";
    const box = document.createElement("div");
    box.style.cssText = "width:min(560px,92vw);max-height:76vh;display:flex;flex-direction:column;gap:8px;padding:14px;" +
      "background:var(--comfy-menu-bg,#222);color:var(--input-text,#ddd);border:1px solid var(--border-color,#555);border-radius:8px;font:13px sans-serif";
    const title = document.createElement("div");
    title.textContent = "Output folder for the finished film";
    title.style.cssText = "font-weight:600;font-size:14px";
    const cur = document.createElement("div");
    cur.style.cssText = "padding:6px 8px;background:var(--comfy-input-bg,#111);border-radius:4px;word-break:break-all;min-height:18px";
    const list = document.createElement("div");
    list.style.cssText = "overflow:auto;flex:1;min-height:200px;border:1px solid var(--border-color,#444);border-radius:4px";
    const err = document.createElement("div");
    err.style.cssText = "color:#bbb;font-size:12px;min-height:14px";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
    const mk = (txt, primary) => {
      const b = document.createElement("button");
      b.textContent = txt;
      b.style.cssText = "padding:6px 14px;border-radius:4px;cursor:pointer;border:1px solid var(--border-color,#555);" +
        (primary ? "background:#ddd;color:#111;font-weight:600" : "background:var(--comfy-input-bg,#333);color:inherit");
      return b;
    };
    const cancel = mk("Cancel"), use = mk("Use this folder", true);
    row.append(cancel, use);
    box.append(title, cur, list, err, row);
    bg.append(box);
    document.body.append(bg);
    let path = "";
    const close = (v) => { bg.remove(); resolve(v); };
    cancel.onclick = () => close(null);
    bg.onclick = (e) => { if (e.target === bg) close(null); };
    use.onclick = () => { if (path) close(path); };
    const item = (label, target, dim) => {
      const d = document.createElement("div");
      d.textContent = label;
      d.style.cssText = "padding:5px 10px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05)" + (dim ? ";color:#999" : "");
      d.onmouseenter = () => (d.style.background = "rgba(255,255,255,.08)");
      d.onmouseleave = () => (d.style.background = "");
      d.onclick = () => go(target);
      list.append(d);
    };
    const go = async (p) => {
      err.textContent = "";
      let j;
      try {
        const r = await api.fetchApi("/infinite_movie/list_dirs", { method: "POST", body: JSON.stringify({ path: p }) });
        j = await r.json();
      } catch (e) {
        j = { ok: false, error: String(e) };
      }
      if (!j.ok) {
        err.textContent = j.error || "cannot open folder";
        if (p) return go("");   // invalid start folder -> drives
        return;
      }
      path = j.path || "";
      cur.textContent = path || "(choose a drive)";
      use.disabled = !path;
      use.style.opacity = path ? "1" : ".4";
      list.innerHTML = "";
      if (path) item("⬆  ..", j.parent || "", true);
      for (const q of j.quick || []) item("★  " + q, q, false);
      for (const d of j.dirs || []) item("📁  " + d, path ? (path.replace(/[\\/]+$/, "") + "\\" + d) : d, false);
      if (path && !(j.dirs || []).length) { const e = document.createElement("div"); e.textContent = "(no subfolders)"; e.style.cssText = "padding:8px 10px;color:#888"; list.append(e); }
    };
    go(start || "");
  });
}
window.fcPickFolder = fcPickFolder;

// 63 (2026-11-03): Settings › output_folder – the "📂 Choose folder" button opens a
// native folder dialog on the ComfyUI machine (POST /infinite_movie/choose_folder)
// and enters the path into the output_folder field. Assemble writes the finished
// film to <output_folder>/<save_name>.mp4 then.
// The button widget is NOT serialized (serialize=false, model: the Regenerate button
// in addRegenerateButton), so the positional widgets_values stay the same length.
app.registerExtension({
  name: "InfiniteMovie.SettingsChooseFolder",
  nodeCreated(node) {
    if (node.comfyClass !== "InfiniteMovieSettings") return;
    // Guard: recreate the button after a configure() (workflow load), but not twice.
    if (node.widgets?.some((x) => x.name === "📂 Choose folder")) return;
    const w = node.widgets?.find((x) => x.name === "output_folder");
    if (!w) return;
    const btn = node.addWidget("button", "📂 Choose folder", null, async () => {
      // 66: folder browser in the browser (the native dialog stayed invisible behind the browser)
      const path = await fcPickFolder(String(w.value ?? ""));
      if (path) {
        w.value = path;
        w.callback?.(w.value);
        node.setDirtyCanvas(true, true);
      }
    });
    btn.serialize = false;
    btn.tooltip = "Open a native folder picker on the ComfyUI machine and store the path in output_folder. " +
      "Assemble writes the finished film to <output_folder>/<save_name>.mp4. Empty = next to the shots.";
  },
});

// Layout button (user 2026-10-26: no switch, arrange only on click): images left, prompts right tightly
// stacked, each image centered on the boundary between its two prompts. Sizes the user has dragged
// stay; the group around the images is adjusted.
function sources(node, prefix) {
  return (node.inputs || [])
    .filter((i) => i.name?.startsWith(prefix) && i.link != null)
    .sort((a, b) => parseInt(a.name.slice(prefix.length), 10) - parseInt(b.name.slice(prefix.length), 10))
    .map((i) => {
      const l = getLink(node.graph, i.link);
      return l && node.graph.getNodeById(l.origin_id);
    })
    .filter(Boolean);
}

const PROMPT_W = 600;

function layoutPrompts(node) {
  const imgs = sources(node, IMG), prs = sources(node, PR);
  if (!imgs.length || !prs.length) return;
  const g = node.graph;
  const titleH = globalThis.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
  const gap = 20;
  const all = [...imgs, ...prs];
  const inside = (gr, n) => n.pos[0] >= gr.pos[0] && n.pos[0] < gr.pos[0] + gr.size[0] &&
    n.pos[1] >= gr.pos[1] && n.pos[1] < gr.pos[1] + gr.size[1];
  const group = (g._groups || g.groups || []).find((gr) => inside(gr, imgs[0]));
  const x0 = Math.min(...imgs.map((n) => n.pos[0]));
  // body-top based like promptPos below; "- titleH" here moved the column up by one title per click
  const y0 = group ? group.pos[1] + 45 : Math.min(...all.map((n) => n.pos[1]));
  // Prompt nodes 50 % wider than the 400 px they are created with, so the prompt text fits
  // (Nutzer 2026-11-01); a width the user dragged larger stays.
  for (const p of prs) {
    if (p.size[0] < PROMPT_W) p.setSize ? p.setSize([PROMPT_W, p.size[1]]) : (p.size[0] = PROMPT_W);
    // 57d: prompt node as tall as the Load Image at image_from (min. computeSize),
    // so prompt + image stand at the same height (user 2026-11-01).
    const fi = (p.inputs || []).findIndex((i) => i.name === "image_from");
    if (fi >= 0 && p.inputs[fi].link != null) {
      const l = getLink(g, p.inputs[fi].link);
      const img = l && g.getNodeById(l.origin_id);
      if (img) {
        const minH = p.computeSize?.()[1] || p.size[1];
        const targetH = Math.max(img.size[1], minH);
        if (Math.abs(p.size[1] - targetH) > 1) {
          p.setSize ? p.setSize([p.size[0], targetH]) : (p.size[1] = targetH);
        }
      }
    }
  }
  const iw = Math.max(...imgs.map((n) => n.size[0]));
  const ih = Math.max(...imgs.map((n) => n.size[1])) + titleH;
  const px = x0 + iw + 40;

  // Read mode switches (71: intro/outro removed – only loop left)
  const w = (name) => node.widgets?.find((x) => x.name === name)?.value;
  const hasLoop = !!w("loop");
  const nImgs = imgs.length;
  const expected = (nImgs - 1) + (hasLoop ? 1 : 0);
  if (prs.length !== expected) {
    console.warn(`[InfiniteMovie] layout: expected ${expected} prompts, got ${prs.length}`);
  }

  // Sort prompts by their slot index on the Render node
  const prSorted = prs
    .map((p) => {
      let idx = 999;
      for (const inp of node.inputs || []) {
        if (!inp.name?.startsWith("shot_prompts.prompt") || inp.link == null) continue;
        const l = getLink(g, inp.link);
        if (l && l.origin_id === p.id) {
          idx = parseInt(/(\d+)$/.exec(inp.name)?.[1] ?? "999", 10); // "shot_prompts.prompt0" -> 0
          break;
        }
      }
      return { p, idx };
    })
    .sort((a, b) => a.idx - b.idx)
    .map((x) => x.p);

  // Stack prompts vertically with gap
  let y = y0;
  const promptPos = []; // {top, bottom, node}
  for (const p of prSorted) {
    const top = y;
    p.pos = [px, top];
    const bottom = top + titleH + p.size[1];
    promptPos.push({ top, bottom, node: p });
    y = bottom + gap;
  }

  // 57c: settings node far left in its own column BEFORE the images (user 2026-11-02).
  // Y position: middle of the prompt column, so the settings links run to the right
  // and do not cross the LoadImage→AutoPrompt/Render links.
  const snode = prSorted.length ? settingsNodeOf(prSorted[0]) : null;
  if (snode) {
    const promptMidY = y0 + (promptPos.length ? (promptPos[promptPos.length - 1].bottom - y0) / 2 : 0);
    snode.pos = [x0 - (snode.size[0] || 340) - 40, promptMidY - (snode.size[1] || 600) / 2];
  }

  // Position images by their real links (user 2026-11-01: every image the same way, incl. the first):
  // image centre on the gap between the prompt it ends (image_to) and the prompt it starts (image_from).
  // Index-based placement broke with intro/outro (prompt k is not the pair k -> k+1 then).
  const edges = (im) => {
    const from = [], to = [];
    for (const out of im.outputs || []) {
      for (const lid of out.links || []) {
        const l = getLink(g, lid);
        const pi = l ? promptPos.findIndex((pp) => pp.node.id === l.target_id) : -1;
        if (pi < 0) continue;
        const name = promptPos[pi].node.inputs?.[l.target_slot]?.name;
        if (name === "image_from") from.push(pi);
        else if (name === "image_to") to.push(pi);
      }
    }
    return { from, to };
  };
  const centers = imgs.map((im, k) => {
    const { from, to } = edges(im);
    // adjacent pair (ends prompt i, starts prompt i+1) -> centre on the gap between them
    for (const i of to) if (from.includes(i + 1)) return (promptPos[i].bottom + promptPos[i + 1].top) / 2;
    if (from.length) return promptPos[Math.min(...from)].top - gap / 2;    // first image (loop wrap ignored)
    if (to.length) return promptPos[Math.max(...to)].bottom + gap / 2;     // last image
    return y0 + k * (ih + gap) + ih / 2;                                   // not wired: plain stack
  });
  // promptPos top/bottom are body-top based (+titleH vs. the drawn box); pos is the body top, so the drawn
  // centre of an image (title included) lands on the centre when pos = c - size/2 - titleH/2.
  const imgY = (im, k) => centers[k] - im.size[1] / 2 - titleH / 2;
  // first image may reach above the start: move the whole column down instead of breaking the rule
  const shift = Math.max(0, y0 - Math.min(...imgs.map(imgY)));
  for (const pp of promptPos) pp.node.pos = [pp.node.pos[0], pp.node.pos[1] + shift];
  imgs.forEach((im, k) => { im.pos = [x0, imgY(im, k) + shift]; });

  if (group) {
    const right = Math.max(...all.map((n) => n.pos[0] + n.size[0]));
    const bottom = Math.max(...all.map((n) => n.pos[1] + n.size[1]));
    group.size = [right - group.pos[0] + 10, bottom - group.pos[1] + 15];
  }
  g.setDirtyCanvas(true, true);
}

// 57c: segment intersection of link endpoints (straight lines output→input).
// Exposed on window.__im_countCrossings for the browser test.
function _fcSegmentsIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function countCrossings(graph) {
  const links = [];
  const entries = typeof graph.links?.entries === "function" ? [...graph.links.entries()] : Object.entries(graph.links || {});
  for (const [id, l] of entries) {
    if (!l || !l.origin_id || !l.target_id) continue;
    const origin = graph.getNodeById(l.origin_id);
    const target = graph.getNodeById(l.target_id);
    if (!origin || !target) continue;
    const start = origin.getConnectionPos(false, l.origin_slot);
    const end = target.getConnectionPos(true, l.target_slot);
    if (!start || !end) continue;
    links.push({ start, end });
  }
  let count = 0;
  for (let i = 0; i < links.length; i++) {
    for (let j = i + 1; j < links.length; j++) {
      if (_fcSegmentsIntersect(links[i].start, links[i].end, links[j].start, links[j].end)) count++;
    }
  }
  return count;
}
window.__im_countCrossings = countCrossings;

// 57e: auto layout places the engine chains (Engine Start → model chain →
// 57c: one button instead of two – "🔗 AUTO LAYOUT" (user 2026-11-02).
// Click = (a) check prompt chain, (b) connect shots→Assemble, (c) connect settings, (d) layout.
// Looked up by name (not a flag), so it is created only ONCE after configure/reload/copy.
// 92 (user 2026-11-09): image count on the director. More = reclaim muted images (silenced by the counter),
// then new Load Image as a copy of the last image („image N – replace“); reconcileChain creates the Auto Prompts,
// then AUTO LAYOUT. Fewer = mute images from the back (never delete), reconcileChain 1b mutes their prompts too.
// Only images of this director chain. Widget not saved (serialize) and not in the prompt (options.serialize),
// Name ≠ „images“ (Autogrow-Gruppe).
function fcChainImages(chain) {
  const g = chain.graph;
  return (chain.inputs || [])
    .filter((i) => i.name?.startsWith(IMG) && i.link != null)
    .sort((a, b) => slotKey(a.name)[0] - slotKey(b.name)[0])
    .map((i) => g.getNodeById(getLink(g, i.link)?.origin_id))
    .filter((n) => n && fcImgActive(g, n));
}

function fcImgPath(g, n) {
  const path = [n];
  for (let d = 0; d < 20; d++) {
    const inp = (path[path.length - 1].inputs || []).find((i) => i.type === "IMAGE" && i.link != null);
    const o = inp && g.getNodeById(getLink(g, inp.link)?.origin_id);
    if (!o) break;
    path.push(o);
  }
  return path;
}

function fcSetImageCount(chain, want) {
  const g = chain.graph;
  if (!g) return;
  want = Math.max(1, Math.min(12, Math.round(Number(want) || 1)));
  let imgs = fcChainImages(chain);
  if (want === imgs.length) return;
  chain._fcReady = false;                                   // no addPromptForNewImage in between
  try {
    if (want < imgs.length) {
      for (const n of imgs.slice(want).reverse()) {
        const path = fcImgPath(g, n);
        const root = path[path.length - 1];
        for (const p of path) p.mode = 2;
        root.properties = root.properties || {};
        root.properties.im_count_muted = chain.id;
        root.properties.im_count_path = path.map((p) => p.id);
      }
    } else {
      // 1) reclaim images muted by the counter (oldest first)
      const muted = (g._nodes || []).filter((n) => n.properties?.im_count_muted === chain.id)
        .sort((a, b) => a.id - b.id);
      let have = imgs.length;
      for (const root of muted) {
        if (have >= want) break;
        for (const id of root.properties.im_count_path || [root.id]) {
          const p = g.getNodeById(id);
          if (p) p.mode = 0;
        }
        delete root.properties.im_count_muted;
        delete root.properties.im_count_path;
        have++;
      }
      // Reclaimed ones only hang on their Auto Prompts → reconcile wires them back to the director
      if (have > imgs.length) { reconcileChain(chain); chain._fcReady = false; imgs = fcChainImages(chain); }
      // 2) new Load Image as a copy of the last image
      const lastRoot = imgs.length ? fcImgRoot(g, imgs[imgs.length - 1]) : null;
      const tplFile = lastRoot?.comfyClass === "LoadImage"
        ? lastRoot.widgets?.find((w) => w.name === "image")?.value : null;
      const imgTpl = (chain.inputs || []).find((i) => i.name?.startsWith(IMG));
      let prev = lastRoot;
      for (let k = imgs.length; k < want; k++) {
        const ni = LiteGraph.createNode("LoadImage");
        if (!ni) break;
        g.add(ni);
        ni.title = `image ${k + 1} – replace`;
        ni.properties = ni.properties || {};
        ni.properties.im_count_created = chain.id;
        const iw = ni.widgets?.find((w) => w.name === "image");
        if (iw && tplFile) { iw.value = tplFile; iw.callback?.(tplFile); }   // the callback loads the preview
        if (prev) {
          ni.size = [...prev.size];
          ni.pos = [prev.pos[0], prev.pos[1] + prev.size[1] + 60];
        } else {
          ni.pos = [chain.pos[0] - 900, chain.pos[1]];
        }
        prev = ni;
        let idx = slotIndex(chain, IMG + k);
        if (idx < 0) {
          const base = imgTpl ? JSON.parse(JSON.stringify(imgTpl)) : { type: "IMAGE" };
          base.name = IMG + k; base.link = null; delete base.label; delete base.localized_name;
          chain.inputs.push(base);
          idx = chain.inputs.length - 1;
        } else if (chain.inputs[idx].link != null) {
          chain.disconnectInput(idx);
        }
        ni.connect(Math.max(0, (ni.outputs || []).findIndex((o) => o.type === "IMAGE")), chain, idx);
      }
    }
  } finally {
    chain._fcReady = true;
  }
  reconcileChain(chain);
  removeStaleModeAPs(chain);
  // AUTO LAYOUT like via the button (wires the settings chain + arranges all groups)
  chain.widgets?.find((w) => w.name === "🔗 AUTO LAYOUT")?.callback?.();
  g.setDirtyCanvas?.(true, true);
}

function addImageCounter(node) {
  if (node.widgets?.find((w) => w.name === "image_count")) return;
  const n0 = Math.max(1, fcChainImages(node).length);
  const w = node.addWidget("number", "image_count", n0, (v) => {
    clearTimeout(node._fcCountT);
    node._fcCountT = setTimeout(() => fcSetImageCount(node, v), 350);   // Pfeile/Ziehen entprellen
  }, { min: 1, max: 12, step: 10, round: 1, precision: 0, serialize: false });
  w.serialize = false;
  w.label = "images";
  w.tooltip = "Number of images. More: adds Load Image nodes (copy of the last image – replace them) with their Auto Prompts and tidies the layout. Fewer: mutes the last images and their prompts (nothing is deleted).";
  // directly via the AUTO LAYOUT button (both not saved → saved widget positions stay the same)
  const bi = node.widgets.findIndex((x) => x.name === "🔗 AUTO LAYOUT");
  if (bi >= 0 && bi < node.widgets.length - 1) {
    node.widgets.splice(node.widgets.indexOf(w), 1);
    node.widgets.splice(bi, 0, w);
  }
}

function addLayoutButton(node) {
  if (node.widgets?.find((w) => w.name === "🔗 AUTO LAYOUT")) return;
  const w = node.addWidget("button", "🔗 AUTO LAYOUT", null, () => {
    // (a) check the prompt chain
    reconcileChain(node);
    // (b) connect shots → Assemble.shots, if Assemble is there and the input is free
    const assemble = node.graph?._nodes?.find((n) => n.comfyClass === "InfiniteMovieAssemble");
    if (assemble) {
      // By TYPE: the output name is the display name ("shots ▶ Assemble"), not "shots".
      const shotsOutIdx = (node.outputs || []).findIndex((o) => o.type === "SHOTS");
      const shotsInIdx = (assemble.inputs || []).findIndex((i) => i.type === "SHOTS" || i.name === "shots");
      if (shotsOutIdx >= 0 && shotsInIdx >= 0 && assemble.inputs[shotsInIdx].link == null) {
        node.connect(shotsOutIdx, assemble, shotsInIdx);
      }
    } else {
      console.warn("[InfiniteMovie] AUTO LAYOUT: kein Assemble-Node gefunden.");
      fcReviewToast("AUTO LAYOUT: kein Assemble-Node gefunden", "#d93025");
    }
    // (c) 57e 14e: the shots pipe wins – redundant STRING links Director→Assemble
    // (segment_paths/save_folder/save_name) are removed once shots is connected.
    if (assemble) {
      const g = node.graph;
      // 73: segments/save_folder/save_name are no longer Assemble inputs ->
      // no redundant links possible anymore (list empty).
      const redundant = [];
      const toRemove = [];
      for (const lid of Object.keys(g.links || {})) {
        const l = g.links[lid];
        if (!l || l.origin_id !== node.id || l.target_id !== assemble.id) continue;
        if (l.type !== "STRING") continue;
        const tname = assemble.inputs?.[l.target_slot]?.name;
        if (redundant.includes(tname)) toRemove.push(lid);
      }
      for (const lid of toRemove) {
        const l = g.links[lid];
        const tslot = l.target_slot;
        if (assemble.inputs?.[tslot]) assemble.inputs[tslot].link = null;
        g.removeLink(lid);
      }
    }
    // (d) 57c2: wire the settings chain (replaces the star wiring)
    wireSettingsChain(node);
    // (e) layout of the whole workflow WITHOUT the engine (user 2026-11-03: „exclude the engine, but the rest“),
    // web/infinite_movie_layout.js; fallback the old prompt arrangement. layoutEngines is no longer called.
    if (window.fcWorkflowLayout) window.fcWorkflowLayout(node);
    else layoutPrompts(node);
    node.setDirtyCanvas?.(true, true);
  });
  // 2026-11-11 (user: "auto layout button really big? 3 rows? it is important"): the core button widget draws with
  // a fixed row height, so it is swapped for a custom widget: three rows high, green, bold. Same name + callback
  // (other code calls widgets.find(name).callback()).
  const cb = w.callback;
  node.widgets.splice(node.widgets.indexOf(w), 1);
  const H = 3 * (globalThis.LiteGraph?.NODE_WIDGET_HEIGHT || 20) + 10;
  node.addCustomWidget({
    name: "🔗 AUTO LAYOUT",
    type: "im_bigbutton",
    value: null,
    serialize: false,
    callback: cb,
    tooltip: "Check & arrange: prompt count, wiring, positions. Connects shots→Assemble and Settings.",
    computeSize: (width) => [width, H],
    draw(ctx, n, width, y) {
      const m = 15, h = H - 8, x = m, bw = width - 2 * m, yy = y + 4;
      ctx.save();
      ctx.fillStyle = this._down ? "#1d7a48" : "#2a6";
      ctx.strokeStyle = "#7fd8a6";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, yy, bw, h, 8); else ctx.rect(x, yy, bw, h);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 22px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("🔗 AUTO LAYOUT", x + bw / 2, yy + h / 2);
      ctx.restore();
    },
    mouse(e, pos, n) {
      const t = e.type;
      if (t === "pointerdown" || t === "mousedown") { this._down = true; n.setDirtyCanvas(true, false); return true; }
      if (t === "pointerup" || t === "mouseup") {
        if (this._down) { this._down = false; this.callback?.(); n.setDirtyCanvas(true, true); }
        return true;
      }
      return false;
    },
  });
}

// New image on InfiniteMovieRender -> automatically create a film Auto Prompt (user 2026-10-26, task 23 package A).
// Wiring only via input names. Loop: the closing prompt (last image -> image 1) moves to the
// new last slot and gets the new image as start; the new prompt fills the gap before it.
// 57c2: settings chain – Settings → Auto Prompts (in director input order,
// intro top … closing bottom) → Director → Assemble. Replaces the
// star wiring (57d): every consumer passes the settings on to the next,
// hence no more crossings. Only if EXACTLY ONE settings node exists, otherwise
// toast + touch nothing. Idempotent: computes the target chain and wires it
// (connect replaces existing settings links at the target). New/removed prompts slot in
// automatically or are bridged (predecessor directly with successor).
// 57c2: settings output index. The display name is "settings ▶ chain" (not "settings"),
// hence look up by type SETTINGS (or prefix), never by exact name.
function settingsOutIdx(node) {
  const outs = node.outputs || [];
  const byType = outs.findIndex((o) => o.type === "SETTINGS");
  if (byType >= 0) return byType;
  return outs.findIndex((o) => o.name && o.name.indexOf("settings") === 0);
}

function wireSettingsChain(director) {
  const g = director?.graph;
  if (!g) return false;
  const nodes = g._nodes || [];
  const snodes = nodes.filter((n) => n.comfyClass === "InfiniteMovieSettings");
  if (snodes.length !== 1) {
    if (snodes.length > 1) fcReviewToast("Settings-Kette: genau EINE Settings-Node erwartet (" + snodes.length + " gefunden)", "#d93025");
    return false;
  }
  const snode = snodes[0];
  const soi = settingsOutIdx(snode);
  if (soi < 0) return false;
  // APs in director input order (prompt target slot; unconnected ones to the end by pos).
  const aps = [];
  for (const n of nodes) {
    if (n.comfyClass !== "InfiniteMovieAutoPrompt" || !fcActive(n)) continue;
    const outIdx = (n.outputs || []).findIndex((o) => o.name === "prompt");
    let slot = -1;
    if (outIdx >= 0 && n.outputs[outIdx].links?.length) {
      for (const lid of n.outputs[outIdx].links) {
        const l = getLink(g, lid);
        if (l && l.target_id === director.id) { slot = l.target_slot; break; }
      }
    }
    aps.push({ node: n, slot: slot });
  }
  aps.sort((a, b) => {
    if (a.slot >= 0 && b.slot >= 0) return a.slot - b.slot;
    if (a.slot >= 0) return -1;
    if (b.slot >= 0) return 1;
    return a.node.pos[1] - b.node.pos[1];
  });
  // Kette: Settings → AP0 → … → APn → Director → Assemble.
  // 66: Prompt Style (falls vorhanden) direkt hinter Settings
  const style = nodes.find((n) => n.comfyClass === "InfiniteMovieStyle" && (n.mode ?? 0) === 0);
  // 2026-11-11: Story Mode (LLM) is not in the chain - it plugs into Settings › "LLM".
  const story = nodes.find((n) => n.comfyClass === "InfiniteMovieStoryMode");
  const llmIn = slotIndex(snode, "llm");
  if (story && llmIn >= 0 && snode.inputs[llmIn].link == null && story.outputs?.length) story.connect(0, snode, llmIn);
  const chainNodes = [snode, ...(style ? [style] : []), ...aps.map((a) => a.node), director];
  const assemble = nodes.find((n) => n.comfyClass === "InfiniteMovieAssemble");
  if (assemble) chainNodes.push(assemble);
  for (let i = 0; i < chainNodes.length - 1; i++) {
    const prev = chainNodes[i];
    const next = chainNodes[i + 1];
    const pi = settingsOutIdx(prev);
    const ni = slotIndex(next, "settings");
    if (pi < 0 || ni < 0) continue;
    const cur = next.inputs[ni].link != null ? getLink(g, next.inputs[ni].link) : null;
    if (cur && cur.origin_id === prev.id && cur.origin_slot === pi) continue; // already correct
    prev.connect(pi, next, ni);
  }
  g.setDirtyCanvas?.(true, true);
  return true;
}

function slotIndex(node, name) {
  return (node.inputs || []).findIndex((i) => i.name === name);
}

function linkFrom(node, name) {
  const inp = node.inputs?.find((i) => i.name === name);
  const l = inp?.link != null ? getLink(node.graph, inp.link) : null;
  return l ? [node.graph.getNodeById(l.origin_id), l.origin_slot] : [null, 0];
}

function addPromptForNewImage(chain, imgName) {
  const g = chain.graph;
  const n = parseInt(imgName.slice(IMG.length), 10);      // 0-based: new image = image n+1
  if (!(n >= 1)) return;
  // only for the rearmost image and only if its prompt slot is still free
  const wired = (chain.inputs || []).filter((i) => i.name?.startsWith(IMG) && i.link != null)
    .map((i) => parseInt(i.name.slice(IMG.length), 10));
  if (Math.max(...wired) !== n) return;
  const loop = !!chain.widgets?.find((w) => w.name === "loop")?.value;
  const [prevImg, prevSlot] = linkFrom(chain, IMG + (n - 1));
  const [newImg, newSlot] = linkFrom(chain, IMG + n);
  if (!prevImg || !newImg) return;
  const prompts = sources(chain, PR);
  const template = prompts[prompts.length - 1];
  const [closing] = linkFrom(chain, PR + (n - 1));          // with loop: so far "last -> 1"
  if (!loop && closing) return;                              // slot occupied -> do nothing
  const ap = LiteGraph.createNode("InfiniteMovieAutoPrompt");
  if (!ap) return;
  const last = prompts.reduce((a, p) => (!a || p.pos[1] > a.pos[1] ? p : a), null);
  const titleH = globalThis.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
  ap.pos = last ? [last.pos[0], last.pos[1] + last.size[1] + titleH + 20] : [chain.pos[0] - 420, chain.pos[1]];
  g.add(ap);
  if (last) ap.size = [last.size[0], ap.size[1]];
  prevImg.connect(prevSlot, ap, slotIndex(ap, "image_from"));
  newImg.connect(newSlot, ap, slotIndex(ap, "image_to"));
  if (loop && closing) {
    // closing prompt one back: start = new image, output = new last slot
    newImg.connect(newSlot, closing, slotIndex(closing, "image_from"));
    const outIdx = closing.outputs.findIndex((o) => o.name === "prompt");
    if (slotIndex(chain, PR + n) >= 0) closing.connect(outIdx, chain, slotIndex(chain, PR + n));
    const ov = closing.widgets?.find((w) => w.name === "prompt");
    if (ov) ov.value = "";                                   // old text fit the old start
  }
  const target = slotIndex(chain, PR + (n - 1));
  if (target >= 0) ap.connect(ap.outputs.findIndex((o) => o.name === "prompt"), chain, target);
  wireSettingsChain(chain);                                   // 57c2: slot the new AP into the settings chain
  g.setDirtyCanvas(true, true);
}

// Stale-Input-Cleanup (2026-10-28, Nutzer: "remove seconds0 and seconds1 inputs"):
// Saved workflows can contain inputs that no longer exist in the node definition
// (e.g. scene_seconds.seconds0/1 after the scene_seconds removal). The
// frontend does not remove them itself. We remove them on load (onConfigure) and on
// creation all UNWIRED inputs whose group/name is not in the definition
//. Wired inputs stay untouched (slot indices of links must not
// shift).
function pruneStaleInputs(node) {
  // 57b2: the definition source is LiteGraph.registered_node_types[comfyClass].nodeData.
  // app.nodeDefs / LiteGraph.registeredNodes do NOT exist in frontend 1.57
  // (browser check 2026-11-01: app.nodeDefs undefined) – before, `def` was undefined,
  // `known` empty, and EVERY unconnected input was deleted on load
  // (on the director also `engine` + the prompt slots). nodeData (Gr class, from
  // /object_info) has input.required/optional with top-level keys (images,
  // shot_prompts, folder, engine, …).
  const def = globalThis.LiteGraph?.registered_node_types?.[node.comfyClass]?.nodeData;
  const known = new Set([
    ...Object.keys(def?.input?.required || {}),
    ...Object.keys(def?.input?.optional || {}),
  ]);
  // Guard: without a definition (or empty known) delete NOTHING.
  if (!def || known.size === 0) return;
  let removed = 0;
  const inputs = node.inputs || [];
  for (let i = inputs.length - 1; i >= 0; i--) {
    const inp = inputs[i];
    if (inp.link != null) continue; // wired: don't touch
    if (inp.widget) continue; // widget input: never delete
    const name = String(inp.name || "");
    const group = name.split(".")[0];
    if (!known.has(group) && !known.has(name)) {
      inputs.splice(i, 1);
      removed++;
    }
  }
  if (removed) {
    console.log(`[InfiniteMovie] removed ${removed} stale input(s) from ${node.comfyClass} #${node.id}`);
    node.setDirtyCanvas?.(true, true);
  }
}

// Loop switch (user 2026-10-28: "add a loop switch to the render interface that
// links the last and the first image and generates the prompt for it
// "): after toggling the chain reconciles immediately - ON creates the closing
// prompt (last -> first image) and generates its text as soon as it is still empty.
// Called ONLY from the loop widget callback, never when loading a workflow.
function genClosingPrompt(chain) {
  if (!chain.widgets?.find((w) => w.name === "loop")?.value) return;
  const g = chain.graph;
  if (!g) return;
  let best = null, bestIdx = -1;
  for (const n of g._nodes || []) {
    if (n.comfyClass !== "InfiniteMovieAutoPrompt") continue;
    const oi = (n.outputs || []).findIndex((o) => o.name === "prompt");
    if (oi < 0) continue;
    for (const lid of n.outputs[oi].links || []) {
      const l = getLink(g, lid);
      if (!l || l.target_id !== chain.id) continue;
      const key = slotKey(chain.inputs?.[l.target_slot]?.name);
      if (key && key[1] === 1 && key[0] > bestIdx) { bestIdx = key[0]; best = n; }
    }
  }
  if (!best) return;
  const ov = best.widgets?.find((w) => w.name === "prompt");
  if (ov && String(ov.value ?? "").trim()) return;   // text already present
  const btn = best._fcRegenBtn;
  if (!btn || btn.name?.startsWith("⏳")) return;
  btn.callback?.();                                   // "🔄 Regenerate prompt" (async, LLM)
}

// Chain reconcile (2026-10-28): the current ComfyUI frontend only stores
// WIRED sockets (widgets moved to widgets_values_named) and shifts the
// autogrow slots on load - links end up on wrong slots (e.g. negative -> image2) and
// prompt wiring is lost. reconcileChain restores the chain semantically:
//   1. release wrongly wired slots (image slot only from LoadImage, prompt slot only from AutoPrompt)
//   2. chain order = LoadImage nodes (id ascending) that hang on image slots or on
//      AutoPrompt image_from/image_to; rewire free image slots
//   3. per image pair (i -> i+1, with loop also last -> first) find the AutoPrompt; if missing,
//      reattach a non-matching (free) AutoPrompt or create a new one
//   4. create shot_prompts.prompt0..T-1; remove link data entries with out-of-range target slot
function reconcileChain(chain) {
  const g = chain.graph;
  if (!g || chain._fcRec) return;
  chain._fcRec = true;
  chain._fcReady = false;
  try {
    // --- 1) falsch verkabelte Slots loesen ---
    const toDisconnect = [];
    for (const inp of chain.inputs || []) {
      const key = slotKey(inp.name);
      if (!key || inp.link == null) continue;
      const l = getLink(g, inp.link);
      const src = l ? g.getNodeById(l.origin_id) : null;
      const ok = key[1] === 0 ? (src && fcImgLink(g, l) && fcImgActive(g, src))
        : (src && src.comfyClass === "InfiniteMovieAutoPrompt" && fcActive(src));
      if (!ok) toDisconnect.push(inp.name);
    }
    for (const name of toDisconnect) _fcDisconnectByName(chain, name);
    // --- 1b) mute Auto Prompts on muted images, otherwise switch them on again ---
    for (const ap of g._nodes || []) {
      if (ap.comfyClass !== "InfiniteMovieAutoPrompt") continue;
      const srcs = ["image_from", "image_to"]
        .map((nm) => getLink(g, ap.inputs?.find((x) => x.name === nm)?.link))
        .map((l) => (l ? g.getNodeById(l.origin_id) : null))
        .filter(Boolean);
      const off = srcs.some((n) => !fcImgActive(g, n));
      ap.properties = ap.properties || {};
      if (off && fcActive(ap)) { ap.mode = 2; ap.properties.im_auto_muted = true; }
      else if (!off && ap.properties.im_auto_muted) { ap.mode = 0; delete ap.properties.im_auto_muted; }
      // loop on again: reclaim the muted closing AP (text kept)
      if (ap.properties.im_loop_off && chain.widgets?.find((w) => w.name === "loop")?.value) {
        ap.mode = 0; delete ap.properties.im_loop_off;
      }
    }
    // --- 2) determine chain images (root of the image chain ascending) ---
    const chainIds = new Set();
    const outSlot = new Map();   // source -> connected IMAGE output (Assemble › last_frame = 1 since 109)
    const addSrc = (l) => {
      if (!fcImgLink(g, l)) return;
      chainIds.add(l.origin_id);
      if (!outSlot.has(l.origin_id)) outSlot.set(l.origin_id, l.origin_slot);
    };
    for (const inp of chain.inputs || []) {
      if (!inp.name?.startsWith(IMG) || inp.link == null) continue;
      addSrc(getLink(g, inp.link));
    }
    // Auto Prompt sources only if their image chain is not already on the director (Load Image → Upscale → Director:
    // the APs still point at the Load Image – that is then NOT a second image, the APs get rewired below).
    const dirRoots = new Set([...chainIds].map((id) => fcImgRoot(g, g.getNodeById(id))?.id));
    for (const n of g._nodes || []) {
      if (n.comfyClass !== "InfiniteMovieAutoPrompt") continue;
      for (const inName of ["image_from", "image_to"]) {
        const l = getLink(g, n.inputs?.find((x) => x.name === inName)?.link);
        const o = l && g.getNodeById(l.origin_id);
        if (o && !chainIds.has(o.id) && dirRoots.has(fcImgRoot(g, o)?.id)) continue;
        addSrc(l);
      }
    }
    const chainNodes = [...chainIds]
      .map((id) => g.getNodeById(id))
      .filter((n) => n && fcImgActive(g, n))
      .sort(fcImgOrder(g));
    const slotOf = (n) => outSlot.get(n.id) ?? Math.max(0, (n.outputs || []).findIndex((o) => o.type === "IMAGE"));
    const N = chainNodes.length;
    const imgTpl = (chain.inputs || []).find((i) => i.name?.startsWith(IMG));
    const ensureSlot = (name, tpl) => {
      let idx = slotIndex(chain, name);
      if (idx >= 0) return idx;
      const base = tpl ? JSON.parse(JSON.stringify(tpl)) : { type: "STRING", shape: 7 };
      base.name = name;
      base.link = null;
      delete base.label;
      delete base.localized_name;
      chain.inputs.push(base);
      return chain.inputs.length - 1;
    };
    if (N > 0) {
      // --- 3) ensure image slots and wire them ---
      for (let i = 0; i < N; i++) {
        const idx = ensureSlot(IMG + i, imgTpl);
        const cur = getLink(g, chain.inputs[idx].link);
        if (cur && cur.origin_id === chainNodes[i].id) continue;
        if (chain.inputs[idx].link != null) chain.disconnectInput(idx);
        chainNodes[i].connect(slotOf(chainNodes[i]), chain, idx);
      }
      for (const inp of [...(chain.inputs || [])]) {
        const k = slotKey(inp.name);
        if (k && k[1] === 0 && k[0] >= N && inp.link != null) _fcDisconnectByName(chain, inp.name);
      }
      // --- 4) Prompt-Slots + AutoPrompt-Paare ---
      const loop = !!chain.widgets?.find((w) => w.name === "loop")?.value;
      // 71: intro/outro removed – T = (N-1) scenes + loop
      // 1 image: open shot (prompt without end image); with loop + return shot last image -> image (nodes.py n_segments)
      const T = N === 1 ? (loop ? 2 : 1) : (N - 1) + (loop ? 1 : 0);
      const prTpl = (chain.inputs || []).find((i) => i.name?.startsWith(PR));
      const aps = () => (g._nodes || []).filter((n) => n.comfyClass === "InfiniteMovieAutoPrompt");
      const srcOf = (ap, inName) => {
        const l = getLink(g, ap.inputs?.find((x) => x.name === inName)?.link);
        return l ? l.origin_id : null;
      };
      const outIdxOf = (ap) => (ap.outputs || []).findIndex((o) => o.name === "prompt");
      const wireAp = (ap, fromN, toN, slotIdx) => {
        const fi = slotIndex(ap, "image_from");
        const ti = slotIndex(ap, "image_to");
        for (const [idx, node] of [[fi, fromN], [ti, toN]]) {
          if (idx < 0) continue;
          if (!node) { if (ap.inputs[idx].link != null) ap.disconnectInput(idx); continue; } // offener Shot
          if (ap.inputs[idx].link != null) ap.disconnectInput(idx);
          node.connect(slotOf(node), ap, idx);
        }
        const oi = outIdxOf(ap);
        if (oi >= 0 && slotIdx >= 0) {
          if (ap.outputs[oi].links?.length) ap.disconnectOutput(oi);
          ap.connect(oi, chain, slotIdx);
        }
      };
      // Map slot index p → (fromImgIdx, toImgIdx)
      // 71: intro/outro removed – only scenes + loop
      const pairFor = (p) => {
        if (N === 1 && p === 0) return [0, -1];      // open shot: no end image (1 image, also with loop)
        if (loop && p === T - 1) return [N - 1, 0]; // loop: last → first
        return [p, p + 1];                          // scenes
      };
      const matched = new Set();
      // exakte Paare zuordnen
      for (let p = 0; p < T; p++) {
        const [fi, ti] = pairFor(p);
        const fromId = chainNodes[fi].id;
        const toId = chainNodes[ti]?.id ?? null;
        const ap = aps().find((a) => !matched.has(a.id) && fcActive(a)
          && srcOf(a, "image_from") === fromId && srcOf(a, "image_to") === toId);
        if (!ap) continue;
        matched.add(ap.id);
        const idx = ensureSlot(PR + p, prTpl);
        const cur = getLink(g, chain.inputs[idx].link);
        if (cur && cur.origin_id === ap.id) continue;
        wireAp(ap, chainNodes[fi], chainNodes[ti], idx);
      }
      // missing pairs: reattach a free AutoPrompt or create a new one
      const template = aps()[0] || null;
      for (let p = 0; p < T; p++) {
        const [fi, ti] = pairFor(p);
        const fromN = chainNodes[fi];
        const toN = chainNodes[ti] || null;
        if (aps().some((a) => matched.has(a.id)
          && srcOf(a, "image_from") === fromN.id && srcOf(a, "image_to") === (toN?.id ?? null))) continue;
        const idx = ensureSlot(PR + p, prTpl);
        let ap = aps().find((a) => !matched.has(a.id) && fcActive(a));
        if (!ap) {
          ap = LiteGraph.createNode("InfiniteMovieAutoPrompt");
          if (!ap) continue;
          g.add(ap);
          ap.properties = ap.properties || {};
          ap.properties.im_auto_created = true;   // may go away again once it becomes free
          const last = aps().filter((a) => a !== ap)
            .reduce((acc, a) => (!acc || a.pos[1] > acc.pos[1] ? a : acc), null);
          const titleH = globalThis.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
          ap.pos = last && last !== ap
            ? [last.pos[0], last.pos[1] + last.size[1] + titleH + 20]
            : [chain.pos[0] - 420, chain.pos[1]];
          if (last && last !== ap) ap.size = [last.size[0], ap.size[1]];   // 92: same width as the others
        }
        matched.add(ap.id);
        wireAp(ap, fromN, toN, idx);
        // Free AP (e.g. old intro AP) → clear the prompt so genClosingPrompt regenerates
        const ovW = ap.widgets?.find((x) => x.name === "prompt");
        if (ovW) ovW.value = "";
      }
      // --- 4b) disconnect APs from slots >= T (intro/outro/loop OFF → AP kept free)
      const toDisc4b = [];
      for (const ap of aps()) {
        const oi = outIdxOf(ap);
        if (oi < 0) continue;
        for (const lid of [...(ap.outputs[oi].links || [])]) {
          const l = getLink(g, lid);
          if (!l || l.target_id !== chain.id) continue;
          const key = slotKey(chain.inputs?.[l.target_slot]?.name);
          if (key && key[1] === 1 && key[0] >= T) { toDisc4b.push(chain.inputs[l.target_slot].name); break; }
        }
      }
      for (const name of toDisc4b) _fcDisconnectByName(chain, name);
      // --- 4c) remove self-created APs that became free again (e.g. after un-muting)
      for (const ap of [...aps()]) {
        if (!ap.properties?.im_auto_created || !fcActive(ap)) continue;
        if (!loop && srcOf(ap, "image_from") === chainNodes[N - 1].id
            && srcOf(ap, "image_to") === chainNodes[0].id) continue;   // closing AP: mute instead of delete
        const oi = outIdxOf(ap);
        const used = oi >= 0 && (ap.outputs[oi].links || []).some((lid) => getLink(g, lid)?.target_id === chain.id);
        if (!used) g.remove(ap);
      }
    }
    // --- 5) remove link data entries with out-of-range target slot (anti-loop) ---
    const links = g.links;
    const entries = typeof links?.entries === "function" ? [...links.entries()] : Object.entries(links || {});
    for (const [id, l] of entries) {
      if (!l || l.target_id !== chain.id) continue;
      if (l.target_slot >= (chain.inputs || []).length) {
        const src = g.getNodeById(l.origin_id);
        const out = src?.outputs?.[l.origin_slot];
        const numId = Number(id);
        if (out?.links) {
          const pos = out.links.indexOf(numId);
          if (pos >= 0) out.links.splice(pos, 1);
        }
        if (typeof links.delete === "function") links.delete(id); else delete links[id];
      }
    }
    interleave(chain);
    wireSettingsChain(chain);                                 // 57c2: rewire the chain after reconciliation
    const cw = chain.widgets?.find((w) => w.name === "image_count");   // 92: counter = active images
    if (cw && N > 0) cw.value = N;
    chain.setDirtyCanvas?.(true, true);
  } finally {
    chain._fcRec = false;
    chain._fcReady = true;
  }
}

// 57c: remove stale mode APs (71: only loop/closing left, intro/outro removed).
// After reconcileChain: free APs (not on chain prompt slots) belonging to disabled modes
// (closing) are removed. Links are cleaned up automatically via graph.remove
// (pitfall "graph.links Map" – graph.remove cleans up everything).
function removeStaleModeAPs(chain) {
  const g = chain.graph;
  if (!g) return;
  const w = (name) => chain.widgets?.find((x) => x.name === name)?.value;
  const hasLoop = !!w("loop");
  // Determine chain images (like reconcileChain step 2)
  const chainIds = new Set();
  for (const inp of chain.inputs || []) {
    if (!inp.name?.startsWith(IMG) || inp.link == null) continue;
    const l = getLink(g, inp.link);
    if (fcImgLink(g, l)) chainIds.add(l.origin_id);
  }
  const dirRoots = new Set([...chainIds].map((id) => fcImgRoot(g, g.getNodeById(id))?.id));
  for (const n of g._nodes || []) {
    if (n.comfyClass !== "InfiniteMovieAutoPrompt") continue;
    for (const inName of ["image_from", "image_to"]) {
      const l = getLink(g, n.inputs?.find((x) => x.name === inName)?.link);
      const o = l && g.getNodeById(l.origin_id);
      if (o && !chainIds.has(o.id) && dirRoots.has(fcImgRoot(g, o)?.id)) continue;
      if (fcImgLink(g, l)) chainIds.add(l.origin_id);
    }
  }
  const chainNodes = [...chainIds]
    .map((id) => g.getNodeById(id))
    .filter((n) => n && fcImgActive(g, n))
    .sort(fcImgOrder(g));
  const N = chainNodes.length;
  if (N < 2) return;
  const firstImg = chainNodes[0].id;
  const lastImg = chainNodes[N - 1].id;
  // APs hanging on chain prompt slots (in use)
  const connectedApIds = new Set();
  for (const inp of chain.inputs || []) {
    if (!inp.name?.startsWith(PR) || inp.link == null) continue;
    const l = getLink(g, inp.link);
    if (l) connectedApIds.add(l.origin_id);
  }
  // Iterate a copy, because g.remove(ap) modifies the array
  const apsToRemove = [];
  for (const ap of [...(g._nodes || [])]) {
    if (ap.comfyClass !== "InfiniteMovieAutoPrompt") continue;
    if (connectedApIds.has(ap.id)) continue; // still in use
    if (!fcActive(ap)) continue;              // muted (image off) – keep the prompt
    const fromId = getLink(g, ap.inputs?.find((x) => x.name === "image_from")?.link)?.origin_id;
    const toId = getLink(g, ap.inputs?.find((x) => x.name === "image_to")?.link)?.origin_id;
    let role = null;
    if (fromId === lastImg && toId === firstImg) role = "closing";
    if (!role) continue;
    const disabled = role === "closing" && !hasLoop;
    if (disabled) apsToRemove.push({ap, role});
  }
  // user 2026-11-04 ("when switching loop prompts are deleted"): mute instead of delete,
  // the text stays; loop on reclaims it in reconcileChain 1b.
  for (const {ap} of apsToRemove) {
    ap.mode = 2;
    ap.properties = ap.properties || {};
    ap.properties.im_loop_off = true;
  }
  if (apsToRemove.length) wireSettingsChain(chain);           // 57c2: bridge the chain over removed APs
  chain.setDirtyCanvas?.(true, true);
}

// Widget hook for loop (idempotent, after configure)
function _fcSetupWidgetHooks(node) {
  if (node._fcWidgetsHooked) return;
  node._fcWidgetsHooked = true;
  for (const wName of ["loop"]) {
    const w = node.widgets?.find((x) => x.name === wName);
    if (!w || w["_fc" + wName + "Hook"]) continue;
    w["_fc" + wName + "Hook"] = true;
    const origCb = w.callback;
    w.callback = function (...args) {
      const r = origCb?.apply(this, args);
      if (!node._fcReady) return r;
      clearTimeout(node._fcRecT);
      node._fcRecT = setTimeout(() => {
        reconcileChain(node);
        removeStaleModeAPs(node);
        genClosingPrompt(node);
        layoutPrompts(node);
      }, 150);
      return r;
    };
  }
}

// Disconnect by name (robust against autogrow index shift)
function _fcDisconnectByName(node, inputName) {
  const idx = (node.inputs || []).findIndex((i) => i.name === inputName);
  if (idx < 0) return;
  const linkId = node.inputs[idx]?.link;
  if (linkId == null) return;
  const g = node.graph;
  g.beforeChange?.();
  try {
    node.disconnectInput(idx);
    if (g.removeLink) g.removeLink(Number(linkId));
    else if (g.links?.delete) g.links.delete(Number(linkId));
  } finally {
    g.afterChange?.();
  }
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "InfiniteMovie.InterleavedPrompts",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "InfiniteMovieRender") return;
    const prevOnConf = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      this._fcReady = false;
      const r = prevOnConf?.apply(this, args);
      // 57b2 fix: warning if the first widget value is a preset name
      // (widget shift: saved OLD set vs. current NEW set).
      const wv = this.widgets?.[0]?.value;
      if (typeof wv === "string" && /^(ltx25|wan22|hunyuan_video)/.test(wv)) {
        console.warn(
          `[InfiniteMovie] Director-Node ${this.id}: erster Widget-Wert "${wv}" sieht aus wie ein ` +
          `Preset-Name (alter Stand). widgets_values könnten verschoben sein – ` +
          `tools/migrate_workflows.py ausführen.`
        );
      }
      setTimeout(() => {
        try {
          pruneStaleInputs(this);
          reconcileChain(this);
          interleave(this);
          _fcSetupWidgetHooks(this);
          addLayoutButton(this);
          addImageCounter(this);
          // 82: shot_seconds is edited in Choose (⏱) – hidden in the node.
          imToggleWidget(this.widgets?.find((w) => w.name === "shot_seconds"), false);
          this.setSize([this.size[0], this.computeSize()[1]]);
          this._fcReady = true;
        } catch (e) { console.error("[InfiniteMovie] onConfigure error:", e); }
      }, 500);
      return r;
    };
  },
  setup() {
    // Mute/bypass of a LoadImage (Ctrl+M/B sets node.mode directly, no event) -> reconcile.
    let fcModeSig = "";
    setInterval(() => {
      const gr = app.graph;
      if (!gr?._nodes) return;
      const sig = gr._nodes.filter((n) => (n.outputs || []).some((o) => o.type === "IMAGE"))
        .map((n) => n.id + ":" + (n.mode ?? 0)).join(",");
      if (sig === fcModeSig) return;
      const first = fcModeSig === "";
      fcModeSig = sig;
      if (first) return;                      // on load, onConfigure does the reconcile
      for (const n of gr._nodes) {
        if (n.comfyClass === "InfiniteMovieRender" && n._fcReady) {
          reconcileChain(n);
          removeStaleModeAPs(n);
          gr.setDirtyCanvas?.(true, true);
        }
      }
    }, 400);
    // Parity after manual deletion (user 2026-10-28: "when I delete them manually, they
    // get replaced automatically"): removed AutoPrompt/LoadImage nodes trigger the reconcile.
    const g = app.graph;
    if (g && !g._fcRemovedWrapped) {
      g._fcRemovedWrapped = true;
      const orig = g.onNodeRemoved;
      g.onNodeRemoved = function (node, ...rest) {
        const r = orig?.apply(this, [node, ...rest]);
        if (node && (node.comfyClass === "InfiniteMovieAutoPrompt" || (node.outputs || []).some((o) => o.type === "IMAGE"))) {
          for (const n of this._nodes || []) {
            if (n.comfyClass === "InfiniteMovieRender") {
              clearTimeout(n._fcRecT);
              n._fcRecT = setTimeout(() => reconcileChain(n), 120);
            }
          }
        }
        return r;
      };
    }
  },
  nodeCreated(node) {
    if (node.comfyClass !== "InfiniteMovieRender") return;
    addLayoutButton(node);
    addImageCounter(node);
    // 82: shot_seconds is edited in Choose (⏱) – hidden in the node.
    setTimeout(() => {
      imToggleWidget(node.widgets?.find((w) => w.name === "shot_seconds"), false);
      node.setSize([node.size[0], node.computeSize()[1]]);
    }, 0);
    const onConn = node.onConnectionsChange;
    node.onConnectionsChange = function (type, slot, connected, ...rest) {
      const r = onConn?.apply(this, [type, slot, connected, ...rest]);
      const name = this.inputs?.[slot]?.name;
      if (this._fcReady && connected && type === (globalThis.LiteGraph?.INPUT ?? 1) && name?.startsWith(IMG)) {
        setTimeout(() => addPromptForNewImage(this, name), 0);
      }
      setTimeout(() => interleave(this), 0);
      return r;
    };
  },
});

// 57b: load migration movie -> shots. 57b2: additionally type migration INFINITE_MOVIE -> SHOTS
// (user decision: the pipe is called "shots" everywhere – ID, display AND type). Old, shared/
// downloaded workflows that the migration script (tools/migrate_workflows.py) did
// not reach still store the pipe input/output under the name "movie" and/or with
// the old type. Links hang on the slot INDEX, not on the name/type - hence only name AND type
// are rewritten (incl. link.type of the wired slot), slot index and link IDs stay
// untouched. Same pattern chain (prevOnConf) as InfiniteMovie.InterleavedPrompts above
// (Vorbild :717-731).
const FC_MIGRATE_MOVIE_CLASSES = new Set(["InfiniteMovieRender", "InfiniteMovieAssemble"]);
function _fcMigrateMovieToShots(node) {
  let n = 0;
  const graph = app.graph;
  const migrateSocket = (s) => {
    if (!s) return;
    if (s.name === "movie") { s.name = "shots"; if (s.localized_name === "movie") s.localized_name = "shots"; n++; }
    // 57b2: Typ INFINITE_MOVIE -> SHOTS.
    if (s.type === "INFINITE_MOVIE") {
      s.type = "SHOTS"; n++;
      // carry along link.type of the wired slot (input: s.link; output: s.links[]).
      const ids = s.links && s.links.length ? s.links : (s.link != null ? [s.link] : []);
      for (const lid of ids) {
        const link = getLink(graph, lid);
        if (link && link.type === "INFINITE_MOVIE") { link.type = "SHOTS"; n++; }
      }
    }
  };
  for (const s of node.inputs || []) migrateSocket(s);
  for (const s of node.outputs || []) migrateSocket(s);
  if (n) console.log("[InfiniteMovie] migrated movie→shots (name+type)", node.id);
}
app.registerExtension({
  name: "InfiniteMovie.MigrateMovieToShots",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!FC_MIGRATE_MOVIE_CLASSES.has(nodeData.name)) return;
    const prevOnConf = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const r = prevOnConf?.apply(this, args);
      try { _fcMigrateMovieToShots(this); }
      catch (e) { console.error("[InfiniteMovie] migration movie→shots error:", e); }
      return r;
    };
  },
});

// Normalize Time: draw the graph of the last run below the widgets (user 2026-10-26:
// "must be visualized which normalization takes effect"). Uses the analysis of the last run
// (POST /infinite_movie/normalize_graph, retime_nodes.py) - no render, no encode.
// The node itself draws the graph below the widgets: the frontend does not show output images
// for nodes with a file upload widget (checked 2026-10-26: nodeOutputs set, node.imgs stayed empty).
function viewUrl(im) {
  const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder || "", type: im.type || "temp" });
  return api.apiURL(`/view?${q}&t=${Date.now()}`);
}

// 86 (user 2026-11-04: „just make everything … then we'll see“): Assemble viewer instead of the canvas graph.
// Tabs Graph | Timeline | Heatmap | Frames; Frames with slider, ▶ and Onion Skin (3 ghosts, in the browser
// computed). Data: ui.im_viz from retime_nodes._viz_shot/_viz_timeline (temp folder, max. 64 frames per shot).
const IMV_TABS = ["Graph", "Timeline", "Heatmap", "Frames", "Particles", "Sheet"];
// Particle color by speed (same scale as the heatmap, without the nearly black end)
const IMV_LUT = [[0.0, [66, 10, 104]], [0.33, [147, 38, 103]], [0.6, [221, 81, 58]], [0.85, [252, 165, 10]], [1.0, [252, 255, 164]]];
function imvLut(v) {
  v = Math.max(0, Math.min(1, v));
  for (let i = 1; i < IMV_LUT.length; i++) {
    const [p1, c1] = IMV_LUT[i], [p0, c0] = IMV_LUT[i - 1];
    if (v <= p1) {
      const t = (v - p0) / (p1 - p0);
      return c0.map((a, j) => Math.round(a + (c1[j] - a) * t));
    }
  }
  return IMV_LUT[IMV_LUT.length - 1][1];
}
const imvJsonCache = new Map();
function imvJson(node, url) {
  if (imvJsonCache.has(url)) return imvJsonCache.get(url);
  imvJsonCache.set(url, null);
  fetch(url).then((r) => (r.ok ? r.json() : null)).then((j) => { imvJsonCache.set(url, j); imvDraw(node); })
    .catch(() => {});
  return null;
}
const IMV_USED = "#3CBE5A", IMV_DUP = "#F08C28";
const imvImgCache = new Map();

function imvImg(node, url) {
  let img = imvImgCache.get(url);
  if (!img) {
    img = new Image();
    img.onload = () => imvDraw(node);
    img.src = url;
    imvImgCache.set(url, img);
    if (imvImgCache.size > 600) imvImgCache.delete(imvImgCache.keys().next().value);
  }
  return img;
}

function imvUrl(subfolder, filename) {
  const q = new URLSearchParams({ filename, subfolder: subfolder || "", type: "temp" });
  return api.apiURL(`/view?${q}`);
}

function imvBtn(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText = "height:22px;padding:0 9px;font:bold 11px sans-serif;border-radius:3px;border:1px solid #555;" +
    "background:#333;color:#fff;cursor:pointer;";
  b.addEventListener("click", onClick);
  return b;
}

function imvStop(st) {
  if (st.timer) { clearInterval(st.timer); st.timer = null; }
  if (st.play) st.play.textContent = "▶";
}

function imvShot(node) {
  const v = node.properties?.im_viz;
  return v?.shots?.[node._imv?.seg ?? 0] || null;
}

// 2026-11-09 (user: „Assemble window to 3×3 … all analyzers to one size“): fixed area = 3×3 Load Image tiles
// (160×160) -> 480×480, square (user 2026-11-09: portrait and landscape fit, images contain);
// every tab fills exactly this area. Director gets the same width (IMV_NODE_W).
const IMV_W = 480, IMV_H = 480, IMV_NODE_W = IMV_W + 24;
function imvFixWidth(node) {
  if (!node?.size || Math.abs(node.size[0] - IMV_NODE_W) < 1) return;
  node.setSize([IMV_NODE_W, Math.max(node.size[1], node.computeSize()[1])]);
}

// Draw an image fitted (contain) and centered into a rectangle
function imvFit(ctx, img, x, y, w, h) {
  const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

// Sheet (3×3 … 8×8 per slider): N×N evenly distributed frames of the shot (at most as many as exist)
function imvSheetPicks(n, grid) {
  const want = Math.min(grid * grid, n);
  const out = [];
  for (let i = 0; i < want; i++) {
    const k = want === 1 ? 0 : Math.round(i * (n - 1) / (want - 1));
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

function imvEnsure(node) {
  if (node._imv) return node._imv;
  const st = { tab: "Graph", seg: 0, k: 0, grid: 3, trail: 16, onion: false, timer: null, graph: null, liveTimeline: null };
  node._imv = st;
  const el = document.createElement("div");
  el.style.cssText = "display:flex;flex-direction:column;gap:4px;font:11px sans-serif;color:#D0D0D0;width:100%;";
  const row = "display:flex;gap:4px;align-items:center;height:22px;flex:none;overflow:hidden;";
  const tabRow = document.createElement("div");
  tabRow.style.cssText = row;
  st.tabBtns = IMV_TABS.map((t) => {
    const b = imvBtn(t, () => { st.tab = t; imvStop(st); imvDraw(node); });
    tabRow.appendChild(b);
    return b;
  });
  const segRow = document.createElement("div");
  segRow.style.cssText = row;
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `display:block;flex:none;width:${IMV_W}px;height:${IMV_H}px;margin:0 auto;` +
    "background:#121212;border-radius:3px;";
  canvas.addEventListener("click", (e) => {
    // Sheet: clicking a tile opens this frame in the Frames tab
    if (st.tab !== "Sheet" || !st._sheet) return;
    const r = canvas.getBoundingClientRect();
    const g = st._sheet.grid;
    const col = Math.floor((e.clientX - r.left) / r.width * g);
    const rw = Math.floor((e.clientY - r.top) / r.height * g);
    const k = st._sheet.picks[rw * g + col];
    if (k === undefined) return;
    st.k = k; st.tab = "Frames"; imvDraw(node);
  });
  const ctlRow = document.createElement("div");
  ctlRow.style.cssText = row + "gap:6px;";
  const play = imvBtn("▶", () => {
    if (st.timer) { imvStop(st); imvDraw(node); return; }
    const sh = imvShot(node);
    if (!sh) return;
    const fps = 24 / (sh.step || 1);
    play.textContent = "⏸";
    st.timer = setInterval(() => {
      const n = imvShot(node)?.frames.length || 1;
      st.k = (st.k + 1) % n;
      imvDraw(node);
    }, Math.max(20, 1000 / fps));
  });
  const slider = document.createElement("input");
  slider.type = "range"; slider.min = "0"; slider.value = "0"; slider.style.cssText = "flex:1;min-width:0;";
  slider.addEventListener("input", () => {
    if (st.tab === "Sheet") st.grid = Number(slider.value);
    else st.k = Number(slider.value);
    imvDraw(node);
  });
  const onionLbl = document.createElement("label");
  onionLbl.style.cssText = "display:flex;gap:3px;align-items:center;cursor:pointer;white-space:nowrap;";
  const onion = document.createElement("input");
  onion.type = "checkbox";
  onion.addEventListener("change", () => { st.onion = onion.checked; imvDraw(node); });
  onionLbl.appendChild(onion); onionLbl.appendChild(document.createTextNode("onion skin"));
  const gridLbl = document.createElement("span");
  gridLbl.style.cssText = "white-space:nowrap;min-width:34px;";
  const trailLbl = document.createElement("span");
  trailLbl.style.cssText = "white-space:nowrap;";
  const trail = document.createElement("input");
  trail.type = "range"; trail.min = "2"; trail.max = "48"; trail.value = String(st.trail);
  trail.style.cssText = "width:70px;flex:none;";
  trail.title = "trail length (source frames)";
  trail.addEventListener("input", () => { st.trail = Number(trail.value); imvDraw(node); });
  ctlRow.appendChild(play); ctlRow.appendChild(gridLbl); ctlRow.appendChild(slider); ctlRow.appendChild(onionLbl);
  ctlRow.appendChild(trailLbl); ctlRow.appendChild(trail);
  const info = document.createElement("div");
  info.style.cssText = "height:14px;line-height:14px;flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  el.appendChild(tabRow); el.appendChild(segRow); el.appendChild(canvas); el.appendChild(ctlRow); el.appendChild(info);
  Object.assign(st, { el, segRow, canvas, ctlRow, slider, play, onionLbl, gridLbl, trailLbl, trailIn: trail, info });
  // fixed height: area 480×480 + 4 rows (22+22+22+14) + 4 gaps -> does not jump on tab switch.
  // +20: the frontend subtracts 10 px margin top/bottom from the widget (el = height - 20); without the 20 the
  // slider and info row would stick out below the frame (user 2026-11-09 "don't fit in frame").
  node.addDOMWidget("im_viz", "div", el, {
    serialize: false,
    getMinHeight: () => IMV_H + 96 + 20,
    getMaxHeight: () => IMV_H + 96 + 20,
  });
  return st;
}

function imvDraw(node) {
  const st = imvEnsure(node);
  const v = node.properties?.im_viz;
  const shots = v?.shots || [];
  if (st.seg >= shots.length) st.seg = 0;
  st.tabBtns.forEach((b, i) => {
    const on = IMV_TABS[i] === st.tab;
    b.style.background = on ? "#2ea043" : "#333";
    b.style.borderColor = on ? "#2ea043" : "#555";
  });
  // Rows always stay (visibility instead of display) so the height stays the same
  const perShot = st.tab !== "Graph" && st.tab !== "Timeline";
  const needSeg = perShot && shots.length > 1;
  st.segRow.style.visibility = needSeg ? "visible" : "hidden";
  if (needSeg && st.segRow.childElementCount !== shots.length) {
    st.segRow.replaceChildren(...shots.map((sh, i) => imvBtn(`seg ${sh.seg}`, () => {
      st.seg = i; st.k = 0; imvStop(st); imvDraw(node); fcChooseFocus(sh.seg);
    })));
  }
  [...st.segRow.children].forEach((b, i) => { b.style.background = i === st.seg ? "#1f6feb" : "#333"; });
  const ctl = (st.tab === "Frames" || st.tab === "Particles" || st.tab === "Sheet") && shots.length;
  st.ctlRow.style.visibility = ctl ? "visible" : "hidden";
  const isSheet = st.tab === "Sheet";
  st.play.style.display = isSheet ? "none" : "";
  st.onionLbl.style.display = st.tab === "Frames" ? "flex" : "none";
  const isPart = st.tab === "Particles";
  st.trailLbl.style.display = isPart ? "" : "none";
  st.trailIn.style.display = isPart ? "" : "none";
  st.trailLbl.textContent = `trail ${st.trail}`;
  st.gridLbl.style.display = isSheet ? "" : "none";

  imvFixWidth(node);
  const W = IMV_W, H = IMV_H;
  const c = st.canvas, ctx = c.getContext("2d");
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#121212";
  ctx.fillRect(0, 0, W, H);
  st._sheet = null;

  let text = "";
  const sh = shots[st.seg];
  if (st.tab === "Graph") {
    if (st.graph?.naturalWidth) imvFit(ctx, st.graph, 0, 0, W, H);
    text = st.graph ? "timing per shot: grey = as rendered, coloured = even_motion" : "Run Assemble once to see the graph.";
  } else if (!v) {
    text = "Run Assemble once (even_motion on) to see timeline, heatmap and frames.";
  } else if (st.tab === "Timeline") {
    const tl = st.liveTimeline || (v.timeline && { subfolder: v.subfolder, filename: v.timeline });
    const img = tl && imvImg(node, imvUrl(tl.subfolder, tl.filename));
    if (img?.complete && img.naturalWidth) imvFit(ctx, img, 0, 0, W, H);
    text = "top: change per frame · bottom: grey dropped, green used, orange duplicate";
  } else if (st.tab === "Heatmap" && sh) {
    const img = imvImg(node, imvUrl(sh.subfolder, sh.heat));
    if (img.complete && img.naturalWidth) imvFit(ctx, img, 0, 0, W, H);
    text = `seg ${sh.seg} · where the picture changes (bright = most change)`;
  } else if (st.tab === "Frames" && sh) {
    const n = sh.frames.length;
    if (st.k >= n) st.k = 0;
    st.slider.min = "0";
    st.slider.max = String(Math.max(0, n - 1));
    st.slider.value = String(st.k);
    const f = sh.frames[st.k];
    const img = imvImg(node, imvUrl(sh.subfolder, f.f));
    if (img.complete && img.naturalWidth) {
      imvFit(ctx, img, 0, 0, W, H);
      if (st.onion) {
        const alphas = [0.35, 0.22, 0.12];
        [1, 2, 3].map((d) => sh.frames[st.k - d]).forEach((g, i) => {
          if (!g) return;
          const gi = imvImg(node, imvUrl(sh.subfolder, g.f));
          if (gi.complete && gi.naturalWidth) { ctx.globalAlpha = alphas[i]; imvFit(ctx, gi, 0, 0, W, H); }
        });
        ctx.globalAlpha = 1;
      }
    }
    const every = sh.step > 1 ? ` · every ${sh.step}. of ${sh.n_out}` : "";
    st.info.replaceChildren(document.createTextNode(
      `seg ${sh.seg} · ${st.k + 1}/${n}${every} · film frame #${f.out} · source #${f.src} · ${f.t.toFixed(2)} s · `));
    const tag = document.createElement("span");
    tag.textContent = f.dup ? "duplicate" : "used";
    tag.style.color = f.dup ? IMV_DUP : IMV_USED;
    st.info.appendChild(tag);
    text = null;
  } else if (st.tab === "Particles" && sh) {
    // detected image points pull trails: a trail over the last `trail` source frames, older parts dimmer
    // (ghosting), color = speed (bright = fast). Image below dimmed.
    const n = sh.frames.length;
    if (st.k >= n) st.k = 0;
    st.slider.min = "0"; st.slider.max = String(Math.max(0, n - 1)); st.slider.step = "1";
    st.slider.value = String(st.k);
    const f = sh.frames[st.k];
    const img = imvImg(node, imvUrl(sh.subfolder, f.f));
    const tj = sh.tracks ? imvJson(node, imvUrl(sh.subfolder, sh.tracks)) : null;
    let bx = 0, by = 0, bw = W, bh = H;
    if (img.complete && img.naturalWidth) {
      const sc = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      bw = img.naturalWidth * sc; bh = img.naturalHeight * sc; bx = (W - bw) / 2; by = (H - bh) / 2;
      ctx.globalAlpha = 0.35; ctx.drawImage(img, bx, by, bw, bh); ctx.globalAlpha = 1;
    }
    let shown = 0, gain = 1;
    if (tj?.tracks) {
      const L = st.trail, t = f.src;
            // Speed scale: 95th percentile of the step widths in the shot (once per file)
      if (tj._vmax === undefined) {
        const sp = [];
        for (const r of tj.tracks) for (let i = 2; i < r.p.length; i += 2) sp.push(Math.hypot(r.p[i] - r.p[i - 2], r.p[i + 1] - r.p[i - 1]));
        sp.sort((a, b) => a - b);
        tj._vmax = Math.max(1, sp[Math.floor(sp.length * 0.95)] || 1);
        // Net speed per trail (start→end / frames) – without jitter; 90th percentile for the boost
        const dv = tj.tracks.map((r) => {
          const k = r.p.length / 2 - 1;
          return Math.hypot(r.p[2 * k] - r.p[0], r.p[2 * k + 1] - r.p[1]) / Math.max(1, k);
        }).sort((a, b) => a - b);
        tj._dv = Math.max(0.05, dv[Math.floor(dv.length * 0.9)] || 1);
      }
      // Glow trails (user 2026-11-04): additive ("lighter"), per segment a wider glow + thin core,
      // older parts dimmer (ghosting); head = small spark with micro glow.
      ctx.lineCap = "round";
      ctx.globalCompositeOperation = "lighter";
      const heads = [];
      // make small motion visible: trail around the head enlarged until the fast trails
      // are net about 5 % of the image width long (at most ×12, shown in the info text)
      gain = Math.max(1, Math.min(12, 50 / (tj._dv * L)));
      for (const r of tj.tracks) {
        const len = r.p.length / 2, end = t - r.s;
        if (end < 0 || end >= len) continue;
        const start = Math.max(0, end - L);
        const hx0 = r.p[2 * end], hy0 = r.p[2 * end + 1];
        const px = (v) => bx + (hx0 + (v - hx0) * gain) / 1000 * bw;
        const py = (v) => by + (hy0 + (v - hy0) * gain) / 1000 * bh;
        for (let i = start + 1; i <= end; i++) {
          const a = (1 - (end - i) / L) ** 1.6;
          const v = Math.hypot(r.p[2 * i] - r.p[2 * i - 2], r.p[2 * i + 1] - r.p[2 * i - 1]) / tj._vmax;
          const [cr, cg, cb] = imvLut(0.35 + 0.65 * v ** 0.6);
          const x0 = px(r.p[2 * i - 2]), y0 = py(r.p[2 * i - 1]), x1 = px(r.p[2 * i]), y1 = py(r.p[2 * i + 1]);
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(0.18 * a).toFixed(3)})`;
          ctx.lineWidth = 3.2;
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(0.85 * a).toFixed(3)})`;
          ctx.lineWidth = 0.9;
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        }
        heads.push([px(r.p[2 * end]), py(r.p[2 * end + 1])]);
        shown++;
      }
      for (const [hx, hy] of heads) {
        const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, 4);
        g.addColorStop(0, "rgba(255,250,200,0.9)");
        g.addColorStop(0.35, "rgba(252,165,10,0.35)");
        g.addColorStop(1, "rgba(221,81,58,0)");
        ctx.fillStyle = g;
        ctx.fillRect(hx - 4, hy - 4, 8, 8);
        ctx.fillStyle = "#FFFFF0";
        ctx.fillRect(hx - 0.5, hy - 0.5, 1, 1);
      }
      ctx.globalCompositeOperation = "source-over";
    }
    text = !sh.tracks ? "No particle data – run Assemble again." :
      `seg ${sh.seg} · ${st.k + 1}/${n} · source #${f.src} · ${shown} particles · trail ${st.trail} frames${gain > 1.05 ? ` · motion ×${gain.toFixed(1)}` : ""} · bright = fast`;
  } else if (st.tab === "Sheet" && sh) {
    const g = st.grid;
    st.slider.min = "3"; st.slider.max = "8"; st.slider.step = "1";
    st.slider.value = String(g);
    st.gridLbl.textContent = `${g}×${g}`;
    const picks = imvSheetPicks(sh.frames.length, g);
    st._sheet = { grid: g, picks };
    // Tiles in the aspect ratio of the area (square): 3×3 = 160×160, images contain
    const T = W / g, TH = H / g, gap = 2, bar = 3;
    ctx.font = `${Math.max(9, Math.round(T / 9))}px sans-serif`;
    ctx.textBaseline = "top";
    picks.forEach((k, i) => {
      const f = sh.frames[k];
      const x = (i % g) * T, y = Math.floor(i / g) * TH;
      const img = imvImg(node, imvUrl(sh.subfolder, f.f));
      if (img.complete && img.naturalWidth) imvFit(ctx, img, x + gap / 2, y + gap / 2, T - gap, TH - gap - bar);
      ctx.fillStyle = f.dup ? IMV_DUP : IMV_USED;
      ctx.fillRect(x + gap / 2, y + TH - gap / 2 - bar, T - gap, bar);
      if (T >= 48) {
        const lbl = `#${f.out}`;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(x + gap / 2, y + gap / 2, ctx.measureText(lbl).width + 6, Math.round(T / 9) + 4);
        ctx.fillStyle = "#D0D0D0";
        ctx.fillText(lbl, x + gap / 2 + 3, y + gap / 2 + 2);
      }
    });
    const every = sh.step > 1 ? ` (every ${sh.step}. of ${sh.n_out})` : "";
    text = `seg ${sh.seg} · ${picks.length} of ${sh.frames.length} frames${every} · bar green used, orange duplicate · click = open in Frames`;
  }
  if (text !== null) st.info.textContent = text;
  const need = node.computeSize()[1];
  if (Math.abs(node.size[1] - need) > 2) node.setSize([node.size[0], need]);
  node.setDirtyCanvas(true, true);
}

function setGraph(node, im) {
  const st = imvEnsure(node);
  const img = new Image();
  img.onload = () => { st.graph = img; imvDraw(node); };
  img.src = viewUrl(im);
  if (im.timeline && im.viz_subfolder) st.liveTimeline = { subfolder: im.viz_subfolder, filename: im.timeline };
}

app.registerExtension({
  name: "InfiniteMovie.NormalizeTimeLiveGraph",
  setup() {
    api.addEventListener("executed", (e) => {
      const d = e.detail;
      const node = app.graph?.getNodeById(Number(d?.display_node || d?.node));
      if (node?.comfyClass !== "InfiniteMovieAssemble") return;
      const viz = d.output?.im_viz?.[0];
      if (viz) {
        node.properties = node.properties || {};
        node.properties.im_viz = viz;   // survives reloading the page (files until ComfyUI restart)
        const st = imvEnsure(node);
        st.liveTimeline = null; st.k = 0; imvStop(st);
      }
      const im = d.output?.images?.[0];
      if (im) setGraph(node, im);
      else imvDraw(node);
    });
  },
  nodeCreated(node) {
    if (node.comfyClass !== "InfiniteMovieAssemble") return;
    imvEnsure(node);
    setTimeout(() => imvDraw(node), 300);
    const onResize = node.onResize;
    node.onResize = function (...args) {
      const r = onResize?.apply(this, args);
      clearTimeout(this._imvRz);
      this._imvRz = setTimeout(() => imvDraw(this), 120);
      return r;
    };
    const redraw = async () => {
      try {
        const r = await fetch("/infinite_movie/normalize_graph", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ node_id: String(node.id) }),  // 110: strength/keep are fixed in Python
        });
        const j = await r.json();
        if (!r.ok) return; // no run yet: nothing to draw
        setGraph(node, j);
      } catch (e) {
        console.warn("[InfiniteMovie] normalize graph:", e);
      }
    };
    // after loading the workflow: fetch the graph of the last run (if the server still knows it)
    setTimeout(redraw, 1500);
  },
});

// 57d: the Assemble `loop` widget is hidden as long as `shots` is connected
// (the value then comes from the pipe; in Python shots["loop"] wins).
app.registerExtension({
  name: "InfiniteMovie.AssembleLoopHide",
  nodeCreated(node) {
    if (node.comfyClass !== "InfiniteMovieAssemble") return;
    // 57c: if `shots` is connected, hide file/video_path/fps/loop + the upload button
    // (Python ignores them anyway, precedence retime_nodes.py:299). Do NOT delete the values.
    const HIDDEN_WHEN_SHOTS = ["file", "video_path", "loop"];
    // 58 (2026-11-02): do NOT take widgets from node.widgets – widgets_values are positional, and graphToPrompt
    // left out the required inputs file/loop (night debug 58: strength=24 > max 1.0). Only hide,
    // Vorbild ComfyUI-LTXVideo/web/js/guider_parameters_advanced.js:22-45 (hidden + computeSize).
    const toggle = (w, show) => {
      if (!w) return;
      if (w._imOrigComputeSize === undefined) w._imOrigComputeSize = w.computeSize ?? null;
      w.hidden = !show;
      if (show) {
        if (w._imOrigComputeSize) w.computeSize = w._imOrigComputeSize;
        else delete w.computeSize;
        delete w.computedHeight;
      } else {
        w.computeSize = () => [0, -4];
        w.computedHeight = 0;
      }
    };
    // 73: copy_to is no longer a widget (input removed) -> no toggle needed.
    const setHidden = (visible) => {
      for (const name of HIDDEN_WHEN_SHOTS) toggle(node.widgets?.find((x) => x.name === name), visible);
      // hide the upload button (DOM widget, belongs to `file`)
      toggle(node.widgets?.find((x) => x._isFileUpload || x.name === "upload"), visible);
      node.setSize([node.size[0], node.computeSize()[1]]);
      node.setDirtyCanvas(true, true);
    };
    // 57c: tooltip for `file` (user 2026-11-01)
    const fileW = node.widgets?.find((x) => x.name === "file");
    if (fileW) fileW.tooltip = "Only for re-timing an existing video without the Director. Hidden while 'shots' is connected.";
    // 2026-11-09: invalid values (shifted widgets_values after a schema change, e.g. interpolate=24,
    // fps='') reset to the default – otherwise validation fails on fields that are hidden and thus
    // not correctable by the user. Valid values stay untouched.
    // Defaults as in retime_nodes.py InfiniteMovieAssemble.define_schema (the frontend does not know them here).
    const DEFAULTS = { interpolate: "RIFE x2", even_motion: true, loop: true };
    const sanitize = () => {
      for (const w of node.widgets || []) {
        const vals = w.options?.values;
        const def = DEFAULTS[w.name];
        if (w.type === "combo" && Array.isArray(vals) && vals.length && !vals.includes(w.value)) {
          if (w.name === "file") continue; // file list: an unknown file stays visible as an error
          w.value = vals.includes(def) ? def : vals[0];
        } else if (w.type === "number" && (w.value === "" || w.value === null || !Number.isFinite(Number(w.value)))) {
          w.value = def ?? w.options?.min ?? 0;
        } else if (w.type === "toggle" && typeof w.value !== "boolean") {
          w.value = def ?? true;
        } else if (w.name === "video_path" && w.value === "as rendered") {
          w.value = ""; // leftover of the removed output_size combo (shifted)
        }
      }
    };
    const update = () => {
      sanitize();
      const inp = (node.inputs || []).find((i) => i.name === "shots");
      setHidden(inp?.link == null);
    };
    setTimeout(update, 100); // after link restore (load) or immediately (new)
    const onConn = node.onConnectionsChange;
    node.onConnectionsChange = function (type, slot, connected, ...rest) {
      const r = onConn?.apply(this, [type, slot, connected, ...rest]);
      if (this.inputs?.[slot]?.name === "shots") setTimeout(update, 0);
      return r;
    };
  },
});

// Render progress on the film chain render node (user 2026-10-26: "Film x Frame ... time estimate until end").
// Reads the events of the expanded segment nodes (IDs "<render>_s<i>_...", display_node = render node):
// which segment is running, sampler step, remaining time from the mean segment duration (before the first finished
// segment estimated from the sampler progress).
function fmtTime(s) {
  if (!isFinite(s) || s < 0) return "–";
  s = Math.round(s);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function chainInfo(node) {
  // 2026-11-10: plan from the server (infinite_movie.render_plan: real shot count, frames on the engine grid)
  const plan = node._fcProg?.plan;
  if (plan) return { segs: plan.segments, frames: plan.frames };
  const imgs = (node.inputs || []).filter((i) => i.name?.startsWith(IMG) && i.link != null).length;
  const get = (n) => node.widgets?.find((w) => w.name === n)?.value;
  const segs = imgs === 1 ? (get("loop") ? 2 : 1) : get("loop") ? imgs : Math.max(imgs - 1, 0);
  const frames = Math.round(Number(get("seconds") || 1) * 24) + 1;
  return { segs, frames };
}

function progressFor(id) {
  const node = app.graph?.getNodeById(Number(id));
  if (node?.comfyClass !== "InfiniteMovieRender") return null;
  node._fcProg ??= { t0: 0, seg: -1, segStart: 0, done: [], step: 0, steps: 0, phase: "", end: 0 };
  return node;
}

function chainOf(detail) {
  const raw = String(detail?.node ?? "");
  const m = raw.match(/^(\d+)_(s(\d+)_|acquire|collector)/);
  if (m) return { node: progressFor(m[1]), seg: m[3] != null ? Number(m[3]) : null, kind: m[2] };
  const dn = detail?.display_node ?? detail?.display_node_id;
  return dn != null ? { node: progressFor(dn), seg: null, kind: "" } : null;
}

// Progress + remaining time of a director (also for Choose, user 2026-11-03: „remaining time!“).
// Remaining time from the mean segment duration; before the first finished segment from the sampler progress.
function renderEstimate(director) {
  const p = director?._fcProg;
  const { segs, frames } = chainInfo(director);
  if (!p?.t0) return { segs, frames, el: 0, frac: 0, eta: NaN, seg: -1, phase: "" };
  const now = p.end || Date.now();
  const el = (now - p.t0) / 1000;
  let frac = 0, eta = NaN;
  if (p.phase === "done") frac = 1;
  else if (segs > 0 && p.seg >= 0) {
    const inSeg = (now - p.segStart) / 1000;
    const stepFrac = p.steps ? p.step / p.steps : 0;
    // before the first finished shot: measured duration of identical shots ON THIS machine (timing.py), otherwise sampler
    const est = Number(p.plan?.seg_seconds);
    const avg = p.done.length ? p.done.reduce((a, b) => a + b, 0) / p.done.length
      : est > 0 ? Math.max(est, inSeg) : stepFrac > 0.05 ? inSeg / stepFrac : NaN;
    frac = Math.min((p.seg + (isFinite(avg) ? Math.min(inSeg / avg, 0.99) : stepFrac)) / segs, 1);
    eta = avg * (segs - p.seg) - inSeg;
  }
  return { segs, frames, el, frac, eta, seg: p.seg, phase: p.phase };
}

app.registerExtension({
  name: "InfiniteMovie.RenderProgress",
  setup() {
    api.addEventListener("executing", (e) => {
      const d = e.detail;
      if (d == null || (typeof d === "object" && d.node == null)) {
        // run finished: close all running chains
        for (const n of app.graph?._nodes || []) {
          const p = n._fcProg;
          if (p?.t0 && !p.end) { p.end = Date.now(); p.phase = "done"; n.setDirtyCanvas(true, true); }
        }
        return;
      }
      const c = chainOf(typeof d === "object" ? d : { node: d });
      if (!c?.node) return;
      const p = c.node._fcProg;
      const now = Date.now();
      if (!p.t0 || p.end) Object.assign(p, { t0: now, seg: -1, segStart: 0, done: [], step: 0, steps: 0, end: 0, plan: null });
      if (c.kind === "acquire") p.phase = "waiting for GPU";
      else if (c.kind === "collector") p.phase = "collecting";
      else if (c.seg != null && c.seg !== p.seg) {
        if (p.seg >= 0 && p.segStart) p.done.push((now - p.segStart) / 1000);
        p.seg = c.seg; p.segStart = now; p.step = 0; p.steps = 0; p.phase = "render";
      }
      c.node.setDirtyCanvas(true, true);
    });
    api.addEventListener("infinite_movie.render_plan", (e) => {
      const node = progressFor(e.detail?.node);
      if (!node) return;
      const p = node._fcProg;
      if (!p.t0 || p.end) Object.assign(p, { t0: Date.now(), seg: -1, segStart: 0, done: [], step: 0, steps: 0, end: 0 });
      p.plan = e.detail;
      node.setDirtyCanvas(true, true);
    });
    api.addEventListener("progress", (e) => {
      const c = chainOf(e.detail);
      if (!c?.node || c.seg == null) return;
      const p = c.node._fcProg;
      p.step = e.detail.value; p.steps = e.detail.max;
      c.node.setDirtyCanvas(true, true);
    });
  },
  nodeCreated(node) {
    if (node.comfyClass !== "InfiniteMovieRender") return;
    // 2026-11-09 (user: „director likewise“): same width as the Assemble viewer (3×3 tiles)
    setTimeout(() => imvFixWidth(node), 0);
    const onCfg = node.onConfigure;
    node.onConfigure = function (...a) { const r = onCfg?.apply(this, a); setTimeout(() => imvFixWidth(this), 0); return r; };
    // 2026-11-11 (user: "timeline behind the image"): the timeline is its own widget instead of an overlay at the
    // bottom edge – the image preview ComfyUI adds while rendering comes after all widgets and used to cover it.
    const progLines = (n) => {
      const p = n._fcProg;
      if (!p?.t0) return null;
      const { segs, frames, el, frac, eta } = renderEstimate(n);
      const lines = p.phase === "done"
        ? [`done: ${segs} × ${frames} frames in ${fmtTime(el)}`]
        : p.seg < 0
          ? [`${p.phase || "starting"} … ${fmtTime(el)}`
             + (p.plan?.seg_seconds > 0 ? ` · ~${fmtTime(p.plan.seg_seconds * segs)} for ${segs} shots` : "")]
          : [`segment ${p.seg + 1}/${segs} · ${frames} frames · step ${p.step}/${p.steps || "?"}`,
             `${fmtTime(el)} elapsed · ~${fmtTime(eta)} left`];
      return { p, lines, frac };
    };
    node.addCustomWidget({
      name: "im_timeline",
      type: "im_timeline",
      value: "",
      serialize: false,
      computeSize(width) {
        const d = progLines(node);
        return d ? [width, 14 + d.lines.length * 16 + 10] : [0, -4];
      },
      draw(ctx, n, width, y) {
        const d = progLines(n);
        if (!d) return;
        const { p, lines, frac } = d;
        const x = 8, w = width - 16, h = 14 + lines.length * 16;
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(x - 2, y + 2, w + 4, h + 4);
        // 2026-11-05 (user): progress bar at the very bottom, text above it
        const by = y + 4 + h - 8;
        ctx.fillStyle = "#333";
        ctx.fillRect(x, by, w, 8);
        ctx.fillStyle = p.phase === "done" ? "#66bb6a" : "#4fc3f7";
        ctx.fillRect(x, by, w * frac, 8);
        ctx.fillStyle = "#ddd";
        ctx.font = "12px sans-serif";
        lines.forEach((t, i) => ctx.fillText(t, x, y + 16 + i * 16));
        ctx.restore();
        if (p.phase !== "done") n.setDirtyCanvas(true, false); // keep the clock running
      },
    });
  },
});

// ---------------------------------------------------------------------------
// InfiniteMovie.OutputSuggestions (Auftrag 28)
//
// If you drag an output into empty space, the context menu shows
// `LiteGraph.slot_types_default_out[TYPE]`. The list is padded in
// load order (first 5, `Comfy.NodeSuggestions.number`) – our
// useful target nodes are often missing there or buried. We prepend per
// type a curated list AT THE FRONT (only nodes that exist in
// `LiteGraph.registered_node_types`), duplicates out, the rest behind.
// `slot_types_default_in` is padded for our inputs the same way.
// User settings are NOT modified.
//
// Note: `Comfy.NodeSuggestions.number` can cap the visible length –
// the curated entries stand AT THE FRONT and survive any cap.
//
// Path outputs (segment_paths, film_path, save_folder, save_name, ...) are
// plain STRING, hence the useful path consumers
// (InfiniteMovieAssemble, VHS_LoadVideoPath) are under STRING.
// ---------------------------------------------------------------------------

const FC_PREFERRED_OUT = {
  STRING: ["ShowText|pysssss", "PreviewAny",
           "InfiniteMovieAssemble", "VHS_LoadVideoPath"],
  IMAGE:  ["PreviewImage", "SaveImage",
           "UpscaleCropUniversal", "InfiniteMovieAssemble"],
  // Save/Preview/Source nodes (only if registered, fcPrependUnique filters):
  // SaveVideo (Speichern), PreviewVideo (Vorschau), GetVideoComponents (Frames),
  // VHS_VideoCombine (Encode). Beleg /object_info 2026-10-26.
  VIDEO:  ["SaveVideo", "PreviewVideo", "GetVideoComponents", "VHS_VideoCombine",
            "InfiniteMovieAssemble"],
  // SHOTS: the "pipe" (task 32) – Render → (Review) → Assemble. 57b2: type SHOTS.
  SHOTS: ["InfiniteMovieAssemble"],
  // Every further type an InfiniteMovieRender node outputs gets at least 1 display node.
  MASK:    ["PreviewAny"],
  INT:     ["PreviewAny"],
  FLOAT:   ["PreviewAny"],
  BOOLEAN: ["PreviewAny"],
};

const FC_PREFERRED_IN = {
  IMAGE: ["LoadImage"],
  VIDEO: ["LoadVideo", "VHS_LoadVideo"],
  SHOTS: ["InfiniteMovieRender", "InfiniteMovieAssemble"],
};

function fcPrependUnique(list, preferred) {
  const registered = LiteGraph.registered_node_types || {};
  const valid = preferred.filter((n) => registered[n]);
  const rest = (list || []).filter((n) => !valid.includes(n));
  const seen = new Set(valid);
  const dedupedRest = rest.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
  return [...valid, ...dedupedRest];
}

app.registerExtension({
  name: "InfiniteMovie.OutputSuggestions",
  // setup() runs GUARANTEED after the /object_info load and the registration
  // of all node types; by then LiteGraph.registered_node_types AND
  // slot_types_default_out/_in are already filled (static, not lazy).
  // ("registeredNodes" is NOT a valid ComfyUI hook – silently ignored,
  // Beleg: comfyui-pitfalls.md, 2026-10-26.)
  setup() {
    const out = LiteGraph.slot_types_default_out;
    const inn = LiteGraph.slot_types_default_in;
    if (!out || !inn) return;
    for (const [type, preferred] of Object.entries(FC_PREFERRED_OUT)) {
      out[type] = fcPrependUnique(out[type], preferred);
    }
    for (const [type, preferred] of Object.entries(FC_PREFERRED_IN)) {
      inn[type] = fcPrependUnique(inn[type], preferred);
    }
    // SHOTS (Auftrag 32): gut sichtbare Linkfarbe (hellblau). 57b2: Typ SHOTS.
    if (LiteGraph.slot_colors) {
      LiteGraph.slot_colors["SHOTS"] = "#4fc3f7";
    }
  },
});

// ---------------------------------------------------------------------------
// Shared helpers: toast + "Rerender marked" (Choose). The review node has been removed since 75.
// ---------------------------------------------------------------------------

const FC_REVIEW_LINE_COLORS = ["transparent", "#e6c229", "#e68929", "#d93025"];  // Verdachts-Linie (Choose)

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

function fcReviewToast(msg, color) {
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
function fcChooseRedoTokens(node) {
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

function fcRerenderMarked(node, rerenderFn) {
  const marked = fcChooseRedoTokens(node);
  if (!marked.length) return;
  // 57c: find the director via `shots` OR `segments`, also through reroute/intermediate nodes
  // (follow the link backwards until comfyClass === "InfiniteMovieRender").
  const g = app.graph;
  const findDirector = (inputName) => {
    const input = (node.inputs || []).find((i) => i.name === inputName);
    if (!input || input.link == null) return null;
    let link = getLink(g, input.link);
    let depth = 0;
    while (link && depth < 20) {
      const origin = g.getNodeById(link.origin_id);
      if (!origin) return null;
      if (origin.comfyClass === "InfiniteMovieRender") return origin;
      // Through a reroute/intermediate node: follow the output going into the intermediate node's input
      const inSlot = link.origin_slot;
      const out = origin.outputs?.[inSlot];
      if (!out || !out.links?.length) return null;
      link = getLink(g, out.links[0]);
      depth++;
    }
    return null;
  };
  let renderNode = findDirector("shots") || findDirector("segments");
  if (!renderNode) {
    fcReviewToast("kein Director über shots/segments gefunden", "#d93025"); return;
  }
  // extend the reseed widget by the marked numbers.
  const reseedIdx = (renderNode.widgets || []).findIndex((w) => w.name === "reseed");
  if (reseedIdx < 0) { fcReviewToast("no reseed widget on the render node", "#d93025"); return; }
  const old = renderNode.widgets[reseedIdx].value || "";
  const parts = old ? old.split(/[,;\s]+/).filter(Boolean) : [];
  const newParts = parts.concat(marked);
  // What is new (for the display during the render): only these tiles "re-rendering…", the rest stays.
  node._fc_redo_pending = {};
  // user 2026-11-08: „after rerender rejected is still active – rather not“: newly rendered shots back
  // to AUTO (no forced choice of the old variant), rejection/marking gone.
  const ch = fcChooseGetChoices(node);
  for (const t of marked) {
    const n = parseInt(t, 10), v = t.replace(/^\d+/, "");
    node._fc_redo_pending[n] = v ? [v] : ["a", "b"];
    if (n >= 1 && n <= ch.length) ch[n - 1] = "auto";
  }
  fcChooseSetChoices(node, ch);
  renderNode.widgets[reseedIdx].value = newParts.join(",");
  // Markierungen zuruecksetzen.
  node.properties.marked = [];
  node.properties.rejected = {};
  rerenderFn(node);
  // Queue + toast (test flag skips queuePrompt for the browser test).
  if (window.__fc_review_test_skip_queue) {
    console.log(`[InfiniteMovie] test: skipped queuePrompt, reseed=${newParts.join(",")}`);
  } else {
    // Seeds fixed: only the marked shots (reseed) render anew, the rest comes from the cache. Target = Choose.
    fcQueueFixedSeeds([String(node.id)]);
  }
  fcReviewToast(`Re-rendering ${marked.map((t) => `shot ${t.toUpperCase()}`).join(", ")}`);
}

// 75: InfiniteMovie.Review extension removed (node deleted).

// ---------------------------------------------------------------------------
// InfiniteMovie.Chooser (task 61): variants builder. Per transition the
// Varianten A/B nebeneinander + Vergleichskachel (B per clip-path, Trennlinie
// follows the mouse, like rgthree Image Comparer). An algorithm pre-selects
// the better variant (AUTO badge with score tooltip); the user can per
// transition override (radio A/B, click on the chosen variant =
// back to AUTO). Only ONE column is animated (mouse, otherwise last
// touched, initially the first); all others show the still image
// (..._still.webp) – A+B+comparison of the active column start in the same frame.
// "Rerender marked (n)" shares the logic with the review node
// (fcRerenderMarked) – both variants get new seeds.
// ---------------------------------------------------------------------------

// user 2026-11-03 („Choose is a mess“): new layout.
// - all shots in ONE row, no scrollbar: column width = node width / shot count,
//   images fixed 256×256 (square, contain): portrait and landscape fit without cropping, UI stays the same size;
//   the node gets wider with the shot count (2–20 shots). Margin minimal (4 px). (user 2026-11-09)
// - per shot: header (number, ✓/✗), A (and B below it), one metric row per variant.
//   click on the image or the A/B button selects; buttons GREY when no choice is possible
//   (before the run, variants = 1, while ComfyUI is rendering).
// - status row at the bottom: director missing / waiting for run / rendering … / please select / done.
// - big button ONLY when it does something: ASSEMBLE (choice changed since the last run)
//   or RERENDER n (✗ marked); never during a run.
const FC_CHOOSE_COL = 256;           // fixed square tile per shot (image contain); node gets wider, never images smaller
const FC_CHOOSE_GAP = 4;
const FC_CHOOSE_PAD = 20;            // DOM widget margin left+right in the node
const FC_CHOOSE_HEAD_H = 20, FC_CHOOSE_STAT_H = 24, FC_CHOOSE_BTNROW_H = 34;
// Effective choice of a shot: A/B from the widget only counts if the shot has both variants (otherwise after
// a run with variants=1 an old „b“ sits in the widget and sheet/seam look for a variant that does not exist).
function fcChooseEff(e, c) { return (e?.has_variants && (c === "a" || c === "b")) ? c : (e?.auto || "a"); }
// Finding of a variant in plain text (thresholds like review_nodes.JERK_HARD / LEVEL_STRONG).
// 78: e = shot entry; q.seam = red seam row to the next shot (only if e.seam_bad).
function fcChooseQuality(v, e) {
  const jerk = +v.jerk || 0, level = +v.level || 0, flags = v.flags || [];
  // 2026-11-09: show errors (sheet/still/check failed, file missing) in red instead of silently black.
  if (v.errors?.length) return { text: `✗ ${v.errors.join(" · ")}`, color: "#fff", bg: "#b3261e" };
  const names = flags.map((f) => ({ CUT: "HARD CUT", FLICKER: "FLICKER", PARTICLES: "FROZEN PARTICLES" }[f] || f));
  if (jerk >= 7 && !names.includes("HARD CUT")) names.unshift("HARD JUMP");
  let q;
  if (level >= 2 || jerk >= 7) q = { text: `⚠ ${names.join(" · ")} · jerk ${jerk.toFixed(1)}`, color: "#fff", bg: "#b3261e" };
  else if (level === 1 || names.length) q = { text: `△ slight ${names.join(" · ").toLowerCase() || "issue"} · jerk ${jerk.toFixed(1)}`, color: "#1a1a1a", bg: "#e6c229" };
  else q = { text: `✓ smooth · jerk ${jerk.toFixed(1)}`, color: "#7ee787", bg: "transparent" };
  if (e && e.seam_bad) q.seam = { text: `⚠ HARD SEAM → next · ${(+e.seam || 0).toFixed(1)}`, color: "#fff", bg: "#b3261e" };
  return q;
}
const FC_CHOOSE_STATUS_H = 26, FC_CHOOSE_BIG_H = 44;
const FC_CHOOSE_SEAM_H = 84;   // 2026-11-08: seam row (last image of this shot | first image of the next)

// 2026-11-08 (user: couple chooser + Assemble): show the shot in the Assemble viewer (click on the shot header
// in the chooser) or highlight it in the chooser (seg button in the Assemble viewer). number = shot number (1-based).
function fcAsmFocus(number) {
  for (const a of app.graph?._nodes || []) {
    if (a.comfyClass !== "InfiniteMovieAssemble" || !a._imv) continue;
    const shots = a.properties?.im_viz?.shots || [];
    const i = shots.findIndex((sh) => sh.seg === number);
    if (i < 0) continue;
    const st = a._imv;
    st.seg = i; st.k = 0; imvStop(st);
    if (st.tab === "Graph" || st.tab === "Timeline") st.tab = "Sheet";
    imvDraw(a);
  }
}
function fcChooseFocus(number) {
  for (const c of fcChooseAll()) {
    c._fc_choose_focus = number;
    c._fc_choose_el?.querySelectorAll(".fc-choose-head").forEach((h, i) => {
      h.style.color = i + 1 === number ? "#58a6ff" : "#fff";
    });
  }
}

// Run state of ComfyUI (for status + greying out), global from the api events.
const fcRun = { running: false, node: "", value: 0, max: 0 };
function fcChooseAll() { return (app.graph?._nodes || []).filter((n) => n.comfyClass === "InfiniteMovieChooser"); }
function fcChooseRefreshAll() { for (const n of fcChooseAll()) fcChooseRender(n); }
// Auto layout (web/infinite_movie_layout.js) refreshes Choose BEFORE measuring – otherwise the old width,
// because Choose otherwise only adapts when drawing (onDrawForeground).
window.fcChooseRefreshAll = fcChooseRefreshAll;
api.addEventListener("status", (e) => {
  const busy = (e.detail?.exec_info?.queue_remaining || 0) > 0;
  if (busy !== fcRun.running) { fcRun.running = busy; if (!busy) { fcRun.node = ""; fcRun.max = 0; fcRun.promptOnly = undefined; fcAsmClear(); } fcChooseRefreshAll(); }
});
api.addEventListener("executing", (e) => {
  const id = e.detail?.node ?? e.detail;
  if (id == null) return;
  fcRun.running = true;
  const top = String(id).split(":")[0].split(".")[0];
  const n = app.graph?.getNodeById?.(top);
  fcRun.node = n ? (n.title || n.type) : String(id);
  // Only generating a prompt (Regenerate) is not a render: Choose stays operable (user 2026-11-03)
  fcRun.promptOnly = n?.comfyClass === "InfiniteMovieAutoPrompt" ? (fcRun.promptOnly ?? true) : false;
  fcRun.max = 0;
  for (const c of fcChooseAll()) fcChooseStatus(c);
});
api.addEventListener("progress", (e) => {
  fcRun.value = e.detail?.value || 0; fcRun.max = e.detail?.max || 0;
  for (const c of fcChooseAll()) fcChooseStatus(c);
});
// Film built (Film or Assemble ran) -> remember the used choice („Film assembled“)
api.addEventListener("executed", (e) => {
  const n = app.graph?.getNodeById?.(String(e.detail?.node ?? "").split(":")[0]);
  if (n?.comfyClass !== "InfiniteMovieFilm" && n?.comfyClass !== "InfiniteMovieAssemble") return;
  for (const c of fcChooseAll()) { c._fc_asm_t0 = null; c._fc_choose_ran = fcChooseEffective(c).join(","); fcChooseStatus(c); }
});
function fcAsmClear() { for (const c of fcChooseAll()) if (c._fc_asm_t0) { c._fc_asm_t0 = null; fcChooseStatus(c); } }
api.addEventListener("execution_error", () => { fcAsmClear(); });
// Cancel: remove half/old films, end the progress (user 2026-11-03)
api.addEventListener("execution_interrupted", () => {
  for (const n of app.graph?._nodes || []) {
    const p = n._fcProg;
    if (p?.t0 && !p.end) { p.end = Date.now(); p.phase = "cancelled"; n.setDirtyCanvas(true, true); }
  }
  fcRun.running = false; fcRun.node = ""; fcRun.max = 0;
  fcAsmClear();
  fcClearFilms({ choose: true });   // do not leave half shots standing as „ready“
  fcReviewToast("Cancelled – film removed.");
});
// Update the remaining time in Choose every second (events only come on sampler steps)
setInterval(() => {
  for (const c of fcChooseAll()) {
    // Never started (e.g. validation error) -> release the waiting state after 15 s
    if (c._fc_asm_t0 && !fcRun.running && Date.now() - c._fc_asm_t0 > 15000) c._fc_asm_t0 = null;
    if (fcRun.running || c._fc_asm_t0 != null) fcChooseStatus(c);
  }
}, 1000);

// Choose adapts to the film length BEFORE the run. Column count from the connected
// director (connected images, loop, intro/outro, variants – same counting as
// total_segments in nodes.py).
function fcChooseDirectorOf(node) {
  let n = node, guard = 0;
  while (n && guard++ < 10) {
    const inp = n.comfyClass === "Reroute" ? n.inputs?.[0] : n.inputs?.find((i) => i.name === "shots");
    if (inp?.link == null) return null;
    n = n.graph?.getNodeById(getLink(n.graph, inp.link)?.origin_id);
    if (n?.comfyClass === "InfiniteMovieRender") return n;
  }
  return null;
}

// 80: find the Auto Prompt node for a shot: director input `shot_prompts.prompt{k-1}`
// (shot number 1-based), also follow the link through reroutes – model fcChooseDirectorOf.
function fcChoosePromptNodeOf(node, shotNumber) {
  const d = fcChooseDirectorOf(node);
  if (!d) return null;
  const inp = (d.inputs || []).find((i) => i.name === `shot_prompts.prompt${shotNumber - 1}`);
  if (inp?.link == null) return null;
  let n = d.graph?.getNodeById(getLink(d.graph, inp.link)?.origin_id), guard = 0;
  while (n && guard++ < 10) {
    if (n.comfyClass === "InfiniteMovieAutoPrompt") return n;
    if (n.comfyClass !== "Reroute") return null;
    const r = n.inputs?.[0];
    if (r?.link == null) return null;
    n = n.graph?.getNodeById(getLink(n.graph, r.link)?.origin_id);
  }
  return null;
}

// 80: „✎ prompt" per Choose column: expands a text field with the prompt of this transition
// (source: prompt widget of the Auto Prompt node at the director input). Saving writes the text
// into the widget (callback like a manual change) and marks the shot REDO (setMarked) – RERENDER
// then only renders this shot, because the changed prompt changes the segment key (reuse logic).
function fcChooseEditPrompt(node, col, e, setMarked) {
  const ap = fcChoosePromptNodeOf(node, e.number);
  const w = ap?.widgets?.find((x) => x.name === "prompt");
  if (!ap || !w) {
    fcReviewToast(`Shot ${e.number}: no Auto Prompt node connected to its prompt input.`);
    return;
  }
  const ov = document.createElement("div");
  ov.style.cssText = "position:absolute;inset:0;z-index:20;background:rgba(12,12,12,0.96);" +
    "display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:3px;";
  // Do NOT pass text field events through to the canvas (pointer drag/pan + canvas keyboard shortcuts).
  for (const t of ["pointerdown", "pointerup", "pointermove", "wheel", "mousedown", "mouseup",
    "dblclick", "contextmenu", "keydown", "keyup", "dragstart"]) {
    ov.addEventListener(t, (ev) => ev.stopPropagation());
  }
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;justify-content:space-between;font:bold 13px sans-serif;color:#fff;";
  const ht = document.createElement("span");
  ht.textContent = `Prompt – Shot ${e.number}`;
  const x = document.createElement("span");
  x.textContent = "✕";
  x.style.cssText = "cursor:pointer;color:#aaa;padding:0 4px;";
  head.appendChild(ht);
  head.appendChild(x);
  const ta = document.createElement("textarea");
  ta.value = String(w.value ?? "");
  ta.style.cssText = "flex:1;min-height:60px;resize:none;background:#1a1a1a;color:#ddd;border:1px solid #444;" +
    "border-radius:3px;padding:6px;font:12px/1.4 monospace;";
  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;gap:6px;";
  const mk = (label, bg, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = `flex:1;height:28px;font:bold 13px sans-serif;color:#fff;background:${bg};border:none;border-radius:3px;cursor:pointer;`;
    b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
    return b;
  };
  const save = () => {
    const text = ta.value;
    const old = w.value;
    // Like the frontend setValue: unchanged text triggers no change (no REDO marking,
    // no incrementVersion/dirty), because the segment key stays the same anyway.
    if (text === old) {
      ov.remove();
      fcReviewToast(`Shot ${e.number}: prompt unchanged – nothing to re-render.`);
      return;
    }
    w.value = text;
    w.callback?.(text);
    // Frontend's own programmatic path (like setValue in the frontend, nodeDefStore): onWidgetChanged
    // + incrementVersion, so the Modified flag and foreign onWidgetChanged hooks see the change.
    ap.onWidgetChanged?.(w.name, text, old, w);
    ap.graph?.incrementVersion?.();
    setMarked(true);
    fcChooseRender(node);
    fcReviewToast(`Shot ${e.number}: prompt saved – marked ✗ REDO.`);
  };
  const cancel = () => ov.remove();
  x.addEventListener("click", (ev) => { ev.stopPropagation(); cancel(); });
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") cancel();
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) save();
  });
  foot.appendChild(mk("💾 save", "#2ea043", save));
  foot.appendChild(mk("cancel", "#333", cancel));
  ov.appendChild(head);
  ov.appendChild(ta);
  ov.appendChild(foot);
  col.appendChild(ov);
  ta.focus();
  ta.select();
}

// 82: „⏱ X s“ per Choose column: overlay with a number field (step 0.5, min 0.5, max 20)
// + „save“ / „global“ (= entry 0). Saving writes the entry (index e.number - 1)
// into the director widget 'shot_seconds' and marks the shot REDO (setMarked) – the length
// is part of the segment key, hence RERENDER only renders this shot (reuse logic).
function fcChooseEditSeconds(node, col, e, setMarked) {
  const d = fcChooseDirectorOf(node);
  const w = d?.widgets?.find((x) => x.name === "shot_seconds");
  if (!d || !w) {
    fcReviewToast(`Shot ${e.number}: no Director with a shot_seconds widget found.`);
    return;
  }
  const ov = document.createElement("div");
  ov.style.cssText = "position:absolute;inset:0;z-index:20;background:rgba(12,12,12,0.96);" +
    "display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:3px;";
  // Do NOT pass number field events through to the canvas (pointer drag/pan + canvas keyboard shortcuts).
  for (const t of ["pointerdown", "pointerup", "pointermove", "wheel", "mousedown", "mouseup",
    "dblclick", "contextmenu", "keydown", "keyup", "dragstart"]) {
    ov.addEventListener(t, (ev) => ev.stopPropagation());
  }
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;justify-content:space-between;font:bold 13px sans-serif;color:#fff;";
  const ht = document.createElement("span");
  ht.textContent = `Length – Shot ${e.number}`;
  const x = document.createElement("span");
  x.textContent = "✕";
  x.style.cssText = "cursor:pointer;color:#aaa;padding:0 4px;";
  head.appendChild(ht);
  head.appendChild(x);
  const num = document.createElement("input");
  num.type = "number";
  num.min = "0.5";
  num.max = "20";
  num.step = "0.5";
  num.value = String(fcShotSecondsOf(d, e.number));
  num.style.cssText = "height:30px;background:#1a1a1a;color:#ddd;border:1px solid #444;border-radius:3px;padding:0 6px;font:13px monospace;";
  const hint = document.createElement("div");
  hint.style.cssText = "font:11px sans-serif;color:#888;";
  hint.textContent = "0.5 – 20 s in 0.5 steps · 'global' = use the Director's 'seconds' value";
  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;gap:6px;";
  const mk = (label, bg, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = `flex:1;height:28px;font:bold 13px sans-serif;color:#fff;background:${bg};border:none;border-radius:3px;cursor:pointer;`;
    b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
    return b;
  };
  const write = (v) => {
    const list = fcParseShotSeconds(w.value);
    while (list.length < e.number - 1) list.push(0);
    list[e.number - 1] = v;
    while (list.length && list[list.length - 1] === 0) list.pop();
    const text = list.join(", ");
    const old = w.value;
    // Like fcChooseEditPrompt: unchanged text triggers no change (no REDO marking).
    if (text === old) {
      ov.remove();
      fcReviewToast(`Shot ${e.number}: length unchanged – nothing to re-render.`);
      return;
    }
    w.value = text;
    w.callback?.(text);
    // Frontend's own programmatic path (like fcChooseEditPrompt): onWidgetChanged
    // + incrementVersion, so the Modified flag and foreign hooks see the change.
    d.onWidgetChanged?.("shot_seconds", text, old, w);
    d.graph?.incrementVersion?.();
    setMarked(true);
    fcChooseRender(node);
    fcReviewToast(`Shot ${e.number}: length ${v > 0 ? `${v} s` : "global"} – marked ✗ REDO.`);
  };
  const save = () => {
    let v = parseFloat(num.value);
    if (isNaN(v) || v < 0.5) v = 0.5;
    if (v > 20) v = 20;
    write(v);
  };
  const cancel = () => ov.remove();
  x.addEventListener("click", (ev) => { ev.stopPropagation(); cancel(); });
  num.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") cancel();
    if (ev.key === "Enter") save();
  });
  foot.appendChild(mk("💾 save", "#2ea043", save));
  foot.appendChild(mk("global", "#555", () => write(0)));
  foot.appendChild(mk("cancel", "#333", cancel));
  ov.appendChild(head);
  ov.appendChild(num);
  ov.appendChild(hint);
  ov.appendChild(foot);
  col.appendChild(ov);
  num.focus();
  num.select();
}

function fcChoosePlan(node) {
  const d = fcChooseDirectorOf(node);
  if (!d) return null;
  const nImg = (d.inputs || []).filter((i) => i.name?.startsWith("images.") && i.link != null).length;
  if (nImg < 1) return { n: 0, variants: false, director: d, nImg };
  const wv = (name) => d.widgets?.find((w) => w.name === name)?.value;
  const loop = !!wv("loop");  // 1 image: open shot, + loop shot (last frame -> image) when loop is on
  let n = nImg === 1 ? (loop ? 2 : 1) : (loop ? nImg : nImg - 1);
  return { n, variants: String(wv("variants")) === "2", director: d, nImg };
}

// Real entries (after the run) or placeholders from the plan; stale entries
// (column count or variants no longer fit the director) yield to the placeholders.
function fcChooseEntries(node) {
  const real = node._fc_choose_entries || [];
  const plan = fcChoosePlan(node);
  if (real.length && (!plan || (plan.n === real.length && plan.variants === !!real[0]?.has_variants))) return real;
  if (!plan || !plan.n) return real.length && !plan ? real : [];
  return Array.from({ length: plan.n }, (_, i) => ({
    number: i + 1, placeholder: true, has_variants: plan.variants, a: {}, b: plan.variants ? {} : null,
  }));
}

function fcChooseSig(e) { return e.length + (e[0]?.placeholder ? "p" : "r") + (e[0]?.has_variants ? "v" : ""); }

// Tile square: height = column width (film aspect ratio irrelevant).
function fcChooseLayout(node, entries) {
  const colW = FC_CHOOSE_COL;
  const tileH = colW;
  const v = entries[0]?.has_variants ? 2 : 1;
  // 78: reserve the seam row if any shot has seam_bad (otherwise clipping).
  const seamH = entries.some((e) => !e.placeholder && e.seam_next) ? FC_CHOOSE_SEAM_H + FC_CHOOSE_GAP : 0;
  const colH = FC_CHOOSE_HEAD_H + v * (tileH + FC_CHOOSE_GAP + FC_CHOOSE_STAT_H) + seamH + (entries[0]?.placeholder ? 0 : FC_CHOOSE_BTNROW_H + FC_CHOOSE_GAP);
  const sheet = fcChooseSheetSize(entries);
  const domH = (entries.length ? colH : 0) + FC_CHOOSE_GAP + FC_CHOOSE_STATUS_H + FC_CHOOSE_GAP + FC_CHOOSE_BIG_H + 8
    + (sheet ? FC_CHOOSE_GAP + sheet[1] : 0);
  return { colW, tileH, domH, sheet };
}
// 2026-11-08 (user: „dont like 3x3 in same window … put them to bottom“, then „2x 3x3 at the bottom side by side, i.e.
// under each image“): at the bottom of the chooser a row of 3×3 sheets, per shot exactly under its column (same width).
// The chosen variant is shown; mouse over tile A/B shows its sheet.
function fcChooseSheetSize(entries) {
  if (!entries.some((e) => !e.placeholder && (e.a?.sheet || e.b?.sheet))) return null;
  return [FC_CHOOSE_COL, FC_CHOOSE_COL];
}
function fcChooseUpdateSheet(node, only = -1) {
  const cells = node._fc_sheet_cells || [];
  const entries = node._fc_choose_entries || [];
  const choices = fcChooseGetChoices(node);
  cells.forEach((cell, i) => {
    if (only >= 0 && i !== only) return;
    const e = entries[i];
    if (!e || !cell) return;
    const eff = fcChooseEff(e, choices[i]);
    const k = (node._fc_sheet_hover?.[0] === i && e[node._fc_sheet_hover[1]]) ? node._fc_sheet_hover[1] : eff;
    const im = e[k]?.sheet;
    const src = im ? fcChooseStableUrl(im) : "";
    if (src && cell.img.getAttribute("src") !== src) cell.img.setAttribute("src", src);
    cell.img.style.visibility = src ? "visible" : "hidden";
    const err = e[k]?.errors?.find((x) => x.startsWith("sheet")) || (e.placeholder ? "" : e[k] ? "" : `variant ${k.toUpperCase()} missing`);
    cell.lbl.textContent = src ? `Shot ${e.number}${e.has_variants ? " · " + k.toUpperCase() : ""} · 3×3`
      : err ? `✗ Shot ${e.number}: ${err}` : "no sheet yet – Run";
    cell.lbl.style.color = !src && err ? "#ff6b6b" : "";
  });
}

function fcChooseWidth(n) { return Math.max(420, FC_CHOOSE_PAD + n * FC_CHOOSE_COL + (n - 1) * FC_CHOOSE_GAP); }

function fcChooseStableUrl(im) {
  // Stable URL WITHOUT cache buster: when switching still<->animated the file comes from the cache.
  const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder || "", type: im.type || "temp" });
  return api.apiURL(`/view?${q}`);
}

// Read/write the choices widget (format 'auto,b,auto', like _parse_choices in review_nodes.py).
function fcChooseGetChoices(node) {
  const w = node.widgets?.find((x) => x.name === "choices");
  const parts = String(w?.value || "").split(",").map((s) => s.trim().toLowerCase());
  const n = (node._fc_choose_entries || []).length;
  return Array.from({ length: n }, (_, i) => (parts[i] === "a" || parts[i] === "b") ? parts[i] : "auto");
}
function fcChooseSetChoices(node, arr) {
  const w = node.widgets?.find((x) => x.name === "choices");
  if (w) w.value = arr.join(",");
}
// Effective choice per shot ('a'/'b'), AUTO resolved.
function fcChooseEffective(node) {
  const c = fcChooseGetChoices(node);
  return (node._fc_choose_entries || []).map((e, i) => fcChooseEff(e, c[i]));
}

// Live preview: only the column under the mouse is animated, all others show the still image.
function fcChooseApplyActive(node) {
  const el = node._fc_choose_el;
  if (!el) return;
  const active = node._fc_choose_active ?? -1;
  const entries = node._fc_choose_entries || [];
  el.querySelectorAll(".fc-choose-col").forEach((col, i) => {
    const e = entries[i];
    if (!e) return;
    for (const k of ["a", "b"]) {
      const img = col.querySelector(`.fc-tile-${k} img`), v = e[k];
      if (!img || !v) continue;
      const im = (i === active && v.preview) ? v.preview : (v.still || v.preview);
      const src = im ? fcChooseStableUrl(im) : "";
      if (src && img.getAttribute("src") !== src) img.setAttribute("src", src);
    }
  });
}

// State for the status row + button.
function fcChooseState(node) {
  const entries = fcChooseEntries(node);
  const plan = fcChoosePlan(node);
  const marked = node.properties?.marked || [];
  if (!plan) return { text: "Connect the Director's shots output to this node.", tone: "warn", btn: null };
  if (!plan.n) return { text: "Connect at least 1 image to the Director.", tone: "warn", btn: null };
  // 2026-11-05 (user: „you need immediate feedback on press“): visible from the click until the film is there.
  if (node._fc_asm_t0) {
    const sec = Math.round((Date.now() - node._fc_asm_t0) / 1000);
    const where = fcRun.running && fcRun.node ? ` · ${fcRun.node}` : " · queued";
    const p = fcRun.max ? ` ${fcRun.value}/${fcRun.max}` : "";
    return { text: `Assembling film… ${sec} s${where}${p}`, tone: "busy", btn: "busy" };
  }
  if (fcRun.running && fcRun.promptOnly) {
    const st = fcChooseStateIdle(node, entries, plan, marked);
    return { ...st, text: `Writing prompt (${fcRun.node})… · ${st.text}` };
  }
  if (fcRun.running) {
    const dir = (app.graph?._nodes || []).find((n) => n.comfyClass === "InfiniteMovieRender" && n._fcProg?.t0 && !n._fcProg.end);
    const r = dir && renderEstimate(dir);
    if (r && r.seg >= 0) {
      const left = isFinite(r.eta) ? ` · ~${fmtTime(r.eta)} left` : " · estimating…";
      return { text: `Rendering shot ${r.seg + 1}/${r.segs} · ${fmtTime(r.el)} elapsed${left}`, tone: "busy", btn: null, frac: r.frac };
    }
    const p = fcRun.max ? ` · ${fcRun.value}/${fcRun.max}` : "";
    return { text: `Rendering… please wait (${r?.phase || fcRun.node || "queued"}${p})`, tone: "busy", btn: null };
  }
  return fcChooseStateIdle(node, entries, plan, marked);
}

// 79: Schritt-Pfad 1 Prompts › 2 Run › 3 Pick › 4 ASSEMBLE (Statuszeile, vorn).
function fcChooseSteps(node) {
  const entries = fcChooseEntries(node);
  const isPlaceholder = !!entries[0]?.placeholder;
  const filmDone = node._fc_choose_ran != null;
  const aps = (app.graph?._nodes || []).filter((n) => n.comfyClass === "InfiniteMovieAutoPrompt");
  const promptsFilled = aps.length === 0 || aps.every((n) => {
    const w = n.widgets?.find((x) => x.name === "prompt");
    return w && String(w.value || "").trim().length > 0;
  });
  let s1, s2, s3, s4;
  if (filmDone) { s1 = s2 = s3 = s4 = "done"; }
  else if (!isPlaceholder) { s1 = "done"; s2 = "done"; s3 = "current"; s4 = "open"; }
  else { s1 = promptsFilled ? "done" : "open"; s2 = "current"; s3 = "open"; s4 = "open"; }
  return [
    { label: "1 Prompts", state: s1 }, { label: "2 Run", state: s2 },
    { label: "3 Pick", state: s3 }, { label: "4 ASSEMBLE", state: s4 },
  ];
}
function fcChooseUpdateSteps(node) {
  const el = node._fc_choose_steps;
  if (!el) return;
  const steps = fcChooseSteps(node);
  el.innerHTML = steps.map((s, i) => {
    const col = s.state === "done" ? "#7ee787" : s.state === "current" ? "#fff" : "#666";
    const fw = s.state === "current" ? "bold" : "normal";
    const sep = i < steps.length - 1 ? '<span style="color:#555;margin:0 1px;">\u203A</span>' : "";
    return `<span style="color:${col};font-weight:${fw};">${s.label}</span>${sep}`;
  }).join("");
}

function fcChooseStateIdle(node, entries, plan, marked) {
  if (entries[0]?.placeholder) return { text: `Waiting for Run: ${entries.length} shot(s)${plan.variants ? " × 2 variants" : ""} will appear here.`, tone: "idle", btn: null };
  const redo = fcChooseRedoTokens(node);
  if (redo.length) return { text: `${redo.map((t) => t.toUpperCase()).join(", ")} marked ✗ – RERENDER renders only these with new seeds.`, tone: "act", btn: "rerender" };
  if (node._fc_choose_ran == null) return { text: entries[0]?.has_variants ? "Shots ready – pick A or B per shot, then ASSEMBLE builds the film."
    : "Shots ready – ASSEMBLE builds the film.", tone: "act", btn: "assemble" };
  const changed = (node._fc_choose_ran || "") !== fcChooseEffective(node).join(",");
  if (changed) return { text: "Choice changed – press ASSEMBLE to rebuild the film.", tone: "act", btn: "assemble" };
  if (entries[0]?.has_variants) return { text: "Film assembled. Pick A or B per shot to change it, ✓/✗ to re-render a shot.", tone: "ok", btn: null };
  return { text: "Film assembled. Mark a shot ✗ to re-render it.", tone: "ok", btn: null };
}

function fcChooseStatus(node) {
  const st = fcChooseState(node);
  const s = node._fc_choose_status, b = node._fc_choose_btn;
  if (s) {
    const col = { warn: "#e3b341", busy: "#4fc3f7", idle: "#aaa", act: "#fff", ok: "#7ee787" }[st.tone] || "#aaa";
    const sText = node._fc_choose_status_text;
    if (sText) { sText.textContent = st.text; sText.style.color = col; }
    // Progress bar in the background of the status row (user 2026-11-03: „missing progress bar“)
    const pct = st.frac != null ? Math.round(Math.max(0, Math.min(1, st.frac)) * 100) : null;
    s.style.background = pct == null ? "#202020"
      : `linear-gradient(90deg, #1f6feb 0%, #1f6feb ${pct}%, #202020 ${pct}%, #202020 100%)`;
    if (pct != null && sText) { sText.style.color = "#fff"; sText.textContent = `${pct}% · ${st.text}`; }
    fcChooseUpdateSteps(node);
  }
  if (b) {
    b.style.visibility = st.btn ? "visible" : "hidden";
    b.style.cursor = st.btn === "busy" ? "progress" : "pointer";
    if (st.btn === "busy") {
      b.textContent = "⏳ ASSEMBLING…"; b.style.background = "#30363d"; b.style.borderColor = "#4fc3f7";
      b.title = "Film is being built – see the status line above.";
    } else if (st.btn === "assemble") {
      b.textContent = "ASSEMBLE ▶"; b.style.background = "#2ea043"; b.style.borderColor = "#2ea043";
      b.title = "Rebuild the film from the chosen variants (Director + Choose come from cache, only Assemble runs).";
    } else if (st.btn === "rerender") {
      const m = fcChooseRedoTokens(node).length;
      b.textContent = `RERENDER ${m} ↻`; b.style.background = "#d93025"; b.style.borderColor = "#d93025";
      b.title = "Re-render the marked shots (new seeds), then choose again.";
    }
    b._fc_mode = st.btn;
  }
  // Lock the A/B buttons + image click while rendering
  node._fc_choose_el?.querySelectorAll(".fc-keep").forEach((x) => { x.style.opacity = fcRun.running ? "0.35" : "1"; });
}

function fcChoosePick(node, i, letter) {
  if (fcRun.running) return;
  const e = (node._fc_choose_entries || [])[i];
  if (!e || e.placeholder || !e.has_variants) return;
  const c = fcChooseGetChoices(node);
  // Choice = auto winner → AUTO again (badge stays visible), otherwise a fixed choice.
  c[i] = letter === e.auto ? "auto" : letter;
  fcChooseSetChoices(node, c);
  fcChooseRender(node);
}

function fcChooseRender(node) {
  let el = node._fc_choose_el;
  if (!el) {
    el = document.createElement("div");
    el.style.cssText = "width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:" + FC_CHOOSE_GAP + "px;";
    const domW = node.addDOMWidget("fc_choose", "div", el, {
      serialize: false,
      getMinHeight: () => fcChooseLayout(node, fcChooseEntries(node)).domH,
      getMaxHeight: () => fcChooseLayout(node, fcChooseEntries(node)).domH,
    });
    // 79 (user 2026-11-03: Choose „halved“): the frontend takes the frame width from widget.width
    // (DomWidgets updateWidgets: (n.width ?? node.width) - 2*margin). widget.width stayed at an old,
    // smaller value (624) when Choose grew -> right shots cut off. Always the node width.
    if (domW) Object.defineProperty(domW, "width", { get: () => node.size[0], set() {}, configurable: true });
    node._fc_choose_el = el;
    // 77 (user 2026-11-03: „half covered … was ok until I pressed Render“): the frontend clips
    // DOM widgets where the SELECTED element is (Comfy.DOMClippingEnabled, useDomClipping) –
    // a selected group/node over Choose made the right shots disappear. Off for Choose.
    const unclip = () => {
      const w = el.parentElement;
      if (w && w.style.clipPath && w.style.clipPath !== "none") w.style.clipPath = "none";
    };
    setTimeout(() => {
      const w = el.parentElement;
      if (!w) return;
      unclip();
      new MutationObserver(unclip).observe(w, { attributes: true, attributeFilter: ["style"] });
    }, 0);
  }
  const entries = fcChooseEntries(node);
  const sig = fcChooseSig(entries);
  node._fc_choose_sig = sig;
  const { colW, tileH } = fcChooseLayout(node, entries);
  const marked = node.properties.marked || [];
  const choices = fcChooseGetChoices(node);
  el.innerHTML = "";

  if (entries.length) {
    const row = document.createElement("div");
    row.style.cssText = `display:flex;gap:${FC_CHOOSE_GAP}px;overflow:hidden;`;
    el.appendChild(row);
    entries.forEach((e, i) => {
      const col = document.createElement("div");
      col.className = "fc-choose-col";
      col.style.cssText = `display:flex;flex-direction:column;gap:${FC_CHOOSE_GAP}px;width:${colW}px;flex:0 0 ${colW}px;min-width:0;position:relative;`;
      col.addEventListener("mouseenter", () => { node._fc_choose_active = i; fcChooseApplyActive(node); });
      col.addEventListener("mouseleave", () => { node._fc_choose_active = -1; fcChooseApplyActive(node); });

      const head = document.createElement("div");
      head.style.cssText = `display:flex;align-items:center;height:${FC_CHOOSE_HEAD_H}px;font:bold 13px sans-serif;color:#fff;`;
      head.className = "fc-choose-head";
      head.textContent = `Shot ${e.number}`;
      if (node._fc_choose_focus === e.number) head.style.color = "#58a6ff";
      if (!e.placeholder) {
        head.style.cursor = "pointer";
        head.title = "Show this shot in Assemble's viewer (Sheet / Frames / Particles)";
        head.addEventListener("click", (ev) => {
          if (ev.target !== head) return;
          ev.stopPropagation(); fcChooseFocus(e.number); fcAsmFocus(e.number);
        });
      }
      col.appendChild(head);
      // 74 (user 2026-11-03: „clearly where hop or top“): KEEP/REDO big below the images, click on the image.
      const isMarked = !e.placeholder && marked.includes(e.number);
      const toggleRedo = () => {
        if (fcRun.running || e.placeholder) return;
        const m = (node.properties.marked || []).slice();
        const k = m.indexOf(e.number);
        if (k >= 0) m.splice(k, 1); else m.push(e.number);
        node.properties.marked = m;
        if (k >= 0) setRejected([]);   // KEEP again: forget the rejection
        fcChooseRender(node);
      };
      const rej = (node.properties.rejected ||= {});
      const rejected = rej[e.number] || [];
      const setRejected = (arr) => { if (arr.length) rej[e.number] = arr; else delete rej[e.number]; };
      const setMarked = (on) => {
        const m = (node.properties.marked || []).filter((x) => x !== e.number);
        if (on) m.push(e.number);
        node.properties.marked = m;
      };

      const eff = e.placeholder ? null : fcChooseEff(e, choices[i]);
      const isAuto = !e.placeholder && choices[i] !== "a" && choices[i] !== "b";
      const canPick = !e.placeholder && !!e.has_variants;
      const letters = e.has_variants ? ["a", "b"] : ["a"];
      for (const k of letters) {
        const v = e[k] || {};
        const sel = e.has_variants && eff === k;
        const pending = !e.placeholder && !!node._fc_redo_pending?.[e.number]?.includes(k);
        const dim = !e.placeholder && (pending || isMarked || (e.has_variants && !sel));
        const t = document.createElement("div");
        t.className = `fc-tile-${k}`;
        t.addEventListener("mouseenter", () => { node._fc_sheet_hover = [i, k]; fcChooseUpdateSheet(node, i); });
        t.addEventListener("mouseleave", () => { node._fc_sheet_hover = null; fcChooseUpdateSheet(node, i); });
        t.style.cssText = `position:relative;width:${colW}px;height:${tileH}px;background:#1a1a1a;border-radius:3px;` +
          `overflow:hidden;box-sizing:border-box;cursor:${e.placeholder ? "default" : "pointer"};` +
          (e.placeholder ? "border:1px dashed #555;" : isMarked ? "outline:5px solid #d93025;outline-offset:-5px;"
            : sel || !e.has_variants ? "outline:5px solid #2ea043;outline-offset:-5px;" : "");
        t.title = v.info || "";
        const img = document.createElement("img");
        img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;" +
          (dim ? "opacity:0.35;filter:grayscale(0.8);" : "");
        t.appendChild(img);
        if (!e.placeholder) {
          const lab = document.createElement("div");
          const on = sel || !e.has_variants;
          const no = isMarked || rejected.includes(k);
          lab.textContent = pending ? `↻ ${e.has_variants ? k.toUpperCase() + " " : ""}new render…` : isMarked ? "✗ REDO" : no ? `✗ ${k.toUpperCase()}`
            : e.has_variants ? (sel ? `✓ ${k.toUpperCase()}${isAuto && e.auto_strong ? " · AUTO" : ""}` : k.toUpperCase()) : "✓";
          lab.style.cssText = "position:absolute;top:8px;left:8px;padding:3px 10px;border-radius:12px;font:bold 16px sans-serif;" +
            `color:#fff;background:${pending ? "#1f6feb" : no ? "#d93025" : on ? "#2ea043" : "rgba(0,0,0,0.6)"};`;
          t.appendChild(lab);
        }
        if (isMarked) {
          const x = document.createElement("div");
          x.textContent = "✗";
          x.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
            "font:bold 110px sans-serif;color:rgba(217,48,37,0.85);pointer-events:none;";
          t.appendChild(x);
        }
        const line = document.createElement("div");
        line.style.cssText = `position:absolute;top:0;left:0;right:0;height:2px;background:${FC_REVIEW_LINE_COLORS[v.level] || "transparent"};`;
        t.appendChild(line);
        if (!e.placeholder) t.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (fcRun.running) return;
          if (!canPick) return toggleRedo();
          // user 2026-11-03: „with 2, both must be rejectable, then rerender“
          if (isMarked) { setRejected([]); setMarked(false); fcChoosePick(node, i, k); return; }
          if (eff === k) {                       // reject the chosen variant
            const other = k === "a" ? "b" : "a";
            if (rejected.includes(other)) { setRejected(["a", "b"]); setMarked(true); fcChooseRender(node); }
            else { setRejected([...rejected, k]); fcChoosePick(node, i, other); }
          } else {                               // choose the other/rejected variant
            setRejected(rejected.filter((x) => x !== k));
            fcChoosePick(node, i, k);
          }
        });
        t.title = e.placeholder ? "" : (canPick
          ? (sel ? `Hover: play · click: reject ${k.toUpperCase()}` : `Hover: play · click: use ${k.toUpperCase()}`)
          : "Hover: play · click: keep / redo") + (v.info ? "\n" + v.info : "");
        col.appendChild(t);
        const st = document.createElement("div");
        // 75 (user 2026-11-03: „features bigger so you can recognize them“): finding in plain text + color
        const q = fcChooseQuality(v, e);
        st.style.cssText = `height:${FC_CHOOSE_STAT_H}px;font:bold 13px/${FC_CHOOSE_STAT_H}px sans-serif;white-space:nowrap;` +
          `overflow:hidden;text-overflow:ellipsis;padding:0 4px;border-radius:3px;color:${q.color};background:${q.bg};`;
        st.textContent = pending ? (fcRun.running ? "waiting for render…" : "queued for re-render")
          : v.score === undefined ? (e.placeholder ? (fcRun.running ? "waiting for render…" : "") : "") : q.text;
        if (pending) { st.style.color = "#4fc3f7"; st.style.background = "transparent"; }
        st.title = (e.auto_reason || "") + (v.info ? "\n" + v.info : "");
        col.appendChild(st);
      }
      // 2026-11-08: make the seam to the next shot visible – last image of the chosen variant of this shot
      // next to the first image of the chosen variant of the next one (loop: shot 1). Follows the A/B choice immediately;
      // the metric comes from the last run (red from JERK_HARD, like the row 78 before).
      if (!e.placeholder && e.seam_next) {
        const ni = e.seam_next - 1, ne = entries[ni];
        const pick = (en, idx) => fcChooseEff(en, choices[idx]);
        const lastIm = (e[pick(e, i)] || e.a)?.last;
        const firstIm = ne ? ((ne[pick(ne, ni)] || ne.a)?.still) : null;
        const bad = !!e.seam_bad;
        const sr = document.createElement("div");
        sr.style.cssText = `height:${FC_CHOOSE_SEAM_H}px;display:flex;align-items:center;gap:6px;padding:2px;box-sizing:border-box;` +
          `border-radius:3px;background:${bad ? "#3a1512" : "#202020"};border:1px solid ${bad ? "#b3261e" : "#333"};`;
        const thumb = (im) => {
          const t = document.createElement(im ? "img" : "div");
          t.style.cssText = "width:70px;height:70px;object-fit:contain;border-radius:2px;background:#111;flex:none;";
          if (im) t.src = fcChooseStableUrl(im);
          return t;
        };
        const mid = document.createElement("div");
        mid.style.cssText = `flex:1;min-width:0;text-align:center;font:bold 12px sans-serif;color:${bad ? "#ff8a80" : "#8b949e"};line-height:1.35;`;
        mid.innerHTML = `seam → Shot ${e.seam_next}<br><span style="font-size:15px">${bad ? "⚠" : "✓"} ${(+e.seam || 0).toFixed(1)}</span>`;
        sr.title = "Last frame of this shot | first frame of the next shot – the cut the film makes here. " +
          "Value from the last run (red = hard jump).";
        sr.appendChild(thumb(lastIm)); sr.appendChild(mid); sr.appendChild(thumb(firstIm));
        col.appendChild(sr);
      }
      if (!e.placeholder) {
        // Button row: ✓ KEEP / ✗ REDO (big) + „✎ prompt" (80: edit the prompt of this transition)
        const krow = document.createElement("div");
        krow.style.cssText = `display:flex;gap:${FC_CHOOSE_GAP}px;height:${FC_CHOOSE_BTNROW_H}px;`;
        const kb = document.createElement("div");
        kb.className = "fc-keep";
        kb.textContent = isMarked ? "✗ REDO – click to keep" : "✓ KEEP – click to redo";
        kb.style.cssText = `flex:1;display:flex;align-items:center;justify-content:center;` +
          `font:bold 15px sans-serif;color:#fff;border-radius:4px;cursor:pointer;user-select:none;` +
          `background:${isMarked ? "#d93025" : "#2ea043"};`;
        kb.style.opacity = fcRun.running ? "0.35" : "1";
        kb.title = isMarked ? "Marked: re-render this shot with new seeds (RERENDER below)" : "Mark this shot to re-render it with new seeds";
        kb.addEventListener("click", (ev) => { ev.stopPropagation(); toggleRedo(); });
        const pb = document.createElement("div");
        pb.className = "fc-keep";   // greyed out like KEEP/REDO during a run
        pb.textContent = "✎ prompt";
        pb.style.cssText = `flex:0 0 auto;min-width:62px;display:flex;align-items:center;justify-content:center;` +
          `font:bold 12px sans-serif;color:#ccc;background:#333;border:1px solid #555;border-radius:4px;cursor:pointer;user-select:none;`;
        pb.style.opacity = fcRun.running ? "0.35" : "1";
        pb.title = "Edit this shot's prompt (its Auto Prompt node) – saving marks ✗ REDO so RERENDER re-renders it";
        pb.addEventListener("click", (ev) => { ev.stopPropagation(); if (fcRun.running) return; fcChooseEditPrompt(node, col, e, setMarked); });
        // 82: „⏱ X s“ – length of this shot (entry in shot_seconds or global seconds)
        const dir = fcChooseDirectorOf(node);
        const secs = fcShotSecondsOf(dir, e.number);
        const sb = document.createElement("div");
        sb.className = "fc-keep";   // greyed out like KEEP/REDO during a run
        sb.textContent = `⏱ ${secs % 1 === 0 ? secs.toFixed(0) : secs.toFixed(1)} s`;
        sb.style.cssText = `flex:0 0 auto;min-width:62px;display:flex;align-items:center;justify-content:center;` +
          `font:bold 12px sans-serif;color:#ccc;background:#333;border:1px solid #555;border-radius:4px;cursor:pointer;user-select:none;`;
        sb.style.opacity = fcRun.running ? "0.35" : "1";
        sb.title = "Set this shot's length (0.5–20 s, or 'global' = the Director's 'seconds') – saving marks ✗ REDO so RERENDER re-renders it";
        sb.addEventListener("click", (ev) => { ev.stopPropagation(); if (fcRun.running) return; fcChooseEditSeconds(node, col, e, setMarked); });
        krow.appendChild(kb);
        krow.appendChild(pb);
        krow.appendChild(sb);
        col.appendChild(krow);
      }
      row.appendChild(col);
    });
  }

  const status = document.createElement("div");
  status.style.cssText = `height:${FC_CHOOSE_STATUS_H}px;display:flex;align-items:center;padding:0 8px;background:#202020;` +
    "border-radius:3px;font:13px sans-serif;white-space:nowrap;overflow:hidden;";
  const steps = document.createElement("div");
  steps.style.cssText = "display:flex;align-items:center;gap:2px;font-size:11px;flex-shrink:0;";
  const statusText = document.createElement("div");
  statusText.style.cssText = "margin-left:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;";
  status.appendChild(steps);
  status.appendChild(statusText);
  el.appendChild(status);
  node._fc_choose_status = status;
  node._fc_choose_steps = steps;
  node._fc_choose_status_text = statusText;

  const btn = document.createElement("button");
  btn.style.cssText = `width:100%;height:${FC_CHOOSE_BIG_H}px;font:bold 18px sans-serif;color:#fff;border:1px solid;border-radius:4px;cursor:pointer;`;
  btn.addEventListener("click", () => {
    if (fcRun.running || btn._fc_mode === "busy") return;
    if (btn._fc_mode === "assemble") {
      node._fc_asm_t0 = Date.now();
      fcChooseStatus(node);
      // Only build the film: partial run on Film (else Assemble), seeds fixed -> director/Choose from the cache
      const all = app.graph?._nodes || [];
      const on = (t) => all.filter((n) => n.comfyClass === t && (n.mode ?? 0) === 0).map((n) => String(n.id));
      const targets = on("InfiniteMovieFilm").length ? on("InfiniteMovieFilm") : on("InfiniteMovieAssemble");
      // 2026-11-08 (user: „last frame does not work“): output nodes BEHIND Assemble (Preview Image on
      // last_frame, Movie to GIF, Save …) belong to the partial run too – otherwise they never run. Director/Choose
      // excluded: a second director on last_frame only renders with Run.
      for (const id of fcDownstreamOutputs(on("InfiniteMovieAssemble"))) if (!targets.includes(id)) targets.push(id);
      if (window.__fc_review_test_skip_queue) console.log("[InfiniteMovie] test: skipped queuePrompt (ASSEMBLE)", JSON.stringify(targets));
      else Promise.resolve(fcQueueFixedSeeds(targets)).catch((err) => {
        node._fc_asm_t0 = null; fcChooseStatus(node);
        fcReviewToast("ASSEMBLE could not be queued – see console", "#d93025");
        console.error("[InfiniteMovie] ASSEMBLE queue failed", err);
      });
      fcReviewToast("ASSEMBLE queued – building film…");
    } else if (btn._fc_mode === "rerender") {
      fcRerenderMarked(node, fcChooseRender);
    }
  });
  el.appendChild(btn);
  node._fc_choose_btn = btn;
  el.appendChild(status);   // 2026-11-05 (user): status/progress at the very bottom
  // 3×3 sheets at the very bottom, per shot under its column
  const sz = fcChooseLayout(node, entries).sheet;
  node._fc_sheet_cells = [];
  if (sz) {
    const srow = document.createElement("div");
    srow.style.cssText = `display:flex;gap:${FC_CHOOSE_GAP}px;overflow:hidden;`;
    entries.forEach(() => {
      const cell = document.createElement("div");
      cell.style.cssText = `position:relative;width:${sz[0]}px;height:${sz[1]}px;flex:0 0 ${sz[0]}px;background:#121212;border-radius:3px;overflow:hidden;`;
      const img = document.createElement("img");
      img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;";
      const lbl = document.createElement("div");
      lbl.style.cssText = "position:absolute;left:4px;bottom:4px;padding:1px 6px;font:bold 11px sans-serif;color:#ddd;" +
        "background:rgba(0,0,0,0.6);border-radius:3px;pointer-events:none;";
      cell.appendChild(img); cell.appendChild(lbl);
      srow.appendChild(cell);
      node._fc_sheet_cells.push({ img, lbl });
    });
    el.appendChild(srow);
    fcChooseUpdateSheet(node);
  }

  fcChooseStatus(node);
  fcChooseApplyActive(node);
  // Width = all shots (fixed image size), height = content.
  const want = [fcChooseWidth(entries.length), node.computeSize()[1]];
  if (Math.abs(node.size[0] - want[0]) > 1 || Math.abs(node.size[1] - want[1]) > 1) node.setSize(want);
  node.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "InfiniteMovie.Chooser",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "InfiniteMovieChooser") return;
    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const r = origCreated ? origCreated.apply(this, args) : undefined;
      this.properties = this.properties || {};
      if (!this.properties.marked) this.properties.marked = [];
      return r;
    };
    // onExecuted: entries after each run; remember the choice used (for „changed?“).
    const origExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      origExecuted?.apply(this, arguments);
      this._fc_choose_entries = (message && message.infinite_movie_choose) || [];
      this._fc_choose_active = -1;
      this._fc_redo_pending = null;   // new variants are there
      // Live run: film not built yet (set by Film/Assemble first). Restored on page load
      // (no run active): the film already exists -> not green „ASSEMBLE“ again.
      this._fc_choose_ran = fcRun.running ? null : fcChooseEffective(this).join(",");
      if (this.properties) this.properties.rejected = {};   // new shots: forget the rejection   // film not built yet – set by Film/Assemble first (executed event)
      fcChooseRender(this);
    };
    // onConfigure: hide the choices widget (written by the frontend) + build the row.
    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const r = origConfigure ? origConfigure.apply(this, args) : undefined;
      const w = this.widgets?.find((x) => x.name === "choices");
      if (w && !w.hidden) {
        w.hidden = true;
        w.computeSize = () => [0, -4];
        w.computedHeight = 0;
      }
      setTimeout(() => fcChooseRender(this), 0);
      return r;
    };
    // Director changes (image connected/disconnected, loop, variants) → check the signature per draw.
    const origFg = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (...args) {
      const r = origFg ? origFg.apply(this, args) : undefined;
      if (fcChooseSig(fcChooseEntries(this)) !== this._fc_choose_sig) fcChooseRender(this);
      return r;
    };
    // Fixed size: width from the shot count, height from the content (dragging the corner is reset).
    const origResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      const r = origResize ? origResize.apply(this, arguments) : undefined;
      if (this._fc_choose_el) {
        const w = fcChooseWidth(fcChooseEntries(this).length);
        if (Math.abs(size[0] - w) > 1) size[0] = w;
      }
      return r;
    };
  },
});

// ---------------------------------------------------------------------------
// InfiniteMovie.AutoBatch (task 39D): status row on the FramesCollect node,
// fetches video info from /infinite_movie/video_info, computes frames_per_batch.
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "InfiniteMovie.AutoBatch",
  nodeCreated(node) {
    if (node.comfyClass !== "InfiniteMovieFramesCollect") return;
    const drawFg = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
      const r = drawFg?.apply(this, arguments);
      const info = this._fc_video_info;
      if (!info || this.flags?.collapsed) return r;
      const maxGb = this.widgets?.find((w) => w.name === "max_images_gb")?.value ?? 0;
      const w = info.width || 768, h = info.height || 960;
      const bytesPerFrame = w * h * 3 * 4;
      const maxFrames = maxGb > 0 ? Math.floor((maxGb * 1024 ** 3) / bytesPerFrame) : info.frames;
      const batches = maxFrames > 0 ? Math.ceil(info.frames / maxFrames) : 1;
      const lines = [
        `${info.frames} frames · ${info.width}×${info.height} · ${info.fps?.toFixed(1) || "?"} fps`,
        maxGb > 0
          ? `~${(info.frames * bytesPerFrame / 1024 ** 3).toFixed(1)} GB → ${batches} batch(es) of ${maxFrames}`
          : `~${(info.frames * bytesPerFrame / 1024 ** 3).toFixed(1)} GB (no limit)`,
      ];
      const x = 8, bw = this.size[0] - 16, bh = 14 + lines.length * 16;
      const y = (this.computeSize?.()[1] || 200) + 4;
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(x - 2, y - 2, bw + 4, bh + 4);
      ctx.fillStyle = "#ddd";
      ctx.font = "12px sans-serif";
      lines.forEach((t, i) => ctx.fillText(t, x, y + 16 + i * 16));
      ctx.restore();
      return r;
    };
    // Fetch video info if a path widget is present
    const refresh = async () => {
      const paths = node.widgets?.find((w) => w.name === "paths")?.value ?? "";
      const first = paths.split("\n").map((s) => s.trim()).filter(Boolean)[0];
      if (!first) { node._fc_video_info = null; node.setDirtyCanvas(true, true); return; }
      try {
        const r = await fetch(`/infinite_movie/video_info?path=${encodeURIComponent(first)}`);
        const j = await r.json();
        if (r.ok) {
          node._fc_video_info = j;
          node.setDirtyCanvas(true, true);
        }
      } catch (e) {
        console.warn("[InfiniteMovie.AutoBatch]", e);
      }
    };
    const pathsWidget = node.widgets?.find((w) => w.name === "paths");
    if (pathsWidget) {
      const origCb = pathsWidget.callback;
      pathsWidget.callback = function (...args) {
        const res = origCb?.apply(this, args);
        clearTimeout(this._fc_batch_timer);
        this._fc_batch_timer = setTimeout(refresh, 500);
        return res;
      };
    }
    setTimeout(refresh, 1500);
  },
});

// ---------------------------------------------------------------------------
// InfiniteMovie.SceneSeconds (task 41A+D): seconds field per scene + tail prompt
// + status row (estimate length) on the render node.
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "InfiniteMovie.SceneSeconds",
  nodeCreated(node) {
    if (node.comfyClass !== "InfiniteMovieRender") return;
    // 2026-11-04: reseed fills Choose (re-render of single shots) – hidden in the director.
    setTimeout(() => {
      imToggleWidget(node.widgets?.find((w) => w.name === "reseed"), false);
      node.setSize([node.size[0], node.computeSize()[1]]);
    }, 0);
    // Status row „Film: 7 shots · 14.0 s · 337 frames“ (2026-11-04: computed locally from seconds +
    // shot_seconds (⏱ in Choose); the old server estimate from the one-pass time is removed).
    const estWidget = node.addWidget("text", "Film:", null, "");
    estWidget.serialize = false;
    estWidget._fc_est = true;

    const refreshEstimate = () => {
      const val = (n) => node.widgets?.find((w) => w.name === n)?.value;
      const seconds = Number(val("seconds")) || 2.0;
      const loop = !!val("loop");
      const nImg = (node.inputs || []).filter((i) => i.name?.startsWith(IMG) && i.link != null).length;
      const nShots = nImg < 1 ? 0 : nImg === 1 ? (loop ? 2 : 1) : (loop ? nImg : nImg - 1);   // 1 image: open shot (+ return shot)
      if (nShots < 1) { estWidget.value = "Film: needs at least 1 image"; node.setDirtyCanvas?.(true, true); return; }
      const per = String(val("shot_seconds") || "").split(",").map((x) => parseFloat(x) || 0);
      let total = 0;
      for (let i = 0; i < nShots; i++) total += per[i] > 0 ? per[i] : seconds;
      const fps = 24; // LTX
      estWidget.value = `Film: ${nShots} shot${nShots > 1 ? "s" : ""} · ${total.toFixed(1)} s · ~${Math.round(total * fps)} frames`;
      node.setDirtyCanvas?.(true, true);
    };

    for (const wn of ["seconds", "loop", "shot_seconds"]) {
      const w = node.widgets?.find((x) => x.name === wn);
      if (!w) continue;
      const origCb = w.callback;
      w.callback = function (...args) {
        const res = origCb?.apply(this, args);
        clearTimeout(node._fc_est_timer);
        node._fc_est_timer = setTimeout(refreshEstimate, 200);
        return res;
      };
    }
    // images added/removed (also mute via reconcileChain) -> recompute
    const origConn = node.onConnectionsChange;
    node.onConnectionsChange = function (...args) {
      const res = origConn?.apply(this, args);
      clearTimeout(this._fc_est_timer);
      this._fc_est_timer = setTimeout(refreshEstimate, 300);
      return res;
    };
    setTimeout(refreshEstimate, 1500);
  },
});

// ---------------------------------------------------------------------------
// InfiniteMovie.Film (2026-11-03): show the finished film + „Saved: …“ status.
// Before the run: „Waiting for the film…“; while ComfyUI renders: „Rendering…“.
// ---------------------------------------------------------------------------
const FC_FILM_W = 360, FC_FILM_H = 450, FC_FILM_STATUS_H = 40, FC_FILM_RECENT_H = 26;
// 79: current film = chosen entry from im_recent (index) or _fc_film_info (fallback).
function fcFilmCurrentInfo(node) {
  const recent = node.properties?.im_recent || [];
  const idx = node._fc_film_recent_idx ?? 0;
  return (idx < recent.length && recent[idx]) ? recent[idx] : node._fc_film_info;
}
function fcFilmRender(node) {
  let el = node._fc_film_el;
  if (!el) {
    el = document.createElement("div");
    el.style.cssText = "width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;";
    const video = document.createElement("video");
    video.loop = true; video.muted = true; video.autoplay = true; video.controls = true; video.playsInline = true;
    // The video takes all free height, so a larger node shows a larger film (user 2026-11-10); FC_FILM_H is the minimum.
    video.style.cssText = `width:100%;flex:1 1 0;min-height:${FC_FILM_H}px;object-fit:contain;background:#111;border-radius:3px;`;
    const status = document.createElement("div");
    status.style.cssText = `min-height:${FC_FILM_STATUS_H}px;padding:4px 8px;box-sizing:border-box;background:#202020;` +
      "border-radius:3px;font:12px sans-serif;word-break:break-all;";
    const open = document.createElement("button");
    open.textContent = "📂 Open folder";
    open.style.cssText = "height:28px;font:bold 13px sans-serif;border-radius:4px;border:1px solid #555;background:#333;color:#fff;cursor:pointer;";
    open.addEventListener("click", async () => {
      const p = fcFilmCurrentInfo(node)?.path;
      if (!p) return;
      try {
        const r = await api.fetchApi("/infinite_movie/open_folder", { method: "POST", body: JSON.stringify({ path: p }) });
        if (!r.ok) fcReviewToast("Open folder failed (run the workflow first)");
      } catch (e) { fcReviewToast("Open folder failed"); }
    });
    // 79: last 3 films – buttons new / -1 / -2 switch the preview.
    const recentRow = document.createElement("div");
    recentRow.style.cssText = `height:${FC_FILM_RECENT_H}px;display:flex;align-items:center;gap:4px;`;
    const btns = [];
    for (const label of ["neu", "-1", "-2"]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "height:22px;padding:0 10px;font:bold 11px sans-serif;border-radius:3px;border:1px solid #555;background:#333;color:#fff;cursor:pointer;";
      b.addEventListener("click", () => {
        const i = ["neu", "-1", "-2"].indexOf(label);
        node._fc_film_recent_idx = i;
        fcFilmRender(node);
      });
      btns.push(b);
      recentRow.appendChild(b);
    }
    el.appendChild(video); el.appendChild(open); el.appendChild(recentRow); el.appendChild(status);  // status at the very bottom (user 2026-11-05)
    node._fc_film_open = open;
    node._fc_film_recent_btns = btns;
    node.addDOMWidget("fc_film", "div", el, {
      serialize: false,
      getMinHeight: () => FC_FILM_H + FC_FILM_STATUS_H + FC_FILM_RECENT_H + 48,
    });
    node._fc_film_el = el; node._fc_film_video = video; node._fc_film_status = status;
  }
  const info = fcFilmCurrentInfo(node);
  const v = node._fc_film_video, s = node._fc_film_status;
  // 2026-11-05 (user: „Open folder greyed out, Rendering wait although the director is running“): say WHO is running;
  // the last film stays visible and operable.
  const runNode = fcRun.running ? (fcRun.node || "queued") : "";
  const filmRuns = /film|assemble/i.test(runNode);
  if (fcRun.running && filmRuns) { s.textContent = "⏳ Building film…"; s.style.color = "#4fc3f7"; }
  else if (fcRun.running) {
    s.textContent = `⏳ ${runNode} running – film follows after ASSEMBLE` + (info?.exists ? " · showing last film" : "");
    s.style.color = "#4fc3f7";
  }
  else if (!info) { s.textContent = "Waiting for the film – press Run."; s.style.color = "#aaa"; }
  else if (!info.exists) { s.textContent = info.status; s.style.color = "#e3b341"; }
  else {
    s.textContent = "✓ " + info.status + (info.view ? "" : "  (outside the ComfyUI output folder – no preview)");
    s.style.color = "#7ee787";
  }
  // 79: buttons new/-1/-2 – active only if an entry exists, green if chosen.
  const recent = node.properties?.im_recent || [];
  const idx = node._fc_film_recent_idx ?? 0;
  for (let i = 0; i < (node._fc_film_recent_btns || []).length; i++) {
    const has = i < recent.length;
    const sel = i === idx && has;
    node._fc_film_recent_btns[i].disabled = !has;
    node._fc_film_recent_btns[i].style.opacity = has ? "1" : "0.35";
    node._fc_film_recent_btns[i].style.background = sel ? "#2ea043" : "#333";
    node._fc_film_recent_btns[i].style.borderColor = sel ? "#2ea043" : "#555";
  }
  const canOpen = !!info?.exists;
  node._fc_film_open.disabled = !canOpen;
  node._fc_film_open.style.opacity = canOpen ? "1" : "0.35";
  node._fc_film_open.style.cursor = canOpen ? "pointer" : "default";
  if (info?.view) {
    const q = new URLSearchParams({ ...info.view, t: info.saved_at || "" });
    const src = api.apiURL(`/view?${q}`);
    if (v.getAttribute("src") !== src) { v.setAttribute("src", src); v.play?.().catch(() => {}); }
  } else if (v.getAttribute("src")) { v.removeAttribute("src"); v.load(); }
  const need = [Math.max(node.size[0], FC_FILM_W + 20), Math.max(node.size[1], node.computeSize()[1])];  // only grow to the minimum, never shrink a user-enlarged node
  if (Math.abs(node.size[0] - need[0]) > 1 || Math.abs(node.size[1] - need[1]) > 1) node.setSize(need);
  node.setDirtyCanvas(true, true);
}
// Active output nodes (output_node) behind the start nodes, without director/Choose (they only render with Run).
function fcDownstreamOutputs(startIds) {
  const g = app.graph;
  if (!g) return [];
  const linkOf = (id) => g.links?.[id] ?? g.links?.get?.(id);
  const seen = new Set(startIds.map(String)), queue = [...seen], out = [];
  while (queue.length) {
    const n = g.getNodeById(queue.shift());
    for (const o of n?.outputs || []) for (const lid of o.links || []) {
      const t = linkOf(lid)?.target_id;
      if (t == null || seen.has(String(t))) continue;
      seen.add(String(t));
      const tn = g.getNodeById(t);
      if (!tn || (tn.mode ?? 0) !== 0) continue;
      if (tn.comfyClass === "InfiniteMovieRender" || tn.comfyClass === "InfiniteMovieChooser") continue;
      queue.push(String(t));
      if (tn.constructor?.nodeData?.output_node) out.push(String(t));
    }
  }
  return out;
}

window.fcDownstreamOutputs = fcDownstreamOutputs;   // for browser tests

function fcFilmRefreshAll() { for (const n of (app.graph?._nodes || [])) if (n.comfyClass === "InfiniteMovieFilm") fcFilmRender(n); }
api.addEventListener("status", fcFilmRefreshAll);
api.addEventListener("executing", () => setTimeout(fcFilmRefreshAll, 0));   // update the running node
app.registerExtension({
  name: "InfiniteMovie.Film",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "InfiniteMovieFilm") return;
    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const r = origCreated ? origCreated.apply(this, args) : undefined;
      this.properties = this.properties || {};
      if (!this.properties.im_recent) this.properties.im_recent = [];
      // 79: after page reload _fc_film_info is gone (ad-hoc), but im_recent survives (serialized).
      if (this.properties.im_recent.length > 0) this._fc_film_info = this.properties.im_recent[0];
      setTimeout(() => fcFilmRender(this), 0);
      return r;
    };
    const origExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      origExecuted?.apply(this, arguments);
      const info = (message && message.infinite_movie_film && message.infinite_movie_film[0]) || null;
      this._fc_film_info = info;
      // 79: remember the last 3 films in node.properties.im_recent (survives page reload).
      if (info?.exists) {
        this.properties = this.properties || {};
        const recent = (this.properties.im_recent || []).slice();
        recent.unshift(info);
        while (recent.length > 3) recent.pop();
        this.properties.im_recent = recent;
        this._fc_film_recent_idx = 0;
      }
      fcFilmRender(this);
    };
  },
});

// 2026-11-09 (user: „pos prompt always green. make the coloring logical“): fixed color by task for the own
// nodes, also for newly created ones (e.g. automatically generated Auto Prompts). LiteGraph default palette:
// green = positive prompt, cyan = engine interface. Saved colors (workflow) win.
const IM_ROLE_COLORS = {
  InfiniteMovieAutoPrompt: ["#232", "#353"],
  InfiniteMovieStyle: ["#232", "#353"],
  InfiniteMovieEngineIn: ["#233", "#355"],
  InfiniteMovieEngineOut: ["#233", "#355"],
};
app.registerExtension({
  name: "InfiniteMovie.RoleColors",
  nodeCreated(node) {
    const c = IM_ROLE_COLORS[node.comfyClass];
    if (!c || node.color) return;
    node.color = c[0];
    node.bgcolor = c[1];
  },
});

// 93 (user 2026-11-09): update hint on the director. The server compares the pyproject version with the newest
// released registry version (version_check.py, 6-h cache). Only a hint – updating happens via the manager.
let imVersionP = null;
const imVersion = () => (imVersionP ??= api.fetchApi("/infinite_movie/version")
  .then((r) => (r.ok ? r.json() : null)).catch(() => null));
app.registerExtension({
  name: "InfiniteMovie.UpdateHint",
  nodeCreated(node) {
    if (node.comfyClass !== "InfiniteMovieRender") return;
    imVersion().then((v) => {
      if (!v?.update || node.widgets?.some((w) => w.name === "im_update")) return;
      const w = node.addWidget("button", "im_update", null, () => fcReviewToast(
        "Update: ComfyUI-Manager → Custom Nodes Manager → search “Infinite Movie” → Update, then restart ComfyUI.", "#2a6"),
        { serialize: false });
      w.serialize = false;
      w.label = `⬆ Update ${v.latest} available (installed ${v.installed})`;
      w.color = "#2a6";
      node.setSize([node.size[0], Math.max(node.size[1], node.computeSize()[1])]);
      node.setDirtyCanvas?.(true, true);
    });
  },
});

// 2026-11-11 (user: "make the prompt prompt editable, add a restore button"): Story Mode (LLM) – both instructions
// are plain editable text widgets; the button puts the defaults from the node definition back.
app.registerExtension({
  name: "InfiniteMovie.StoryModeRestore",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "InfiniteMovieStoryMode") return;
    const req = nodeData.input?.required || {};
    const defaults = {};
    for (const k of ["storyboard_instruction", "instruction"]) defaults[k] = req[k]?.[1]?.default ?? "";
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...a) {
      const r = onCreated?.apply(this, a);
      if (!this.widgets?.find((w) => w.name === "↺ Restore default prompts")) {
        const b = this.addWidget("button", "↺ Restore default prompts", null, () => {
          for (const [k, v] of Object.entries(defaults)) {
            const w = this.widgets?.find((x) => x.name === k);
            if (w) { w.value = v; w.callback?.(v); }
          }
          this.setDirtyCanvas?.(true, true);
        });
        b.serialize = false;
        b.options = { ...(b.options || {}), serialize: false };   // not into the API prompt either
        b.tooltip = "Puts the original storyboard and shot instructions back.";
      }
      // 2026-11-11 (user: "the prompts have no label - can the user read minds?"): a heading above each text box.
      // serialize:false -> skipped when saving/loading widgets_values, so the order of the values is unchanged.
      const LABELS = {
        story: "① Story – red thread of your film (optional)",
        storyboard_instruction: "② Plan – the LLM reads ALL images, plans the film",
        instruction: "③ Shot – the LLM writes each shot from its 2 images",
      };
      for (const [target, text] of Object.entries(LABELS)) {
        const name = `im_label_${target}`;
        if (this.widgets?.find((w) => w.name === name)) continue;
        const lw = this.addCustomWidget({
          name, type: "im_label", value: null, serialize: false, options: { serialize: false },
          computeSize: () => [0, 22],
          draw(ctx, _node, _w, y) {
            ctx.save();
            ctx.fillStyle = "#e8e8e8";
            ctx.font = "bold 13px Arial";
            ctx.fillText(text, 14, y + 16);
            ctx.restore();
          },
          mouse() { return false; },
        });
        const i = this.widgets.indexOf(lw);
        const t = this.widgets.findIndex((w) => w.name === target);
        if (i >= 0 && t >= 0) { this.widgets.splice(i, 1); this.widgets.splice(t, 0, lw); }
      }
      this.setSize?.([this.size[0], Math.max(this.size[1], this.computeSize()[1])]);
      // 2026-11-11 (user: "the model could be shown"): after the check, an empty model field says which one answers
      const CHECK = "🔌 Check connection";
      if (!this.widgets?.find((w) => w.name === CHECK)) {
        const cb = this.addWidget("button", CHECK, null, async () => {
          const val = (k) => String(this.widgets?.find((x) => x.name === k)?.value ?? "");
          cb.label = "⏳ checking ...";
          this.setDirtyCanvas?.(true, true);
          let res;
          try {
            const r = await api.fetchApi("/infinite_movie/llm_check", { method: "POST",
              body: JSON.stringify({ endpoint: val("endpoint"), model: val("model"), api_key_env: val("api_key_env") }) });
            res = await r.json();
          } catch (e) { res = { ok: false, message: String(e) }; }
          cb.label = `${res.ok ? "🟢" : "🔴"} ${res.message}`;
          cb.tooltip = res.message;
          const mw = this.widgets?.find((x) => x.name === "model");
          if (mw) mw.label = res.ok && res.model && !val("model") ? `model (auto: ${res.model})` : undefined;
          this.setDirtyCanvas?.(true, true);
        });
        cb.serialize = false;
        cb.options = { ...(cb.options || {}), serialize: false };
        cb.tooltip = "Asks the server once for its models. Green = reachable (shows the model that will answer).";
      }
      // 2026-11-11 (user: "can't see the result of the plan"): plan shown read-only (selectable, copyable) at the
      // bottom; kept in properties.im_plan so it survives a reload. Filled by the event infinite_movie.storyboard.
      if (!this.widgets?.find((w) => w.name === "im_plan")) {
        const lbl = this.addCustomWidget({
          name: "im_label_plan", type: "im_label", value: null, serialize: false, options: { serialize: false },
          computeSize: () => [0, 22],
          draw(ctx, _n, _w, y) {
            ctx.save(); ctx.fillStyle = "#e8e8e8"; ctx.font = "bold 13px Arial";
            ctx.fillText("④ Plan result – written on Regenerate", 14, y + 16); ctx.restore();
          },
          mouse() { return false; },
        });
        const ta = document.createElement("textarea");
        ta.readOnly = true;
        ta.placeholder = "The plan appears here after the first 🔄 Regenerate prompt.";
        ta.style.cssText = "width:100%;height:100%;resize:none;box-sizing:border-box;font:11px monospace;" +
          "background:#1a1a1a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px;";
        ta.value = this.properties?.im_plan || "";
        this._imPlanEl = ta;
        this.addDOMWidget("im_plan", "textarea", ta, { serialize: false, getMinHeight: () => 120,
          getValue: () => ta.value, setValue: () => {} });
        void lbl;
      }
      // provider fills endpoint / model / api_key_env (table from llm_nodes.PROVIDERS), only on a user change
      const pw = this.widgets?.find((w) => w.name === "provider");
      if (pw && !pw._imWrapped) {
        pw._imWrapped = true;
        const cb = pw.callback;
        pw.callback = async (v, ...rest) => {
          const out = cb?.call(pw, v, ...rest);
          try {
            const table = await (await api.fetchApi("/infinite_movie/llm_providers")).json();
            const p = table?.[pw.value];
            if (p) for (const k of ["endpoint", "model", "api_key_env"]) {
              const w = this.widgets?.find((x) => x.name === k);
              if (w) w.value = p[k] ?? "";
            }
            this.setDirtyCanvas?.(true, true);
          } catch (e) { console.warn("[InfiniteMovie] llm_providers", e); }
          return out;
        };
      }
      return r;
    };
  },
});

// 2026-11-11: the plan from the server -> every Story Mode node (text box ④ + properties, saved with the workflow)
api.addEventListener("infinite_movie.storyboard", (e) => {
  const text = String(e.detail?.text || "") + (e.detail?.cached ? "\n\n(from cache - same images, story and instruction)" : "");
  for (const n of app.graph?._nodes || []) {
    if (n.comfyClass !== "InfiniteMovieStoryMode") continue;
    n.properties = n.properties || {};
    n.properties.im_plan = text;
    if (n._imPlanEl) n._imPlanEl.value = text;
    n.setDirtyCanvas?.(true, true);
  }
});
app.registerExtension({
  name: "InfiniteMovie.StoryModePlanRestore",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "InfiniteMovieStoryMode") return;
    const onCfg = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...a) {
      const r = onCfg?.apply(this, a);
      if (this._imPlanEl) this._imPlanEl.value = this.properties?.im_plan || "";
      return r;
    };
  },
});

// 2026-11-11: Settings – while Story Mode is plugged into "LLM", prompt_model is greyed out.
app.registerExtension({
  name: "InfiniteMovie.SettingsLLMSocket",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "InfiniteMovieSettings") return;
    const sync = (node) => {
      const w = node.widgets?.find((x) => x.name === "prompt_model");
      if (!w) return;
      const on = !!storyModeOf(node);   // plugged in and not bypassed/muted
      if (w.disabled === on && node._imLLMOn === on) return;
      node._imLLMOn = on;
      w.disabled = on;
      w.label = on ? "prompt_model → Story Mode (LLM)" : undefined;
      node.setDirtyCanvas?.(true, true);
    };
    const onConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...a) {
      const r = onConn?.apply(this, a);
      sync(this);
      return r;
    };
    const onCfg = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...a) {
      const r = onCfg?.apply(this, a);
      setTimeout(() => sync(this), 0);
      return r;
    };
    // bypassing Story Mode changes no connection -> also check while drawing (cheap, returns early)
    const onDraw = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (...a) {
      const r = onDraw?.apply(this, a);
      sync(this);
      return r;
    };
  },
});
