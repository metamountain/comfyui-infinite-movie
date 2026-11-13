import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { fcReviewToast } from "./im_common.js";
import { fcRun } from "./im_cut_state.js";
// ---------------------------------------------------------------------------
// InfiniteMovie.Film (2026-11-03): show the finished film + „Saved: …“ status.
// Before the run: „Waiting for the film…“; while ComfyUI renders: „Rendering…“.
// ---------------------------------------------------------------------------
const FC_FILM_W = 360, FC_FILM_BAR_H = 26;
// 2026-11-13 (user: "6 7 8 all players square"): the video is a square of the DOM width (node width - 20).
const fcFilmSide = (node) => Math.max(FC_FILM_W, (node?.size?.[0] ?? 0) - 20);
// Film or a single shot (sent by Cut's ▶ play) – only offered when the node hangs on Cut (user 2026-11-13).
const fcFilmSource = (node) => (node.properties?.im_source === "shot" && node._fc_shot) ? "shot" : "film";
const fcLinkOrigin = (node, name) => {
  const i = node.inputs?.find((x) => x.name === name);
  const l = i?.link != null ? (node.graph?.links?.[i.link] ?? node.graph?.links?.get?.(i.link)) : null;
  return l ? node.graph.getNodeById(l.origin_id) : null;
};
const fcFromCut = (node) => {
  const o = fcLinkOrigin(node, "video_path");
  return (o?.comfyClass || o?.type) === "InfiniteMovieChooser";
};
// 2026-11-13 (user: "the node looks stupid"): only what is needed – fps only with images, file only without a link.
function fcFilmWidgets(node) {
  const hide = (name, show) => {
    const w = node.widgets?.find((x) => x.name === name);
    if (!w || w.hidden === !show) return;
    if (w._imOrigComputeSize === undefined) w._imOrigComputeSize = w.computeSize ?? null;
    w.hidden = !show;
    if (show) { if (w._imOrigComputeSize) w.computeSize = w._imOrigComputeSize; else delete w.computeSize; delete w.computedHeight; }
    else { w.computeSize = () => [0, -4]; w.computedHeight = 0; }
  };
  const linked = (n) => node.inputs?.find((x) => x.name === n)?.link != null;
  hide("fps", linked("images"));
  hide("file", !linked("video") && !linked("images") && !linked("video_path"));
}
// 79: current film = the newest entry of im_recent (survives reload) or _fc_film_info.
function fcFilmCurrentInfo(node) {
  return node._fc_film_info || node.properties?.im_recent?.[0] || null;
}
const fcShortStatus = (info) => String(info?.status || "").replace(/^(Saved|Preview):\s*/, "").replace(/^[^·]*[\\/]/, "");
export function fcFilmRender(node) {
  let el = node._fc_film_el;
  if (!el) {
    el = document.createElement("div");
    el.style.cssText = "width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;";
    const video = document.createElement("video");
    video.loop = true; video.muted = true; video.autoplay = true; video.controls = true; video.playsInline = true;
    // Square video (portrait and landscape both fit, object-fit:contain), side = DOM width.
    video.style.cssText = "width:100%;aspect-ratio:1/1;flex:none;object-fit:contain;background:#111;border-radius:3px;";
    // one line under the video: 📂 · status · (Film | Shot when on Cut)
    const bar = document.createElement("div");
    bar.style.cssText = `height:${FC_FILM_BAR_H}px;flex:none;display:flex;align-items:center;gap:6px;font:12px sans-serif;`;
    const btnCss = "height:22px;padding:0 8px;font:12px sans-serif;border-radius:3px;border:1px solid #555;background:#333;color:#ddd;cursor:pointer;flex:none;";
    const open = document.createElement("button");
    open.textContent = "📂"; open.title = "Open the folder of this film";
    open.style.cssText = btnCss;
    open.addEventListener("click", async () => {
      const p = fcFilmCurrentInfo(node)?.path;
      if (!p) return;
      try {
        const r = await api.fetchApi("/infinite_movie/open_folder", { method: "POST", body: JSON.stringify({ path: p }) });
        if (r.status === 403) fcReviewToast("Open folder: the server does not know this film (file moved or deleted?) - run the node again");
        else if (!r.ok) fcReviewToast("Open folder failed");
      } catch (e) { fcReviewToast("Open folder failed"); }
    });
    const status = document.createElement("div");
    status.style.cssText = "flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    const srcBtns = {};
    const srcBox = document.createElement("div");
    srcBox.style.cssText = "display:flex;gap:2px;flex:none;";
    for (const [key, label] of [["film", "Film"], ["shot", "Shot"]]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = btnCss;
      b.title = key === "film" ? "Show the whole film" : "Show the shot chosen with ▶ play in Cut";
      b.addEventListener("click", () => { node.properties = node.properties || {}; node.properties.im_source = key; fcFilmRender(node); });
      srcBtns[key] = b; srcBox.appendChild(b);
    }
    bar.appendChild(open); bar.appendChild(status); bar.appendChild(srcBox);
    el.appendChild(video); el.appendChild(bar);
    node._fc_film_src_btns = srcBtns; node._fc_film_src_box = srcBox; node._fc_film_open = open;
    node.addDOMWidget("fc_film", "div", el, {
      serialize: false,
      getMinHeight: () => fcFilmSide(node) + FC_FILM_BAR_H + 4 + 8,
    });
    node._fc_film_el = el; node._fc_film_video = video; node._fc_film_status = status;
  }
  fcFilmWidgets(node);
  const info = fcFilmCurrentInfo(node);
  const v = node._fc_film_video, s = node._fc_film_status;
  const onCut = fcFromCut(node);
  const src = onCut ? fcFilmSource(node) : "film";
  node._fc_film_src_box.style.display = onCut ? "flex" : "none";
  for (const [key, b] of Object.entries(node._fc_film_src_btns || {})) {
    const on = key === src, can = key === "film" || !!node._fc_shot;
    b.style.background = on ? "#2ea043" : "#333"; b.style.borderColor = on ? "#2ea043" : "#555"; b.style.color = on ? "#fff" : "#ddd";
    b.disabled = !can; b.style.opacity = can ? "1" : "0.35";
  }
  // 2026-11-05: say WHO is running; the last film stays visible and operable.
  const runNode = fcRun.running ? (fcRun.node || "queued") : "";
  const filmRuns = /film|assemble/i.test(runNode);
  let txt, col = "#aaa";
  if (src === "shot") { txt = `▶ ${node._fc_shot.title} (from Cut)`; col = "#fff"; }
  else if (fcRun.running && filmRuns) { txt = "⏳ Building film…"; col = "#4fc3f7"; }
  else if (fcRun.running) { txt = `⏳ ${runNode} running` + (info?.exists ? " · last film" : ""); col = "#4fc3f7"; }
  else if (!info) txt = "No film yet – Run, then RENDER VIDEO";
  else if (!info.exists) { txt = info.status; col = "#e3b341"; }
  else { txt = "✓ " + fcShortStatus(info) + (info.view ? "" : " (outside ComfyUI output – no preview)"); col = "#7ee787"; }
  s.textContent = txt; s.style.color = col; s.title = info?.status || txt;
  const canOpen = !!info?.exists;
  node._fc_film_open.disabled = !canOpen;
  node._fc_film_open.style.opacity = canOpen ? "1" : "0.35";
  if (src === "shot") {
    if (v.getAttribute("src") !== node._fc_shot.url) { v.setAttribute("src", node._fc_shot.url); v.muted = false; v.play?.().catch(() => {}); }
  } else if (info?.view) {
    const q = new URLSearchParams({ ...info.view, t: info.saved_at || "" });
    const url = api.apiURL(`/view?${q}`);
    if (v.getAttribute("src") !== url) { v.setAttribute("src", url); v.play?.().catch(() => {}); }
  } else if (v.getAttribute("src")) { v.removeAttribute("src"); v.load(); }
  // Square player: the height always follows the width (node width set by the user or the auto layout).
  const need = [Math.max(node.size[0], FC_FILM_W + 20), node.computeSize()[1]];
  if (Math.abs(node.size[0] - need[0]) > 1 || Math.abs(node.size[1] - need[1]) > 1) node.setSize(need);
  node.setDirtyCanvas(true, true);
}
// Cut's ▶ play: show one shot in this Film node and switch it to "Single shot" (called from im_cut_state.js).
export function fcFilmShowShot(node, shot) {
  node._fc_shot = shot;
  node.properties = node.properties || {};
  node.properties.im_source = "shot";
  fcFilmRender(node);
}
window.fcFilmShowShot = fcFilmShowShot;

// Active output nodes (output_node) behind the start nodes, without director/Choose (they only render with Run).
export function fcDownstreamOutputs(startIds) {
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
        this.properties.im_source = "film";   // a new film was built: show it (not the last single shot)
      }
      fcFilmRender(this);
    };
    // 2026-11-13: fps/file and the Film|Shot switch follow the connections
    const origConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      const r = origConn?.apply(this, args);
      if (this._fc_film_el) setTimeout(() => fcFilmRender(this), 0);
      return r;
    };
    // 2026-11-13: a saved/created value outside the list ("" after a node swap) fails validation
    // ("The value  for Video Preview's file is not available") -> back to "(none)" on load.
    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const r = origConfigure?.apply(this, args);
      const w = this.widgets?.find((x) => x.name === "file");
      const vals = w?.options?.values;
      if (w && Array.isArray(vals) && vals.length && !vals.includes(w.value)) w.value = vals.includes("(none)") ? "(none)" : vals[0];
      return r;
    };
  },
});

// 2026-11-09 (user: „pos prompt always green. make the coloring logical“): fixed color by task for the own
// nodes, also for newly created ones (e.g. automatically generated Auto Prompts). LiteGraph default palette:
// green = positive prompt, cyan = engine interface. Saved colors (workflow) win.
export const IM_ROLE_COLORS = {
  InfiniteMovieAutoPrompt: ["#232", "#353"],
  InfiniteMovieStyle: ["#232", "#353"],
  InfiniteMovieEngineIn: ["#233", "#355"],
  InfiniteMovieEngineOut: ["#233", "#355"],
};
