import { app } from "../../scripts/app.js";
import { IMG, fcActive, fcImgActive, fcImgLink, fcImgOrder, fcImgRoot, getLink, interleave, settingsNodeOf, slotKey } from "./im_common.js";
import { wireSettingsChain } from "./im_director.js";
// Layout button (user 2026-10-26: no switch, arrange only on click): images left, prompts right tightly
// stacked, each image centered on the boundary between its two prompts. Sizes the user has dragged
// stay; the group around the images is adjusted.
function sources(node, prefix) {
  return (node.inputs || [])
    .filter((i) => i.name?.startsWith(prefix) && i.link != null)
    .sort((a, b) => parseInt(a.name.slice(prefix.length), 10) - parseInt(b.name.slice(prefix.length), 10))
    .map((i) => {
      const l = getLink(node.graph, i.link);
      return l && node.graph.getNodeById(l.origin_id);
    })
    .filter(Boolean);
}

const PROMPT_W = 600;

export function layoutPrompts(node) {
  const imgs = sources(node, IMG), prs = sources(node, PR);
  if (!imgs.length || !prs.length) return;
  const g = node.graph;
  const titleH = globalThis.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
  const gap = 20;
  const all = [...imgs, ...prs];
  const inside = (gr, n) => n.pos[0] >= gr.pos[0] && n.pos[0] < gr.pos[0] + gr.size[0] &&
    n.pos[1] >= gr.pos[1] && n.pos[1] < gr.pos[1] + gr.size[1];
  const group = (g._groups || g.groups || []).find((gr) => inside(gr, imgs[0]));
  const x0 = Math.min(...imgs.map((n) => n.pos[0]));
  // body-top based like promptPos below; "- titleH" here moved the column up by one title per click
  const y0 = group ? group.pos[1] + 45 : Math.min(...all.map((n) => n.pos[1]));
  // Prompt nodes 50 % wider than the 400 px they are created with, so the prompt text fits
  // (Nutzer 2026-11-01); a width the user dragged larger stays.
  for (const p of prs) {
    if (p.size[0] < PROMPT_W) p.setSize ? p.setSize([PROMPT_W, p.size[1]]) : (p.size[0] = PROMPT_W);
    // 57d: prompt node as tall as the Load Image at image_from (min. computeSize),
    // so prompt + image stand at the same height (user 2026-11-01).
    const fi = (p.inputs || []).findIndex((i) => i.name === "image_from");
    if (fi >= 0 && p.inputs[fi].link != null) {
      const l = getLink(g, p.inputs[fi].link);
      const img = l && g.getNodeById(l.origin_id);
      if (img) {
        const minH = p.computeSize?.()[1] || p.size[1];
        const targetH = Math.max(img.size[1], minH);
        if (Math.abs(p.size[1] - targetH) > 1) {
          p.setSize ? p.setSize([p.size[0], targetH]) : (p.size[1] = targetH);
        }
      }
    }
  }
  const iw = Math.max(...imgs.map((n) => n.size[0]));
  const ih = Math.max(...imgs.map((n) => n.size[1])) + titleH;
  const px = x0 + iw + 40;

  // Read mode switches (71: intro/outro removed – only loop left)
  const w = (name) => node.widgets?.find((x) => x.name === name)?.value;
  const hasLoop = !!w("loop");
  const nImgs = imgs.length;
  const expected = (nImgs - 1) + (hasLoop ? 1 : 0);
  if (prs.length !== expected) {
    console.warn(`[InfiniteMovie] layout: expected ${expected} prompts, got ${prs.length}`);
  }

  // Sort prompts by their slot index on the Render node
  const prSorted = prs
    .map((p) => {
      let idx = 999;
      for (const inp of node.inputs || []) {
        if (!inp.name?.startsWith("shot_prompts.prompt") || inp.link == null) continue;
        const l = getLink(g, inp.link);
        if (l && l.origin_id === p.id) {
          idx = parseInt(/(\d+)$/.exec(inp.name)?.[1] ?? "999", 10); // "shot_prompts.prompt0" -> 0
          break;
        }
      }
      return { p, idx };
    })
    .sort((a, b) => a.idx - b.idx)
    .map((x) => x.p);

  // Stack prompts vertically with gap
  let y = y0;
  const promptPos = []; // {top, bottom, node}
  for (const p of prSorted) {
    const top = y;
    p.pos = [px, top];
    const bottom = top + titleH + p.size[1];
    promptPos.push({ top, bottom, node: p });
    y = bottom + gap;
  }

  // 57c: settings node far left in its own column BEFORE the images (user 2026-11-02).
  // Y position: middle of the prompt column, so the settings links run to the right
  // and do not cross the LoadImage→AutoPrompt/Render links.
  const snode = prSorted.length ? settingsNodeOf(prSorted[0]) : null;
  if (snode) {
    const promptMidY = y0 + (promptPos.length ? (promptPos[promptPos.length - 1].bottom - y0) / 2 : 0);
    snode.pos = [x0 - (snode.size[0] || 340) - 40, promptMidY - (snode.size[1] || 600) / 2];
  }

  // Position images by their real links (user 2026-11-01: every image the same way, incl. the first):
  // image centre on the gap between the prompt it ends (image_to) and the prompt it starts (image_from).
  // Index-based placement broke with intro/outro (prompt k is not the pair k -> k+1 then).
  const edges = (im) => {
    const from = [], to = [];
    for (const out of im.outputs || []) {
      for (const lid of out.links || []) {
        const l = getLink(g, lid);
        const pi = l ? promptPos.findIndex((pp) => pp.node.id === l.target_id) : -1;
        if (pi < 0) continue;
        const name = promptPos[pi].node.inputs?.[l.target_slot]?.name;
        if (name === "image_from") from.push(pi);
        else if (name === "image_to") to.push(pi);
      }
    }
    return { from, to };
  };
  const centers = imgs.map((im, k) => {
    const { from, to } = edges(im);
    // adjacent pair (ends prompt i, starts prompt i+1) -> centre on the gap between them
    for (const i of to) if (from.includes(i + 1)) return (promptPos[i].bottom + promptPos[i + 1].top) / 2;
    if (from.length) return promptPos[Math.min(...from)].top - gap / 2;    // first image (loop wrap ignored)
    if (to.length) return promptPos[Math.max(...to)].bottom + gap / 2;     // last image
    return y0 + k * (ih + gap) + ih / 2;                                   // not wired: plain stack
  });
  // promptPos top/bottom are body-top based (+titleH vs. the drawn box); pos is the body top, so the drawn
  // centre of an image (title included) lands on the centre when pos = c - size/2 - titleH/2.
  const imgY = (im, k) => centers[k] - im.size[1] / 2 - titleH / 2;
  // first image may reach above the start: move the whole column down instead of breaking the rule
  const shift = Math.max(0, y0 - Math.min(...imgs.map(imgY)));
  for (const pp of promptPos) pp.node.pos = [pp.node.pos[0], pp.node.pos[1] + shift];
  imgs.forEach((im, k) => { im.pos = [x0, imgY(im, k) + shift]; });

  if (group) {
    const right = Math.max(...all.map((n) => n.pos[0] + n.size[0]));
    const bottom = Math.max(...all.map((n) => n.pos[1] + n.size[1]));
    group.size = [right - group.pos[0] + 10, bottom - group.pos[1] + 15];
  }
  g.setDirtyCanvas(true, true);
}

// 57c: segment intersection of link endpoints (straight lines output→input).
// Exposed on window.__im_countCrossings for the browser test.
function _fcSegmentsIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function countCrossings(graph) {
  const links = [];
  const entries = typeof graph.links?.entries === "function" ? [...graph.links.entries()] : Object.entries(graph.links || {});
  for (const [id, l] of entries) {
    if (!l || !l.origin_id || !l.target_id) continue;
    const origin = graph.getNodeById(l.origin_id);
    const target = graph.getNodeById(l.target_id);
    if (!origin || !target) continue;
    const start = origin.getConnectionPos(false, l.origin_slot);
    const end = target.getConnectionPos(true, l.target_slot);
    if (!start || !end) continue;
    links.push({ start, end });
  }
  let count = 0;
  for (let i = 0; i < links.length; i++) {
    for (let j = i + 1; j < links.length; j++) {
      if (_fcSegmentsIntersect(links[i].start, links[i].end, links[j].start, links[j].end)) count++;
    }
  }
  return count;
}
window.__im_countCrossings = countCrossings;

// 57e: auto layout places the engine chains (Engine Start → model chain →
// 57c: one button instead of two – "🔗 AUTO LAYOUT" (user 2026-11-02).
export function slotIndex(node, name) {
  return (node.inputs || []).findIndex((i) => i.name === name);
}

function linkFrom(node, name) {
  const inp = node.inputs?.find((i) => i.name === name);
  const l = inp?.link != null ? getLink(node.graph, inp.link) : null;
  return l ? [node.graph.getNodeById(l.origin_id), l.origin_slot] : [null, 0];
}

export function addPromptForNewImage(chain, imgName) {
  const g = chain.graph;
  const n = parseInt(imgName.slice(IMG.length), 10);      // 0-based: new image = image n+1
  if (!(n >= 1)) return;
  // only for the rearmost image and only if its prompt slot is still free
  const wired = (chain.inputs || []).filter((i) => i.name?.startsWith(IMG) && i.link != null)
    .map((i) => parseInt(i.name.slice(IMG.length), 10));
  if (Math.max(...wired) !== n) return;
  const loop = !!chain.widgets?.find((w) => w.name === "loop")?.value;
  const [prevImg, prevSlot] = linkFrom(chain, IMG + (n - 1));
  const [newImg, newSlot] = linkFrom(chain, IMG + n);
  if (!prevImg || !newImg) return;
  const prompts = sources(chain, PR);
  const template = prompts[prompts.length - 1];
  const [closing] = linkFrom(chain, PR + (n - 1));          // with loop: so far "last -> 1"
  if (!loop && closing) return;                              // slot occupied -> do nothing
  const ap = LiteGraph.createNode("InfiniteMovieAutoPrompt");
  if (!ap) return;
  const last = prompts.reduce((a, p) => (!a || p.pos[1] > a.pos[1] ? p : a), null);
  const titleH = globalThis.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
  ap.pos = last ? [last.pos[0], last.pos[1] + last.size[1] + titleH + 20] : [chain.pos[0] - 420, chain.pos[1]];
  g.add(ap);
  if (last) ap.size = [last.size[0], ap.size[1]];
  prevImg.connect(prevSlot, ap, slotIndex(ap, "image_from"));
  newImg.connect(newSlot, ap, slotIndex(ap, "image_to"));
  if (loop && closing) {
    // closing prompt one back: start = new image, output = new last slot
    newImg.connect(newSlot, closing, slotIndex(closing, "image_from"));
    const outIdx = closing.outputs.findIndex((o) => o.name === "prompt");
    if (slotIndex(chain, PR + n) >= 0) closing.connect(outIdx, chain, slotIndex(chain, PR + n));
    const ov = closing.widgets?.find((w) => w.name === "prompt");
    if (ov) ov.value = "";                                   // old text fit the old start
  }
  const target = slotIndex(chain, PR + (n - 1));
  if (target >= 0) ap.connect(ap.outputs.findIndex((o) => o.name === "prompt"), chain, target);
  wireSettingsChain(chain);                                   // 57c2: slot the new AP into the settings chain
  g.setDirtyCanvas(true, true);
}

// Stale-Input-Cleanup (2026-10-28, Nutzer: "remove seconds0 and seconds1 inputs"):
// Saved workflows can contain inputs that no longer exist in the node definition
// (e.g. scene_seconds.seconds0/1 after the scene_seconds removal). The
// frontend does not remove them itself. We remove them on load (onConfigure) and on
// creation all UNWIRED inputs whose group/name is not in the definition
//. Wired inputs stay untouched (slot indices of links must not
// shift).
export function pruneStaleInputs(node) {
  // 57b2: the definition source is LiteGraph.registered_node_types[comfyClass].nodeData.
  // app.nodeDefs / LiteGraph.registeredNodes do NOT exist in frontend 1.57
  // (browser check 2026-11-01: app.nodeDefs undefined) – before, `def` was undefined,
  // `known` empty, and EVERY unconnected input was deleted on load
  // (on the director also `engine` + the prompt slots). nodeData (Gr class, from
  // /object_info) has input.required/optional with top-level keys (images,
  // shot_prompts, folder, engine, …).
  const def = globalThis.LiteGraph?.registered_node_types?.[node.comfyClass]?.nodeData;
  const known = new Set([
    ...Object.keys(def?.input?.required || {}),
    ...Object.keys(def?.input?.optional || {}),
  ]);
  // Guard: without a definition (or empty known) delete NOTHING.
  if (!def || known.size === 0) return;
  let removed = 0;
  const inputs = node.inputs || [];
  for (let i = inputs.length - 1; i >= 0; i--) {
    const inp = inputs[i];
    if (inp.link != null) continue; // wired: don't touch
    if (inp.widget) continue; // widget input: never delete
    const name = String(inp.name || "");
    const group = name.split(".")[0];
    if (!known.has(group) && !known.has(name)) {
      inputs.splice(i, 1);
      removed++;
    }
  }
  if (removed) {
    console.log(`[InfiniteMovie] removed ${removed} stale input(s) from ${node.comfyClass} #${node.id}`);
    node.setDirtyCanvas?.(true, true);
  }
}

// Loop switch (user 2026-10-28: "add a loop switch to the render interface that
// links the last and the first image and generates the prompt for it
// "): after toggling the chain reconciles immediately - ON creates the closing
// prompt (last -> first image) and generates its text as soon as it is still empty.
// Called ONLY from the loop widget callback, never when loading a workflow.
function genClosingPrompt(chain) {
  if (!chain.widgets?.find((w) => w.name === "loop")?.value) return;
  const g = chain.graph;
  if (!g) return;
  let best = null, bestIdx = -1;
  for (const n of g._nodes || []) {
    if (n.comfyClass !== "InfiniteMovieAutoPrompt") continue;
    const oi = (n.outputs || []).findIndex((o) => o.name === "prompt");
    if (oi < 0) continue;
    for (const lid of n.outputs[oi].links || []) {
      const l = getLink(g, lid);
      if (!l || l.target_id !== chain.id) continue;
      const key = slotKey(chain.inputs?.[l.target_slot]?.name);
      if (key && key[1] === 1 && key[0] > bestIdx) { bestIdx = key[0]; best = n; }
    }
  }
  if (!best) return;
  const ov = best.widgets?.find((w) => w.name === "prompt");
  if (ov && String(ov.value ?? "").trim()) return;   // text already present
  const btn = best._fcRegenBtn;
  if (!btn || btn.name?.startsWith("⏳")) return;
  btn.callback?.();                                   // "🔄 Regenerate prompt" (async, LLM)
}

// Chain reconcile (2026-10-28): the current ComfyUI frontend only stores
// WIRED sockets (widgets moved to widgets_values_named) and shifts the
// autogrow slots on load - links end up on wrong slots (e.g. negative -> image2) and
// prompt wiring is lost. reconcileChain restores the chain semantically:
//   1. release wrongly wired slots (image slot only from LoadImage, prompt slot only from AutoPrompt)
//   2. chain order = LoadImage nodes (id ascending) that hang on image slots or on
//      AutoPrompt image_from/image_to; rewire free image slots
//   3. per image pair (i -> i+1, with loop also last -> first) find the AutoPrompt; if missing,
//      reattach a non-matching (free) AutoPrompt or create a new one
//   4. create shot_prompts.prompt0..T-1; remove link data entries with out-of-range target slot
export function reconcileChain(chain) {
  const g = chain.graph;
  if (!g || chain._fcRec) return;
  chain._fcRec = true;
  chain._fcReady = false;
  try {
    // --- 1) falsch verkabelte Slots loesen ---
    const toDisconnect = [];
    for (const inp of chain.inputs || []) {
      const key = slotKey(inp.name);
      if (!key || inp.link == null) continue;
      const l = getLink(g, inp.link);
      const src = l ? g.getNodeById(l.origin_id) : null;
      const ok = key[1] === 0 ? (src && fcImgLink(g, l) && fcImgActive(g, src))
        : (src && src.comfyClass === "InfiniteMovieAutoPrompt" && fcActive(src));
      if (!ok) toDisconnect.push(inp.name);
    }
    for (const name of toDisconnect) _fcDisconnectByName(chain, name);
    // --- 1b) mute Auto Prompts on muted images, otherwise switch them on again ---
    for (const ap of g._nodes || []) {
      if (ap.comfyClass !== "InfiniteMovieAutoPrompt") continue;
      const srcs = ["image_from", "image_to"]
        .map((nm) => getLink(g, ap.inputs?.find((x) => x.name === nm)?.link))
        .map((l) => (l ? g.getNodeById(l.origin_id) : null))
        .filter(Boolean);
      const off = srcs.some((n) => !fcImgActive(g, n));
      ap.properties = ap.properties || {};
      if (off && fcActive(ap)) { ap.mode = 2; ap.properties.im_auto_muted = true; }
      else if (!off && ap.properties.im_auto_muted) { ap.mode = 0; delete ap.properties.im_auto_muted; }
      // loop on again: reclaim the muted closing AP (text kept)
      if (ap.properties.im_loop_off && chain.widgets?.find((w) => w.name === "loop")?.value) {
        ap.mode = 0; delete ap.properties.im_loop_off;
      }
    }
    // --- 2) determine chain images (root of the image chain ascending) ---
    const chainIds = new Set();
    const outSlot = new Map();   // source -> connected IMAGE output (Assemble › last_frame = 1 since 109)
    const addSrc = (l) => {
      if (!fcImgLink(g, l)) return;
      chainIds.add(l.origin_id);
      if (!outSlot.has(l.origin_id)) outSlot.set(l.origin_id, l.origin_slot);
    };
    for (const inp of chain.inputs || []) {
      if (!inp.name?.startsWith(IMG) || inp.link == null) continue;
      addSrc(getLink(g, inp.link));
    }
    // Auto Prompt sources only if their image chain is not already on the director (Load Image → Upscale → Director:
    // the APs still point at the Load Image – that is then NOT a second image, the APs get rewired below).
    const dirRoots = new Set([...chainIds].map((id) => fcImgRoot(g, g.getNodeById(id))?.id));
    for (const n of g._nodes || []) {
      if (n.comfyClass !== "InfiniteMovieAutoPrompt") continue;
      for (const inName of ["image_from", "image_to"]) {
        const l = getLink(g, n.inputs?.find((x) => x.name === inName)?.link);
        const o = l && g.getNodeById(l.origin_id);
        if (o && !chainIds.has(o.id) && dirRoots.has(fcImgRoot(g, o)?.id)) continue;
        addSrc(l);
      }
    }
    const chainNodes = [...chainIds]
      .map((id) => g.getNodeById(id))
      .filter((n) => n && fcImgActive(g, n))
      .sort(fcImgOrder(g));
    const slotOf = (n) => outSlot.get(n.id) ?? Math.max(0, (n.outputs || []).findIndex((o) => o.type === "IMAGE"));
    const N = chainNodes.length;
    const imgTpl = (chain.inputs || []).find((i) => i.name?.startsWith(IMG));
    const ensureSlot = (name, tpl) => {
      let idx = slotIndex(chain, name);
      if (idx >= 0) return idx;
      const base = tpl ? JSON.parse(JSON.stringify(tpl)) : { type: "STRING", shape: 7 };
      base.name = name;
      base.link = null;
      delete base.label;
      delete base.localized_name;
      chain.inputs.push(base);
      return chain.inputs.length - 1;
    };
    if (N > 0) {
      // --- 3) ensure image slots and wire them ---
      for (let i = 0; i < N; i++) {
        const idx = ensureSlot(IMG + i, imgTpl);
        const cur = getLink(g, chain.inputs[idx].link);
        if (cur && cur.origin_id === chainNodes[i].id) continue;
        if (chain.inputs[idx].link != null) chain.disconnectInput(idx);
        chainNodes[i].connect(slotOf(chainNodes[i]), chain, idx);
      }
      for (const inp of [...(chain.inputs || [])]) {
        const k = slotKey(inp.name);
        if (k && k[1] === 0 && k[0] >= N && inp.link != null) _fcDisconnectByName(chain, inp.name);
      }
      // --- 4) Prompt-Slots + AutoPrompt-Paare ---
      const loop = !!chain.widgets?.find((w) => w.name === "loop")?.value;
      // 71: intro/outro removed – T = (N-1) scenes + loop
      // 1 image: open shot (prompt without end image); with loop + return shot last image -> image (nodes.py n_segments)
      const T = N === 1 ? (loop ? 2 : 1) : (N - 1) + (loop ? 1 : 0);
      const prTpl = (chain.inputs || []).find((i) => i.name?.startsWith(PR));
      const aps = () => (g._nodes || []).filter((n) => n.comfyClass === "InfiniteMovieAutoPrompt");
      const srcOf = (ap, inName) => {
        const l = getLink(g, ap.inputs?.find((x) => x.name === inName)?.link);
        return l ? l.origin_id : null;
      };
      const outIdxOf = (ap) => (ap.outputs || []).findIndex((o) => o.name === "prompt");
      const wireAp = (ap, fromN, toN, slotIdx) => {
        const fi = slotIndex(ap, "image_from");
        const ti = slotIndex(ap, "image_to");
        for (const [idx, node] of [[fi, fromN], [ti, toN]]) {
          if (idx < 0) continue;
          if (!node) { if (ap.inputs[idx].link != null) ap.disconnectInput(idx); continue; } // offener Shot
          if (ap.inputs[idx].link != null) ap.disconnectInput(idx);
          node.connect(slotOf(node), ap, idx);
        }
        const oi = outIdxOf(ap);
        if (oi >= 0 && slotIdx >= 0) {
          if (ap.outputs[oi].links?.length) ap.disconnectOutput(oi);
          ap.connect(oi, chain, slotIdx);
        }
      };
      // Map slot index p → (fromImgIdx, toImgIdx)
      // 71: intro/outro removed – only scenes + loop
      const pairFor = (p) => {
        if (N === 1 && p === 0) return [0, -1];      // open shot: no end image (1 image, also with loop)
        if (loop && p === T - 1) return [N - 1, 0]; // loop: last → first
        return [p, p + 1];                          // scenes
      };
      const matched = new Set();
      // exakte Paare zuordnen
      for (let p = 0; p < T; p++) {
        const [fi, ti] = pairFor(p);
        const fromId = chainNodes[fi].id;
        const toId = chainNodes[ti]?.id ?? null;
        const ap = aps().find((a) => !matched.has(a.id) && fcActive(a)
          && srcOf(a, "image_from") === fromId && srcOf(a, "image_to") === toId);
        if (!ap) continue;
        matched.add(ap.id);
        const idx = ensureSlot(PR + p, prTpl);
        const cur = getLink(g, chain.inputs[idx].link);
        if (cur && cur.origin_id === ap.id) continue;
        wireAp(ap, chainNodes[fi], chainNodes[ti], idx);
      }
      // missing pairs: reattach a free AutoPrompt or create a new one
      const template = aps()[0] || null;
      for (let p = 0; p < T; p++) {
        const [fi, ti] = pairFor(p);
        const fromN = chainNodes[fi];
        const toN = chainNodes[ti] || null;
        if (aps().some((a) => matched.has(a.id)
          && srcOf(a, "image_from") === fromN.id && srcOf(a, "image_to") === (toN?.id ?? null))) continue;
        const idx = ensureSlot(PR + p, prTpl);
        let ap = aps().find((a) => !matched.has(a.id) && fcActive(a));
        if (!ap) {
          ap = LiteGraph.createNode("InfiniteMovieAutoPrompt");
          if (!ap) continue;
          g.add(ap);
          ap.properties = ap.properties || {};
          ap.properties.im_auto_created = true;   // may go away again once it becomes free
          const last = aps().filter((a) => a !== ap)
            .reduce((acc, a) => (!acc || a.pos[1] > acc.pos[1] ? a : acc), null);
          const titleH = globalThis.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
          ap.pos = last && last !== ap
            ? [last.pos[0], last.pos[1] + last.size[1] + titleH + 20]
            : [chain.pos[0] - 420, chain.pos[1]];
          if (last && last !== ap) ap.size = [last.size[0], ap.size[1]];   // 92: same width as the others
        }
        matched.add(ap.id);
        wireAp(ap, fromN, toN, idx);
        // Free AP (e.g. old intro AP) → clear the prompt so genClosingPrompt regenerates
        const ovW = ap.widgets?.find((x) => x.name === "prompt");
        if (ovW) ovW.value = "";
      }
      // --- 4b) disconnect APs from slots >= T (intro/outro/loop OFF → AP kept free)
      const toDisc4b = [];
      for (const ap of aps()) {
        const oi = outIdxOf(ap);
        if (oi < 0) continue;
        for (const lid of [...(ap.outputs[oi].links || [])]) {
          const l = getLink(g, lid);
          if (!l || l.target_id !== chain.id) continue;
          const key = slotKey(chain.inputs?.[l.target_slot]?.name);
          if (key && key[1] === 1 && key[0] >= T) { toDisc4b.push(chain.inputs[l.target_slot].name); break; }
        }
      }
      for (const name of toDisc4b) _fcDisconnectByName(chain, name);
      // --- 4c) remove self-created APs that became free again (e.g. after un-muting)
      for (const ap of [...aps()]) {
        if (!ap.properties?.im_auto_created || !fcActive(ap)) continue;
        if (!loop && srcOf(ap, "image_from") === chainNodes[N - 1].id
            && srcOf(ap, "image_to") === chainNodes[0].id) continue;   // closing AP: mute instead of delete
        const oi = outIdxOf(ap);
        const used = oi >= 0 && (ap.outputs[oi].links || []).some((lid) => getLink(g, lid)?.target_id === chain.id);
        if (!used) g.remove(ap);
      }
    }
    // --- 5) remove link data entries with out-of-range target slot (anti-loop) ---
    const links = g.links;
    const entries = typeof links?.entries === "function" ? [...links.entries()] : Object.entries(links || {});
    for (const [id, l] of entries) {
      if (!l || l.target_id !== chain.id) continue;
      if (l.target_slot >= (chain.inputs || []).length) {
        const src = g.getNodeById(l.origin_id);
        const out = src?.outputs?.[l.origin_slot];
        const numId = Number(id);
        if (out?.links) {
          const pos = out.links.indexOf(numId);
          if (pos >= 0) out.links.splice(pos, 1);
        }
        if (typeof links.delete === "function") links.delete(id); else delete links[id];
      }
    }
    interleave(chain);
    wireSettingsChain(chain);                                 // 57c2: rewire the chain after reconciliation
    const cw = chain.widgets?.find((w) => w.name === "image_count");   // 92: counter = active images
    if (cw && N > 0) cw.value = N;
    // image list (im_layers) one row per image: director height follows the count
    if (chain.widgets?.find((w) => w.name === "im_layers") && chain._fcLayN !== N) {
      chain._fcLayN = N;
      chain.setSize([chain.size[0], chain.computeSize()[1]]);
    }
    chain.setDirtyCanvas?.(true, true);
  } finally {
    chain._fcRec = false;
    chain._fcReady = true;
  }
}

// 57c: remove stale mode APs (71: only loop/closing left, intro/outro removed).
// After reconcileChain: free APs (not on chain prompt slots) belonging to disabled modes
// (closing) are removed. Links are cleaned up automatically via graph.remove
// (pitfall "graph.links Map" – graph.remove cleans up everything).
export function removeStaleModeAPs(chain) {
  const g = chain.graph;
  if (!g) return;
  const w = (name) => chain.widgets?.find((x) => x.name === name)?.value;
  const hasLoop = !!w("loop");
  // Determine chain images (like reconcileChain step 2)
  const chainIds = new Set();
  for (const inp of chain.inputs || []) {
    if (!inp.name?.startsWith(IMG) || inp.link == null) continue;
    const l = getLink(g, inp.link);
    if (fcImgLink(g, l)) chainIds.add(l.origin_id);
  }
  const dirRoots = new Set([...chainIds].map((id) => fcImgRoot(g, g.getNodeById(id))?.id));
  for (const n of g._nodes || []) {
    if (n.comfyClass !== "InfiniteMovieAutoPrompt") continue;
    for (const inName of ["image_from", "image_to"]) {
      const l = getLink(g, n.inputs?.find((x) => x.name === inName)?.link);
      const o = l && g.getNodeById(l.origin_id);
      if (o && !chainIds.has(o.id) && dirRoots.has(fcImgRoot(g, o)?.id)) continue;
      if (fcImgLink(g, l)) chainIds.add(l.origin_id);
    }
  }
  const chainNodes = [...chainIds]
    .map((id) => g.getNodeById(id))
    .filter((n) => n && fcImgActive(g, n))
    .sort(fcImgOrder(g));
  const N = chainNodes.length;
  if (N < 2) return;
  const firstImg = chainNodes[0].id;
  const lastImg = chainNodes[N - 1].id;
  // APs hanging on chain prompt slots (in use)
  const connectedApIds = new Set();
  for (const inp of chain.inputs || []) {
    if (!inp.name?.startsWith(PR) || inp.link == null) continue;
    const l = getLink(g, inp.link);
    if (l) connectedApIds.add(l.origin_id);
  }
  // Iterate a copy, because g.remove(ap) modifies the array
  const apsToRemove = [];
  for (const ap of [...(g._nodes || [])]) {
    if (ap.comfyClass !== "InfiniteMovieAutoPrompt") continue;
    if (connectedApIds.has(ap.id)) continue; // still in use
    if (!fcActive(ap)) continue;              // muted (image off) – keep the prompt
    const fromId = getLink(g, ap.inputs?.find((x) => x.name === "image_from")?.link)?.origin_id;
    const toId = getLink(g, ap.inputs?.find((x) => x.name === "image_to")?.link)?.origin_id;
    let role = null;
    if (fromId === lastImg && toId === firstImg) role = "closing";
    if (!role) continue;
    const disabled = role === "closing" && !hasLoop;
    if (disabled) apsToRemove.push({ap, role});
  }
  // user 2026-11-04 ("when switching loop prompts are deleted"): mute instead of delete,
  // the text stays; loop on reclaims it in reconcileChain 1b.
  for (const {ap} of apsToRemove) {
    ap.mode = 2;
    ap.properties = ap.properties || {};
    ap.properties.im_loop_off = true;
  }
  if (apsToRemove.length) wireSettingsChain(chain);           // 57c2: bridge the chain over removed APs
  chain.setDirtyCanvas?.(true, true);
}

// Widget hook for loop (idempotent, after configure)
export function _fcSetupWidgetHooks(node) {
  if (node._fcWidgetsHooked) return;
  node._fcWidgetsHooked = true;
  for (const wName of ["loop"]) {
    const w = node.widgets?.find((x) => x.name === wName);
    if (!w || w["_fc" + wName + "Hook"]) continue;
    w["_fc" + wName + "Hook"] = true;
    const origCb = w.callback;
    w.callback = function (...args) {
      const r = origCb?.apply(this, args);
      if (!node._fcReady) return r;
      clearTimeout(node._fcRecT);
      node._fcRecT = setTimeout(() => {
        reconcileChain(node);
        removeStaleModeAPs(node);
        genClosingPrompt(node);
        layoutPrompts(node);
      }, 150);
      return r;
    };
  }
}

// Disconnect by name (robust against autogrow index shift)
function _fcDisconnectByName(node, inputName) {
  const idx = (node.inputs || []).findIndex((i) => i.name === inputName);
  if (idx < 0) return;
  const linkId = node.inputs[idx]?.link;
  if (linkId == null) return;
  const g = node.graph;
  g.beforeChange?.();
  try {
    node.disconnectInput(idx);
    if (g.removeLink) g.removeLink(Number(linkId));
    else if (g.links?.delete) g.links.delete(Number(linkId));
  } finally {
    g.afterChange?.();
  }
  node.setDirtyCanvas?.(true, true);
}

