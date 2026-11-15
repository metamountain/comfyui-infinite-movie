// Director storyboard view: image tiles on the left (one per row), the prompt of the film image i -> next to the
// right, half a row lower (between its two images). Rules in im_storyboard_model.js, widgets/server in
// im_storyboard_io.js. User decisions: tiles as large as a standard Load Image preview, format from Settings; one
// delete button (image + prompt); a dragged image takes its prompt along, prompts whose images changed glow red.
// Cut (user 2026-11-15): ✂ in a prompt box, between two tiles (hover) or in a tile's right-click menu = that film ends
// open ("First to Open") and the next film starts fresh at its own image. Shown as a thin black line in the gap below
// the image - the images stay one stack. Black, not red: a cut is a choice, not a warning.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { fcQueueFixedSeeds, fcReviewToast, imWidget, settingsNodeOf } from "./im_common.js";
import {
  MAX_IMAGES, boardGeometry, boxHeight, emptyRow, hasFilm, isCut, isStale, moveRow, nextOf, pairOf, samePair,
} from "./im_storyboard_model.js";
import {
  boardFormat, defaultSeconds, imageUrl, isLoop, readRows, uploadImage, writeRows,
} from "./im_storyboard_io.js";
import { PP_CSS } from "./im_prompt_progress.js";

// Tile = preview box of a standard Load Image node (TILE_W x TILE_H in im_storyboard_model.js, shared with Cut)
const GAP = 10, PROMPT_W = 250, TOOLBAR_H = 66, MARGIN = 10;

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
.imsb-p .bg.none { display:none; }
.imsb-p .bg.own { background:#e6c229; color:#111; } .imsb-p .bg.llm { background:#2f5d8a; color:#fff; }
.imsb-p .red { display:none; color:#ff6b5e; font:700 10px system-ui; }
.imsb-p.stale .red { display:inline; }
.imsb-p .sec { margin-left:auto; display:flex; align-items:center; gap:3px; font-weight:400; }
.imsb-p .sec input { width:44px; background:#1b1b1b; color:#ddd; border:1px solid #444; border-radius:3px; font:12px system-ui; padding:1px 3px; }
.imsb-p .sec input.own { color:#e6c229; font-weight:700; border-color:#e6c229; }
.imsb-p textarea { flex:1; resize:none; background:#1b1b1b; color:#ddd; border:1px solid #444; border-radius:3px; font:12px system-ui; padding:4px; }
.imsb-p .rg { height:28px; border-radius:4px; border:1px solid #4a4a4a; background:#2b2b2b; color:#ddd; font:600 13px system-ui; cursor:pointer; }
.imsb-p .rg:hover { background:#383838; }
.imsb-p .hd { cursor:ns-resize; }
.imsb-p.lift { box-shadow:0 0 0 2px #000, 0 6px 16px #000a; z-index:4; }
.imsb-p .hd input { cursor:auto; }
.imsb-p .ct { cursor:pointer; padding:0 4px; border-radius:3px; color:#888; font:700 13px system-ui; }
.imsb-p .ct:hover { background:#383838; color:#fff; }
.imsb-p.cut { border-top:4px solid #000; }
.imsb-p .ct.x-cut { position:relative; }
.imsb-p .ct.x-cut::after, .imsb-ins span.cut.on::after { content:""; position:absolute; left:2px; right:2px; top:50%; height:2px; background:currentColor; transform:rotate(-45deg); }
.imsb-cut { position:absolute; left:0; height:4px; border-radius:2px; background:#000; pointer-events:none; }
.imsb-p.short .rg { display:none; }
.imsb-p .lamp { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:7px; vertical-align:0; flex:none;
  background:radial-gradient(circle at 40% 35%, var(--c1) 0 18%, var(--c2) 45%, var(--c3) 100%); box-shadow:0 0 3px 1px var(--g), 0 0 9px 2px var(--g); }
.imsb-p .lamp.ok { --c1:#eaffd9; --c2:#5ee05a; --c3:#1b7a26; --g:#49d84a88; }
.imsb-p .lamp.wait { --c1:#fffbe0; --c2:#ffe45c; --c3:#a07a00; --g:#ffd23a88; }
.imsb-p .lamp.bad { --c1:#ffe0ea; --c2:#ff6b8a; --c3:#9c1020; --g:#ff3b5c88; }
.imsb-menu { position:fixed; z-index:10000; min-width:210px; background:#1f1f1f; border:1px solid #4a4a4a; border-radius:6px; padding:4px; box-shadow:0 6px 18px #000a; font:13px system-ui,sans-serif; color:#ddd; }
.imsb-menu div { padding:6px 10px; border-radius:4px; cursor:pointer; white-space:nowrap; }
.imsb-menu div:hover { background:#2f5d8a; }
.imsb-menu div.off { color:#666; cursor:default; background:none; }
.imsb-menu hr { border:0; border-top:1px solid #3a3a3a; margin:4px 2px; }
.imsb-anchor { position:absolute; left:0; width:1px; height:0; pointer-events:none; }
.imsb-ins { position:absolute; left:0; height:18px; z-index:3; cursor:pointer; display:flex; align-items:center; justify-content:center; }
.imsb-ins span { display:none; width:22px; height:22px; margin:0 4px; border-radius:50%; background:#4af; color:#fff; font:700 17px/22px system-ui; text-align:center; box-shadow:0 0 0 3px #1b1b1b; position:relative; }
.imsb-ins span.cut { background:#000; border:1px dashed #888; font-size:12px; line-height:20px; }
.imsb-ins span.cut.on { border-style:solid; }
.imsb-ins:hover span { display:block; }
.imsb-ins span:hover { transform:scale(1.2); }
.imsb-ins:hover::before { content:""; position:absolute; left:0; right:0; top:7px; height:4px; background:#4af8; border-radius:2px; }
.imsb-gap { position:absolute; left:-4px; height:4px; background:#4af; border-radius:2px; pointer-events:none; display:none; }
.imsb-gap::before, .imsb-gap::after { content:""; position:absolute; top:-3px; width:10px; height:10px; border-radius:50%; background:#4af; }
.imsb-gap::before { left:-5px; } .imsb-gap::after { right:-5px; }
`;
document.head.appendChild(Object.assign(document.createElement("style"), { textContent: CSS + PP_CSS }));

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
  const n = rows.length, g = boardGeometry(node._imsb.fmt, rows, loop), { iw, cells } = g;   // shared with Cut
  const pw = Math.max(PROMPT_W, Math.round(node.size[0]) - iw - GAP - 2 * MARGIN);
  // + room for the insert strip below the last tile; a prompt box may reach further down
  const h = Math.max(n ? cells.end - GAP + (n < MAX_IMAGES ? GAP / 2 + 10 : 0) : 0, ...g.tops.map((t, i) => (t == null ? 0 : t + g.heights[i])));
  return { ...g, pw, h, w: iw + GAP + PROMPT_W + 2 * MARGIN };
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
  const rows = readRows(node), n = rows.length, loop = isLoop(node), r = rows[i];
  const canCut = n > 1 && hasFilm(n, i, loop);
  showMenu(e, [
    ["↑ Move up", i > 0 ? () => move(node, i, i - 1) : null],
    ["↓ Move down", i < n - 1 ? () => move(node, i, i + 2) : null],
    "-",
    [r.cut ? "Remove cut" : "✂ Cut after this image", canCut ? () => setCut(node, i, !r.cut) : null],
    ["✂ Replace with cut", i > 0 && n > 2 ? () => replaceWithCut(node, i) : null],
    "-",
    ["Change image…", () => pickImage(node, i)],
    ["✕ Remove image and prompt", () => remove(node, i)],
  ]);
}

// The image goes, the film before it ends open: image i-1 -> ✂ -> image i+1.
function replaceWithCut(node, i) {
  const rows = readRows(node);
  rows.splice(i, 1);
  rows[i - 1].cut = true;
  commit(node, rows);
}

function remove(node, i) {
  const rows = readRows(node);
  rows.splice(i, 1);
  commit(node, rows.length ? rows : [emptyRow()]);
}

// Prompt header drag (user 2026-11-15: "add drag again"): the box snaps live to one of its two slots - next to its
// image (cut, film ends open) or between its image and the next (transition) - and stays where it is dropped. The box
// above shortens live, as it will after the drop.
function dragPrompt(node, e, i, box) {
  const st = node._imsb, bd = st.board, { row, ih } = st.size, y0 = e.clientY, top0 = parseFloat(box.style.top);
  const lo = st.size.cells.img[i], hi = lo + row / 2;
  const prev = !readRows(node)[i - 1]?.cut ? st.boxes?.[i - 1] : null;   // a transition box right above
  const scale = () => (bd.getBoundingClientRect().height / bd.offsetHeight) || 1;
  // Down past the middle to the next image = cut as well (user 2026-11-15): the box shows next to image i+1 with the
  // line above it while dragging; dropped, it sits next to its own image (same cut, the line stays put).
  const below = i + 1 < (st.size.cells.img.length || 0);
  let cut = top0 < lo + row / 4;
  box.classList.add("lift");
  const onMove = (ev) => {
    const y = top0 + (ev.clientY - y0) / scale(), down = below && y > hi + row / 4;
    cut = y < lo + row / 4 || down;
    box.style.top = `${down ? lo + row : cut ? lo : hi}px`;
    box.classList.toggle("cut", cut);
    if (prev) { prev.style.height = `${boxHeight(row, ih, cut)}px`; prev.classList.toggle("short", cut); }
  };
  const end = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    box.classList.remove("lift");
    setCut(node, i, cut);
    render(node);
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
}

// One wording for every cut toggle (prompt header and hover strip): what a click does now.
const cutTitle = (on, film, next) => (on
  ? `Remove cut: film ${film} goes to image ${next} again`
  : `Cut: film ${film} ends open (no end image), image ${next} starts the next film fresh`);

function setCut(node, i, on) {
  const rows = readRows(node);
  if (!!rows[i]?.cut === on) return;
  rows[i].cut = on;
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
  t.oncontextmenu = (e) => tileMenu(node, e, i);
  t.ondragover = (e) => e.preventDefault();
  t.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer?.files?.[0]; if (f) setImage(node, i, f); };
  return t;
}

const words = (t) => (t || "").trim().split(/\s+/).filter(Boolean).length;

function promptEl(node, rows, i, loop) {
  const st = node._imsb, r = rows[i], n = rows.length, j = nextOf(n, i, loop), { iw, ih, row, pw } = st.size;
  const cut = isCut(rows, i, loop);
  const box = el("div", "imsb-p" + (j === 0 && n > 1 && !cut ? " loop" : "") + (isStale(rows, i, loop) ? " stale" : "") + (cut ? " cut" : ""));
  const short = st.size.cells.short[i];   // the cut box below sits next to its image: this one ends where it starts
  if (short) box.classList.add("short");
  box.style.cssText = `left:${iw + GAP}px;top:${st.size.cells.box[i]}px;height:${st.size.heights[i]}px;width:${pw}px`;
  const hd = el("div", "hd");
  const badge = () => (r.own ? ["own", "✎ manual"] : r.prompt.trim() ? ["llm", "LLM"] : ["none", ""]);   // no prompt: no badge
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
  hd.append(el("span", null, `${i + 1} → ${n === 1 || cut ? "open" : j + 1}`), bg, red, sec);
  if (n > 1) {
    const ct = el("span", "ct" + (cut ? " x-cut" : ""), "✂");   // crossed ✂ = remove the cut
    ct.title = cutTitle(cut, i + 1, j + 1);
    ct.onpointerdown = (e) => e.stopPropagation();
    ct.onclick = (e) => { e.stopPropagation(); setCut(node, i, !cut); };
    hd.insertBefore(ct, sec);
    hd.title = "Drag: up next to the image (or down to the next image) = cut (film ends open) · between the images = transition";
    hd.onpointerdown = (e) => {
      if (e.button !== 0 || e.target.closest("input, .ct")) return;
      e.stopPropagation();
      dragPrompt(node, e, i, box);
    };
  }
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
    setLamp();
  };
  const rg = Object.assign(el("button", "rg", busy ? "… writing" : "↻ Regenerate prompt"), { disabled: busy });
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
  rg.prepend(lamp);
  rg.onclick = () => regen(node, [i]);
  if (short) {   // no room for the button: ↻ in the header
    const r2 = el("span", "ct", "↻");
    r2.title = "Regenerate prompt";
    r2.onpointerdown = (e) => e.stopPropagation();
    r2.onclick = (e) => { e.stopPropagation(); regen(node, [i]); };
    hd.insertBefore(r2, sec);
    hd.insertBefore(lamp, r2);
  }
  box.append(hd, ta, rg);
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
    if (hasFilm(rows.length, i, loop)) st.board.appendChild(promptEl(node, rows, i, loop));
    if (st.size.cells.cut[i] != null) {   // the cut: a thin black line in the gap below image i
      const c = el("div", "imsb-cut");
      c.style.cssText = `top:${st.size.cells.cut[i] - 2}px;width:${iw + GAP + st.size.pw}px`;   // whole width
      st.board.appendChild(c);
    }
  }
  // Mark for the auto layout: where prompt box 1 sits (Cut's first row mirrors it)
  const anchor = el("div", "imsb-anchor");
  anchor.style.top = `${st.size.cells.box[0] ?? row / 2}px`;
  st.board.appendChild(anchor);
  // Hover between two tiles (user 2026-11-15): + = insert an image here, ✂ = cut here on/off (after the image above).
  for (let k = 1; k <= rows.length; k++) {   // k = n: below the last image
    const add = rows.length < MAX_IMAGES, cut = rows.length > 1 && hasFilm(rows.length, k - 1, loop), on = cut && rows[k - 1].cut;
    if (!add && !cut) continue;
    const z = el("div", "imsb-ins");
    z.style.cssText = `top:${gapTop(st, k) - 9}px;width:${iw}px`;
    z.onpointerdown = (e) => e.stopPropagation();
    if (add) {
      const a = el("span", "add", "+");
      a.title = "Insert an image here";
      a.onclick = () => insertAt(node, k);
      z.appendChild(a);
    }
    if (cut) {
      const c = el("span", "cut" + (on ? " on" : ""), "✂");
      c.title = cutTitle(on, k, nextOf(rows.length, k - 1, loop) + 1);
      c.onclick = () => setCut(node, k - 1, !on);
      z.appendChild(c);
    }
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
  const pbar = el("div", "imsb-pp");   // prompt writing progress (im_prompt_progress.js)
  pbar.appendChild(el("span"));
  tb.append(cnt, bAll, bLoad, pbar);
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
