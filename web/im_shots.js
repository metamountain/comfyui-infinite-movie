// 124c (2026-11-14): Director storyboard - image tiles on the left (one per row, never wrapping), the prompt of the
// film image i -> i+1 to the right, half a row lower (between the two images). User decisions: tile height constant
// 188, width from the Settings format; one delete button (image + prompt); a dragged image takes its prompt along,
// prompts whose image pair changed light up red (edit instead of rewriting everything).
import { fcReviewToast } from "./im_common.js";
import {
  MAX_SHOTS, emptyShot, hasFilm, imageUrl, importFolder, isLoop, isStale, pairOf, readSecs, readShots,
  shotFormat, uploadImage, writeSecs, writeShots,
} from "./im_shots_io.js";

export const IH = 188, G = 10, P = IH + G, PW = 250, TBH = 66, M = 10;
const FLASH = 1200;   // ms, landing glow after a drag or insert

const CSS = `
.ims { position:relative; font:12px system-ui,sans-serif; color:#ddd; box-sizing:border-box; padding:0 ${M}px; }
.ims * { box-sizing:border-box; }
.ims-tb { display:flex; flex-wrap:wrap; gap:6px; height:${TBH}px; align-content:flex-start; }
.ims-tb button, .ims-cnt { height:28px; border-radius:4px; border:1px solid #4a4a4a; background:#2b2b2b; color:#ddd; cursor:pointer; font:600 12px system-ui; padding:0 9px; }
.ims-tb button:hover { background:#383838; }
.ims-cnt { display:flex; align-items:center; gap:6px; cursor:default; }
.ims-cnt b { cursor:pointer; padding:0 3px; }
.ims-bd { position:relative; }
.ims-t { position:absolute; left:0; border-radius:5px; background:#222; border:1px solid #4a4a4a; overflow:hidden; cursor:grab; user-select:none; }
.ims-t img { width:100%; height:100%; object-fit:cover; display:block; pointer-events:none; }
.ims-t.empty { border:2px dashed #555; display:flex; align-items:center; justify-content:center; color:#888; cursor:pointer; }
.ims-t.drag { background:#1f3550; border:3px solid #4af; opacity:.85; }
.ims-t .no { position:absolute; left:4px; top:4px; background:#000a; border-radius:3px; padding:0 5px; font:700 12px system-ui; }
.ims-t .x { position:absolute; right:4px; top:4px; width:22px; height:22px; border-radius:3px; background:#000a; text-align:center; line-height:22px; cursor:pointer; }
.ims-t .x:hover { background:#d93025; }
.ims-t .lb { position:absolute; left:0; right:0; bottom:0; padding:2px 5px; background:#000a; font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ims-t .lb i { color:#3fb950; font-style:normal; margin-right:5px; }
.ims-p { position:absolute; border-radius:5px; background:#262626; border:1px solid #4a4a4a; display:flex; flex-direction:column; padding:5px; gap:4px; }
.ims-p.loop { border-style:dashed; }
.ims-p.stale { border:2px solid #d93025; box-shadow:0 0 8px #d9302588; }
.ims-p .hd { display:flex; align-items:center; gap:5px; font-weight:700; }
.ims-p .bg { font:600 10px system-ui; border-radius:3px; padding:1px 5px; background:#333; color:#aaa; }
.ims-p .bg.own { background:#e6c229; color:#111; } .ims-p .bg.llm { background:#2f5d8a; color:#fff; }
.ims-p .red { display:none; color:#ff6b5e; font:700 10px system-ui; }
.ims-p.stale .red { display:inline; }
.ims-p .sec { margin-left:auto; display:flex; align-items:center; gap:3px; font-weight:400; }
.ims-p .sec input { width:44px; background:#1b1b1b; color:#ddd; border:1px solid #444; border-radius:3px; font:12px system-ui; padding:1px 3px; }
.ims-p .sec input.own { color:#e6c229; font-weight:700; border-color:#e6c229; }
.ims-p textarea { flex:1; resize:none; background:#1b1b1b; color:#ddd; border:1px solid #444; border-radius:3px; font:12px system-ui; padding:4px; }
.ims-p .rg { height:28px; border-radius:4px; border:1px solid #4a4a4a; background:#2b2b2b; color:#ddd; font:600 13px system-ui; cursor:pointer; }
.ims-p .rg:hover { background:#383838; }
.ims-ins { position:absolute; left:0; height:18px; z-index:3; cursor:pointer; display:flex; align-items:center; justify-content:center; }
.ims-ins span { display:none; width:22px; height:22px; border-radius:50%; background:#4af; color:#fff; font:700 17px/22px system-ui; text-align:center; box-shadow:0 0 0 3px #1b1b1b; }
.ims-ins:hover span { display:block; }
.ims-ins:hover::before { content:""; position:absolute; left:0; right:0; top:7px; height:4px; background:#4af8; border-radius:2px; }
.ims-gap { position:absolute; left:-4px; height:4px; background:#4af; border-radius:2px; pointer-events:none; display:none; }
.ims-gap::before, .ims-gap::after { content:""; position:absolute; top:-3px; width:10px; height:10px; border-radius:50%; background:#4af; }
.ims-gap::before { left:-5px; } .ims-gap::after { right:-5px; }
`;

function css() {
  if (document.getElementById("ims-css")) return;
  const s = document.createElement("style");
  s.id = "ims-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

function pickFiles(multiple) {
  return new Promise((resolve) => {
    const inp = el("input");
    inp.type = "file"; inp.accept = "image/*"; inp.multiple = multiple;
    inp.onchange = () => resolve([...(inp.files || [])]);
    inp.click();
  });
}

export function boardSize(node) {
  const st = node._ims;
  const n = readShots(node).length, loop = isLoop(node);
  const iw = Math.round(IH * st.fmt.w / st.fmt.h);
  const pw = Math.max(PW, Math.round(node.size[0]) - iw - G - 2 * M);
  const lastFilm = hasFilm({ length: n }, n - 1, loop) ? n - 1 : n - 2;
  const bottom = Math.max(n * P - G, lastFilm >= 0 ? lastFilm * P + IH / 2 + G / 2 + IH : 0);
  return { iw, pw, h: bottom, w: iw + G + PW + 2 * M };
}

function signature(node) {
  const s = node.graph?._nodes?.find((n) => n.comfyClass === "InfiniteMovieSettings" && (n.mode ?? 0) === 0);
  const v = (n, k) => n?.widgets?.find((w) => w.name === k)?.value;
  return [v(node, "shots"), v(node, "loop"), v(node, "seconds"), v(node, "shot_seconds"), v(s, "aspect"), v(s, "long_side")].join("|");
}

function fit(node) {
  const { w } = boardSize(node);
  const sz = node.computeSize();
  node.setSize([Math.max(w, node.size[0] < w ? w : node.size[0]), sz[1]]);
  node.setDirtyCanvas?.(true, true);
}

function setList(node, list) { writeShots(node, list); render(node); }

async function setImage(node, i, file) {
  const name = await uploadImage(file);
  if (!name) return;
  const list = readShots(node);
  list[i].image = name;
  setList(node, list);
}

function move(node, from, gap) {
  if (gap === from || gap === from + 1) return;
  const list = readShots(node), secs = readSecs(node).list;
  while (secs.length < list.length) secs.push(0);
  const to = gap > from ? gap - 1 : gap;
  list.splice(to, 0, list.splice(from, 1)[0]);       // the prompt below travels with its image
  secs.splice(to, 0, secs.splice(from, 1)[0]);
  writeSecs(node, secs);
  node._ims.flash = { i: to, t0: performance.now() };
  setList(node, list);
  setTimeout(() => render(node), FLASH);
}

// 2026-11-14 (user: hover on the line between two images shows a plus, click = new image there).
async function insertAt(node, k) {
  if (readShots(node).length >= MAX_SHOTS) { fcReviewToast(`Max ${MAX_SHOTS} images`, "#e68929"); return; }
  const f = (await pickFiles(false))[0];
  const name = f ? await uploadImage(f) : null;
  if (!name) return;
  const list = readShots(node), secs = readSecs(node).list;
  list.splice(k, 0, { ...emptyShot(), image: name });
  if (secs.length > k) { secs.splice(k, 0, 0); writeSecs(node, secs); }
  node._ims.flash = { i: k, t0: performance.now() };
  setList(node, list);
  setTimeout(() => render(node), FLASH);
}

function remove(node, i) {
  const list = readShots(node), secs = readSecs(node).list;
  list.splice(i, 1);
  if (secs.length > i) { secs.splice(i, 1); writeSecs(node, secs); }
  setList(node, list.length ? list : [emptyShot()]);
}

function regen(node, idx) {
  if (!idx.length) { fcReviewToast("No prompt to write (all are ✎ own)", "#e68929"); return; }
  if (window.imShotsRegen) window.imShotsRegen(node, idx);
  else fcReviewToast("Prompt writing comes with 124b", "#e68929");
}

function startDrag(node, e, i, tile) {
  const st = node._ims, bd = st.board, x0 = e.clientX, y0 = e.clientY;
  let active = false, gap = -1;
  const scale = () => (bd.getBoundingClientRect().height / bd.offsetHeight) || 1;
  const onMove = (ev) => {
    if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
    active = true;
    tile.classList.add("drag");
    const n = readShots(node).length;
    const y = (ev.clientY - bd.getBoundingClientRect().top) / scale();
    gap = Math.max(0, Math.min(n, Math.round(y / P)));
    const own = gap === i || gap === i + 1;
    st.gap.style.display = own ? "none" : "block";
    st.gap.style.top = `${gap * P - G / 2 - 2}px`;
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    st.gap.style.display = "none";
    tile.classList.remove("drag");
    if (active && gap >= 0) move(node, i, gap);
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
}

function tileEl(node, list, i, iw) {
  const st = node._ims, s = list[i];
  const t = el("div", "ims-t" + (s.image ? "" : " empty"));
  t.style.cssText = `top:${i * P}px;width:${iw}px;height:${IH}px`;
  t.dataset.i = i;
  if (s.image) {
    const img = el("img");
    img.src = imageUrl(s.image);
    img.draggable = false;
    if (i === 0) img.onload = () => { st.img0 = img; if (st.fmt.label.startsWith("from image")) render(node); };
    t.appendChild(img);
    const lb = el("div", "lb");
    lb.appendChild(el("i", null, st.fmt.label));
    lb.appendChild(document.createTextNode(s.image.split("/").pop()));
    t.appendChild(lb);
  } else {
    t.appendChild(el("span", null, "+ image – click"));
  }
  t.appendChild(el("div", "no", String(i + 1)));
  const x = el("div", "x", "✕");
  x.title = "Remove this shot (image + prompt)";
  x.onpointerdown = (e) => e.stopPropagation();
  x.onclick = (e) => { e.stopPropagation(); remove(node, i); };
  t.appendChild(x);
  const fl = st.flash;
  if (fl && fl.i === i && performance.now() - fl.t0 < FLASH) t.style.boxShadow = "0 0 14px 4px #4af";
  t.onpointerdown = (e) => { if (e.button === 0 && s.image) { e.stopPropagation(); startDrag(node, e, i, t); } };
  t.onclick = async () => { if (!s.image) { const f = await pickFiles(false); if (f[0]) setImage(node, i, f[0]); } };
  t.ondblclick = async () => { const f = await pickFiles(false); if (f[0]) setImage(node, i, f[0]); };
  t.ondragover = (e) => e.preventDefault();
  t.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer?.files?.[0]; if (f) setImage(node, i, f); };
  return t;
}

function promptEl(node, list, i, iw, pw, secs) {
  const s = list[i], n = list.length, loopEdge = i === n - 1;
  const box = el("div", "ims-p" + (loopEdge ? " loop" : "") + (isStale(list, i, isLoop(node)) ? " stale" : ""));
  box.style.cssText = `left:${iw + G}px;top:${i * P + IH / 2 + G / 2}px;height:${IH}px;width:${pw}px`;
  box.dataset.i = i;
  const hd = el("div", "hd");
  hd.appendChild(el("span", null, `${i + 1} → ${loopEdge ? 1 : i + 2}`));
  const badge = () => (s.own ? ["own", "✎ own"] : s.prompt.trim() ? ["llm", "LLM"] : ["", "empty"]);
  const bg = el("span", "bg " + badge()[0], badge()[1]);
  hd.appendChild(bg);
  const red = el("span", "red", "● doesn't fit");
  red.title = "The images around this prompt changed – edit or regenerate it";
  hd.appendChild(red);
  const sec = el("label", "sec", "⏱");
  const inp = el("input");
  inp.type = "number"; inp.min = "0.5"; inp.max = "20"; inp.step = "0.5";
  const own = secs.list[i] > 0;
  inp.value = String(own ? secs.list[i] : secs.def);
  if (own) inp.className = "own";
  inp.onchange = () => {
    const v = parseFloat(inp.value), l = readSecs(node).list;
    while (l.length <= i) l.push(0);
    l[i] = !isNaN(v) && v > 0 && v !== secs.def ? Math.min(20, Math.max(0.5, v)) : 0;
    writeSecs(node, l);
    render(node);
  };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") inp.blur(); };
  sec.appendChild(inp);
  sec.appendChild(document.createTextNode("s"));
  hd.appendChild(sec);
  box.appendChild(hd);
  const ta = el("textarea");
  ta.value = s.prompt;
  ta.placeholder = "What happens from this image to the next…";
  ta.onkeydown = (e) => e.stopPropagation();
  ta.oninput = () => {
    const l = readShots(node);
    l[i].prompt = ta.value; l[i].own = !!ta.value.trim(); l[i].pair = pairOf(l, i, isLoop(node));
    writeShots(node, l);
    node._ims.sig = signature(node);
    s.own = l[i].own; s.prompt = ta.value;
    bg.className = "bg " + badge()[0]; bg.textContent = badge()[1];
    box.classList.remove("stale");
  };
  box.appendChild(ta);
  const rg = el("button", "rg", "↻ Regenerate prompt");
  rg.onclick = () => regen(node, [i]);
  box.appendChild(rg);
  return box;
}

export function render(node) {
  const st = node._ims;
  if (!st) return;
  const list = readShots(node), loop = isLoop(node), secs = readSecs(node);
  st.fmt = shotFormat(node, st.img0);
  const { iw, pw, h } = boardSize(node);
  st.w = node.size[0];
  st.cnt.textContent = String(list.length);
  st.board.replaceChildren();
  st.board.style.height = `${h}px`;
  st.gap.style.width = `${iw + 8}px`;
  for (let i = 0; i < list.length; i++) {
    st.board.appendChild(tileEl(node, list, i, iw));
    if (hasFilm(list, i, loop)) st.board.appendChild(promptEl(node, list, i, iw, pw, secs));
  }
  for (let k = 1; k < list.length && list.length < MAX_SHOTS; k++) {
    const z = el("div", "ims-ins");
    z.style.cssText = `top:${k * P - G / 2 - 9}px;width:${iw}px`;
    z.title = "Insert an image here";
    z.appendChild(el("span", null, "+"));
    z.onpointerdown = (e) => e.stopPropagation();
    z.onclick = () => insertAt(node, k);
    st.board.appendChild(z);
  }
  st.board.appendChild(st.gap);
  st.sig = signature(node);
  fit(node);
}

export function addShotsBoard(node) {
  if (node._ims) return;
  css();
  const root = el("div", "ims");
  const tb = el("div", "ims-tb");
  const cnt = el("div", "ims-cnt");
  const less = el("b", null, "◀"), num = el("span", null, "4"), more = el("b", null, "▶");
  cnt.append("images", less, num, more);
  less.onclick = () => { const l = readShots(node); if (l.length > 1) { l.pop(); setList(node, l); } };
  more.onclick = () => {
    const l = readShots(node);
    if (l.length >= MAX_SHOTS) { fcReviewToast(`Max ${MAX_SHOTS} images`, "#e68929"); return; }
    l.push(emptyShot()); setList(node, l);
  };
  const replace = (names) => {
    if (!names?.length) return;
    writeSecs(node, []);
    setList(node, names.slice(0, MAX_SHOTS).map((image) => ({ ...emptyShot(), image })));
  };
  const bLoad = el("button", null, "📂 Load images…");
  bLoad.onclick = async () => {
    const files = (await pickFiles(true)).slice(0, MAX_SHOTS);
    const names = [];
    for (const f of files) { const nm = await uploadImage(f); if (nm) names.push(nm); }
    replace(names);
  };
  const bFolder = el("button", null, "🗂 Storyboard folder…");
  bFolder.title = "Load all images of a folder (sorted by name, max 24) - replaces the storyboard";
  bFolder.onclick = async () => replace(await importFolder());
  const bAll = el("button", null, "✎ Write all prompts");
  bAll.title = "Writes every prompt except the ✎ own ones";
  bAll.onclick = () => {
    const l = readShots(node), loop = isLoop(node);
    regen(node, l.map((s, i) => i).filter((i) => hasFilm(l, i, loop) && !l[i].own));
  };
  tb.append(cnt, bAll, bLoad, bFolder);
  const board = el("div", "ims-bd");
  root.append(tb, board);
  node._ims = { root, board, cnt: num, gap: el("div", "ims-gap"), fmt: { w: 4, h: 5, label: "" }, sig: "" };
  const dw = node.addDOMWidget("im_shots", "div", root, {
    serialize: false,
    getMinHeight: () => TBH + boardSize(node).h + 8,
    getMaxHeight: () => TBH + boardSize(node).h + 8,
  });
  if (dw) Object.defineProperty(dw, "width", { get: () => node.size[0], set() {}, configurable: true });
  // Changes from outside (loop/seconds widgets, Cut's ⏱, the Settings format, loading a workflow): redraw.
  node._ims.timer = setInterval(() => {
    if (!node.graph) { clearInterval(node._ims.timer); return; }
    if (document.activeElement?.closest?.(".ims")) return;    // never redraw while typing
    if (signature(node) !== node._ims.sig || Math.abs(node.size[0] - (node._ims.w || 0)) > 1) render(node);
  }, 1000);
  render(node);
}
