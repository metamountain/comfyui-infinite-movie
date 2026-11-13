import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { IMG } from "./im_common.js";
import { imvFixWidth } from "./im_viewer.js";
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
export function renderEstimate(director) {
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
  // SYNC: the "pipe" (task 32) – Render → (Cut) → Even Motion. 116a: type SYNC.
  SYNC: ["InfiniteMovieAssemble"],
  // Every further type an InfiniteMovieRender node outputs gets at least 1 display node.
  MASK:    ["PreviewAny"],
  INT:     ["PreviewAny"],
  FLOAT:   ["PreviewAny"],
  BOOLEAN: ["PreviewAny"],
};

const FC_PREFERRED_IN = {
  IMAGE: ["LoadImage"],
  VIDEO: ["LoadVideo", "VHS_LoadVideo"],
  SYNC: ["InfiniteMovieRender", "InfiniteMovieAssemble"],
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
    // SYNC (Auftrag 32): gut sichtbare Linkfarbe (hellblau). 116a: Typ SYNC.
    if (LiteGraph.slot_colors) {
      LiteGraph.slot_colors["SYNC"] = "#4fc3f7";
    }
  },
});

