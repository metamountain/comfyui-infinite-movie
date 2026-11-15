// Director and Cut are twins (user 2026-11-15: "Siamese twins"): Cut's top and bottom edges are flush with the
// Director's (same y, same height - the taller content decides for both), and a
// flexible head (spacer above Cut's film rows, node._imHead) puts its first film row exactly at the height of the
// Director's first prompt box. Both share one height system (boardGeometry), so one offset fixes every row. Runs after
// every render of either node: the Director's content can change (toolbar, format, images) and workflows load with
// old positions.
import { app } from "../../scripts/app.js";
import { fcChooseDirectorOf } from "./im_cut_edit.js";
import { fcChooseRender } from "./im_cut.js";

const pending = new Set();

export function alignTwins(node) {
  pending.add(node);
  if (pending.size > 1) return;
  // two frames: the canvas has drawn the DOM widgets at their new place before we measure
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const nodes = [...pending];
    pending.clear();
    for (const n of nodes) align(n);
  }));
}

const firstIn = (n, sel) => {
  for (const w of n?.widgets || []) {
    const e = w.element?.querySelector?.(sel);
    if (e?.offsetParent) return e;
  }
  return null;
};

function align(n) {
  const cuts = n.comfyClass === "InfiniteMovieChooser" ? [n]
    : (app.graph?._nodes || []).filter((c) => c.comfyClass === "InfiniteMovieChooser" && fcChooseDirectorOf(c) === n);
  for (const c of cuts) {
    const d = fcChooseDirectorOf(c), box = firstIn(d, ".imsb-p"), info = firstIn(c, ".fc-info");
    if (!box || !info) continue;   // collapsed / off screen / no films yet
    // head that puts row 1 at box 1 with both tops flush; Cut's own head taller than the Director's -> head 0, Cut lower
    const need = (c._imHead || 0) + (box.getBoundingClientRect().top - info.getBoundingClientRect().top) / app.canvas.ds.scale
      + (c.pos[1] - d.pos[1]);
    const head = Math.max(0, Math.round(need)), y = d.pos[1] + Math.max(0, Math.round(-need));
    if (head !== (c._imHead || 0) || Math.abs(c.pos[1] - y) >= 0.5) {
      c._imHead = head;
      c.pos = [c.pos[0], y];
      fcChooseRender(c);   // renders at its content height, the bottom follows below
    }
    // same bottom: one height for both, the taller content wins
    const bottom = Math.max(d.pos[1] + d.size[1], c.pos[1] + c.computeSize()[1]);
    if (Math.abs(d.pos[1] + d.size[1] - bottom) >= 0.5) d.setSize([d.size[0], bottom - d.pos[1]]);
    if (Math.abs(c.pos[1] + c.size[1] - bottom) >= 0.5) c.setSize([c.size[0], bottom - c.pos[1]]);
    app.canvas.setDirty(true, true);
  }
}
