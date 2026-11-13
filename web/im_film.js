import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { fcReviewToast } from "./im_common.js";
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
export function fcFilmRender(node) {
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
    s.textContent = `⏳ ${runNode} running – film follows after FILM` + (info?.exists ? " · showing last film" : "");
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
        this._fc_film_recent_idx = 0;
      }
      fcFilmRender(this);
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
