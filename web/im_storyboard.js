// Director storyboard view: image tiles on the left (one per row), the prompt of the film image i -> next to the
// right, half a row lower (between its two images). Rules in im_storyboard_model.js, widgets/server in
// im_storyboard_io.js. User decisions: tiles as large as a standard Load Image preview, format from Settings; one
// delete button (image + prompt); a dragged image takes its prompt along, prompts whose images changed glow red.
// Cut (user 2026-11-15): ✂ between two tiles (hover) = hard cut after the image above; the next image starts fresh.
// The row keeps its prompt box: empty = no film, text = open film (no end image). Thin black lines below the image
// and below its box - the images stay one stack. Black, not red: a cut is a choice, not a warning.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { IM_LETTERS, fcQueueFixedSeeds, fcReviewToast, imVariantCount, imWidget, settingsNodeOf } from "./im_common.js";
import {
  MAX_IMAGES, boardGeometry, emptyRow, filmRows, hasFilm, isCut, isStale, moveRow, nextOf, pairOf, samePair,
} from "./im_storyboard_model.js";
import {
  boardFormat, defaultSeconds, emptyImage, imageUrl, isEmptyImage, isLoop, readRows, uploadImage, writeRows,
} from "./im_storyboard_io.js";
import { PP_CSS } from "./im_prompt_progress.js";
import { alignTwins } from "./im_twin.js";

// Tile = preview box of a standard Load Image node (TILE_W x TILE_H in im_storyboard_model.js, shared with Cut)
const GAP = 10, PROMPT_W = 250, PROMPT_V_W = 200, TOOLBAR_H = 66, MARGIN = 10;   // PROMPT_V_W: each extra variant field

const CSS = `
.imsb { position:relative; font:12px system-ui,sans-serif; color:#ddd; box-sizing:border-box; padding:0 ${MARGIN}px; }
.imsb * { box-sizing:border-box; }
.imsb-tb { display:flex; flex-wrap:wrap; gap:6px; height:${TOOLBAR_H}px; align-content:flex-start; }
.imsb-tb button, .imsb-cnt { height:28px; border-radius:4px; border:1px solid #4a4a4a; background:#2b2b2b; color:#ddd; cursor:pointer; font:600 12px system-ui; padding:0 9px; }
.imsb-tb button:hover { background:#383838; }
.imsb-cnt { display:flex; align-items:center; gap:6px; cursor:default; }
.imsb-cnt b { cursor:pointer; padding:0 3px; }
.imsb-bd { position:relative; }
.imsb-wp { position:absolute; display:flex; gap:6px; }
.imsb-wp button { flex:1; min-width:0; height:28px; border-radius:4px; border:1px solid #4a4a4a; background:#2b2b2b; color:#ddd;
  cursor:pointer; font:600 12px system-ui; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.imsb-wp button:hover { background:#383838; }
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
.imsb-p .hd { display:flex; align-items:center; gap:6px; font:700 13px system-ui; min-height:24px; }
.imsb-p .bg { font:600 10px system-ui; border-radius:3px; padding:1px 5px; background:#333; color:#aaa; }
.imsb-p .bg.none { display:none; }
.imsb-p .bg.own { background:#e6c229; color:#111; } .imsb-p .bg.llm { background:#2f5d8a; color:#fff; }
.imsb-p .sec { margin-left:auto; display:flex; align-items:center; gap:3px; font-weight:400; }
.imsb-p .sec input { width:46px; background:#1b1b1b; color:#ddd; border:1px solid #444; border-radius:3px; font:13px system-ui; padding:2px 3px; }
.imsb-p .sec input.own { color:#e6c229; font-weight:700; border-color:#e6c229; }
.imsb-p .vs { flex:1; min-height:0; display:flex; gap:6px; }
.imsb-p .vc { flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }
.imsb-p .vc + .vc { border-left:1px solid #444; padding-left:6px; }
.imsb-p .vh { display:flex; align-items:center; gap:5px; font:700 12px system-ui; color:#bbb; min-height:18px; }
.imsb-p .vh .vre { margin-left:auto; cursor:pointer; opacity:.75; } .imsb-p .vh .vre:hover { opacity:1; }
.imsb-p .cp { cursor:pointer; opacity:.75; } .imsb-p .cp:hover { opacity:1; }
.imsb-p textarea { flex:1; min-height:0; resize:none; background:#1b1b1b; color:#ddd; border:1px solid #444; border-radius:3px; font:12px system-ui; padding:4px; }
.imsb-p .hd input { cursor:auto; }
.imsb-p .ct { cursor:pointer; padding:1px 5px; border-radius:3px; color:#aaa; font:700 15px system-ui; }
.imsb-p .ct.busy { cursor:progress; color:#666; }
.imsb-p .ct:hover { background:#383838; color:#fff; }
.imsb-p.nofilm { opacity:.6; }   /* cut row without a prompt: no film there */
.imsb-cut { position:absolute; left:0; height:4px; border-radius:2px; background:#000; pointer-events:none; }
.imsb-p .lamp { display:inline-block; width:10px; height:10px; border-radius:50%; margin:0 1px 0 2px; flex:none;
  background:radial-gradient(circle at 40% 35%, var(--c1) 0 18%, var(--c2) 45%, var(--c3) 100%); box-shadow:0 0 3px 1px var(--g), 0 0 9px 2px var(--g); }
.imsb-p .lamp.ok { --c1:#eaffd9; --c2:#5ee05a; --c3:#1b7a26; --g:#49d84a88; }
.imsb-p .lamp.wait { --c1:#fffbe0; --c2:#ffe45c; --c3:#a07a00; --g:#ffd23a88; }
.imsb-p .lamp.bad { --c1:#ffe0ea; --c2:#ff6b8a; --c3:#9c1020; --g:#ff3b5c88; }
.imsb-menu { position:fixed; z-index:10000; min-width:210px; background:#1f1f1f; border:1px solid #4a4a4a; border-radius:6px; padding:4px; box-shadow:0 6px 18px #000a; font:13px system-ui,sans-serif; color:#ddd; }
.imsb-menu div { padding:6px 10px; border-radius:4px; cursor:pointer; white-space:nowrap; }
.imsb-menu div:hover { background:#2f5d8a; }
.imsb-menu div.off { color:#666; cursor:default; background:none; }
.imsb-menu hr { border:0; border-top:1px solid #3a3a3a; margin:4px 2px; }
.imsb-ins { position:absolute; left:0; height:18px; z-index:3; cursor:pointer; display:flex; align-items:center; justify-content:center; }
.imsb-ins span { display:none; height:20px; margin:0 3px; padding:0 6px; border-radius:4px; background:#2b2b2b; border:1px solid #4a4a4a; color:#ddd; font:600 11px/20px system-ui; text-align:center; box-shadow:0 0 0 3px #1b1b1b; position:relative; }
.imsb-ins span.off { color:#666; cursor:default; }
.imsb-ins:hover span { display:block; }
.imsb-ins span:not(.off):hover { background:#3a3a3a; }
.imsb-ins:hover::before { content:""; position:absolute; left:0; right:0; top:7px; height:4px; background:#8888; border-radius:2px; }
.imsb-gap { position:absolute; left:-4px; height:4px; background:#4af; border-radius:2px; pointer-events:none; display:none; }
.imsb-gap::before, .imsb-gap::after { content:""; position:absolute; top:-3px; width:10px; height:10px; border-radius:50%; background:#4af; }
.imsb-gap::before { left:-5px; } .imsb-gap::after { right:-5px; }
`;
document.head.appendChild(Object.assign(document.createElement("style"), { textContent: CSS + PP_CSS }));

const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

function pickFiles(multiple, accept = "image/*") {
  return new Promise((resolve) => {
    const inp = Object.assign(el("input"), { type: "file", accept, multiple });
    inp.onchange = () => resolve([...(inp.files || [])]);
    inp.click();
  });
}

// Tile = the film format contain-fitted into the Load Image box; the prompt column fills the rest of the node.
function boardSize(node, rows, loop) {
  const n = rows.length, g = boardGeometry(node._imsb.fmt, rows, loop), { iw, cells } = g;   // shared with Cut
  const minP = PROMPT_W + (imVariantCount(node) - 1) * PROMPT_V_W;   // variant prompts side by side (A B C D)
  const pw = Math.max(minP, Math.round(node.size[0]) - iw - GAP - 2 * MARGIN);
  // + room for the insert strip below the last tile; a prompt box may reach further down
  const h = Math.max(n ? cells.end - GAP + (n < MAX_IMAGES ? GAP / 2 + 10 : 0) : 0, ...g.tops.map((t, i) => (t == null ? 0 : t + g.heights[i])));
  return { ...g, pw, h, w: iw + GAP + minP + 2 * MARGIN };
}

function signature(node) {
  const s = settingsNodeOf(node), v = (n, k) => imWidget(n, k)?.value;
  return [v(node, "storyboard"), v(node, "loop"), v(node, "seconds"), v(node, "shot_seconds"), v(node, "variants"), v(s, "aspect"), v(s, "long_side")].join("|");
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
// aboveCut: a cut after image k stays below the new frame (the frame ends the film before the cut); else it stays above.
async function insertAt(node, k, empty = false, aboveCut = false) {
  if (readRows(node).length >= MAX_IMAGES) { fcReviewToast(`Max ${MAX_IMAGES} images`, "#e68929"); return; }
  const f = empty ? null : (await pickFiles(false))[0];
  const name = empty ? await emptyImage(node._imsb.fmt) : f && await uploadImage(f);
  if (!name) return;
  const rows = readRows(node);
  const moveCut = aboveCut && k > 0 && !!rows[k - 1]?.cut;
  if (moveCut) rows[k - 1].cut = false;
  rows.splice(k, 0, { ...emptyRow(), image: name, cut: moveCut });
  node._imsb.land = k;
  commit(node, rows);
}

// Right-click menu of a tile (user 2026-11-15): order, cut and image in one place. items: [label, fn | null] or "-".
function showMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  document.querySelector(".imsb-menu")?.remove();
  const m = el("div", "imsb-menu");
  for (const it of items) {
    if (it === "-") { m.appendChild(el("hr")); continue; }
    const [label, fn] = it, d = el("div", fn ? null : "off", label);
    if (fn) d.onclick = () => { close(); fn(); };
    m.appendChild(d);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(e.clientX, innerWidth - r.width - 4)}px`;
  m.style.top = `${Math.min(e.clientY, innerHeight - r.height - 4)}px`;
  const away = (ev) => { if (!m.contains(ev.target)) close(); };
  const key = (ev) => { if (ev.key === "Escape") close(); };
  function close() {
    m.remove();
    window.removeEventListener("pointerdown", away, true);
    window.removeEventListener("keydown", key, true);
  }
  setTimeout(() => { window.addEventListener("pointerdown", away, true); window.addEventListener("keydown", key, true); }, 0);
}

function tileMenu(node, e, i) {
  const n = readRows(node).length;
  showMenu(e, [   // cuts live on the hover strip between the images (user 2026-11-15: not in the menu)
    ["↑ Move up", i > 0 ? () => move(node, i, i - 1) : null],
    ["↓ Move down", i < n - 1 ? () => move(node, i, i + 2) : null],
    "-",
    ["Change image…", () => pickImage(node, i)],
    ["✕ Remove image and prompt", () => remove(node, i)],
  ]);
}

function remove(node, i) {
  const rows = readRows(node);
  rows.splice(i, 1);
  commit(node, rows.length ? rows : [emptyRow()]);
}

// One wording for every cut toggle (prompt header and hover strip): what a click does now.
const cutTitle = (on, film, next) => (on
  ? `Remove cut: film ${film} → ${next} comes back`
  : `Cut after image ${film}: hard cut, image ${next} starts fresh. Prompt ${film} empty = no film, text = film from image ${film} into ∅`);
const CUT_HINT = "Cut after this image: the end is empty (∅). Empty prompt = no film here. Text = film from this image into ∅, then the cut";
const TEXT_HINT = "∅ → ∅: no image on either side - write this prompt yourself (text to video)";
const hint = (cutRow, textOnly) => (textOnly ? TEXT_HINT : cutRow ? CUT_HINT : "What happens from this image to the next…");

function setCut(node, i, on) {
  const rows = readRows(node);
  if (!!rows[i]?.cut === on) return;
  rows[i].cut = on;
  if (on && !filmRows(rows, isLoop(node)).length) { fcReviewToast("At least one film must stay", "#e68929"); return; }
  commit(node, rows);
}

// y of the insert line above image k (k = n: below the last tile) - an empty ✂ tile stays with the image above it
const gapTop = (st, k) => (k < st.size.cells.img.length ? st.size.cells.img[k] : st.size.cells.end) - GAP / 2;

// End the "writing" state of a storyboard: clear busy and redraw (no-op when it already ended).
const endBusy = (node) => { if (node._imsb?.busy) { node._imsb.busy = null; render(node); } };

// Prompt writing = a partial run of the Director alone with its `regen` widget set: it writes the prompts of these
// rows, renders nothing, and sends them back as ui.im_prompts (received).
async function regen(node, idx) {
  if (node._imsb?.busy) { fcReviewToast("Prompts are being written", "#e68929"); return; }
  if (!idx.length) { fcReviewToast("No prompt to write (all are ✎ manual)", "#e68929"); return; }
  const w = imWidget(node, "regen");
  if (!w) { fcReviewToast("Director has no regen input - restart ComfyUI", "#d93025"); return; }
  node._imsb.busy = new Set(idx.map((x) => (Array.isArray(x) ? x[0] : x)));
  render(node);
  w.value = JSON.stringify(idx);
  try { if (!(await fcQueueFixedSeeds([String(node.id)]))) endBusy(node); }
  catch (e) { endBusy(node); fcReviewToast(`Prompt writing not started: ${e}`, "#d93025"); }
  finally { w.value = ""; }
}

// One prompt column: A = every prompt except the manual ones; B-D = the empty fields, all filled = the whole column.
function writeColumn(node, l) {
  // cut rows are never filled by Write all (empty = no film is a choice) - ↻ on the box writes an open shot
  const rows = readRows(node), loop = isLoop(node), films = rows.flatMap((r, i) => (pairOf(rows, i, loop) && !isCut(rows, i, loop)
    && !(isEmptyImage(r.image) && isEmptyImage(rows[nextOf(rows.length, i, loop)]?.image)) ? [i] : []));   // ∅ → ∅: yours
  if (l === "a") return regen(node, films.filter((i) => !rows[i].own));
  const empty = films.filter((i) => !String(rows[i][`prompt_${l}`] || "").trim());
  regen(node, (empty.length ? empty : films).map((i) => [i, l]));
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
    if (k < 0) continue;
    if (r.v && r.v !== "a") rows[k][`prompt_${r.v}`] = r.prompt;   // variant B-D: only its field
    else Object.assign(rows[k], { prompt: r.prompt, own: false, pair: r.pair });
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
    gap = st.size.cells.img.filter((t) => t + st.size.ih / 2 < y).length;   // gap k = above image k (n = below the last)
    st.gap.style.display = gap === i || gap === i + 1 ? "none" : "block";
    st.gap.style.top = `${gapTop(st, gap) - 2}px`;
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
  t.style.cssText = `top:${st.size.cells.img[i]}px;width:${iw}px;height:${ih}px`;
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
    const file = r.image.split("/").pop();
    lb.append(el("i", null, st.fmt.label), isEmptyImage(file) ? "empty" : file);
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
  t.oncontextmenu = (e) => tileMenu(node, e, i);
  t.ondragover = (e) => e.preventDefault();
  t.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer?.files?.[0]; if (f) setImage(node, i, f); };
  return t;
}

const words = (t) => (t || "").trim().split(/\s+/).filter(Boolean).length;

function promptEl(node, rows, i, loop) {
  const st = node._imsb, r = rows[i], n = rows.length, j = nextOf(n, i, loop), { iw, ih, row, pw } = st.size;
  const box = el("div", "imsb-p" + (j === 0 && n > 1 ? " loop" : "") + (isStale(rows, i, loop) ? " stale" : ""));
  box.style.cssText = `left:${iw + GAP}px;top:${st.size.cells.box[i]}px;height:${st.size.heights[i]}px;width:${pw}px`;
  const hd = el("div", "hd");
  const badge = () => (r.own ? ["own", "✎ manual"] : r.prompt.trim() ? ["llm", "LLM"] : ["none", ""]);   // no prompt: no badge
  const bg = el("span", "bg " + badge()[0], badge()[1]);
  bg.title = "manual = you typed this prompt; ✎ Write all prompts keeps it. LLM = written by the model.";
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
  const cutRow = isCut(rows, i, loop);   // hard cut after this image: empty = no film, text = open film
  const noFilm = () => box.classList.toggle("nofilm", cutRow && !readRows(node)[i]?.prompt.trim());
  box.classList.toggle("cut", cutRow);
  noFilm();
  // black = empty (user 2026-11-15): an empty frame gives the engine nothing on that side - ∅ in the header
  const e0 = isEmptyImage(r.image), e1 = !cutRow && n > 1 && isEmptyImage(rows[j]?.image);
  const textOnly = e0 && (e1 || cutRow || n === 1);
  hd.append(el("span", null, `${e0 ? "∅" : i + 1} → ${n === 1 ? "∅" : cutRow || e1 ? "∅" : j + 1}`), bg, sec);
  // user 2026-11-15: no ✂ in the prompt box - cuts are set only between the images (hover ✂ in the image column)
  const busy = !!st.busy?.has(i);
  const ta = Object.assign(el("textarea"), { value: r.prompt, disabled: busy,
    placeholder: busy ? "writing…" : hint(cutRow, textOnly) });
  ta.onkeydown = (e) => e.stopPropagation();
  ta.oninput = () => {
    const now = readRows(node);
    Object.assign(now[i], { prompt: ta.value, own: !!ta.value.trim(), pair: pairOf(now, i, loop) });
    writeRows(node, now);
    Object.assign(r, now[i]);
    st.sig = signature(node);
    [bg.className, bg.textContent] = ["bg " + badge()[0], badge()[1]];
    box.classList.remove("stale");
    noFilm();
    setLamp();
  };
  // Prompt status lamp (user 2026-11-15): green = prompt fits its images, yellow = none yet / writing, red = doesn't fit
  const lamp = el("span", "lamp");
  const setLamp = () => {
    const [c, t] = busy ? ["wait", "Writing the prompt…"] : box.classList.contains("stale") ? ["bad", "Doesn't fit: the images around this prompt changed – edit or regenerate it"]
      : words(readRows(node)[i]?.prompt) >= 5 ? ["ok", "Prompt ready"]
      : words(readRows(node)[i]?.prompt) ? ["wait", "Prompt very short (under 5 words) – add detail or regenerate"] : ["wait", "No prompt yet – Run or ↻ writes one"];
    lamp.className = "lamp " + c;
    lamp.title = t;
  };
  setLamp();
  // One layout for full and half boxes (user 2026-11-15): every control in the header, below only the text
  const rg = el("span", "ct re" + (busy ? " busy" : ""), busy ? "…" : "↻");
  rg.title = busy ? "Writing the prompt…" : "Regenerate prompt";
  rg.onpointerdown = (e) => e.stopPropagation();
  rg.onclick = (e) => { e.stopPropagation(); if (!busy) regen(node, [i]); };
  hd.append(lamp, rg);
  // Variants (user 2026-11-15: "one prompt per variant, side by side, max 4 ABCD"): A plus one field per extra
  // variant, empty = A's prompt. ⧉ copies A into the empty fields - then change only the detail to compare.
  const nv = imVariantCount(node);
  if (nv > 1) {
    // user 2026-11-15 ("separate, split graphically"): one column per variant with its own head - letter, lamp, ↻
    // (the LLM writes an independent take from the same two images); empty field = A's prompt
    const vs = el("div", "vs");
    const col = (l, field) => {
      const c = el("div", "vc"), h = el("div", "vh"), L = l.toUpperCase();
      const lp = el("span", "lamp " + (busy ? "wait" : words(field.value) >= 5 ? "ok" : "wait"));
      lp.title = l === "a" ? lamp.title : field.value.trim() ? "Own prompt" : "Empty – renders with prompt A";
      const re = el("span", "vre", busy ? "…" : "↻");
      re.title = `Write prompt ${L} with the LLM (an own take from the same two images)`;
      re.onpointerdown = (e) => e.stopPropagation();
      re.onclick = (e) => { e.stopPropagation(); if (!busy) regen(node, [l === "a" ? i : [i, l]]); };
      h.append(el("span", null, L), lp, re);
      c.append(h, field);
      vs.append(c);
    };
    ta.placeholder = busy ? "writing…" : hint(cutRow, textOnly);
    col("a", ta);
    rg.remove();   // the columns have their own ↻
    const fields = [];
    for (const l of IM_LETTERS.slice(1, nv)) {
      const key = `prompt_${l}`, L = l.toUpperCase();
      const tv = Object.assign(el("textarea", l), { value: r[key] || "", disabled: busy, placeholder: busy ? "writing…" : `empty = same as A` });
      tv.title = `Variant ${L} prompt – Cut shows the variants side by side`;
      tv.onkeydown = (e) => e.stopPropagation();
      tv.oninput = () => {
        const now = readRows(node);
        now[i][key] = tv.value;
        writeRows(node, now);
        r[key] = tv.value;
        st.sig = signature(node);
      };
      fields.push([key, tv]);
      col(l, tv);
    }
    const cp = el("span", "cp", "⧉");
    cp.title = "Copy prompt A into the empty variant fields";
    cp.onpointerdown = (e) => e.stopPropagation();
    cp.onclick = (e) => {
      e.stopPropagation();
      const now = readRows(node);
      for (const [key, tv] of fields) if (!tv.value.trim()) { tv.value = now[i].prompt; now[i][key] = tv.value; r[key] = tv.value; }
      writeRows(node, now);
      st.sig = signature(node);
    };
    hd.insertBefore(cp, lamp);
    box.append(hd, vs);
  } else box.append(hd, ta);
  (st.boxes ||= [])[i] = box;
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
  st.boxes = [];
  st.board.style.height = `${h}px`;
  st.gap.style.width = `${iw + 8}px`;
  for (let i = 0; i < rows.length; i++) {
    st.board.appendChild(tileEl(node, rows, i));
    if (hasFilm(rows.length, i, loop)) st.board.appendChild(promptEl(node, rows, i, loop));   // every image has a prompt
    if (st.size.cells.cut[i] != null) {   // the cut: one black line through both columns, below box i
      const c = el("div", "imsb-cut");
      c.style.cssText = `top:${st.size.cells.cut[i] - 2}px;width:${iw + GAP + st.size.pw}px`;
      st.board.appendChild(c);
    }
  }
  // ✎ Write all over every prompt column (user 2026-11-15): each button writes only its own column (variant)
  const first = rows.findIndex((_, i) => st.size.cells.box[i] != null);
  if (first >= 0) {
    const nv = imVariantCount(node), wp = el("div", "imsb-wp");
    wp.style.cssText = `left:${iw + GAP + 6}px;width:${st.size.pw - 12}px;top:${Math.max(0, st.size.cells.box[first] - 34)}px`;
    for (const l of IM_LETTERS.slice(0, nv)) {
      const b = el("button", null, nv === 1 ? "✎ Write all prompts" : `✎ Write all ${l.toUpperCase()}`);
      b.title = l === "a" ? `Writes every prompt${nv > 1 ? " of column A" : ""} except the ✎ manual ones (typed by you)`
        : `Writes the empty ${l.toUpperCase()} prompts (an own take each); all filled: rewrites the whole column`;
      b.onpointerdown = (e) => e.stopPropagation();
      b.onclick = (e) => { e.stopPropagation(); writeColumn(node, l); };
      wp.appendChild(b);
    }
    st.board.appendChild(wp);
  }
  // Hover between two tiles (user 2026-11-15): four grey buttons - empty frame above / below the cut, cut, uncut.
  for (let k = 1; k <= rows.length; k++) {   // k = n: below the last image
    const add = rows.length < MAX_IMAGES, cut = rows.length > 1 && hasFilm(rows.length, k - 1, loop), on = cut && rows[k - 1].cut;
    if (!add && !cut) continue;
    const z = el("div", "imsb-ins");
    z.style.cssText = `top:${gapTop(st, k) - 9}px;width:${iw}px`;
    z.onpointerdown = (e) => e.stopPropagation();
    const btn = (cls, label, title, fn, off = false) => {
      const b = el("span", cls + (off ? " off" : ""), label);
      b.title = title;
      if (!off) b.onclick = fn;
      z.appendChild(b);
    };
    if (add) {
      btn("eu", "▢↑", on ? `Empty frame above the cut: it ends the film from image ${k}, then the cut` : "Insert an empty (black) frame here",
        () => insertAt(node, k, true, true));
      btn("ed", "▢↓", on ? `Empty frame below the cut: the next part starts with it` : "Insert an empty (black) frame here",
        () => insertAt(node, k, true, false));
    }
    if (cut) {
      const next = nextOf(rows.length, k - 1, loop) + 1;
      btn("cut", "✂", cutTitle(false, k, next), () => setCut(node, k - 1, true), on);
      btn("uncut", "uncut", cutTitle(true, k, next), () => setCut(node, k - 1, false), !on);
    }
    st.board.appendChild(z);
  }
  st.board.appendChild(st.gap);
  st.land = -1;
  st.sig = signature(node);
  // variant count changed: the width follows exactly (fields side by side), otherwise only grow
  const nvNow = imVariantCount(node), exact = st.nv != null && st.nv !== nvNow;
  st.nv = nvNow;
  node.setSize([exact ? w : Math.max(w, node.size[0]), node.computeSize()[1]]);
  st.w = node.size[0];
  node.setDirtyCanvas?.(true, true);
  alignTwins(node);   // Cut's rows follow (flexible head)
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
  const append = (names, prompts = {}) => {
    if (!names.length) return;
    const rows = readRows(node);
    while (rows.length && !rows[rows.length - 1].image && !rows[rows.length - 1].prompt) rows.pop();
    const room = MAX_IMAGES - rows.length;
    if (names.length > room) fcReviewToast(`${names.length - room} images skipped (max ${MAX_IMAGES})`, "#e68929");
    commit(node, [...rows, ...names.slice(0, room).map((image, k) => {
      const prompt = prompts[k] || "";
      return { ...emptyRow(), image, prompt, own: !!prompt };   // a .txt prompt counts as manual: Write all keeps it
    })]);
  };
  const bLoad = el("button", null, "📂 Load images…");
  bLoad.title = `Adds the chosen images below the last one (sorted by name, max ${MAX_IMAGES}). ` +
    "Select .txt files along with them: shark1.txt becomes the prompt of shark1.jpg (the film from that image on)";
  bLoad.onclick = async () => {
    // user 2026-11-15: a prompt travels as a text file with the image's name (shark1.jpg + shark1.txt)
    const all = await pickFiles(true, "image/*,.txt,text/plain");
    const stem = (f) => f.name.replace(/\.[^.]*$/, "").toLowerCase();
    const isTxt = (f) => /\.txt$/i.test(f.name);
    const texts = new Map(await Promise.all(all.filter(isTxt).map(async (f) => [stem(f), (await f.text()).trim()])));
    const files = all.filter((f) => !isTxt(f)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const names = [], prompts = {};
    for (const f of files.slice(0, MAX_IMAGES)) {
      const nm = await uploadImage(f);
      if (!nm) continue;
      if (texts.get(stem(f))) prompts[names.length] = texts.get(stem(f));
      names.push(nm);
    }
    append(names, prompts);
    const used = Object.keys(prompts).length;
    if (texts.size) fcReviewToast(`${used} prompt${used === 1 ? "" : "s"} loaded from .txt` + (texts.size > used ? `, ${texts.size - used} without a matching image` : ""), "#888");
  };
  const pbar = el("div", "imsb-pp");   // prompt writing progress (im_prompt_progress.js)
  pbar.appendChild(el("span"));
  tb.append(bLoad, cnt, pbar);   // Load images on the left, then the count; Write all sits over the prompt columns
  const board = el("div", "imsb-bd");
  root.append(tb, board);
  const st = node._imsb = { root, board, pbar, cnt: num, gap: el("div", "imsb-gap"), fmt: { w: 4, h: 5, label: "" }, sig: "", land: -1 };
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
