// Infinite Movie · Movie to GIF – live preview + save / save as… in the node (2026-11-08, 2026-11-12).
// Every widget change (debounced) posts the values to /infinite_movie/gif_preview; the server renders a small,
// short version into the temp folder – nothing is saved. save / save as… render the full version with the same
// values (/infinite_movie/gif_save), like Preview Image MM: save = next free name next to the source film (the
// tooltip shows the exact path); save as… = the OS save dialog in that folder with that name filled in; from another
// computer the browser's own save dialog, without one a name prompt (saved next to the source).
// images from a VHS Load Video: the preview reads the loader's file with its frame settings (same frames as a Run);
// images from any other node: preview after one Run (token = node id).
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const GIF_CLASS = "InfiniteMovieGif";
const PREVIEW_H = 280;
const INFO_H = 40;
const PARAMS = ["format", "long_side", "crop", "every_nth", "start", "end", "speed", "direction", "colors", "dither",
  "palette", "quality", "repeat", "source_fps"];
const GIF_ONLY = ["colors", "dither", "palette"];
const WEBP_ONLY = ["quality"];
const LOADER_KEYS = ["force_rate", "skip_first_frames", "select_every_nth", "frame_load_cap"];

const wval = (node, name) => node.widgets?.find((w) => w.name === name)?.value;
const linked = (node, name) => node.inputs?.some((i) => i.name === name && i.link != null);

function toast(severity, summary, detail) {
  const t = app.extensionManager?.toast;
  if (t?.add) t.add({ severity, summary, detail, life: severity === "error" ? 6000 : 3000 });
  else console[severity === "error" ? "error" : "log"](`[Movie to GIF] ${summary}: ${detail}`);
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
  node._gif_img.src = viewUrl(r);
  node._gif_img.style.display = "block";
}

// Grey out widgets that do not apply: GIF-only / WebP-only, source_fps without a connected images input
// (video takes priority over images: its rate comes from the file, not from the widget).
function updateHints(node) {
  const webp = String(wval(node, "format") || "").startsWith("WebP");
  const imgs = linked(node, "images");
  const vid = linked(node, "video");
  for (const w of node.widgets || []) {
    if (GIF_ONLY.includes(w.name)) w.disabled = webp;
    if (WEBP_ONLY.includes(w.name)) w.disabled = !webp;
    if (w.name === "source_fps") w.disabled = !(imgs && !vid);
  }
  node.setDirtyCanvas?.(true, true);
}

// Tooltip of save = the exact file the next save writes (like Preview Image MM).
async function refreshTarget(node, body) {
  const j = body ? await post("/infinite_movie/gif_target", body) : null;
  node._gif_target = j?.ok ? j.target : "";
  if (node._gif_save) node._gif_save.tooltip = node._gif_target ||
    "next free name next to the source film (uploads and images: output/infinite_movie/gif)";
}

function schedule(node, delay = 500) {
  clearTimeout(node._gif_timer);
  node._gif_timer = setTimeout(() => refreshPreview(node), delay);
}

// Connected source node with a file widget -> its file directly, without a Run. VHS Load Video also hands on its
// frame settings, so the preview shows the same frames a Run gets.
function upstreamSource(node) {
  for (const name of ["video", "images", "video_path"]) {
    const inp = node.inputs?.find((i) => i.name === name && i.link != null);
    if (!inp) continue;
    const link = node.graph?.links?.[inp.link] ?? node.graph?.links?.get?.(inp.link);
    const src = link && node.graph.getNodeById(link.origin_id);
    if (!src) return null;
    const w = src.widgets?.find((x) => ["video", "video_path", "file", "path"].includes(x.name));
    const v = String(w?.value ?? "").trim();
    if (!v || v === "(none)") return null;
    const out = /[\\/]/.test(v) || /^[a-zA-Z]:/.test(v) ? { video_path: v } : { file: v };
    if (name === "images") {
      if (!String(src.type || "").startsWith("VHS_LoadVideo")) return null;   // generator: frames exist only in a Run
      out.loader = {};
      for (const k of LOADER_KEYS) out.loader[k] = src.widgets?.find((x) => x.name === k)?.value ?? 0;
    }
    return out;
  }
  return null;
}

// Request body for preview and save: values + source. { body } or { message } when there is no source yet.
function requestBody(node) {
  const viaInput = linked(node, "images") || linked(node, "video_path") || linked(node, "video");
  const body = { params: {}, max_mb: wval(node, "max_mb") || 0 };
  for (const k of PARAMS) body.params[k] = wval(node, k);
  const up = viaInput ? upstreamSource(node) : null;
  if (up) return { body: Object.assign(body, up) };
  if (viaInput) {
    if (!node._gif_token) return { message: "Connected input: press Run once – after that the preview follows every change." };
    body.token = node._gif_token;
    return { body };
  }
  body.video_path = wval(node, "video_path") || "";
  body.file = wval(node, "file") || "";
  if (!body.video_path.trim() && (!body.file || body.file === "(none)"))
    return { message: "Choose a file, enter a video_path or connect video or images." };
  return { body };
}

async function post(path, body) {
  try {
    const r = await api.fetchApi(path, { method: "POST", body: JSON.stringify(body) });
    return r.ok ? await r.json() : { ok: false, message: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
}

async function refreshPreview(node) {
  updateHints(node);
  const { body, message } = requestBody(node);
  refreshTarget(node, body);
  if (!body) { setInfo(node, message); return; }
  const req = (node._gif_req = (node._gif_req || 0) + 1);
  setInfo(node, "Rendering preview …");
  const res = await post("/infinite_movie/gif_preview", body);
  if (req !== node._gif_req) return;   // a newer request is already running
  if (!res.ok) { setInfo(node, res.message || "preview failed", true); return; }
  showImage(node, res);
  setInfo(node, `Live (not saved): ${res.message}`);
}

async function save(node, saveAs = "", tempOnly = false) {
  const { body, message } = requestBody(node);
  if (!body) { toast("error", "Save", message); return null; }
  body.save_as = saveAs;
  body.temp_only = tempOnly;
  node._gif_req = (node._gif_req || 0) + 1;   // a running preview must not overwrite the status
  setInfo(node, "Rendering full version …");
  const j = await post("/infinite_movie/gif_save", body);
  if (!j.ok) { setInfo(node, j.message || "save failed", true); toast("error", "Save failed", j.message || ""); return null; }
  showImage(node, j);
  if (tempOnly) return j;
  setInfo(node, `Saved: ${j.text}`);
  toast("success", "Saved", j.path);
  refreshTarget(node, body);   // the next free name is taken now
  return j;
}

const PICK_TYPES = [
  { description: "GIF", accept: { "image/gif": [".gif"] } },
  { description: "WebP", accept: { "image/webp": [".webp"] } },
];

async function saveAs(node) {
  const { body, message } = requestBody(node);
  if (!body) { toast("error", "Save as", message); return; }
  const suggested = String(node._gif_target || "").replace(/\\/g, "/").split("/").pop() || "movie.gif";
  // the normal OS "save as" dialog (browser on the ComfyUI computer), starts in the folder save would use
  const d = await post("/infinite_movie/gif_dialog", body);
  if (d.ok) {
    if (d.path) await save(node, d.path);
    return;
  }
  if (d.local !== false) { toast("error", "Save as", d.message || "failed"); return; }
  // browser on another computer: the browser's own save dialog
  if (typeof window.showSaveFilePicker === "function") {
    let handle;
    try {
      handle = await window.showSaveFilePicker({ id: "infinite-movie-gif", suggestedName: suggested, types: PICK_TYPES });
    } catch (e) {
      if (e?.name !== "AbortError") toast("error", "Save as", String(e));
      return;
    }
    const j = await save(node, "", true);
    if (!j) return;
    try {
      const blob = await (await fetch(viewUrl(j))).blob();
      const wr = await handle.createWritable();
      await wr.write(blob);
      await wr.close();
      setInfo(node, `Saved: ${j.text}`);
      toast("success", "Saved", handle.name);
    } catch (e) {
      toast("error", "Save failed", String(e));
    }
    return;
  }
  // no file dialog (plain http on a LAN address): ask for a name, saved next to the source
  const stem = suggested.replace(/\.[^.]+$/, "");
  let name = "";
  const prompt = app.extensionManager?.dialog?.prompt;
  if (typeof prompt === "function") name = await prompt({ title: "Save as (next to the source)", message: "File name", defaultValue: stem });
  else name = window.prompt("Save as (next to the source):", stem);
  if (name != null && String(name).trim() !== "") await save(node, String(name).trim());
}

function buildWidget(node) {
  const el = document.createElement("div");
  el.style.cssText = "width:100%;display:flex;flex-direction:column;gap:4px;";
  const img = document.createElement("img");
  img.style.cssText = `width:100%;height:${PREVIEW_H}px;object-fit:contain;background:#111;border-radius:3px;display:none;`;
  img.alt = "GIF preview";
  const info = document.createElement("div");
  info.style.cssText = `min-height:${INFO_H}px;font:12px sans-serif;color:#bbb;word-break:break-word;`;
  el.appendChild(img); el.appendChild(info);
  node._gif_img = img; node._gif_info = info;
  node.addDOMWidget("gif_preview", "div", el, {
    serialize: false,
    getMinHeight: () => PREVIEW_H + INFO_H + 8,
    getMaxHeight: () => PREVIEW_H + INFO_H + 8,
  });
  const mk = (label, cb, tip) => {
    const b = node.addWidget("button", label, null, cb);
    b.serialize = false;
    b.options = { ...(b.options || {}), serialize: false };
    b.tooltip = tip;
    return b;
  };
  node._gif_save = mk("save", () => save(node), "");
  mk("save as…", () => saveAs(node), "choose folder and name (system save dialog, starts where save would write)");
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
      schedule(this, 800);   // after loading (widget values are set)
      // File or frame settings changed in the connected loader node -> new preview (its widgets do not know us)
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
        setInfo(this, res.saved ? `Saved: ${res.text} – ${res.saved}` : `Run (not saved – use save): ${res.text}`);
      }
      return r;
    };
  },
});
