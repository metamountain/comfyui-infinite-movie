// Infinite Movie · Movie to GIF – live preview in the node (2026-11-08).
// Every widget change (debounced) posts the values to /infinite_movie/gif_preview; the server renders a small,
// short version into the temp folder. Connected video/images inputs can only be previewed after one Run
// (the server then knows the source the node used: token = node id).
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const GIF_CLASS = "InfiniteMovieGif";
const PREVIEW_H = 280;
const INFO_H = 40;
const PARAMS = ["format", "long_side", "crop", "fps", "start", "end", "speed", "direction", "colors", "dither",
  "palette", "quality", "repeat"];
const GIF_ONLY = ["colors", "dither", "palette"];
const WEBP_ONLY = ["quality"];

function wval(node, name) {
  return node.widgets?.find((w) => w.name === name)?.value;
}

function linked(node, name) {
  return node.inputs?.some((i) => i.name === name && i.link != null);
}

function viewUrl(r) {
  const q = new URLSearchParams({ filename: r.filename, subfolder: r.subfolder || "", type: r.type || "temp" });
  return api.apiURL(`/view?${q}&t=${Date.now()}`);
}

function setInfo(node, text, isError = false) {
  const el = node._gif_info;
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#e88" : "#bbb";
}

function showImage(node, r) {
  const url = viewUrl(r);
  node._gif_img.src = url;
  node._gif_img.style.display = "block";
  node._gif_dl.href = url;
  node._gif_dl.download = r.filename;
  node._gif_dl.style.display = "inline-block";
}

// Grey out GIF-only / WebP-only widgets so it is clear which ones apply to the chosen format.
function updateFormatHints(node) {
  const webp = String(wval(node, "format") || "").startsWith("WebP");
  for (const w of node.widgets || []) {
    if (GIF_ONLY.includes(w.name)) w.disabled = webp;
    if (WEBP_ONLY.includes(w.name)) w.disabled = !webp;
  }
  node.setDirtyCanvas?.(true, true);
}

function schedule(node, delay = 500) {
  clearTimeout(node._gif_timer);
  node._gif_timer = setTimeout(() => refreshPreview(node), delay);
}

// Connected loader node (e.g. VHS Load Video: widget "video" = file in ComfyUI/input; Load Video (Path):
// "video"/"video_path" = path) -> use its file directly in the live preview, without a Run.
function upstreamSource(node) {
  for (const name of ["video", "video_path", "images"]) {
    const inp = node.inputs?.find((i) => i.name === name && i.link != null);
    if (!inp) continue;
    const link = node.graph?.links?.[inp.link] ?? node.graph?.links?.get?.(inp.link);
    const src = link && node.graph.getNodeById(link.origin_id);
    if (!src) return null;
    const w = src.widgets?.find((x) => ["video", "video_path", "file", "path"].includes(x.name));
    const v = String(w?.value ?? "").trim();
    if (!v || v === "(none)") return null;
    return /[\\/]/.test(v) || /^[a-zA-Z]:/.test(v) ? { video_path: v } : { file: v };
  }
  return null;
}

async function refreshPreview(node) {
  updateFormatHints(node);
  const viaInput = linked(node, "video") || linked(node, "images") || linked(node, "video_path");
  const body = { params: {} };
  for (const k of PARAMS) body.params[k] = wval(node, k);
  const up = viaInput ? upstreamSource(node) : null;
  if (up) {
    Object.assign(body, up);
  } else if (viaInput) {
    if (!node._gif_token) {
      setInfo(node, "Connected input: press Run once – after that the preview follows every change.");
      return;
    }
    body.token = node._gif_token;
  } else {
    body.video_path = wval(node, "video_path") || "";
    body.file = wval(node, "file") || "";
    if (!body.video_path.trim() && (!body.file || body.file === "(none)")) {
      setInfo(node, "Choose a file, enter a video_path or connect video / images.");
      return;
    }
  }
  const req = (node._gif_req = (node._gif_req || 0) + 1);
  setInfo(node, "Rendering preview …");
  try {
    const r = await api.fetchApi("/infinite_movie/gif_preview", { method: "POST", body: JSON.stringify(body) });
    const res = r.ok ? await r.json() : { ok: false, message: `preview failed (HTTP ${r.status})` };
    if (req !== node._gif_req) return;   // a newer request is already running
    if (!res.ok) { setInfo(node, res.message || "preview failed", true); return; }
    showImage(node, res);
    setInfo(node, `Live: ${res.message}`);
  } catch (e) {
    if (req === node._gif_req) setInfo(node, `preview failed: ${e?.message || e}`, true);
  }
}

function buildWidget(node) {
  const el = document.createElement("div");
  el.style.cssText = "width:100%;display:flex;flex-direction:column;gap:4px;";
  const img = document.createElement("img");
  img.style.cssText = `width:100%;height:${PREVIEW_H}px;object-fit:contain;background:#111;border-radius:3px;display:none;`;
  img.alt = "GIF preview";
  const row = document.createElement("div");
  row.style.cssText = `min-height:${INFO_H}px;display:flex;align-items:center;gap:6px;`;
  const info = document.createElement("div");
  info.style.cssText = "flex:1;font:12px sans-serif;color:#bbb;word-break:break-word;";
  const dl = document.createElement("a");
  dl.textContent = "⬇ Download";
  dl.title = "Download the image shown above";
  dl.style.cssText = "display:none;padding:3px 10px;font:bold 12px sans-serif;border-radius:4px;border:1px solid #555;" +
    "background:#333;color:#fff;text-decoration:none;white-space:nowrap;";
  row.appendChild(info); row.appendChild(dl);
  el.appendChild(img); el.appendChild(row);
  node._gif_img = img; node._gif_info = info; node._gif_dl = dl;
  node.addDOMWidget("gif_preview", "div", el, {
    serialize: false,
    getMinHeight: () => PREVIEW_H + INFO_H + 8,
    getMaxHeight: () => PREVIEW_H + INFO_H + 8,
  });
}

app.registerExtension({
  name: "InfiniteMovie.GifPreview",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== GIF_CLASS) return;

    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = created?.apply(this, arguments);
      buildWidget(this);
      for (const w of this.widgets || []) {
        if (![...PARAMS, "video_path", "file"].includes(w.name)) continue;
        const cb = w.callback;
        w.callback = (...a) => { const x = cb?.apply(w, a); schedule(this); return x; };
      }
      // 💾 Save as… (folder browser from infinite_movie.js, like Settings > output_folder)
      const of = this.widgets?.find((w) => w.name === "output_folder");
      if (of && !this.widgets.some((w) => w.name === "💾 Save as…")) {
        const btn = this.addWidget("button", "💾 Save as…", null, async () => {
          if (!window.fcPickFolder) return;
          const path = await window.fcPickFolder(String(of.value ?? ""));
          if (path) { of.value = path; of.callback?.(of.value); this.setDirtyCanvas(true, true); }
        });
        btn.serialize = false;
        btn.tooltip = "Choose where the GIF is saved (folder browser on the ComfyUI computer). Empty output_folder = ComfyUI output folder.";
        // Insert the button directly below output_folder
        const i = this.widgets.indexOf(of);
        this.widgets.splice(this.widgets.indexOf(btn), 1);
        this.widgets.splice(i + 1, 0, btn);
      }
      schedule(this, 800);   // after loading (widget values are set)
      // File changed in the connected loader node -> new preview (its widgets do not know about us)
      this._gif_up = "";
      this._gif_poll = setInterval(() => {
        if (!this.graph) { clearInterval(this._gif_poll); return; }
        const k = JSON.stringify(upstreamSource(this));
        if (k !== this._gif_up) { this._gif_up = k; schedule(this); }
      }, 1500);
      return r;
    };

    const conn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = conn?.apply(this, arguments);
      this._gif_token = null;   // different source -> valid again only after a Run
      schedule(this);
      return r;
    };

    const executed = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = executed?.apply(this, arguments);
      const res = message?.infinite_movie_gif?.[0];
      if (res) {
        if (res.token) this._gif_token = res.token;
        showImage(this, res);
        setInfo(this, `Saved: ${res.text}`);
      }
      return r;
    };
  },
});
