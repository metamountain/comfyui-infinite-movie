import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { fcReviewToast, imFilmDoneNotice } from "./im_common.js";
import { fcChooseFocus, fcChooseStatus } from "./im_cut_state.js";
import { fcFilmShowFilm } from "./im_film.js";
import { imToggleWidget } from "./im_settings.js";
import { imSyncGet, imvShotDur } from "./im_sync.js";
// 86 (user 2026-11-04: „just make everything … then we'll see“): Assemble viewer instead of the canvas graph.
// Tabs Graph | Timeline | Heatmap | Frames; Frames with slider, ▶ and Onion Skin (3 ghosts, in the browser
// computed). Data: ui.im_viz from retime_nodes._viz_shot/_viz_timeline (temp folder, max. 64 frames per shot).
const IMV_TABS = ["Graph", "Timeline", "Heatmap", "Frames", "Particles", "Sheet"];
// Tabs per node – Assemble keeps Graph/Timeline (before/after re-timing comparison); the Film node fed by Cut shows
// Cut's shot analysis Heatmap/Frames/Particles/Sheet (that im_viz has timeline: null, no graph). Start tab = first entry.
const imvIsFilm = (node) => node?.comfyClass === "InfiniteMovieFilm";
const imvIsAna = (node) => (node?.comfyClass || node?.type) === "InfiniteMovieAnalysis";
function imvTabs(node) {
  // Particles first = the start tab (user 2026-11-15: "set particles as standard")
  if (imvIsAna(node) || imvIsFilm(node) || node?.comfyClass === "InfiniteMovieChooser") return ["Particles", "Heatmap", "Frames", "Sheet"];
  return IMV_TABS;
}
// Particle color by speed (same scale as the heatmap, without the nearly black end)
const IMV_LUT = [[0.0, [66, 10, 104]], [0.33, [147, 38, 103]], [0.6, [221, 81, 58]], [0.85, [252, 165, 10]], [1.0, [252, 255, 164]]];
function imvLut(v) {
  v = Math.max(0, Math.min(1, v));
  for (let i = 1; i < IMV_LUT.length; i++) {
    const [p1, c1] = IMV_LUT[i], [p0, c0] = IMV_LUT[i - 1];
    if (v <= p1) {
      const t = (v - p0) / (p1 - p0);
      return c0.map((a, j) => Math.round(a + (c1[j] - a) * t));
    }
  }
  return IMV_LUT[IMV_LUT.length - 1][1];
}
const imvJsonCache = new Map();
function imvJson(node, url) {
  if (imvJsonCache.has(url)) return imvJsonCache.get(url);
  imvJsonCache.set(url, null);
  fetch(url).then((r) => (r.ok ? r.json() : null)).then((j) => { imvJsonCache.set(url, j); imvDraw(node); })
    .catch(() => {});
  return null;
}
const IMV_USED = "#3CBE5A", IMV_DUP = "#F08C28";
const imvImgCache = new Map();

function imvImg(node, url) {
  let img = imvImgCache.get(url);
  if (!img) {
    img = new Image();
    img.onload = () => imvDraw(node);
    img.src = url;
    imvImgCache.set(url, img);
    if (imvImgCache.size > 600) imvImgCache.delete(imvImgCache.keys().next().value);
  }
  return img;
}

function imvUrl(subfolder, filename) {
  const q = new URLSearchParams({ filename, subfolder: subfolder || "", type: "temp" });
  return api.apiURL(`/view?${q}`);
}

function imvBtn(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText = "height:22px;padding:0 9px;font:bold 11px sans-serif;border-radius:3px;border:1px solid #555;" +
    "background:#333;color:#fff;cursor:pointer;";
  b.addEventListener("click", onClick);
  return b;
}

export function imvStop(st) {
  if (st.timer) { clearInterval(st.timer); st.timer = null; }
  if (st.play) st.play.textContent = "▶";
}

function imvShot(node) {
  const v = node.properties?.im_viz;
  return v?.shots?.[node._imv?.seg ?? 0] || null;
}

// 2026-11-09 (user: „Assemble window to 3×3 … all analyzers to one size“): fixed area = 3×3 Load Image tiles
// (160×160) -> 480×480, square (user 2026-11-09: portrait and landscape fit, images contain);
// every tab fills exactly this area. Director gets the same width (IMV_NODE_W).
export const IMV_W = 480, IMV_H = 480, IMV_NODE_W = IMV_W + 24;
// 2026-11-13 (user: "Cut as tall as the layout allows, content as big as possible"): AUTO LAYOUT may give a node its
// own area height (properties.imv_h); the area is then as wide as the node. Without it the area stays 480×480.
// With imv_h the area is a SQUARE (height = width), not as tall as the node.
export const IMV_MIN_H = 200;
// Film player: the video square as wide as the player; with properties.im_fit_h (AUTO LAYOUT, user 2026-11-15:
// "previews together, group as tall as the Director") it shrinks so the whole player fits that height.
export const IMV_FILM_EXTRA = 16 + 16 + 26;   // gaps + timeline + bar (im_film)
// user 2026-11-15 ("perfect aspect ratio, optimise for width, use everything"): the video box has the film's format
// (width / height): its own video once loaded (properties.im_ar), before that the Director's format.
export function filmAspect(node) {
  const own = Number(node?.properties?.im_ar);
  if (own > 0.1 && own < 10) return own;
  const d = (node?.graph || app.graph)?._nodes?.find((n) => n.comfyClass === "InfiniteMovieRender" && n._imsb?.fmt?.w);
  return d ? d._imsb.fmt.w / d._imsb.fmt.h : 1;
}
// Height of the video box: full width / format; with im_fit_h at most what that height leaves.
export function filmSquare(node, minW = 360) {
  const w = Math.max(minW, Math.round((node?.size?.[0] || IMV_NODE_W) - 20)), fit = Number(node?.properties?.im_fit_h);
  const h = Math.round(w / filmAspect(node));
  return fit > 0 ? Math.max(120, Math.min(h, Math.floor(fit - IMV_FILM_EXTRA))) : h;
}
// Movie Analysis node (user 2026-11-15: "analysis external, a square block"): a square as wide as the node; with
// properties.im_fit_h (AUTO LAYOUT: preview + analysis = the Director's height) as tall as that leaves.
export const IMV_CTL_H = 96 + 20;   // tab / shot / control / info rows + the widget margin
function imvArea(node) {
  if (imvIsAna(node)) {
    // im_sq (AUTO LAYOUT, user 2026-11-15: "identical to the preview, same size and format"): the preview's video
    // height; the box has the film's format (im_ar), as wide as the node allows
    const w = Math.max(200, Math.round((node.size?.[0] || IMV_NODE_W) - 20)), sq = Number(node.properties?.im_sq);
    const fit = Number(node.properties?.im_fit_h), ar = filmAspect(node);
    let h = Math.min(Math.round(w / ar), sq > 0 ? Math.floor(sq) : Infinity, fit > 0 ? Math.floor(fit - IMV_CTL_H) : Infinity);
    h = Math.max(120, h);
    return [Math.min(w, Math.round(h * ar)), h];
  }
  if (imvIsFilm(node)) { const h = filmSquare(node, 0); return [Math.round(h * filmAspect(node)), h]; }
  if ((node?.comfyClass || node?.type) === "InfiniteMovieAssemble") {
    // Even Motion's graph (user 2026-11-15): full node width, height from the graph image's format (before the
    // first run: the film's format)
    const w = Math.max(IMV_MIN_H, Math.round((node.size?.[0] || IMV_NODE_W) - 20)), g = node._imv?.graph;
    const ar = g?.naturalWidth && g.naturalHeight ? g.naturalWidth / g.naturalHeight : filmAspect(node);
    return [w, Math.round(w / ar)];
  }
  const h = Number(node?.properties?.imv_h);
  if (!(h >= IMV_MIN_H)) return [IMV_W, IMV_H];
  const w = Math.max(IMV_W, Math.round((node.size?.[0] || IMV_NODE_W) - 24));
  return [w, w];
}
// 2026-11-13 (user: "Assemble as wide as the group"): only a minimum – AUTO LAYOUT may make it wider, the 480 area
// stays centred (canvas margin auto).
export function imvFixWidth(node) {
  if (!node?.size || node.size[0] >= IMV_NODE_W - 1) return;
  node.setSize([IMV_NODE_W, Math.max(node.size[1], node.computeSize()[1])]);
}

// Draw an image fitted (contain) and centered into a rectangle
function imvFit(ctx, img, x, y, w, h) {
  const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

// Sheet (3×3 … 8×8 per slider): N×N evenly distributed frames of the shot (at most as many as exist)
function imvSheetPicks(n, grid) {
  const want = Math.min(grid * grid, n);
  const out = [];
  for (let i = 0; i < want; i++) {
    const k = want === 1 ? 0 : Math.round(i * (n - 1) / (want - 1));
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

export function imvEnsure(node) {
  if (node._imv) return node._imv;
  const st = { tab: imvTabs(node)[0], seg: 0, k: 0, grid: 3, trail: 16, onion: false, timer: null, graph: null, liveTimeline: null };
  node._imv = st;
  const el = document.createElement("div");
  el.style.cssText = "display:flex;flex-direction:column;gap:4px;font:11px sans-serif;color:#D0D0D0;width:100%;";
  const row = "display:flex;gap:4px;align-items:center;height:22px;flex:none;overflow:hidden;";
  const tabRow = document.createElement("div");
  tabRow.style.cssText = row;
  st.tabBtns = imvTabs(node).map((t) => {
    const b = imvBtn(t, () => { st.tab = t; imvStop(st); imvDraw(node); });
    tabRow.appendChild(b);
    return b;
  });
  const segRow = document.createElement("div");
  segRow.style.cssText = row;
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `display:block;flex:none;width:${IMV_W}px;height:${IMV_H}px;margin:0 auto;` +
    "background:#121212;border-radius:3px;";
  canvas.addEventListener("click", (e) => {
    // Sheet: clicking a tile opens this frame in the Frames tab
    if (st.tab !== "Sheet" || !st._sheet) return;
    const r = canvas.getBoundingClientRect();
    const g = st._sheet.grid;
    const col = Math.floor((e.clientX - r.left) / r.width * g);
    const rw = Math.floor((e.clientY - r.top) / r.height * g);
    const k = st._sheet.picks[rw * g + col];
    if (k === undefined) return;
    st.k = k; st.tab = "Frames"; imvDraw(node);
  });
  const ctlRow = document.createElement("div");
  ctlRow.style.cssText = row + "gap:6px;";
  const play = imvBtn("▶", () => {
    if (st.timer) { imvStop(st); imvDraw(node); return; }
    const sh = imvShot(node);
    if (!sh) return;
    const fps = 24 / (sh.step || 1);
    play.textContent = "⏸";
    st.timer = setInterval(() => {
      const n = imvShot(node)?.frames.length || 1;
      st.k = (st.k + 1) % n;
      imvDraw(node);
    }, Math.max(20, 1000 / fps));
  });
  const slider = document.createElement("input");
  slider.type = "range"; slider.min = "0"; slider.value = "0"; slider.style.cssText = "flex:1;min-width:0;";
  slider.addEventListener("input", () => {
    if (st.tab === "Sheet") st.grid = Number(slider.value);
    else st.k = Number(slider.value);
    imvDraw(node);
  });
  const onionLbl = document.createElement("label");
  onionLbl.style.cssText = "display:flex;gap:3px;align-items:center;cursor:pointer;white-space:nowrap;";
  const onion = document.createElement("input");
  onion.type = "checkbox";
  onion.addEventListener("change", () => { st.onion = onion.checked; imvDraw(node); });
  onionLbl.appendChild(onion); onionLbl.appendChild(document.createTextNode("onion skin"));
  const gridLbl = document.createElement("span");
  gridLbl.style.cssText = "white-space:nowrap;min-width:34px;";
  const trailLbl = document.createElement("span");
  trailLbl.style.cssText = "white-space:nowrap;";
  const trail = document.createElement("input");
  trail.type = "range"; trail.min = "2"; trail.max = "48"; trail.value = String(st.trail);
  trail.style.cssText = "width:70px;flex:none;";
  trail.title = "trail length (source frames)";
  trail.addEventListener("input", () => { st.trail = Number(trail.value); imvDraw(node); });
  ctlRow.appendChild(play); ctlRow.appendChild(gridLbl); ctlRow.appendChild(slider); ctlRow.appendChild(onionLbl);
  ctlRow.appendChild(trailLbl); ctlRow.appendChild(trail);
  const info = document.createElement("div");
  info.style.cssText = "height:14px;line-height:14px;flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  el.appendChild(tabRow); el.appendChild(segRow); el.appendChild(canvas); el.appendChild(ctlRow); el.appendChild(info);
  Object.assign(st, { el, segRow, canvas, ctlRow, slider, play, onionLbl, gridLbl, trailLbl, trailIn: trail, info });
  // fixed height: area 480×480 + 4 rows (22+22+22+14) + 4 gaps -> does not jump on tab switch.
  // +20: the frontend subtracts 10 px margin top/bottom from the widget (el = height - 20); without the 20 the
  // slider and info row would stick out below the frame (user 2026-11-09 "don't fit in frame").
  if (imvIsFilm(node)) {
    // Film node (user 2026-11-15: "the analysis has no business in the preview"): a plain player, the analysis
    // state only keeps the timeline data; nothing is shown.
    st.hostH = () => 0;
    return st;
  }
  node.addDOMWidget("im_viz", "div", el, {
    serialize: false,
    getMinHeight: () => imvArea(node)[1] + 96 + 20,
  }).serialize = false;   // the option alone does not keep it out of widgets_values
  return st;
}

// Player time t (s) -> shot index, frame index k and position 0..1 inside that shot. t runs over the whole film
// (shots back to back), or over one shot when segIdx (Cut tile index) is given.
export function imvTimeToFrame(shots, t, segIdx = null) {
  const dur = imvShotDur;
  let i = 0, local = Math.max(0, t);
  if (segIdx != null) {
    i = shots.findIndex((s) => s.seg === segIdx + 1);
    if (i < 0) i = Math.min(Math.max(segIdx, 0), shots.length - 1);
  } else {
    while (i < shots.length - 1 && local >= dur(shots[i])) { local -= dur(shots[i]); i++; }
  }
  const sh = shots[i];
  if (!sh?.frames?.length) return null;
  let k = 0;
  while (k < sh.frames.length - 1 && sh.frames[k + 1].t <= local) k++;
  return { seg: i, k, frac: Math.min(1, local / dur(sh)) };
}

// The player drives every analysis view: same shot and frame, white position bar at the bottom.
window.addEventListener("imv-time", (e) => {
  const t = e.detail?.t;
  if (t == null) return;
  const sync = imSyncGet();
  for (const n of (app.graph?._nodes || [])) {
    const shots = n.properties?.im_viz?.shots, st = n._imv;
    if (!shots?.length || !st) continue;
    const m = imvTimeToFrame(shots, t, sync.src === "seg" ? sync.seg : null);
    if (!m) continue;
    const moved = m.seg !== st.seg || m.k !== st.k;
    if (!moved && Math.abs((st.playFrac ?? -1) - m.frac) < 0.005) continue;   // nothing visible changed
    if (moved) { imvStop(st); st.seg = m.seg; st.k = m.k; }
    st.playFrac = m.frac;
    imvDraw(n);
  }
});

export function imvDraw(node) {
  if (imvIsFilm(node)) return;   // the player shows no analysis
  const st = imvEnsure(node);
  const v = node.properties?.im_viz;
  const shots = v?.shots || [];
  if (st.seg >= shots.length) st.seg = 0;
  st.tabBtns.forEach((b, i) => {
    const on = imvTabs(node)[i] === st.tab;
    b.style.background = on ? "#2ea043" : "#333";
    b.style.borderColor = on ? "#2ea043" : "#555";
  });
  // Rows always stay (visibility instead of display) so the height stays the same
  const perShot = st.tab !== "Graph" && st.tab !== "Timeline";
  const needSeg = perShot && shots.length > 1;
  st.segRow.style.visibility = needSeg ? "visible" : "hidden";
  if (needSeg && st.segRow.childElementCount !== shots.length) {
    st.segRow.replaceChildren(...shots.map((sh, i) => imvBtn(`seg ${sh.seg}`, () => {
      st.seg = i; st.k = 0; imvStop(st); imvDraw(node); fcChooseFocus(sh.seg);
    })));
  }
  [...st.segRow.children].forEach((b, i) => { b.style.background = i === st.seg ? "#1f6feb" : "#333"; });
  const ctl = (st.tab === "Frames" || st.tab === "Particles" || st.tab === "Sheet") && shots.length;
  st.ctlRow.style.visibility = ctl ? "visible" : "hidden";
  const isSheet = st.tab === "Sheet";
  st.play.style.display = isSheet ? "none" : "";
  st.onionLbl.style.display = st.tab === "Frames" ? "flex" : "none";
  const isPart = st.tab === "Particles";
  st.trailLbl.style.display = isPart ? "" : "none";
  st.trailIn.style.display = isPart ? "" : "none";
  st.trailLbl.textContent = `trail ${st.trail}`;
  st.gridLbl.style.display = isSheet ? "" : "none";

  imvFixWidth(node);
  const [W, H] = imvArea(node);
  const c = st.canvas, ctx = c.getContext("2d");
  if (c.width !== W || c.height !== H) {
    c.width = W; c.height = H;
    c.style.width = W + "px"; c.style.height = H + "px";
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#121212";
  ctx.fillRect(0, 0, W, H);
  st._sheet = null;

  let text = "";
  const sh = shots[st.seg];
  if (st.tab === "Graph") {
    if (st.graph?.naturalWidth) imvFit(ctx, st.graph, 0, 0, W, H);
    text = st.graph ? "timing per shot: grey = as rendered, coloured = even_motion" : "Run Even Motion once to see the graph.";
  } else if (!v) {
    text = "Run Even Motion once (even_motion on) to see timeline, heatmap and frames.";
  } else if (st.tab === "Timeline") {
    const tl = st.liveTimeline || (v.timeline && { subfolder: v.subfolder, filename: v.timeline });
    const img = tl && imvImg(node, imvUrl(tl.subfolder, tl.filename));
    if (img?.complete && img.naturalWidth) imvFit(ctx, img, 0, 0, W, H);
    text = "top: change per frame · bottom: grey dropped, green used, orange duplicate";
  } else if (st.tab === "Heatmap" && sh) {
    const img = imvImg(node, imvUrl(sh.subfolder, sh.heat));
    if (img.complete && img.naturalWidth) imvFit(ctx, img, 0, 0, W, H);
    text = `seg ${sh.seg} · where the picture changes (bright = most change)`;
  } else if (st.tab === "Frames" && sh) {
    const n = sh.frames.length;
    if (st.k >= n) st.k = 0;
    st.slider.min = "0";
    st.slider.max = String(Math.max(0, n - 1));
    st.slider.value = String(st.k);
    const f = sh.frames[st.k];
    const img = imvImg(node, imvUrl(sh.subfolder, f.f));
    if (img.complete && img.naturalWidth) {
      imvFit(ctx, img, 0, 0, W, H);
      if (st.onion) {
        const alphas = [0.35, 0.22, 0.12];
        [1, 2, 3].map((d) => sh.frames[st.k - d]).forEach((g, i) => {
          if (!g) return;
          const gi = imvImg(node, imvUrl(sh.subfolder, g.f));
          if (gi.complete && gi.naturalWidth) { ctx.globalAlpha = alphas[i]; imvFit(ctx, gi, 0, 0, W, H); }
        });
        ctx.globalAlpha = 1;
      }
    }
    const every = sh.step > 1 ? ` · every ${sh.step}. of ${sh.n_out}` : "";
    st.info.replaceChildren(document.createTextNode(
      `seg ${sh.seg} · ${st.k + 1}/${n}${every} · film frame #${f.out} · source #${f.src} · ${f.t.toFixed(2)} s · `));
    const tag = document.createElement("span");
    tag.textContent = f.dup ? "duplicate" : "used";
    tag.style.color = f.dup ? IMV_DUP : IMV_USED;
    st.info.appendChild(tag);
    text = null;
  } else if (st.tab === "Particles" && sh) {
    // detected image points pull trails: a trail over the last `trail` source frames, older parts dimmer
    // (ghosting), color = speed (bright = fast). Image below dimmed.
    const n = sh.frames.length;
    if (st.k >= n) st.k = 0;
    st.slider.min = "0"; st.slider.max = String(Math.max(0, n - 1)); st.slider.step = "1";
    st.slider.value = String(st.k);
    const f = sh.frames[st.k];
    const img = imvImg(node, imvUrl(sh.subfolder, f.f));
    const tj = sh.tracks ? imvJson(node, imvUrl(sh.subfolder, sh.tracks)) : null;
    let bx = 0, by = 0, bw = W, bh = H;
    if (img.complete && img.naturalWidth) {
      const sc = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      bw = img.naturalWidth * sc; bh = img.naturalHeight * sc; bx = (W - bw) / 2; by = (H - bh) / 2;
      ctx.globalAlpha = 0.35; ctx.drawImage(img, bx, by, bw, bh); ctx.globalAlpha = 1;
    }
    let shown = 0, gain = 1;
    if (tj?.tracks) {
      const L = st.trail, t = f.src;
            // Speed scale: 95th percentile of the step widths in the shot (once per file)
      if (tj._vmax === undefined) {
        const sp = [];
        for (const r of tj.tracks) for (let i = 2; i < r.p.length; i += 2) sp.push(Math.hypot(r.p[i] - r.p[i - 2], r.p[i + 1] - r.p[i - 1]));
        sp.sort((a, b) => a - b);
        tj._vmax = Math.max(1, sp[Math.floor(sp.length * 0.95)] || 1);
        // Net speed per trail (start→end / frames) – without jitter; 90th percentile for the boost
        const dv = tj.tracks.map((r) => {
          const k = r.p.length / 2 - 1;
          return Math.hypot(r.p[2 * k] - r.p[0], r.p[2 * k + 1] - r.p[1]) / Math.max(1, k);
        }).sort((a, b) => a - b);
        tj._dv = Math.max(0.05, dv[Math.floor(dv.length * 0.9)] || 1);
      }
      // Glow trails (user 2026-11-04): additive ("lighter"), per segment a wider glow + thin core,
      // older parts dimmer (ghosting); head = small spark with micro glow.
      ctx.lineCap = "round";
      ctx.globalCompositeOperation = "lighter";
      const heads = [];
      // make small motion visible: trail around the head enlarged until the fast trails
      // are net about 5 % of the image width long (at most ×12, shown in the info text)
      gain = Math.max(1, Math.min(12, 50 / (tj._dv * L)));
      for (const r of tj.tracks) {
        const len = r.p.length / 2, end = t - r.s;
        if (end < 0 || end >= len) continue;
        const start = Math.max(0, end - L);
        const hx0 = r.p[2 * end], hy0 = r.p[2 * end + 1];
        const px = (v) => bx + (hx0 + (v - hx0) * gain) / 1000 * bw;
        const py = (v) => by + (hy0 + (v - hy0) * gain) / 1000 * bh;
        for (let i = start + 1; i <= end; i++) {
          const a = (1 - (end - i) / L) ** 1.6;
          const v = Math.hypot(r.p[2 * i] - r.p[2 * i - 2], r.p[2 * i + 1] - r.p[2 * i - 1]) / tj._vmax;
          const [cr, cg, cb] = imvLut(0.35 + 0.65 * v ** 0.6);
          const x0 = px(r.p[2 * i - 2]), y0 = py(r.p[2 * i - 1]), x1 = px(r.p[2 * i]), y1 = py(r.p[2 * i + 1]);
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(0.18 * a).toFixed(3)})`;
          ctx.lineWidth = 3.2;
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(0.85 * a).toFixed(3)})`;
          ctx.lineWidth = 0.9;
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        }
        heads.push([px(r.p[2 * end]), py(r.p[2 * end + 1])]);
        shown++;
      }
      for (const [hx, hy] of heads) {
        const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, 4);
        g.addColorStop(0, "rgba(255,250,200,0.9)");
        g.addColorStop(0.35, "rgba(252,165,10,0.35)");
        g.addColorStop(1, "rgba(221,81,58,0)");
        ctx.fillStyle = g;
        ctx.fillRect(hx - 4, hy - 4, 8, 8);
        ctx.fillStyle = "#FFFFF0";
        ctx.fillRect(hx - 0.5, hy - 0.5, 1, 1);
      }
      ctx.globalCompositeOperation = "source-over";
    }
    text = !sh.tracks ? "No particle data – run Even Motion again." :
      `seg ${sh.seg} · ${st.k + 1}/${n} · source #${f.src} · ${shown} particles · trail ${st.trail} frames${gain > 1.05 ? ` · motion ×${gain.toFixed(1)}` : ""} · bright = fast`;
  } else if (st.tab === "Sheet" && sh) {
    const g = st.grid;
    st.slider.min = "3"; st.slider.max = "8"; st.slider.step = "1";
    st.slider.value = String(g);
    st.gridLbl.textContent = `${g}×${g}`;
    const picks = imvSheetPicks(sh.frames.length, g);
    st._sheet = { grid: g, picks };
    // Tiles in the aspect ratio of the area (square): 3×3 = 160×160, images contain
    const T = W / g, TH = H / g, gap = 2, bar = 3;
    ctx.font = `${Math.max(9, Math.round(T / 9))}px sans-serif`;
    ctx.textBaseline = "top";
    picks.forEach((k, i) => {
      const f = sh.frames[k];
      const x = (i % g) * T, y = Math.floor(i / g) * TH;
      const img = imvImg(node, imvUrl(sh.subfolder, f.f));
      if (img.complete && img.naturalWidth) imvFit(ctx, img, x + gap / 2, y + gap / 2, T - gap, TH - gap - bar);
      ctx.fillStyle = f.dup ? IMV_DUP : IMV_USED;
      ctx.fillRect(x + gap / 2, y + TH - gap / 2 - bar, T - gap, bar);
      if (T >= 48) {
        const lbl = `#${f.out}`;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(x + gap / 2, y + gap / 2, ctx.measureText(lbl).width + 6, Math.round(T / 9) + 4);
        ctx.fillStyle = "#D0D0D0";
        ctx.fillText(lbl, x + gap / 2 + 3, y + gap / 2 + 2);
      }
    });
    const every = sh.step > 1 ? ` (every ${sh.step}. of ${sh.n_out})` : "";
    text = `seg ${sh.seg} · ${picks.length} of ${sh.frames.length} frames${every} · bar green used, orange duplicate · click = open in Frames`;
  }
  if (st.playFrac != null && shots.length) {   // player position inside the shown shot
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, H - 3, Math.round(W * st.playFrac), 3);
  }
  if (text !== null) st.info.textContent = text;
  const need = Math.ceil(node.computeSize()[1] / 10) * 10;   // on the layout's 10 grid
  if (Math.abs(node.size[1] - need) > 2) node.setSize([node.size[0], need]);
  node.setDirtyCanvas(true, true);
}


app.registerExtension({
  name: "InfiniteMovie.NormalizeTimeLiveGraph",
  setup() {
    api.addEventListener("executed", (e) => {
      const d = e.detail;
      const node = app.graph?.getNodeById(Number(d?.display_node || d?.node));
      // 116c2: Cut (Chooser) also delivers im_viz (review_nodes.py:771) -> same viewer treatment,
      // but without setGraph/normalize_graph (no graph output there).
      if (node?.comfyClass !== "InfiniteMovieAssemble" && node?.comfyClass !== "InfiniteMovieChooser") return;
      // 2026-11-13 (user: "remove preview from assemble"): Even Motion has no viewer any more – the film is shown by
      // the Film node below it; only the film-done notice stays.
      if (node.comfyClass === "InfiniteMovieAssemble") {
        const fi0 = d.output?.film_info?.[0];
        if (fi0) { node._fc_film_done = fi0; imFilmDoneNotice(node, fi0); }
        return;
      }
      // Cut's shot analysis is shown by the Movie Analysis node(s) on its sync output, Cut keeps a copy.
      const viz = d.output?.im_viz?.[0];
      const films = imvCutFilms(node), anas = imvCutTargets(node, imvIsAna);
      if (viz) {
        for (const n of [node, ...films, ...anas]) {
          n.properties = n.properties || {};
          n.properties.im_viz = viz;   // survives reloading the page (files until ComfyUI restart)
        }
        for (const f of [...films, ...anas]) { const st = imvEnsure(f); st.liveTimeline = null; st.k = 0; imvStop(st); }
      }
      // 116c2: film build failed (review_nodes.py:724 ui["film_error"]) -> red Cut status + toast.
      const fe = d.output?.film_error?.[0];
      if (fe) {
        node._fc_film_error = fe;
        fcReviewToast(fe, "#d93025");
      } else if (d.output?.film?.[0]) {
        node._fc_film_error = null;   // film built again: clear the error
      }
      // Film-done notice (user 2026-11-13: "status message when the film is done, clearly"):
      // ui["film_info"] from Cut (review_nodes.py) and Even Motion (retime_nodes.py).
      const fi = d.output?.film_info?.[0];
      if (fi && !fe) { node._fc_film_done = fi; imFilmDoneNotice(node, fi); }
      // Cut built the film itself: the Film players it feeds show it (they are not part of a shot run)
      const fv = d.output?.film?.[0];
      if (fi && !fe && fv?.filename) {
        const info = { exists: true, path: fi.path, view: { filename: fv.filename, subfolder: fv.subfolder || "", type: fv.type || "output" },
          status: `Saved: ${fi.path} · ${fi.seconds} s · ${fi.shots} shots`, saved_at: Date.now() };
        for (const f of films) fcFilmShowFilm(f, info);
      }
      for (const a of anas) if (a.properties?.im_viz) imvDraw(a);
      fcChooseStatus(node);
    });
  },
  // A Movie Analysis node shows its analysis right away: its own saved copy, else the one of the Cut it is linked to.
  nodeCreated(node) {
    if (!imvIsAna(node)) return;
    const take = (force) => {
      const l = node.inputs?.[0]?.link, g = node.graph || app.graph;
      const src = l != null ? g?.getNodeById((g.links?.[l] ?? g.links?.get?.(l))?.origin_id) : null;
      if (src?.properties?.im_viz && (force || !node.properties?.im_viz)) (node.properties ||= {}).im_viz = src.properties.im_viz;
      imvDraw(node);
    };
    setTimeout(() => take(false), 0);
    const prev = node.onConnectionsChange;
    node.onConnectionsChange = function (...a) { prev?.apply(this, a); setTimeout(() => take(true), 0); };   // linked later
  },
});

// Nodes this Cut feeds that match test (Film players on video_path, Movie Analysis on sync).
function imvCutTargets(cut, test) {
  const g = cut.graph || app.graph, out = [];
  for (const o of cut.outputs || []) for (const lid of o.links || []) {
    const t = g?.getNodeById((g.links?.[lid] ?? g.links?.get?.(lid))?.target_id);
    if (test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}
const imvCutFilms = (cut) => imvCutTargets(cut, imvIsFilm);

// 57d: the Assemble `loop` widget is hidden as long as `sync` is connected
// (the value then comes from the pipe; in Python sync["loop"] wins).
app.registerExtension({
  name: "InfiniteMovie.AssembleLoopHide",
  nodeCreated(node) {
    if (node.comfyClass !== "InfiniteMovieAssemble") return;
    // 57c: if `sync` is connected, hide file/video_path/fps/loop + the upload button
    // (Python ignores them anyway, precedence retime_nodes.py:299). Do NOT delete the values.
    const HIDDEN_WHEN_SYNC = ["file", "video_path", "loop"];
    // 58 (2026-11-02): do NOT take widgets from node.widgets – widgets_values are positional, and graphToPrompt
    // left out the required inputs file/loop (night debug 58: strength=24 > max 1.0). Only hide,
    // Vorbild ComfyUI-LTXVideo/web/js/guider_parameters_advanced.js:22-45 (hidden + computeSize).
    const toggle = imToggleWidget;
    // 73: copy_to is no longer a widget (input removed) -> no toggle needed.
    const setHidden = (visible) => {
      for (const name of HIDDEN_WHEN_SYNC) toggle(node.widgets?.find((x) => x.name === name), visible);
      // hide the upload button (DOM widget, belongs to `file`)
      toggle(node.widgets?.find((x) => x._isFileUpload || x.name === "upload"), visible);
      node.setSize([node.size[0], node.computeSize()[1]]);
      node.setDirtyCanvas(true, true);
    };
    // 57c: tooltip for `file` (user 2026-11-01)
    const fileW = node.widgets?.find((x) => x.name === "file");
    if (fileW) fileW.tooltip = "Only for re-timing an existing video without the Director. Hidden while 'sync' is connected.";
    // 2026-11-09: invalid values (shifted widgets_values after a schema change, e.g. interpolate=24,
    // fps='') reset to the default – otherwise validation fails on fields that are hidden and thus
    // not correctable by the user. Valid values stay untouched.
    // Defaults as in retime_nodes.py InfiniteMovieAssemble.define_schema (the frontend does not know them here).
    const DEFAULTS = { interpolate: "auto", loop: true, time_extend: 1 };  // 116c2: even_motion widget gone since 116b3
    const sanitize = () => {
      for (const w of node.widgets || []) {
        const vals = w.options?.values;
        const def = DEFAULTS[w.name];
        if (w.type === "combo" && Array.isArray(vals) && vals.length && !vals.includes(w.value)) {
          if (w.name === "file") continue; // file list: an unknown file stays visible as an error
          w.value = vals.includes(def) ? def : vals[0];
        } else if ((w.type === "number" || w.type === "slider" || w.name === "time_extend")
          && (w.value === "" || w.value === null || !Number.isFinite(Number(w.value)))) {
          w.value = def ?? w.options?.min ?? 0;
        } else if (w.type === "toggle" && typeof w.value !== "boolean") {
          w.value = def ?? true;
        } else if (w.name === "video_path" && w.value === "as rendered") {
          w.value = ""; // leftover of the removed output_size combo (shifted)
        }
      }
    };
    const update = () => {
      sanitize();
      const inp = (node.inputs || []).find((i) => i.name === "sync");
      setHidden(inp?.link == null);
    };
    setTimeout(update, 100); // after link restore (load) or immediately (new)
    const onConn = node.onConnectionsChange;
    node.onConnectionsChange = function (type, slot, connected, ...rest) {
      const r = onConn?.apply(this, [type, slot, connected, ...rest]);
      if (this.inputs?.[slot]?.name === "sync") setTimeout(update, 0);
      return r;
    };
  },
});

