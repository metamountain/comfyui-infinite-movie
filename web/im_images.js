import { IMG, fcImgActive, fcImgRoot, fcOrderKey, getLink, slotKey } from "./im_common.js";
import { reconcileChain, removeStaleModeAPs, slotIndex } from "./im_prompts.js";
// Click = (a) check prompt chain, (b) connect sync→Assemble, (c) connect settings, (d) layout.
// Looked up by name (not a flag), so it is created only ONCE after configure/reload/copy.
// 92 (user 2026-11-09): image count on the director. More = reclaim muted images (silenced by the counter),
// then new Load Image as a copy of the last image („image N – replace“); reconcileChain creates the Auto Prompts,
// then AUTO LAYOUT. Fewer = mute images from the back (never delete), reconcileChain 1b mutes their prompts too.
// Only images of this director chain. Widget not saved (serialize) and not in the prompt (options.serialize),
// Name ≠ „images“ (Autogrow-Gruppe).
function fcChainImages(chain) {
  const g = chain.graph;
  return (chain.inputs || [])
    .filter((i) => i.name?.startsWith(IMG) && i.link != null)
    .sort((a, b) => slotKey(a.name)[0] - slotKey(b.name)[0])
    .map((i) => g.getNodeById(getLink(g, i.link)?.origin_id))
    .filter((n) => n && fcImgActive(g, n));
}

function fcImgPath(g, n) {
  const path = [n];
  for (let d = 0; d < 20; d++) {
    const inp = (path[path.length - 1].inputs || []).find((i) => i.type === "IMAGE" && i.link != null);
    const o = inp && g.getNodeById(getLink(g, inp.link)?.origin_id);
    if (!o) break;
    path.push(o);
  }
  return path;
}

// Max image count = MAX_IMAGES in nodes.py (one source, user 2026-11-13): read from the node definition.
export function fcMaxImages() {
  return LiteGraph.registered_node_types?.InfiniteMovieRender?.nodeData?.input?.optional?.images?.[1]?.template?.max ?? Infinity;
}

function fcSetImageCount(chain, want) {
  const g = chain.graph;
  if (!g) return;
  want = Math.max(1, Math.min(fcMaxImages(), Math.round(Number(want) || 1)));
  let imgs = fcChainImages(chain);
  if (want === imgs.length) return;
  const restored = [];                                      // [new Load Image, remembered entry]
  chain._fcReady = false;                                   // no addPromptForNewImage in between
  try {
    if (want < imgs.length) {
      // 2026-11-11 (user: "images and prompts disappear completely when the slider reduces the count"):
      // delete the image chain and every Auto Prompt that uses one of its images (was: mute).
      // user: "deleted - so they are gone when I raise it again?" -> remembered in chain.properties.im_removed
      // (image file + prompt texts, saved with the workflow); raising the count brings them back.
      const firstId = imgs[0]?.id;
      for (const n of imgs.slice(want).reverse()) fcRemoveImage(chain, n, firstId);
    } else {
      // 1) reclaim images muted by the counter (oldest first)
      const muted = (g._nodes || []).filter((n) => n.properties?.im_count_muted === chain.id)
        .sort((a, b) => a.id - b.id);
      let have = imgs.length;
      for (const root of muted) {
        if (have >= want) break;
        for (const id of root.properties.im_count_path || [root.id]) {
          const p = g.getNodeById(id);
          if (p) p.mode = 0;
        }
        delete root.properties.im_count_muted;
        delete root.properties.im_count_path;
        have++;
      }
      // Reclaimed ones only hang on their Auto Prompts → reconcile wires them back to the director
      if (have > imgs.length) { reconcileChain(chain); chain._fcReady = false; imgs = fcChainImages(chain); }
      // 2) new Load Image as a copy of the last image
      const lastRoot = imgs.length ? fcImgRoot(g, imgs[imgs.length - 1]) : null;
      const tplFile = lastRoot?.comfyClass === "LoadImage"
        ? lastRoot.widgets?.find((w) => w.name === "image")?.value : null;
      const imgTpl = (chain.inputs || []).find((i) => i.name?.startsWith(IMG));
      let prev = lastRoot;
      const stack = chain.properties?.im_removed || [];
      for (let k = imgs.length; k < want; k++) {
        const ni = LiteGraph.createNode("LoadImage");
        if (!ni) break;
        g.add(ni);
        const back = stack.pop();   // an image removed by the counter comes back first (file + prompts)
        ni.title = back?.title || `image ${k + 1} – replace`;
        ni.properties = ni.properties || {};
        ni.properties.im_count_created = chain.id;
        if (back) restored.push([ni, back]);
        const file = back?.file || tplFile;
        const iw = ni.widgets?.find((w) => w.name === "image");
        if (iw && file) { iw.value = file; iw.callback?.(file); }   // the callback loads the preview
        if (prev) {
          ni.size = [...prev.size];
          ni.pos = [prev.pos[0], prev.pos[1] + prev.size[1] + 60];
        } else {
          ni.pos = [chain.pos[0] - 900, chain.pos[1]];
        }
        prev = ni;
        let idx = slotIndex(chain, IMG + k);
        if (idx < 0) {
          const base = imgTpl ? JSON.parse(JSON.stringify(imgTpl)) : { type: "IMAGE" };
          base.name = IMG + k; base.link = null; delete base.label; delete base.localized_name;
          chain.inputs.push(base);
          idx = chain.inputs.length - 1;
        } else if (chain.inputs[idx].link != null) {
          chain.disconnectInput(idx);
        }
        ni.connect(Math.max(0, (ni.outputs || []).findIndex((o) => o.type === "IMAGE")), chain, idx);
      }
    }
  } finally {
    chain._fcReady = true;
  }
  reconcileChain(chain);
  removeStaleModeAPs(chain);
  // remembered prompt texts back into the Auto Prompts of the restored images (only into empty ones)
  if (restored.length) {
    const first = fcChainImages(chain)[0];
    const lastNew = restored[restored.length - 1][0];
    for (const ap of (g._nodes || []).filter((a) => a.comfyClass === "InfiniteMovieAutoPrompt")) {
      const src = (nm) => { const i = ap.inputs?.find((x) => x.name === nm); return i?.link != null ? getLink(g, i.link)?.origin_id : null; };
      const pw = ap.widgets?.find((w) => w.name === "prompt");
      if (!pw || String(pw.value ?? "").trim()) continue;
      const hit = restored.find(([ni]) => ni.id === src("image_to"));
      let text = hit ? hit[1].promptIn : "";
      if (!text && src("image_from") === lastNew.id && first && src("image_to") === first.id) text = restored[restored.length - 1][1].promptClose;
      if (text) pw.value = text;
    }
  }
  // AUTO LAYOUT like via the button (wires the settings chain + arranges all groups)
  chain.widgets?.find((w) => w.name === "🔗 AUTO LAYOUT")?.callback?.();
  g.setDirtyCanvas?.(true, true);
}

// Removes one image (its image chain + every Auto Prompt using it) and remembers file + prompts in
// chain.properties.im_removed – raising the images counter brings it back.
function fcRemoveImage(chain, n, firstId, keepPrompts = true) {
  const g = chain.graph;
  const srcIs = (ap, nm, ids) => {
    const inp = ap.inputs?.find((x) => x.name === nm);
    const l = inp?.link != null ? getLink(g, inp.link) : null;
    return !!(l && ids.has(l.origin_id));
  };
  const promptOf = (ap) => String(ap?.widgets?.find((w) => w.name === "prompt")?.value ?? "");
  chain.properties = chain.properties || {};
  const stack = chain.properties.im_removed = chain.properties.im_removed || [];
  const path = fcImgPath(g, n);
  const root = path[path.length - 1];
  const ids = new Set(path.map((p) => p.id));
  const aps = (g._nodes || []).filter((a) => a.comfyClass === "InfiniteMovieAutoPrompt"
    && (srcIs(a, "image_from", ids) || srcIs(a, "image_to", ids)));
  const apIn = aps.find((a) => srcIs(a, "image_to", ids));
  const apClose = aps.find((a) => srcIs(a, "image_from", ids) && srcIs(a, "image_to", new Set([firstId])));
  stack.push({
    file: root.comfyClass === "LoadImage" ? root.widgets?.find((w) => w.name === "image")?.value ?? null : null,
    // ✕ in the image list (any position): the image comes back at the end with other neighbours → no old prompts
    title: root.title, promptIn: keepPrompts ? promptOf(apIn) : "", promptClose: keepPrompts && apClose ? promptOf(apClose) : "",
  });
  for (const ap of aps) g.remove(ap);
  for (const id of ids) { const p = g.getNodeById(id); if (p) g.remove(p); }
}

// 2026-11-11 (user: "rows in the director you can drag, like layers in Photoshop? auto layout follows.
// no in-between image, just drag up/down + remove"): image list on the director.
const fcApSrc = (g, ap, nm) => {
  const i = ap.inputs?.find((x) => x.name === nm);
  return i?.link != null ? g.getNodeById(getLink(g, i.link)?.origin_id) : null;
};
function fcApPairs(g) {
  const m = new Map();
  for (const ap of (g._nodes || []).filter((a) => a.comfyClass === "InfiniteMovieAutoPrompt")) {
    const f = fcApSrc(g, ap, "image_from"), t = fcApSrc(g, ap, "image_to");
    m.set(ap.id, (f ? fcImgRoot(g, f).id : "-") + ">" + (t ? fcImgRoot(g, t).id : "-"));
  }
  return m;
}
// Auto Prompts whose image pair changed and that are empty now: old hints off, the button says what to do.
function fcMarkChangedPairs(g, before) {
  const now = fcApPairs(g);
  for (const ap of (g._nodes || []).filter((a) => a.comfyClass === "InfiniteMovieAutoPrompt")) {
    if (before.get(ap.id) === now.get(ap.id)) continue;
    const pw = ap.widgets?.find((w) => w.name === "prompt");
    if (pw && String(pw.value ?? "").trim()) continue;
    ap.properties = ap.properties || {};
    ap.properties.prompt_hint = null;
    delete ap.properties.im_last_generated;
    if (ap._fcRegenBtn) ap._fcRegenBtn.name = "⚠ new pair – 🔄 regenerate";
  }
}
function fcAfterReorder(chain, before) {
  reconcileChain(chain);
  removeStaleModeAPs(chain);
  fcMarkChangedPairs(chain.graph, before);
  chain.widgets?.find((w) => w.name === "🔗 AUTO LAYOUT")?.callback?.();
  chain.graph.setDirtyCanvas?.(true, true);
}
function fcReorderImages(chain, from, to) {
  const g = chain.graph;
  const imgs = fcChainImages(chain);
  if (from === to || !imgs[from] || to < 0 || to >= imgs.length) return;
  const keys = imgs.map((n) => fcOrderKey(g, n)).sort((a, b) => a - b);
  const roots = imgs.map((n) => fcImgRoot(g, n));
  const [r] = roots.splice(from, 1);
  roots.splice(to, 0, r);
  const before = fcApPairs(g);
  roots.forEach((x, i) => { x.properties = x.properties || {}; x.properties.im_order = keys[i]; });
  fcAfterReorder(chain, before);
}
function fcDeleteImage(chain, k) {
  const g = chain.graph;
  const imgs = fcChainImages(chain);
  if (imgs.length <= 1 || !imgs[k]) return;
  const before = fcApPairs(g);
  chain._fcReady = false;
  try { fcRemoveImage(chain, imgs[k], imgs[0].id, k === imgs.length - 1); } finally { chain._fcReady = true; }
  fcAfterReorder(chain, before);
}

const IM_ROW = 64;
const IM_FLASH = 1200;   // ms, landing glow after a drag
export function addImageLayers(node) {
  if (node.widgets?.find((w) => w.name === "im_layers")) return;
  const M = 15, DEL = 28;
  const rowAt = (w, y) => Math.floor((y - w._y - 4) / IM_ROW);
  node.addCustomWidget({
    name: "im_layers",
    type: "im_layers",
    value: null,
    serialize: false,
    options: { serialize: false },
    tooltip: "Image order of the film, top = first. Drag an image up or down – the blue line shows where it lands; ✕ removes it " +
      "(raising the images counter brings it back). Transitions that change get an empty prompt – regenerate them.",
    computeSize: (width) => [width, Math.max(1, fcChainImages(node).length) * IM_ROW + 8],
    draw(ctx, n, width, y) {
      this._y = y; this._w = width;
      const g = n.graph;
      const imgs = fcChainImages(n);
      const rows = imgs.map((x, i) => [x, i]);
      const d = this._drag;
      ctx.save();
      rows.forEach(([img, orig], k) => {
        const root = fcImgRoot(g, img);
        const x = M, bw = width - 2 * M, ry = y + 4 + k * IM_ROW, rh = IM_ROW - 6, cy = ry + rh / 2;
        const dragged = d && orig === d.from;
        const fl = this._flash && this._flash.id === root.id ? 1 - (performance.now() - this._flash.t0) / IM_FLASH : 0;
        // user: "the frame being moved blue, the target a blue line"
        ctx.fillStyle = dragged ? "#1f3550" : "#262626";
        ctx.strokeStyle = dragged ? "#4af" : "#444";
        ctx.lineWidth = dragged ? 3 : 1;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, ry, bw, rh, 6); else ctx.rect(x, ry, bw, rh);
        ctx.fill(); ctx.stroke();
        if (fl > 0) {
          ctx.save();
          ctx.globalAlpha = fl;
          ctx.shadowColor = "#4af"; ctx.shadowBlur = 16;
          ctx.strokeStyle = "#4af"; ctx.lineWidth = 3;
          ctx.fillStyle = "rgba(68,170,255,0.25)";
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(x, ry, bw, rh, 6); else ctx.rect(x, ry, bw, rh);
          ctx.fill(); ctx.stroke();
          ctx.restore();
        }
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillStyle = "#bbb"; ctx.font = "bold 13px sans-serif";
        ctx.fillText(String(k + 1), x + 14, cy);
        // the image is the drag element (aspect kept), the name sits quietly next to it
        let tx = x + 28;
        const im = root.imgs?.[0];
        const ih = rh - 8;
        if (im?.naturalWidth) {
          const iw = Math.min(ih * 1.8, ih * im.naturalWidth / im.naturalHeight);
          ctx.drawImage(im, tx, ry + 4, iw, ih);
          tx += iw + 10;
        } else {
          ctx.fillStyle = "#333"; ctx.fillRect(tx, ry + 4, ih * 0.8, ih);
          tx += ih * 0.8 + 10;
        }
        ctx.textAlign = "left";
        ctx.fillStyle = "#999"; ctx.font = "12px sans-serif";
        let t = String(root.title || root.type || "");
        const maxW = x + bw - DEL - 6 - tx;
        while (t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -1);
        if (maxW > 20) ctx.fillText(t, tx, cy);
        ctx.textAlign = "center";
        ctx.fillStyle = this._del === orig ? "#f66" : "#a77"; ctx.font = "15px sans-serif";
        ctx.fillText("✕", x + bw - DEL / 2, cy);
      });
      if (d && d.gap != null) {
        const ly = y + 4 + d.gap * IM_ROW - 3, x0 = M - 4, x1 = width - M + 4;
        ctx.strokeStyle = "#4af"; ctx.fillStyle = "#4af"; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(x0, ly); ctx.lineTo(x1, ly); ctx.stroke();
        for (const x of [x0, x1]) { ctx.beginPath(); ctx.arc(x, ly, 5, 0, 2 * Math.PI); ctx.fill(); }
      }
      ctx.restore();
    },
    mouse(e, pos, n) {
      const t = e.type;
      const N = fcChainImages(n).length;
      const k = rowAt(this, pos[1]);
      if (t === "pointerdown" || t === "mousedown") {
        if (k < 0 || k >= N) return false;
        if (pos[0] > (this._w || n.size[0]) - M - DEL - 4) this._del = k;
        else this._drag = { from: k, gap: null };
        n.setDirtyCanvas(true, false);
        return true;
      }
      if (t === "pointermove" || t === "mousemove") {
        if (!this._drag) return false;
        // drop gap 0..N (line between rows); the own place (above/below itself) = no move
        const gap = Math.max(0, Math.min(N, Math.round((pos[1] - this._y - 4) / IM_ROW)));
        this._drag.gap = gap === this._drag.from || gap === this._drag.from + 1 ? null : gap;
        n.setDirtyCanvas(true, false);
        return true;
      }
      if (t === "pointerup" || t === "mouseup") {
        const d = this._drag, del = this._del;
        this._drag = null; this._del = null;
        if (d && d.gap != null) {
          const to = d.gap > d.from ? d.gap - 1 : d.gap;
          const moved = fcChainImages(n)[d.from];
          const id = moved && fcImgRoot(n.graph, moved).id;
          setTimeout(() => {
            fcReorderImages(n, d.from, to);
            // landing confirmation (user): the moved image glows blue at its new place and fades out
            this._flash = { id, t0: performance.now() };
            const tick = () => {
              n.setDirtyCanvas(true, false);
              if (this._flash && performance.now() - this._flash.t0 < IM_FLASH) requestAnimationFrame(tick);
              else { this._flash = null; n.setDirtyCanvas(true, false); }
            };
            requestAnimationFrame(tick);
          }, 0);
        }
        if (del != null && del === k) setTimeout(() => fcDeleteImage(n, del), 0);
        n.setDirtyCanvas(true, true);
        return true;
      }
      return false;
    },
  });
  // directly below the images counter (both not saved → saved widget positions stay the same)
  const w = node.widgets[node.widgets.length - 1];
  const ci = node.widgets.findIndex((x) => x.name === "image_count");
  if (ci >= 0) { node.widgets.splice(node.widgets.length - 1, 1); node.widgets.splice(ci + 1, 0, w); }
}

export function addImageCounter(node) {
  if (node.widgets?.find((w) => w.name === "image_count")) return;
  const n0 = Math.max(1, fcChainImages(node).length);
  const w = node.addWidget("number", "image_count", n0, (v) => {
    clearTimeout(node._fcCountT);
    node._fcCountT = setTimeout(() => fcSetImageCount(node, v), 350);   // Pfeile/Ziehen entprellen
  }, { min: 1, max: fcMaxImages(), step: 10, round: 1, precision: 0, serialize: false });
  w.serialize = false;
  w.label = "images";
  w.tooltip = "Number of images. More: adds Load Image nodes (copy of the last image – replace them) with their Auto Prompts and tidies the layout. Fewer: removes the last images and their prompts.";
  // directly via the AUTO LAYOUT button (both not saved → saved widget positions stay the same)
  const bi = node.widgets.findIndex((x) => x.name === "🔗 AUTO LAYOUT");
  if (bi >= 0 && bi < node.widgets.length - 1) {
    node.widgets.splice(node.widgets.indexOf(w), 1);
    node.widgets.splice(bi, 0, w);
  }
}

