import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { fcClearFilms, fcChooseRedoTokens, fcReviewToast, imEmptyPromptFilms, imFilmCount, imFilmInfoText, imPromptRun, imShotImageCount } from "./im_common.js";
import { fcFilmShowShot } from "./im_film.js";
import { fcChooseRender } from "./im_cut.js";
import { fmtTime, renderEstimate } from "./im_progress.js";
import { IMV_NODE_W, imvDraw, imvStop } from "./im_viewer.js";
import { fcChooseDirectorOf } from "./im_cut_edit.js";
import { boardFormat } from "./im_storyboard_io.js";
import { cellTops } from "./im_storyboard_model.js";
import { imParseStoryboard, imRowCut } from "./im_common.js";
// 124d: one row per film (mirror of the Director's prompt boxes): tile box 283×205 scaled to the
// connected Director's format, rows staggered half a row, node width fixed 672.
const FC_CHOOSE_LI_W = 283, FC_CHOOSE_LI_H = 205;
export const FC_CHOOSE_ROW_GAP = 10;
export const FC_CHOOSE_NODE_W = 672;
export const FC_CHOOSE_GAP = 4;
export const FC_CHOOSE_PAD = 20;     // DOM widget margin left+right in the node
// Effective choice of a shot: A/B from the widget only counts if the shot has both variants (otherwise after
// a run with variants=1 an old „b“ sits in the widget and sheet/seam look for a variant that does not exist).
export function fcChooseEff(e, c) { return (e?.has_variants && (c === "a" || c === "b")) ? c : (e?.auto || "a"); }
// Finding of a variant in plain text (thresholds like review_nodes.JERK_HARD / LEVEL_STRONG).
// 78: e = shot entry; q.seam = red seam row to the next shot (only if e.seam_bad).
export function fcChooseQuality(v, e) {
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
export const FC_CHOOSE_STATUS_H = 26, FC_CHOOSE_BIG_H = 44;

// 2026-11-08 (user: couple chooser + Assemble): show the shot in the Assemble viewer (click on the shot header
// in the chooser) or highlight it in the chooser (seg button in the Assemble viewer). number = shot number (1-based).
export function fcAsmFocus(number) {
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
export function fcChooseFocus(number) {
  for (const c of fcChooseAll()) {
    c._fc_choose_focus = number;
    c._fc_choose_el?.querySelectorAll(".fc-choose-head").forEach((h, i) => {
      h.style.color = i + 1 === number ? "#58a6ff" : "#fff";
    });
  }
}

// Run state of ComfyUI (for status + greying out), global from the api events.
export const fcRun = { running: false, node: "", value: 0, max: 0 };
function fcChooseAll() { return (app.graph?._nodes || []).filter((n) => n.comfyClass === "InfiniteMovieChooser"); }
export function fcChooseRefreshAll() { for (const n of fcChooseAll()) fcChooseRender(n); }
// Auto layout (web/infinite_movie_layout.js) refreshes Choose BEFORE measuring – otherwise the old width,
// because Choose otherwise only adapts when drawing (onDrawForeground).
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
  fcRun.promptOnly = imPromptRun(n) ? (fcRun.promptOnly ?? true) : false;
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
// director (storyboard images, loop, variants – same counting as n_segments in nodes.py).
function fcChoosePlan(node) {
  const d = fcChooseDirectorOf(node);
  if (!d) return null;
  const nImg = imShotImageCount(d);
  const variants = String(d.widgets?.find((w) => w.name === "variants")?.value) === "2";
  return { n: imFilmCount(d), variants: nImg > 0 && variants, director: d, nImg };
}

// Real entries (after the run) or placeholders from the plan; stale entries
// (column count or variants no longer fit the director) yield to the placeholders.
export function fcChooseEntries(node) {
  const real = node._fc_choose_entries || [];
  const plan = fcChoosePlan(node);
  if (real.length && (!plan || (plan.n === real.length && plan.variants === !!real[0]?.has_variants))) return real;
  if (!plan || !plan.n) return real.length && !plan ? real : [];
  return Array.from({ length: plan.n }, (_, i) => ({
    number: i + 1, placeholder: true, has_variants: plan.variants, a: {}, b: plan.variants ? {} : null,
  }));
}

export function fcChooseSig(e) { return e.length + (e[0]?.placeholder ? "p" : "r") + (e[0]?.has_variants ? "v" : ""); }

// 124d: one row per film (mirror of the Director's prompt boxes): the tile box 283×205 is scaled to the
// connected Director's format (Settings node via boardFormat), rows staggered half a row, node width fixed 672.
export function fcChooseLayout(node, entries) {
  const fmt = boardFormat(fcChooseDirectorOf(node), null) || { w: 4, h: 5 };
  const k = Math.min(FC_CHOOSE_LI_W / fmt.w, FC_CHOOSE_LI_H / fmt.h);
  const iw = Math.round(fmt.w * k), ih = Math.round(fmt.h * k);
  const row = ih + FC_CHOOSE_ROW_GAP;
  // rows mirror the Director's prompt boxes, including the cell division of cut films (cellTops)
  const dir = fcChooseDirectorOf(node), sb = imParseStoryboard(dir);
  const cells = cellTops(sb.map((r) => ({ ...r, cut: imRowCut(dir, r) })), !!dir?.widgets?.find((w) => w.name === "loop")?.value, row);
  const tops = entries.map((_, i) => cells.box[i] ?? i * row + row / 2);
  const boardH = entries.length ? Math.max(...tops) + ih : 0;
  // 2026-11-13: no play field in Cut any more – the analysis viewer is its own widget (im_viz) below this one.
  const domH = boardH + FC_CHOOSE_GAP + FC_CHOOSE_STATUS_H + FC_CHOOSE_GAP + FC_CHOOSE_BIG_H + 8;
  return { iw, ih, row, boardH, domH, sheet: null, tops };
}
// 124d: the 3×3 sheet row is gone (one row per film) – the sheet is reached via the analysis viewer.
function fcChooseSheetSize() { return null; }
export function fcChooseUpdateSheet(node, only = -1) {
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
    cell.lbl.textContent = src ? `Film ${e.number}${e.has_variants ? " · " + k.toUpperCase() : ""} · 3×3`
      : err ? `✗ Film ${e.number}: ${err}` : "no sheet yet – Run";
    cell.lbl.style.color = !src && err ? "#ff6b6b" : "";
  });
}

// 124d: fixed node width – one row per film, tiles + info box always fit into 672 px.
export function fcChooseWidth() { return FC_CHOOSE_NODE_W; }

export function fcChooseStableUrl(im) {
  // Stable URL WITHOUT cache buster: when switching still<->animated the file comes from the cache.
  const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder || "", type: im.type || "temp" });
  return api.apiURL(`/view?${q}`);
}

// Read/write the choices widget (format 'auto,b,auto', like _parse_choices in review_nodes.py).
export function fcChooseGetChoices(node) {
  const w = node.widgets?.find((x) => x.name === "choices");
  const parts = String(w?.value || "").split(",").map((s) => s.trim().toLowerCase());
  const n = (node._fc_choose_entries || []).length;
  return Array.from({ length: n }, (_, i) => (parts[i] === "a" || parts[i] === "b") ? parts[i] : "auto");
}
export function fcChooseSetChoices(node, arr) {
  const w = node.widgets?.find((x) => x.name === "choices");
  if (w) w.value = arr.join(",");
}
// Effective choice per shot ('a'/'b'), AUTO resolved.
export function fcChooseEffective(node) {
  const c = fcChooseGetChoices(node);
  return (node._fc_choose_entries || []).map((e, i) => fcChooseEff(e, c[i]));
}

// Live preview: only the row under the mouse is animated, all others show the still image.
export function fcChooseApplyActive(node) {
  const el = node._fc_choose_el;
  if (!el) return;
  const active = node._fc_choose_active ?? -1;
  const entries = node._fc_choose_entries || [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    for (const k of ["a", "b"]) {
      const img = el.querySelector(`.fc-tile-${k}[data-fc-i="${i}"] img`), v = e[k];
      if (!img || !v) continue;
      const im = (i === active && v.preview) ? v.preview : (v.still || v.preview);
      const src = im ? fcChooseStableUrl(im) : "";
      if (src && img.getAttribute("src") !== src) img.setAttribute("src", src);
    }
  }
}

// State for the status row + button.
function fcChooseState(node) {
  const entries = fcChooseEntries(node);
  const plan = fcChoosePlan(node);
  const marked = node.properties?.marked || [];
  if (!plan) return { text: "Connect the Director's sync output to this node.", tone: "warn", btn: null };
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
    const r = fcRenderLine();
    if (r) return { text: r.text, tone: "busy", btn: null, frac: r.frac };
    const dir = (app.graph?._nodes || []).find((n) => n.comfyClass === "InfiniteMovieRender" && n._fcProg?.t0 && !n._fcProg.end);
    const p = fcRun.max ? ` · ${fcRun.value}/${fcRun.max}` : "";
    return { text: `Rendering… please wait (${dir?._fcProg?.phase || "queued"}${p})`, tone: "busy", btn: null };
  }
  // 116c2: film build failed (ui["film_error"] from the executed event) -> red status line.
  if (node._fc_film_error) return { text: node._fc_film_error, tone: "err", btn: null };
  return fcChooseStateIdle(node, entries, plan, marked);
}

// 79: Schritt-Pfad 1 Prompts › 2 Run › 3 Pick › 4 FILM (Statuszeile, vorn).
function fcChooseSteps(node) {
  const entries = fcChooseEntries(node);
  const isPlaceholder = !!entries[0]?.placeholder;
  const filmDone = node._fc_choose_ran != null;
  const director = fcChooseDirectorOf(node);
  const promptsFilled = !director || imEmptyPromptFilms(director).length === 0;
  let s1, s2, s3, s4;
  if (filmDone) { s1 = s2 = s3 = s4 = "done"; }
  else if (!isPlaceholder) { s1 = "done"; s2 = "done"; s3 = "current"; s4 = "open"; }
  else { s1 = promptsFilled ? "done" : "open"; s2 = "current"; s3 = "open"; s4 = "open"; }
  return [
    { label: "1 Prompts", state: s1 }, { label: "2 Run", state: s2 },
    { label: "3 Pick", state: s3 }, { label: "4 RENDER", state: s4 },
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

// Render countdown of the running Director, remaining time first: "⏳ ~2:14 left · film 2/4 · 0:56 elapsed".
export function fcRenderLine() {
  const dir = (app.graph?._nodes || []).find((n) => n.comfyClass === "InfiniteMovieRender" && n._fcProg?.t0 && !n._fcProg.end);
  const r = dir && renderEstimate(dir);
  if (!r || r.seg < 0) return null;
  const left = isFinite(r.eta) ? `⏳ ~${fmtTime(r.eta)} left` : "⏳ estimating…";
  return { text: `${left} · film ${r.seg + 1}/${r.segs} · ${fmtTime(r.el)} elapsed`, frac: r.frac };
}

function fcChooseStateIdle(node, entries, plan, marked) {
  if (entries[0]?.placeholder) return { text: `Waiting for Run: ${entries.length} film(s)${plan.variants ? " × 2 variants" : ""} will appear here.`, tone: "idle", btn: null };
  const redo = fcChooseRedoTokens(node);
  if (redo.length) return { text: `${redo.map((t) => t.toUpperCase()).join(", ")} marked ✗ – RERENDER renders only these with new seeds.`, tone: "act", btn: "rerender" };
  if (node._fc_choose_ran == null) return { text: entries[0]?.has_variants ? "Films ready – pick A or B per film, then RENDER VIDEO builds the film."
    : "Films ready – RENDER VIDEO builds the film.", tone: "act", btn: "assemble" };
  const changed = (node._fc_choose_ran || "") !== fcChooseEffective(node).join(",");
  if (changed) return { text: "Choice changed – press RENDER VIDEO to rebuild the film.", tone: "act", btn: "assemble" };
  if (node._fc_film_done) {
    // 119: total render time (Director's _fcProg t0→end) in the green done line.
    const dir = fcChooseDirectorOf(node);
    const rt = dir?._fcProg?.t0 && dir._fcProg.end ? ` · rendered in ${fmtTime(renderEstimate(dir).el)}` : "";
    return { text: `✓ VIDEO READY · ${imFilmInfoText(node._fc_film_done)}${rt}`, tone: "done", btn: null,
      title: node._fc_film_done.path };
  }
  if (entries[0]?.has_variants) return { text: "Film assembled. Pick A or B per film to change it, ✓/✗ to re-render a film.", tone: "ok", btn: null };
  return { text: "Film assembled. Mark a film ✗ to re-render it.", tone: "ok", btn: null };
}

export function fcChooseStatus(node) {
  const st = fcChooseState(node);
  const s = node._fc_choose_status, b = node._fc_choose_btn;
  if (s) {
    const col = { warn: "#e3b341", busy: "#4fc3f7", idle: "#aaa", act: "#fff", ok: "#7ee787", err: "#d93025", done: "#fff" }[st.tone] || "#aaa";
    const sText = node._fc_choose_status_text;
    if (sText) {
      sText.textContent = st.text; sText.style.color = col;
      sText.style.fontWeight = st.tone === "done" ? "bold" : "";
      sText.title = st.title || "";
    }
    // Progress bar in the background of the status row (user 2026-11-03: „missing progress bar“)
    const pct = st.frac != null ? Math.round(Math.max(0, Math.min(1, st.frac)) * 100) : null;
    s.style.background = pct == null ? (st.tone === "done" ? "#1a7f37" : "#202020")
      : `linear-gradient(90deg, #39ff14 0%, #39ff14 ${pct}%, #202020 ${pct}%, #202020 100%)`;   // user 2026-11-13: neon green
    // white text with a dark outline: readable on the neon part and on the dark rest
    if (pct != null && sText) { sText.style.color = "#fff"; sText.style.textShadow = "0 0 3px #000, 0 0 2px #000"; sText.textContent = `${pct}% · ${st.text}`; }
    else if (sText) sText.style.textShadow = "";
    fcChooseUpdateSteps(node);
  }
  if (b) {
    b.style.visibility = st.btn ? "visible" : "hidden";
    b.style.cursor = st.btn === "busy" ? "progress" : "pointer";
    if (st.btn === "busy") {
      b.textContent = "⏳ ASSEMBLING…"; b.style.background = "#30363d"; b.style.borderColor = "#4fc3f7";
      b.title = "Film is being built – see the status line above.";
    } else if (st.btn === "assemble") {
      b.textContent = "RENDER VIDEO ▶"; b.style.background = "#2ea043"; b.style.borderColor = "#2ea043";
      b.title = "Rebuild the film from the chosen variants (Director + Cut come from cache, only Even Motion runs).";
    } else if (st.btn === "rerender") {
      const m = fcChooseRedoTokens(node).length;
      b.textContent = `RERENDER ${m} ↻`; b.style.background = "#d93025"; b.style.borderColor = "#d93025";
      b.title = "Re-render the marked films (new seeds), then choose again.";
    }
    b._fc_mode = st.btn;
  }
  // Lock the A/B buttons + image click while rendering
  node._fc_choose_el?.querySelectorAll(".fc-keep").forEach((x) => { x.style.opacity = fcRun.running ? "0.35" : "1"; });
}

export function fcChoosePick(node, i, letter) {
  if (fcRun.running) return;
  const e = (node._fc_choose_entries || [])[i];
  if (!e || e.placeholder || !e.has_variants) return;
  const c = fcChooseGetChoices(node);
  // Choice = auto winner → AUTO again (badge stays visible), otherwise a fixed choice.
  c[i] = letter === e.auto ? "auto" : letter;
  fcChooseSetChoices(node, c);
  fcChooseRender(node);
}

// ▶ play (and tile hover, quiet) shows the film in the Film node(s) fed by this Cut, switched to Shot.
export function fcChoosePlay(node, number, letter, ref, quiet = false) {
  if (!ref) return;
  const g = node.graph || app.graph;
  const linkOf = (id) => g?.links?.[id] ?? g?.links?.get?.(id);
  const films = [];
  for (const o of node.outputs || []) for (const lid of o.links || []) {
    const t = g?.getNodeById(linkOf(lid)?.target_id);
    if (t?.comfyClass === "InfiniteMovieFilm") films.push(t);
  }
  if (!films.length) { if (quiet) return; fcReviewToast("Connect Cut's video_path to a Film node to play films there.", "#d93025"); return; }
  const title = `Film ${number}${letter ? " · " + letter : ""}`;
  for (const f of films) fcFilmShowShot(f, { url: fcChooseStableUrl(ref), title });
}

