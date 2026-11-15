// Prompt writing progress in the Director's storyboard (user 2026-11-15: "separate progress bar for prompt
// generation, estimate the time, log it, refine the estimate, same look as image gen").
// The server (director_prompts.write_prompts) sends infinite_movie.prompt_progress: start (count + estimates from
// the timing log), plan_done, prompt / prompt_done per film, done. The estimate refines itself during the run:
// measured prompt durations replace the logged median as soon as the first one is done.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { fmtTime } from "./im_progress.js";

export const PP_CSS = `
.imsb-pp { flex-basis:100%; height:22px; border-radius:3px; background:#202020; display:flex; align-items:center;
  padding:0 6px; box-sizing:border-box; visibility:hidden; }
.imsb-pp span { font:bold 11px system-ui; color:#fff; background:rgba(20,20,20,0.85); padding:2px 6px; border-radius:3px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }`;

// Remaining seconds and fraction of a running prompt job (state p, now in ms).
export function promptEta(p, now) {
  const el = (now - p.t0) / 1000;
  const avg = p.done.length ? p.done.reduce((a, b) => a + b, 0) / p.done.length : p.estPrompt;
  let rem;
  if (p.phase === "plan") rem = Math.max(p.estPlan - el, 1) + p.n * avg;
  else if (p.phase === "prompt") rem = Math.max(avg - (now - p.kStart) / 1000, 1) + avg * (p.n - p.k - 1);
  else rem = 0;
  return { el, rem, frac: p.phase === "done" ? 1 : el / (el + rem) };
}

function draw(node) {
  const p = node._impp, bar = node._imsb?.pbar;
  if (!p || !bar) return;
  const { el, rem, frac } = promptEta(p, p.end || Date.now());
  const pct = Math.round(Math.min(1, Math.max(0, frac)) * 100);
  bar.style.visibility = "visible";
  bar.style.background = p.phase === "done" ? "#1a7f37"
    : `linear-gradient(90deg, #39ff14 0%, #39ff14 ${pct}%, #202020 ${pct}%, #202020 100%)`;   // = Cut's render bar
  bar.firstChild.textContent = p.phase === "done" ? `✓ ${p.n} prompt${p.n === 1 ? "" : "s"} written · ${fmtTime(el)}`
    : p.phase === "plan" ? `✎ Story plan… · ${fmtTime(rem)} left`
    : `✎ Prompt ${p.k + 1}/${p.n} · ${fmtTime(rem)} left`;
  bar.title = `Estimate from earlier runs: plan ${Math.round(p.estPlan)} s, prompt ${Math.round(p.estPrompt)} s` +
    (p.done.length ? ` · this run: ${(p.done.reduce((a, b) => a + b, 0) / p.done.length).toFixed(1)} s per prompt` : "");
}

function stop(node, hideAfterMs) {
  const p = node._impp;
  if (!p) return;
  clearInterval(p.timer);
  if (!p.end) { p.end = Date.now(); p.phase = "done"; }
  draw(node);
  setTimeout(() => { if (node._impp === p && node._imsb?.pbar) node._imsb.pbar.style.visibility = "hidden"; }, hideAfterMs);
}

api.addEventListener("infinite_movie.prompt_progress", (e) => {
  const d = e.detail || {}, node = app.graph?.getNodeById?.(String(d.node).split(":")[0]);
  if (!node?._imsb) return;
  const now = Date.now();
  if (d.phase === "start") {
    clearInterval(node._impp?.timer);
    node._impp = { t0: now, n: d.n || 0, estPlan: d.est_plan || 0, estPrompt: d.est_prompt || 20, phase: d.plan ? "plan" : "prompt",
      k: 0, kStart: now, done: [], end: 0, timer: setInterval(() => draw(node), 500) };   // local redraw only, no server poll
  }
  const p = node._impp;
  if (!p) return;
  if (d.phase === "prompt") Object.assign(p, { phase: "prompt", k: d.k, kStart: now });
  if (d.phase === "prompt_done" && d.seconds > 0) p.done.push(d.seconds);
  if (d.phase === "done") { stop(node, 5000); return; }
  draw(node);
});

// The queue drained (error / cancel included): close a bar that never got its "done".
api.addEventListener("status", (e) => {
  if (e.detail?.exec_info?.queue_remaining !== 0) return;
  for (const n of app.graph?._nodes || []) if (n._impp && !n._impp.end) stop(n, 3000);
});
