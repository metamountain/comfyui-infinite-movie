// Director storyboard view: image tiles on the left (one per row), the prompt of the film image i -> next to the
// right, half a row lower (between its two images). Rules in im_storyboard_model.js, widgets/server in
// im_storyboard_io.js. User decisions: tiles as large as a standard Load Image preview, format from Settings; one
// delete button (image + prompt); a dragged image takes its prompt along, prompts whose images changed glow red.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { fcQueueFixedSeeds, fcReviewToast, imWidget, settingsNodeOf } from "./im_common.js";
import {
  MAX_IMAGES, emptyRow, hasFilm, isStale, moveRow, nextOf, pairOf, samePair,
} from "./im_storyboard_model.js";
import {
  boardFormat, defaultSeconds, imageUrl, isLoop, readRows, uploadImage, writeRows,
} from "./im_storyboard_io.js";

// LI_W x LI_H: preview box of a standard Load Image node (measured 2026-11-14: 16:9 = 283x159, 4:5 = 164x205)
const LI_W = 283, LI_H = 205, GAP = 10, PROMPT_W = 250, TOOLBAR_H = 66, MARGIN = 10;

const CSS = `
.imsb { position:relative; font:12px system-ui,sans-serif; color:#ddd; box-sizing:border-box; padding:0 ${MARGIN}px; }
.imsb * { box-sizing:border-box; }
.imsb-tb { display:flex; flex-wrap:wrap; gap:6px; height:${TOOLBAR_H}px; align-content:flex-start; }
.imsb-tb button, .imsb-cnt { height:28px; border-radius:4px; border:1px solid #4a4a4a; background:#2b2b2b; color:#ddd; cursor:pointer; font:600 12px system-ui; padding:0 9px; }
.imsb-tb button:hover { background:#383838; }
.imsb-cnt { display:flex; align-items:center; gap:6px; cursor:default; }
.imsb-cnt b { cursor:pointer; padding:0 3px; }
.imsb-bd { position:relative; }
.imsb-t { position:absolute; left:0; border-radius:5px; background:#222; border:1px solid #4a4a4a; overflow:hidden; cursor:grab; user-select:none; }
.imsb-t img { width:100%; height:100%; object-fit:cover; display:block; pointer-events:none; }
.imsb-t.empty { border:2px dashed #555; display:flex; align-items:center; justify-content:center; color:#888; cursor:pointer; }
.imsb-t.drag { background:#1f3550; border:3px solid #4af; opacity:.85; }
.imsb-t.land { animation:imsb-land 1.2s ease-out; }
@keyframes imsb-land { from { box-shadow:0 0 14px 4px #4af; } to { box-shadow:none; } }
.imsb-t .no { position:absolute; left:4px; top:4px; background:#000a; border-radius:3px; padding:0 5px; font:700 12px system-ui; }
.imsb-t .x { position:absolute; right:4px; top:4px; width:22px; height:22px; border-radius:3px; background:#000a; text-align:center; line-height:22px; cursor:pointer; }
.imsb-t .x:hover { background:#d93025; }
.imsb-t .lb { position:absolute; left:0; right:0; bottom:0; padding:2px 5px; background:#000a; font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.imsb-t .lb i { color:#3fb950; font-style:normal; margin-right:5px; }
.imsb-p { position:absolute; border-radius:5px; background:#262626; border:1px solid #4a4a4a; display:flex; flex-direction:column; padding:5px; gap:4px; }
.imsb-p.loop { border-style:dashed; }
.imsb-p.stale { border:2px solid #d93025; box-shadow:0 0 8px #d9302588; }
.imsb-p .hd { display:flex; align-items:center; gap:5px; font-weight:700; }
.imsb-p .bg { font:600 10px system-ui; border-radius:3px; padding:1px 5px; background:#333; color:#aaa; }
.imsb-p .bg.own { background:#e6c229; color:#111; } .imsb-p .bg.llm { background:#2f5d8a; color:#fff; }
.imsb-p .red { display:none; color:#ff6b5e; font:700 10px system-ui; }
.imsb-p.stale .red { display:inline; }
.imsb-p .sec { margin-left:auto; display:flex; align-items:center; gap:3px; font-weight:400; }
.imsb-p .sec input { width:44px; background:#1b1b1b; color:#ddd; border:1px solid #444; border-radius:3px; font:12px system-ui; padding:1px 3px; }
.imsb-p .sec input.own { color:#e6c229; font-weight:700; border-color:#e6c229; }
.imsb-p textarea { flex:1; resize:none; background:#1b1b1b; color:#ddd; border:1px solid #444; border-radius:3px; font:12px system-ui; padding:4px; }
.imsb-p .rg { height:28px; border-radius:4px; border:1px solid #4a4a4a; background:#2b2b2b; color:#ddd; font:600 13px system-ui; cursor:pointer; }
.imsb-p .rg:hover { background:#383838; }
.imsb-ins { position:absolute; left:0; height:18px; z-index:3; cursor:pointer; display:flex; align-items:center; justify-content:center; }
.imsb-ins span { display:none; width:22px; height:22px; border-radius:50%; background:#4af; color:#fff; font:700 17px/22px system-ui; text-align:center; box-shadow:0 0 0 3px #1b1b1b; }
.imsb-ins:hover span { display:block; }
.imsb-ins:hover::before { content:""; position:absolute; left:0; right:0; top:7px; height:4px; background:#4af8; border-radius:2px; }
.imsb-gap { position:absolute; left:-4px; height:4px; background:#4af; border-radius:2px; pointer-events:none; display:none; }
.imsb-gap::before, .imsb-gap::after { content:""; position:absolute; top:-3px; width:10px; height:10px; border-radius:50%; background:#4af; }
.imsb-gap::before { left:-5px; } .imsb-gap::after { right:-5px; }
`;
document.head.appendChild(Object.assign(document.createElement("style"), { textContent: CSS }));

const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

function pickFiles(multiple) {
  return new Promise((resolve) => {
    const inp = Object.assign(el("input"), { type: "file", accept: "image/*", multiple });
    inp.onchange = () => resolve([...(inp.files || [])]);
    inp.click();
  });
}

// Tile = the film format contain-fitted into the Load Image box; the prompt column fills the rest of the node.
function boardSize(node, rows, loop) {
  const { fmt } = node._imsb, n = rows.length;
  const k = Math.min(LI_W / fmt.w, LI_H / fmt.h);
  const iw = Math.round(fmt.w * k), ih = Math.round(fmt.h * k), row = ih + GAP;
  const pw = Math.max(PROMPT_W, Math.round(node.size[0]) - iw - GAP - 2 * MARGIN);
  const lastFilm = hasFilm(n, n - 1, loop) ? n - 1 : n - 2;   // its prompt box reaches half a row below its image
  // + room for the insert strip below the last image
  const h = Math.max(n * row - GAP + (n < MAX_IMAGES ? GAP / 2 + 10 : 0), lastFilm >= 0 ? lastFilm * row + row / 2 + ih : 0);
  return { iw, ih, row, pw, h, w: iw + GAP + PROMPT_W + 2 * MARGIN };
}

function signature(node) {
  const s = settingsNodeOf(node), v = (n, k) => imWidget(n, k)?.value;
  return [v(node, "storyboard"), v(node, "loop"), v(node, "seconds"), v(node, "shot_seconds"), v(s, "aspect"), v(s, "long_side")].join("|");
}

function commit(node, rows) { writeRows(node, rows); render(node); }

async function setImage(node, i, file) {
  const name = await uploadImage(file);
  if (!name) return;
  const rows = readRows(node);
  rows[i].image = name;
  commit(node, rows);
}

async function pickImage(node, i) {
  const f = (await pickFiles(false))[0];
  if (f) setImage(node, i, f);
}

function move(node, from, gap) {
  const rows = readRows(node), to = moveRow(rows, from, gap);
  if (to < 0) return;
  node._imsb.land = to;
  commit(node, rows);
}

// User 2026-11-14: hover on the line between two images shows a plus, click = new image there.
async function insertAt(node, k) {
  if (readRows(node).length >= MAX_IMAGES) { fcReviewToast(`Max ${MAX_IMAGES} images`, "#e68929"); return; }
  const f = (await pickFiles(false))[0];
  const name = f && await uploadImage(f);
  if (!name) return;
  const rows = readRows(node);
  rows.splice(k, 0, { ...emptyRow(), image: name });
  node._imsb.land = k;
  commit(node, rows);
}

function remove(node, i) {
  const rows = readRows(node);
  rows.splice(i, 1);
  commit(node, rows.length ? rows : [emptyRow()]);
}

// End the "writing" state of a storyboard: clear busy and redraw (no-op when it already ended).
const endBusy = (node) => { if (node._imsb?.busy) { node._imsb.busy = null; render(node); } };

// Prompt writing = a partial run of the Director alone with its `regen` widget set: it writes the prompts of these
// rows, renders nothing, and sends them back as ui.im_prompts (received).
async function regen(node, idx) {
  if (node._imsb?.busy) { fcReviewToast("Prompts are being written", "#e68929"); return; }
  if (!idx.length) { fcReviewToast("No prompt to write (all are ✎ manual)", "#e68929"); return; }
  const w = imWidget(node, "regen");
  if (!w) { fcReviewToast("Director has no regen input - restart ComfyUI", "#d93025"); return; }
  node._imsb.busy = new Set(idx);
  render(node);
  w.value = JSON.stringify(idx);
  try { if (!(await fcQueueFixedSeeds([String(node.id)]))) endBusy(node); }
  catch (e) { endBusy(node); fcReviewToast(`Prompt writing not started: ${e}`, "#d93025"); }
  finally { w.value = ""; }
}

// A result lands on the row whose current pair is the one it was written for - rows may have moved meanwhile.
function received(e) {
  const out = e.detail?.output?.im_prompts;
  const node = out && app.graph?.getNodeById?.(String(e.detail.node).split(":")[0]);
  if (!node?._imsb) return;
  const rows = readRows(node), loop = isLoop(node);
  for (const r of out) {
    if (r.error) { fcReviewToast(`Prompt ${r.i + 1}: ${r.error}`, "#d93025"); continue; }
    const at = (k) => samePair(pairOf(rows, k, loop), r.pair);
    const k = at(r.i) ? r.i : rows.findIndex((_, j) => at(j));
    if (k >= 0) Object.assign(rows[k], { prompt: r.prompt, own: false, pair: r.pair });
  }
  node._imsb.busy = null;
  commit(node, rows);
}

api.addEventListener("executed", received);
// The queue drained (queue_remaining 0) = every run is over -> end every "writing" state. Robust also when the
// Director ran without sending im_prompts (error/cancel), where "executed" never fires.
api.addEventListener("status", (e) => {
  if (e.detail?.exec_info?.queue_remaining === 0) for (const n of app.graph?._nodes || []) endBusy(n);
});

function startDrag(node, e, i, tile) {
  const st = node._imsb, bd = st.board, x0 = e.clientX, y0 = e.clientY, { row } = st.size;
  let active = false, gap = -1;
  const scale = () => (bd.getBoundingClientRect().height / bd.offsetHeight) || 1;
  const onMove = (ev) => {
    if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
    active = true;
    tile.classList.add("drag");
    const y = (ev.clientY - bd.getBoundingClientRect().top) / scale();
    gap = Math.max(0, Math.min(readRows(node).length, Math.round(y / row)));
    st.gap.style.display = gap === i || gap === i + 1 ? "none" : "block";
    st.gap.style.top = `${gap * row - GAP / 2 - 2}px`;
  };
  const end = (drop) => () => {
    for (const [t, f] of handlers) window.removeEventListener(t, f, true);
    st.gap.style.display = "none";
    tile.classList.remove("drag");
    if (drop && active && gap >= 0) move(node, i, gap);
  };
  const handlers = [["pointermove", onMove], ["pointerup", end(true)], ["pointercancel", end(false)]];
  for (const [t, f] of handlers) window.addEventListener(t, f, true);
}

function tileEl(node, rows, i) {
  const st = node._imsb, r = rows[i], { iw, ih, row } = st.size;
  const t = el("div", "imsb-t" + (r.image ? "" : " empty") + (st.land === i ? " land" : ""));
  t.style.cssText = `top:${i * row}px;width:${iw}px;height:${ih}px`;
  if (r.image) {
    const img = el("img");
    img.src = imageUrl(r.image);
    img.draggable = false;
    if (i === 0) img.onload = () => {
      const size = `${img.naturalWidth}x${img.naturalHeight}`;
      if (size === st.size0) return;   // a new <img> per render - without this check "from images" renders forever
      st.size0 = size; st.img0 = img;
      if (st.fmt.label.startsWith("from image")) render(node);
    };
    const lb = el("div", "lb");
    lb.append(el("i", null, st.fmt.label), r.image.split("/").pop());
    t.append(img, lb);
    t.onpointerdown = (e) => { if (e.button === 0) { e.stopPropagation(); startDrag(node, e, i, t); } };
    t.ondblclick = () => pickImage(node, i);
  } else {
    t.appendChild(el("span", null, "+ image – click"));
    t.onclick = () => pickImage(node, i);
  }
  const x = el("div", "x", "✕");
  x.title = "Remove this image and its prompt";
  x.onpointerdown = (e) => e.stopPropagation();
  x.onclick = (e) => { e.stopPropagation(); remove(node, i); };
  t.append(el("div", "no", String(i + 1)), x);
  t.ondragover = (e) => e.preventDefault();
  t.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer?.files?.[0]; if (f) setImage(node, i, f); };
  return t;
}

function promptEl(node, rows, i, loop) {
  const st = node._imsb, r = rows[i], n = rows.length, j = nextOf(n, i, loop), { iw, ih, row, pw } = st.size;
  const box = el("div", "imsb-p" + (j === 0 && n > 1 ? " loop" : "") + (isStale(rows, i, loop) ? " stale" : ""));
  box.style.cssText = `left:${iw + GAP}px;top:${i * row + row / 2}px;height:${ih}px;width:${pw}px`;
  const hd = el("div", "hd");
  const badge = () => (r.own ? ["own", "✎ manual"] : r.prompt.trim() ? ["llm", "LLM"] : ["", "empty"]);
  const bg = el("span", "bg " + badge()[0], badge()[1]);
  bg.title = "manual = you typed this prompt; ✎ Write all prompts keeps it. LLM = written by the model.";
  const red = el("span", "red", "● doesn't fit");
  red.title = "The images around this prompt changed – edit or regenerate it";
  const def = defaultSeconds(node);
  const inp = Object.assign(el("input", r.sec ? "own" : null), { type: "number", min: "0.5", max: "20", step: "0.5", value: String(r.sec || def) });
  inp.onchange = () => {
    const v = parseFloat(inp.value), now = readRows(node);
    now[i].sec = v > 0 && v !== def ? Math.min(20, Math.max(0.5, v)) : 0;
    commit(node, now);
  };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") inp.blur(); };
  const sec = el("label", "sec", "⏱");
  sec.append(inp, "s");
  hd.append(el("span", null, `${i + 1} → ${n === 1 ? "open" : j + 1}`), bg, red, sec);
  const busy = !!st.busy?.has(i);
  const ta = Object.assign(el("textarea"), { value: r.prompt, disabled: busy,
    placeholder: busy ? "writing…" : "What happens from this image to the next…" });
  ta.onkeydown = (e) => e.stopPropagation();
  ta.oninput = () => {
    const now = readRows(node);
    Object.assign(now[i], { prompt: ta.value, own: !!ta.value.trim(), pair: pairOf(now, i, loop) });
    writeRows(node, now);
    Object.assign(r, now[i]);
    st.sig = signature(node);
    [bg.className, bg.textContent] = ["bg " + badge()[0], badge()[1]];
    box.classList.remove("stale");
  };
  const rg = Object.assign(el("button", "rg", busy ? "… writing" : "↻ Regenerate prompt"), { disabled: busy });
  rg.onclick = () => regen(node, [i]);
  box.append(hd, ta, rg);
  return box;
}

export function render(node) {
  const st = node._imsb;
  if (!st) return;
  const rows = readRows(node), loop = isLoop(node);
  st.fmt = boardFormat(node, st.img0);
  st.size = boardSize(node, rows, loop);
  const { iw, row, h, w } = st.size;
  st.cnt.textContent = String(rows.length);
  st.board.replaceChildren();
  st.board.style.height = `${h}px`;
  st.gap.style.width = `${iw + 8}px`;
  for (let i = 0; i < rows.length; i++) {
    st.board.appendChild(tileEl(node, rows, i));
    if (hasFilm(rows.length, i, loop)) st.board.appendChild(promptEl(node, rows, i, loop));
  }
  for (let k = 1; k <= rows.length && rows.length < MAX_IMAGES; k++) {   // k = n: below the last image
    const z = el("div", "imsb-ins");
    z.style.cssText = `top:${k * row - GAP / 2 - 9}px;width:${iw}px`;
    z.title = "Insert an image here";
    z.appendChild(el("span", null, "+"));
    z.onpointerdown = (e) => e.stopPropagation();
    z.onclick = () => insertAt(node, k);
    st.board.appendChild(z);
  }
  st.board.appendChild(st.gap);
  st.land = -1;
  st.sig = signature(node);
  st.w = node.size[0];
  node.setSize([Math.max(w, node.size[0]), node.computeSize()[1]]);
  node.setDirtyCanvas?.(true, true);
}

export function addStoryboard(node) {
  if (node._imsb) return;
  const root = el("div", "imsb"), tb = el("div", "imsb-tb"), cnt = el("div", "imsb-cnt");
  const less = el("b", null, "◀"), num = el("span", null, "4"), more = el("b", null, "▶");
  cnt.append("images", less, num, more);
  less.onclick = () => { const rows = readRows(node); if (rows.length > 1) { rows.pop(); commit(node, rows); } };
  more.onclick = () => {
    const rows = readRows(node);
    if (rows.length >= MAX_IMAGES) { fcReviewToast(`Max ${MAX_IMAGES} images`, "#e68929"); return; }
    commit(node, [...rows, emptyRow()]);
  };
  // Load images appends: empty rows at the end are filled first, then new rows follow (max MAX_IMAGES).
  const append = (names) => {
    if (!names.length) return;
    const rows = readRows(node);
    while (rows.length && !rows[rows.length - 1].image && !rows[rows.length - 1].prompt) rows.pop();
    const room = MAX_IMAGES - rows.length;
    if (names.length > room) fcReviewToast(`${names.length - room} images skipped (max ${MAX_IMAGES})`, "#e68929");
    commit(node, [...rows, ...names.slice(0, room).map((image) => ({ ...emptyRow(), image }))]);
  };
  const bLoad = el("button", null, "📂 Load images…");
  bLoad.title = `Adds the chosen images below the last one (sorted by name, max ${MAX_IMAGES})`;
  bLoad.onclick = async () => {
    const files = (await pickFiles(true)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const names = [];
    for (const f of files.slice(0, MAX_IMAGES)) { const nm = await uploadImage(f); if (nm) names.push(nm); }
    append(names);
  };
  const bAll = el("button", null, "✎ Write all prompts");
  bAll.title = "Writes every prompt except the ✎ manual ones (typed by you)";
  bAll.onclick = () => {
    const rows = readRows(node), loop = isLoop(node);
    regen(node, rows.flatMap((r, i) => (pairOf(rows, i, loop) && !r.own ? [i] : [])));
  };
  tb.append(cnt, bAll, bLoad);
  const board = el("div", "imsb-bd");
  root.append(tb, board);
  const st = node._imsb = { root, board, cnt: num, gap: el("div", "imsb-gap"), fmt: { w: 4, h: 5, label: "" }, sig: "", land: -1 };
  const height = () => TOOLBAR_H + (st.size?.h || 0) + 8;
  const dw = node.addDOMWidget("im_storyboard", "div", root, { serialize: false, getMinHeight: height, getMaxHeight: height });
  dw.serialize = false;   // the option alone does not keep it out of widgets_values (would drop all values on load)
  Object.defineProperty(dw, "width", { get: () => node.size[0], set() {}, configurable: true });
  // Changes from outside (loop/seconds widgets, Cut's ⏱, the Settings format, loading a workflow): redraw.
  st.timer = setInterval(() => {
    if (!node.graph) { clearInterval(st.timer); return; }
    if (document.activeElement?.matches?.(".imsb textarea, .imsb input")) return;   // never redraw while typing
    if (signature(node) !== st.sig || Math.abs(node.size[0] - (st.w || 0)) > 1) render(node);
  }, 1000);
  render(node);
}
