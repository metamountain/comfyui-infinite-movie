// Infinite Movie · workflow layout. Called from the "🔗 AUTO LAYOUT" button on the Director
// (web/infinite_movie.js → window.fcWorkflowLayout).
//
// User 2026-11-03 ("engine at the very top", "help always in the middle above the fields", "box at the front separately"):
//                 ┌ 1 ENGINE (help centered on top, content as a block) ┐
//                 └─────────────────────────────────────────────────┘
//   ┌ 0 README ┐  ┌ 2 Settings ┐┌ 3 Images ┐┌ 4 Prompts ┐┌ 5 Director ┐┌ 6 Choose ┐┌ 7 Assemble + Film ┐┌ 8 Upscale ┐
//   │          │  │  help      ││  help    ││  help     ││  help      ││  help    ││  help             │  ← ONE row
//   └──────────┘  │  Nodes     ││  Nodes   ││  Nodes    ││  Nodes     ││  Nodes   ││  Nodes            │
// Each help note "Help: N · …" sits centered on top INSIDE its group "N · …". Notes without a matching group
// stay with the README. Anchor: x = README group, y = top edge of the engine.
import { app } from "../../scripts/app.js";

const T = 30;        // node title bar
const HEAD = 64;     // group header: title (32) + room for the node badge (#id …)
const PAD = 20;      // margin left/right/bottom
const GAP = 40;      // between groups
const NGAP = 40;     // between nodes in a group
const MINW = 420;    // minimum width of a group

const inRect = (n, r) => n.pos[0] >= r[0] - 5 && n.pos[1] >= r[1] - 5 && n.pos[0] < r[0] + r[2] && n.pos[1] < r[1] + r[3];
const gRect = (g) => [g.pos[0], g.pos[1], g.size[0], g.size[1]];
const findGroup = (groups, re) => groups.find((g) => re.test(g.title || ""));
const isEngineGroup = (g) => /ENGINE/i.test(g.title || "");
const isNote = (n) => /Note/i.test(n.type || "");
const isHelp = (n) => /^\s*help/i.test(n.title || "");
// "Help: 4 · Prompts" / "4 · Prompts" → number 4 and key "prompts"
const numOf = (t) => { const m = /(\d+)/.exec(t || ""); return m ? +m[1] : null; };
const keyOf = (t) => (t || "").replace(/^\s*help\s*:?/i, "").replace(/[\d·:.\-]+/g, " ").trim().toLowerCase();
const helpFits = (note, grp) => {
  const a = numOf(note.title), b = numOf(grp.title);
  if (a != null && b != null) return a === b;
  return keyOf(note.title) === keyOf(grp.title);
};

function linkedOrigins(g, node, prefix) {
  // Origin nodes of the prefix.* inputs in slot order (images.image0.. / shot_prompts.prompt0..)
  const out = [];
  for (const inp of node.inputs || []) {
    if (!inp.name?.startsWith(prefix) || inp.link == null) continue;
    const l = g.links?.[inp.link] ?? g.links?.get?.(inp.link);
    const o = l && g.getNodeById(l.origin_id);
    if (o && !out.includes(o)) out.push(o);
  }
  return out;
}

// 2026-11-08: image chain of a source upstream (Load Image → Upscale Crop Universal → … → source), only via
// IMAGE inputs and without core nodes; order root first.
function imageRow(g, src, core) {
  const row = [src];
  let n = src;
  for (let d = 0; d < 20; d++) {
    const inp = (n.inputs || []).find((i) => i.type === "IMAGE" && i.link != null);
    const l = inp && (g.links?.[inp.link] ?? g.links?.get?.(inp.link));
    const o = l && g.getNodeById(l.origin_id);
    if (!o || core.has(o.comfyClass) || row.includes(o)) break;
    row.unshift(o);
    n = o;
  }
  return row;
}

// Height of the help block on top in a group (title bar + note + spacing)
const helpH = (help) => (help ? T + help.size[1] + NGAP : 0);

// Group: help centered on top, below it nodes one under another (stack) or side by side (side).
function colSize(nodes, side, help) {
  const hw = help ? help.size[0] : 0;
  if (!nodes.length) return [Math.max(MINW, hw + 2 * PAD), HEAD + (help ? T + help.size[1] : 0) + PAD];
  if (side) {
    const w = nodes.reduce((s, n) => s + n.size[0], 0) + PAD * (nodes.length - 1);
    return [Math.max(MINW, w + 2 * PAD, hw + 2 * PAD), HEAD + helpH(help) + T + Math.max(...nodes.map((n) => n.size[1])) + PAD];
  }
  const w = Math.max(...nodes.map((n) => n.size[0]));
  const h = HEAD + helpH(help) + nodes.reduce((s, n) => s + T + n.size[1], 0) + NGAP * (nodes.length - 1) + PAD;
  return [Math.max(MINW, w + 2 * PAD, hw + 2 * PAD), h];
}

function placeCol(nodes, side, help, x, y, w) {
  if (help) help.pos = [x + (w - help.size[0]) / 2, y + HEAD + T];
  const top0 = y + HEAD + helpH(help);
  if (side) {
    let nx = x + PAD;
    for (const n of nodes) { n.pos = [nx, top0 + T]; nx += n.size[0] + PAD; }
    return;
  }
  let top = top0;
  for (const n of nodes) { n.pos = [x + PAD, top + T]; top += T + n.size[1] + NGAP; }
}

export function fcWorkflowLayout(director, second = false) {
  const g = director?.graph || app.graph;
  if (!g) return;
  // Cleanup: remove auto prompts whose prompt output is no longer connected (image removed).
  // Muted ones stay (image muted / loop off): they keep their text for later (user 2026-11-04).
  for (const ap of (g._nodes || []).filter((n) => n.comfyClass === "InfiniteMovieAutoPrompt" && (n.mode ?? 0) === 0)) {
    const out = (ap.outputs || []).find((o) => o.name === "prompt");
    if (out && !(out.links || []).length) g.remove(ap);
  }
  // Adapt Choose to the current shot count, then measure.
  if (window.fcChooseRefreshAll) window.fcChooseRefreshAll();
  const groups = g._groups || [];
  const engines = groups.filter(isEngineGroup);
  // Core nodes NEVER belong to the engine, even if they currently sit over an engine group.
  const CORE = new Set(["InfiniteMovieSettings", "InfiniteMovieStoryMode", "InfiniteMovieStyle", "InfiniteMovieAutoPrompt", "InfiniteMovieRender",
    "InfiniteMovieChooser", "InfiniteMovieAssemble", "InfiniteMovieFilm"]);
  // Image sources (without core nodes like Assemble > last_frame - those stay in their group) plus their image chain
  const imgRows = linkedOrigins(g, director, "images.").filter((n) => !CORE.has(n.comfyClass))
    .map((src) => imageRow(g, src, CORE));
  // A node feeding several images (e.g. a Load Image before two upscalers) appears only in the first row.
  { const seen = new Set();
    for (let i = 0; i < imgRows.length; i++) {
      imgRows[i] = imgRows[i].filter((n, j, r) => j === r.length - 1 || !seen.has(n));
      imgRows[i].forEach((n) => seen.add(n));
    }
    for (let i = imgRows.length - 1; i >= 0; i--) if (seen.size && imgRows.slice(0, i).some((r) => r.at(-1) === imgRows[i].at(-1))) imgRows.splice(i, 1); }
  const coreImages = new Set(imgRows.flat());
  const allNotes = (g._nodes || []).filter(isNote);
  const engineHelp = engines.map((e) => allNotes.find((n) => isHelp(n) && helpFits(n, e)) || null);
  const inEngine = (n) => !CORE.has(n.comfyClass) && !coreImages.has(n) && !isNote(n)
    && engines.some((e) => inRect(n, gRect(e)));
  // Determine members BEFORE any moving (the engine lands where something else used to be).
  const engineMembers = engines.map((e) => (g._nodes || []).filter((n) => inEngine(n) && inRect(n, gRect(e))));
  // 8 Upscale (optional, B3 2026-11-04): block like the engine, members determined BEFORE moving.
  const upGrp = groups.find((x) => !isEngineGroup(x) && /upscale/i.test(x.title || ""));
  const upMembers = upGrp ? (g._nodes || []).filter((n) => !isNote(n) && !inEngine(n) && !coreImages.has(n) && inRect(n, gRect(upGrp))) : [];
  const upHelp = upGrp ? allNotes.find((n) => isHelp(n) && helpFits(n, upGrp)) || null : null;
  const upSet = new Set(upMembers);
  // 9 Movie to GIF (optional, 2026-11-13): right of Upscale, help on top, the GIF node(s) below.
  const gifGrp = groups.find((x) => !isEngineGroup(x) && /gif/i.test(x.title || ""));
  const gifHelp = gifGrp ? allNotes.find((n) => isHelp(n) && helpFits(n, gifGrp)) || null : null;
  const gifNodes = (g._nodes || []).filter((n) => (n.comfyClass || n.type) === "InfiniteMovieGif" && !inEngine(n) && !upSet.has(n));
  const nodes = (g._nodes || []).filter((n) => !inEngine(n) && !upSet.has(n));
  const byType = (t) => nodes.filter((n) => n.comfyClass === t || n.type === t);

  const prompts = linkedOrigins(g, director, "shot_prompts.");
  for (const p of byType("InfiniteMovieAutoPrompt")) if (!prompts.includes(p)) prompts.push(p);
  const G = (re) => findGroup(groups.filter((x) => !isEngineGroup(x)), re);
  // 2026-11-13 (user: "the finished film below in our Film node, the same in 6 7 8", "6 7 8 all players square, 6 7 8
  // the same width"): Cut / Even Motion / Upscale on top, a Film node with a SQUARE player at the bottom of each group;
  // groups 6, 7, 8 share one inner width (the widest of Cut, Even Motion, the Upscale block).
  // comfyClass || type: nodes created at runtime (LiteGraph.createNode) can lack comfyClass
  const cls = (n) => n?.comfyClass || n?.type;
  const isFilm = (n) => cls(n) === "InfiniteMovieFilm";
  const upBlock = upMembers.filter((n) => !isFilm(n)), upFilms = upMembers.filter(isFilm);
  const linkAt = (id) => g.links?.[id] ?? g.links?.get?.(id);
  const filmSrc = (f) => { const i = (f.inputs || []).find((x) => x.link != null); const l = i && linkAt(i.link); return l ? g.getNodeById(l.origin_id) : null; };
  const allFilms = byType("InfiniteMovieFilm");
  const cutFilms = allFilms.filter((f) => cls(filmSrc(f)) === "InfiniteMovieChooser");
  const asmFilms = allFilms.filter((f) => !cutFilms.includes(f));
  const asm = byType("InfiniteMovieAssemble"), cut = byType("InfiniteMovieChooser");
  const blockW = upBlock.length ? Math.max(...upBlock.map((n) => n.pos[0] + n.size[0])) - Math.min(...upBlock.map((n) => n.pos[0])) : 0;
  // user 2026-11-13: "after 6 the work is done, 7 8 are extras" -> Cut (group 6) alone sets the width of 6-9;
  // a wider Upscale block only widens group 8 itself
  const inner678 = Math.max(MINW - 2 * PAD, ...cut.map((n) => n.size[0]));
  for (const a of asm) a.size = [inner678, a.computeSize()[1]];
  // square player: width first, then the height follows from the Film node's getMinHeight (side = width - 20)
  for (const f of [...cutFilms, ...asmFilms, ...upFilms]) { f.size = [inner678, f.size[1]]; f.size = [inner678, f.computeSize()[1]]; }
  // ONE row, order = numbers 2…7
  // 2026-11-11: help note "Story Mode …" sits right under the Story Mode node (not with the README)
  const storyHelp = byType("InfiniteMovieStoryMode").length ? allNotes.filter((n) => /story mode/i.test(n.title || "")) : [];
  const row = [
    [G(/settings/i), [...byType("InfiniteMovieSettings"), ...byType("InfiniteMovieStoryMode"), ...storyHelp]],
    [G(/images/i), imgRows.flat()],
    [G(/prompt/i), [...byType("InfiniteMovieStyle"), ...prompts]],
    [G(/director/i), [director]],
    // user 2026-11-13 ("widen 6, double it - the bottom edge of the 4 images is the bottom edge"): Cut and its preview
    // side by side, so group 6 is no taller than the image column
    [G(/cut|choose/i), [...cut, ...cutFilms], true],
    [G(/even motion|assemble/i), [...asm, ...asmFilms], false],
  ];
  const used = new Set([...engineHelp, upHelp, gifHelp, ...storyHelp].filter(Boolean));
  const rowHelp = row.map(([grp]) => {
    const h = grp && allNotes.find((n) => isHelp(n) && !used.has(n) && helpFits(n, grp));
    if (h) used.add(h);
    return h || null;
  });
  // README group: README + all notes without their own group, one under another
  const readme = G(/readme/i);
  const restNotes = allNotes.filter((n) => !used.has(n))
    .sort((a, b) => (/readme/i.test(b.title || "") ? 1 : 0) - (/readme/i.test(a.title || "") ? 1 : 0));

  // Anchor: x = README group (otherwise the settings/first group of the row), y = top edge of the engine (very top)
  const anchor = readme || row.find(([grp]) => grp)?.[0];
  const XR = anchor ? anchor.pos[0] : director.pos[0] - PAD;
  const TOP = engines.length ? Math.min(...engines.map((e) => e.pos[1])) : (anchor ? anchor.pos[1] : director.pos[1] - T - HEAD);
  const [rw, rh] = colSize(restNotes, false, null);
  const X0 = (readme || restNotes.length) ? XR + rw + GAP : XR;

  // 1 Engine at the very top: groups side by side, help centered on top, content as a block below
  let Y = TOP;
  if (engines.length) {
    let ex = X0, HE = 0;
    // user 2026-11-13 ("compress the engine"): help on the LEFT, the nodes in columns by data flow (column = longest
    // chain of links from an engine-internal source: loaders -> Engine In -> sampler -> decode -> Engine Out), each
    // column stacked top-down. Height = max(help, tallest column) instead of help + hand-made block.
    engines.forEach((e, k) => {
      const ms = engineMembers[k], help = engineHelp[k];
      const set = new Set(ms), depth = new Map();
      const dep = (n, guard = 0) => {
        if (depth.has(n)) return depth.get(n);
        if (guard > 40) return 0;
        let d = 0;
        for (const i of n.inputs || []) {
          if (i.link == null) continue;
          const l = g.links?.[i.link] ?? g.links?.get?.(i.link);
          const o = l && g.getNodeById(l.origin_id);
          if (o && set.has(o) && o !== n) d = Math.max(d, dep(o, guard + 1) + 1);
        }
        depth.set(n, d);
        return d;
      };
      ms.forEach((n) => dep(n));
      const cols = [];
      for (const n of [...ms].sort((a, b) => a.pos[1] - b.pos[1])) (cols[depth.get(n)] ||= []).push(n);
      const used = cols.filter(Boolean);
      const helpW = help ? help.size[0] + PAD : 0;
      let cx = ex + PAD + helpW, bh = 0;
      for (const c of used) {
        let cy = TOP + HEAD + T;
        for (const n of c) { n.pos = [cx, cy]; cy += n.size[1] + NGAP + T; }
        bh = Math.max(bh, cy - NGAP - T - (TOP + HEAD));
        cx += Math.max(...c.map((n) => n.size[0])) + PAD;
      }
      const w = Math.max(MINW, cx - ex);
      const h = HEAD + Math.max(help ? T + help.size[1] : 0, bh) + PAD;
      if (help) help.pos = [ex + PAD, TOP + HEAD + T];
      e.pos = [ex, TOP]; e.size = [w, h];
      ex += w + GAP; HE = Math.max(HE, h);
    });
    Y = TOP + HE + GAP;
  }

  // 2…7 ONE row, same height, help centered on top each. Images: one row per image (chain side by side).
  // 2026-11-11 (user: "help notes on top all the same height, same margin"): one height for all help notes of the
  // row (2…8) = the tallest; width = group width minus PAD on both sides (set after the widths are known).
  const rowHelps = [...rowHelp, upHelp].filter(Boolean);
  const HH = rowHelps.length ? Math.max(...rowHelps.map((h) => h.size[1])) : 0;
  // the help never makes a group wider: the nodes set the width, the help is stretched to it afterwards
  for (const h of rowHelps) h.size = [MINW - 2 * PAD, HH];
  const rowW = (r) => r.reduce((s, n) => s + n.size[0], 0) + PAD * (r.length - 1);
  const rowH = (r) => T + Math.max(...r.map((n) => n.size[1]));
  const sizes = row.map(([, ns, side], k) => {
    if (k !== 1 || !imgRows.length) return colSize(ns, side, rowHelp[k]);
    const help = rowHelp[k];
    const w = Math.max(MINW, ...imgRows.map((r) => rowW(r) + 2 * PAD), (help ? help.size[0] : 0) + 2 * PAD);
    const h = HEAD + helpH(help) + imgRows.reduce((s, r) => s + rowH(r), 0) + NGAP * (imgRows.length - 1) + PAD;
    return [w, h];
  });
  // user 2026-11-13 ("groups modular, 2 or 3 widths, no more"; "5 as wide as 4"): one module width U = a Cut column
  // (Cut node + margins). 2 Settings, 4 Prompts, 5 Director, 7, 8, 9 are U wide, 6 Cut (Cut + preview side by side)
  // is 2U + GAP, only 3 Images keeps its own narrow width. The nodes of a U column are stretched to fill it.
  const U = Math.max(inner678 + 2 * PAD, sizes[0][0], sizes[2][0], sizes[3][0]);
  for (const k of [0, 2, 3]) {
    sizes[k][0] = U;
    for (const n of row[k][1]) if (!isHelp(n)) n.size = [U - 2 * PAD, n.size[1]];
  }
  sizes[4][0] = Math.max(sizes[4][0], 2 * U + GAP);
  // user 2026-11-13 ("2 3 4 the same"): 3 Images is U wide too; a row with a single node (Load Image) fills it
  if (imgRows.length) {
    sizes[1][0] = Math.max(sizes[1][0], U);
    for (const r of imgRows) if (r.length === 1) r[0].size = [U - 2 * PAD, r[0].size[1]];
  }
  // user 2026-11-13 ("1 wider"): the engine on top spans groups 2-5 (4U + 3 GAP); help stays on the left
  for (const [k, e] of engines.entries()) {
    if (engines.length !== 1) break;
    const w = Math.max(e.size[0], 4 * U + 3 * GAP);
    e.size = [w, e.size[1]];
  }
  row.forEach((_, k) => { const h = rowHelp[k]; if (h) h.size = [sizes[k][0] - 2 * PAD, HH]; });
  let x = X0;
  row.forEach(([grp, ns, side], k) => {
    if (!ns.length && !grp) return;
    if (k === 1 && imgRows.length) {
      const help = rowHelp[k];
      if (help) help.pos = [x + (sizes[k][0] - help.size[0]) / 2, Y + HEAD + T];
      let top = Y + HEAD + helpH(help);
      for (const r of imgRows) {
        let nx = x + PAD;
        for (const n of r) { n.pos = [nx, top + T]; nx += n.size[0] + PAD; }
        top += rowH(r) + NGAP;
      }
    } else {
      placeCol(ns, side, rowHelp[k], x, Y, sizes[k][0]);
    }
    if (grp) grp.pos = [x, Y];
    x += sizes[k][0] + GAP;
  });

  // Prompt k exactly between image k and image k+1 (loop prompt n→1 half a step below the last image):
  // so you can read the transition directly (user 2026-11-03: "exactly between the images ... important").
  const imgs = imgRows.map((r) => r[r.length - 1]);   // source per row (the prompts align to it)
  const linkedPrompts = linkedOrigins(g, director, "shot_prompts.");
  if (imgs.length >= 2 && linkedPrompts.length) {
    const mid = (n) => n.pos[1] + (n.size[1] - T) / 2;          // middle of the box incl. title bar
    const c = imgs.map(mid);
    const step = c[1] - c[0];
    linkedPrompts.forEach((p, k) => {
      const target = k + 1 < c.length ? (c[k] + c[k + 1]) / 2 : c[c.length - 1] + step / 2;
      p.pos = [p.pos[0], target - (p.size[1] - T) / 2];
    });
    // Prompt Style sits on top of the prompt column: move images + prompts down enough so nothing overlaps.
    const style = byType("InfiniteMovieStyle")[0];
    if (style) {
      const need = style.pos[1] + style.size[1] + NGAP + T;
      const shift = Math.max(0, need - Math.min(...linkedPrompts.map((p) => p.pos[1])));
      if (shift) for (const n of [...imgRows.flat(), ...linkedPrompts]) n.pos = [n.pos[0], n.pos[1] + shift];
    }
  }
  // user 2026-11-13 ("the bottom edge of the 4 images is the bottom edge"): if the Settings column (Story Mode with its
  // big text fields) reaches lower than images + prompts, Story Mode gets shorter (min 400) instead of the row taller.
  const story = byType("InfiniteMovieStoryMode")[0];
  if (story && imgRows.length && row[0][0]) {
    const b12 = Math.max(...[...imgRows.flat(), ...prompts].map((n) => n.pos[1] + n.size[1]));
    const b0 = Math.max(...row[0][1].map((n) => n.pos[1] + n.size[1]));
    if (b0 > b12) {
      story.size = [story.size[0], Math.max(400, story.size[1] - (b0 - b12))];
      sizes[0] = [sizes[0][0], colSize(row[0][1], row[0][2], rowHelp[0])[1]];
      placeCol(row[0][1], row[0][2], rowHelp[0], row[0][0].pos[0], Y, sizes[0][0]);
    }
  }
  // 6: the preview sits at the right edge of the double-width group
  if (row[4][0]) for (const f of cutFilms) f.pos = [row[4][0].pos[0] + sizes[4][0] - PAD - f.size[0], f.pos[1]];
  // Group height from the real content (prompts can reach below the last image)
  const bottom = Math.max(...row.flatMap(([, ns]) => ns.map((n) => n.pos[1] + n.size[1])));
  // Upscale content (block + Film players below) also counts, so 8 has exactly the height of the row (user: "7-8 the
  // same height as everything")
  let upNeed = 0;
  if (upGrp && upMembers.length) {
    const ms = upBlock.length ? upBlock : upMembers;
    const blockH = Math.max(...ms.map((n) => n.pos[1] + n.size[1])) - Math.min(...ms.map((n) => n.pos[1] - T));
    upNeed = HEAD + helpH(upHelp) + blockH + (upBlock.length ? upFilms.reduce((s, f) => s + NGAP + T + f.size[1], 0) : 0) + PAD;
  }
  // 9 GIF: width = 6/7/8 (square preview), its full height counts for the row height too
  let gifNeed = 0;
  if (gifGrp && gifNodes.length) {
    for (const n of gifNodes) { n.size = [inner678, n.size[1]]; n.size = [inner678, n.computeSize()[1]]; }
    gifNeed = HEAD + helpH(gifHelp) + gifNodes.reduce((s, n) => s + T + n.size[1] + NGAP, 0) + PAD;
  }
  const H = Math.max(...sizes.map((s) => s[1]), bottom - Y + PAD, upNeed, gifNeed);
  row.forEach(([grp, ns], k) => { if (grp && (ns.length || grp)) grp.size = [sizes[k][0], H]; });
  // Film player(s) of 6 and 7 sit at the bottom edge of their group (user: "films at the bottom")
  for (const fs of [cutFilms, asmFilms]) { let b = Y + H - PAD; for (const f of [...fs].reverse()) { f.pos = [f.pos[0], b - f.size[1]]; b -= T + f.size[1] + NGAP; } }
  // 8 Upscale right of 7, content as a block, help centered on top, same height as the row
  if (upGrp && upMembers.length) {
    // block = loaders + upscaler as they are arranged; the Film player(s) below it (same width as group 7)
    const ms = upBlock.length ? upBlock : upMembers;
    const minX = Math.min(...ms.map((n) => n.pos[0])), minY = Math.min(...ms.map((n) => n.pos[1] - T));
    const maxY = Math.max(...ms.map((n) => n.pos[1] + n.size[1]));
    const w = Math.max(MINW, inner678 + 2 * PAD, blockW + 2 * PAD);
    if (upHelp) upHelp.size = [w - 2 * PAD, HH];
    if (upHelp) upHelp.pos = [x + (w - upHelp.size[0]) / 2, Y + HEAD + T];
    const dx = x + PAD - minX, dy = Y + HEAD + helpH(upHelp) - minY;
    for (const n of ms) n.pos = [n.pos[0] + dx, n.pos[1] + dy];
    // Film player(s) at the bottom edge, level with the one in 7
    let b = Y + H - PAD;
    for (const f of upBlock.length ? [...upFilms].reverse() : []) { f.pos = [x + PAD, b - f.size[1]]; b -= T + f.size[1] + NGAP; }
    upGrp.pos = [x, Y];
    upGrp.size = [w, H];
  }
  // 9 Movie to GIF right of 8 (or of 7 without Upscale): help on top, GIF node(s) one under another, row height
  if (gifGrp && gifNodes.length) {
    const gx = upGrp && upMembers.length ? upGrp.pos[0] + upGrp.size[0] + GAP : x;
    // user 2026-11-13: "4 equal squares, 3x video, 1x image preview" -> same width as 6/7/8, the GIF node (square
    // preview at its bottom) sits at the bottom edge of the group, level with the Film players
    const w = Math.max(MINW, inner678 + 2 * PAD);
    if (gifHelp) { gifHelp.size = [w - 2 * PAD, HH]; gifHelp.pos = [gx + PAD, Y + HEAD + T]; }
    // user 2026-11-13 ("make the gif node big"): settings start under the help, the (last) GIF node is stretched to the
    // bottom edge - its preview sits at the bottom of the node, level with the Film players
    let gy = Y + HEAD + helpH(gifHelp) + T;
    gifNodes.forEach((n, k) => {
      if (k === gifNodes.length - 1) n.size = [inner678, Math.max(n.size[1], Y + H - PAD - gy)];
      n.pos = [gx + PAD, gy]; gy += n.size[1] + NGAP + T;
    });
    gifGrp.pos = [gx, Y];
    gifGrp.size = [w, H];
  }

  // 0 README at the front, separate, at the height of the row
  if (readme || restNotes.length) {
    placeCol(restNotes, false, null, XR, Y, rw);
    if (readme) { readme.pos = [XR, Y]; readme.size = [rw, rh]; }
  }

  g.setDirtyCanvas?.(true, true);
  console.log("[InfiniteMovie] layout: README left / engine top / row 2-7 with help", { XR, X0, TOP, Y, H, second });
  // Second pass: newly created nodes (e.g. auto prompts) only get their real height after the
  // first draw - without re-measuring they overlap.
  if (!second) setTimeout(() => fcWorkflowLayout(director, true), 250);
}

window.fcWorkflowLayout = fcWorkflowLayout;
