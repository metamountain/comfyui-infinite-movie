import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { IM_REGEN, addRegenerateButton, fcReviewToast, storyModeOf, wrapQueue } from "./im_common.js";
import { IM_ROLE_COLORS } from "./im_film.js";
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
export function imToggleWidget(w, show) {
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
      "Even Motion writes the finished film to <output_folder>/<save_name>.mp4. Empty = next to the shots.";
  },
});

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
