import { app } from "../../scripts/app.js";
import { fcChooseRedoTokens, fcParseShotSeconds, fcQueueFixedSeeds, fcReviewToast, fcShotSecondsOf, getLink } from "./im_common.js";
import { fcChooseRender } from "./im_cut.js";
import { fcChooseGetChoices, fcChooseSetChoices } from "./im_cut_state.js";
export function fcRerenderMarked(node, rerenderFn) {
  const marked = fcChooseRedoTokens(node);
  if (!marked.length) return;
  // 57c: find the director via `sync` OR `segments`, also through reroute/intermediate nodes
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
  let renderNode = findDirector("sync") || findDirector("segments");
  if (!renderNode) {
    fcReviewToast("kein Director über sync/segments gefunden", "#d93025"); return;
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
export function fcChooseDirectorOf(node) {
  let n = node, guard = 0;
  while (n && guard++ < 10) {
    const inp = n.comfyClass === "Reroute" ? n.inputs?.[0] : n.inputs?.find((i) => i.name === "sync");
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
export function fcChooseEditPrompt(node, col, e, setMarked) {
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
export function fcChooseEditSeconds(node, col, e, setMarked) {
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

