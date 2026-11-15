// Infinite Movie · workflow layout. Called from the "🔗 AUTO LAYOUT" button on the Director
// (imported by web/im_director.js).
//
// User 2026-11-03 ("engine at the very top", "help always in the middle above the fields", "box at the front separately"),
// 2026-11-13 ("README outside the groups, without a group, Settings 1, engine 0, README as tall as the groups"):
//                 ┌ 0 ENGINE (help on the left, nodes in columns) ┐
//                 └───────────────────────────────────────────────┘
//    README       ┌ 1 Settings ┐┌ 2 Images ┐┌ 3 Prompts ┐┌ 4 Director ┐┌ 5 Cut ┐┌ 6 Even Motion + Film ┐┌ 7 Upscale ┐┌ 8 GIF ┐
//   (no group,    │  help      ││  help    ││  help     ││  help      ││  help ││  help                │  ← ONE row
//    row height)  │  Nodes     ││  Nodes   ││  Nodes    ││  Nodes     ││  Nodes││  Nodes               │
// Each help note "Help: N · …" sits on top INSIDE its group "N · …". Notes without a matching group stack on the
// left like the README. Anchor: x = README note, y = top edge of the engine.
import { app } from "../../scripts/app.js";
import { fcChooseRefreshAll } from "./im_cut_state.js";
import { filmAspect, filmSquare } from "./im_viewer.js";

const T = 30;        // node title bar
const HEAD = 70;     // group header: title (32) + room for the node badge (#id …)
const PAD = 20;      // margin left/right/bottom
const GAP = 40;      // between groups
const NGAP = 40;     // between nodes in a group
const MINW = 420;    // minimum width of a group
// user 2026-11-15 ("graph and players maximised to the format, height variable, width fixed"): one fixed width for
// every player column (Cut's preview + analysis, Even Motion, Upscale, GIF) - variants only widen Cut itself
const PLAYER_W = 600;
// user 2026-11-15 ("everything on a simple grid, no rounding errors"): every constant above is a multiple of R, node
// sizes are rounded UP to it (csH), positions snapped - edges that should meet meet exactly.
const R = 10;
const up = (v) => Math.ceil(v / R) * R;
const snap = (v) => Math.round(v / R) * R;
const csH = (n) => up(n.computeSize()[1]);

const inRect = (n, r) => n.pos[0] >= r[0] - 5 && n.pos[1] >= r[1] - 5 && n.pos[0] < r[0] + r[2] && n.pos[1] < r[1] + r[3];
const gRect = (g) => [g.pos[0], g.pos[1], g.size[0], g.size[1]];
const findGroup = (groups, re) => groups.find((g) => re.test(g.title || ""));
const isEngineGroup = (g) => /ENGINE/i.test(g.title || "");
const isNote = (n) => /Note/i.test(n.type || "");
const isHelp = (n) => /^\s*help/i.test(n.title || "");
// "Help: 2 · Director" / "2 · Director" → number 2 and key "director". Only a LEADING group number counts, otherwise
// "ENGINE: Wan 2.2" would match "Help: 2 · Images".
const numOf = (t) => { const m = /^\s*(?:help\s*:?\s*)?(\d+)\s*·/i.exec(t || ""); return m ? +m[1] : null; };
const keyOf = (t) => (t || "").replace(/^\s*help\s*:?/i, "").replace(/[\d·:.\-]+/g, " ").trim().toLowerCase();
const helpFits = (note, grp) => {
  const a = numOf(note.title), b = numOf(grp.title);
  if (a != null && b != null) return a === b;
  return keyOf(note.title) === keyOf(grp.title);
};

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
  // Adapt Choose to the current shot count, then measure.
  fcChooseRefreshAll();
  // user 2026-11-15 ("all my nodes, MM nodes too, on the 10 grid"): every node's size rounded up to R first
  for (const n of g._nodes || []) n.size = [up(n.size[0]), up(n.size[1])];
  const groups = g._groups || [];
  const engines = groups.filter(isEngineGroup);
  // Core nodes NEVER belong to the engine, even if they currently sit over an engine group.
  const CORE = new Set(["InfiniteMovieSettings", "InfiniteMovieStoryMode", "InfiniteMovieStyle", "InfiniteMovieRender",
    "InfiniteMovieChooser", "InfiniteMovieAssemble", "InfiniteMovieFilm"]);
  const allNotes = (g._nodes || []).filter(isNote);
  const engineHelp = engines.map((e) => allNotes.find((n) => isHelp(n) && helpFits(n, e)) || null);
  const inEngine = (n) => !CORE.has(n.comfyClass) && !isNote(n)
    && engines.some((e) => inRect(n, gRect(e)));
  // Determine members BEFORE any moving (the engine lands where something else used to be).
  const engineMembers = engines.map((e) => (g._nodes || []).filter((n) => inEngine(n) && inRect(n, gRect(e))));
  // 8 Upscale (optional, B3 2026-11-04): block like the engine, members determined BEFORE moving.
  const upGrp = groups.find((x) => !isEngineGroup(x) && /upscale/i.test(x.title || ""));
  const upMembers = upGrp ? (g._nodes || []).filter((n) => !isNote(n) && !inEngine(n) && inRect(n, gRect(upGrp))) : [];
  const upHelp = upGrp ? allNotes.find((n) => isHelp(n) && helpFits(n, upGrp)) || null : null;
  const upSet = new Set(upMembers);
  // 9 Movie to GIF (optional, 2026-11-13): right of Upscale, help on top, the GIF node(s) below.
  const gifGrp = groups.find((x) => !isEngineGroup(x) && /gif/i.test(x.title || ""));
  const gifHelp = gifGrp ? allNotes.find((n) => isHelp(n) && helpFits(n, gifGrp)) || null : null;
  const gifNodes = (g._nodes || []).filter((n) => (n.comfyClass || n.type) === "InfiniteMovieGif" && !inEngine(n) && !upSet.has(n));
  const nodes = (g._nodes || []).filter((n) => !inEngine(n) && !upSet.has(n));
  const byType = (t) => nodes.filter((n) => n.comfyClass === t || n.type === t);

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
  const cutAnas = byType("InfiniteMovieAnalysis");   // Movie Analysis: under Cut's preview, same width
  const asm = byType("InfiniteMovieAssemble"), cut = byType("InfiniteMovieChooser");
  const blockW = upBlock.length ? Math.max(...upBlock.map((n) => n.pos[0] + n.size[0])) - Math.min(...upBlock.map((n) => n.pos[0])) : 0;
  // user 2026-11-13: "after 6 the work is done, 7 8 are extras" -> Cut (group 6) alone sets the width of 6-9;
  // a wider Upscale block only widens group 8 itself
  const inner678 = PLAYER_W;
  for (const a of asm) a.size = [inner678, csH(a)];
  // players: width first (user 2026-11-15: "width!"), the height follows from the film's format (im_viewer filmAspect)
  for (const f of [...cutFilms, ...asmFilms, ...upFilms, ...cutAnas]) {
    if (f.properties) { delete f.properties.im_fit_h; delete f.properties.im_sq; }
    f.size = [inner678, f.size[1]];
  }
  // the analysis box = the preview's video box (same height, same format)
  if (cutFilms.length) for (const a of cutAnas) { a.properties ||= {}; a.properties.im_sq = filmSquare(cutFilms[0], 0); a.properties.im_ar = filmAspect(cutFilms[0]); }
  for (const f of [...cutFilms, ...asmFilms, ...upFilms, ...cutAnas]) f.size = [inner678, csH(f)];
  // ONE row, order = numbers 2…7
  // 2026-11-11: help note "Story Mode …" sits right under the Story Mode node (not with the README)
  const storyHelp = byType("InfiniteMovieStoryMode").length ? allNotes.filter((n) => /story mode/i.test(n.title || "")) : [];
  const SET = 0, DIR = 1, CUT = 2;   // row indices
  const row = [
    // 124c: the storyboard lives in the Director - prompt writing settings (Style, Story Mode) join Settings
    [G(/settings/i), [...byType("InfiniteMovieSettings"), ...byType("InfiniteMovieStyle"), ...byType("InfiniteMovieStoryMode"), ...storyHelp]],
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
  // README + all notes without their own group: no group (user 2026-11-13), one under another on the left.
  // An old README group is removed.
  const oldReadme = G(/readme/i);
  if (oldReadme) g.remove(oldReadme);
  const restNotes = allNotes.filter((n) => !used.has(n))
    .sort((a, b) => (/readme/i.test(b.title || "") ? 1 : 0) - (/readme/i.test(a.title || "") ? 1 : 0));

  // Anchor: x = README note (otherwise the settings/first group of the row), y = top edge of the engine (very top)
  const firstGrp = row.find(([grp]) => grp)?.[0];
  const XR = snap(restNotes.length ? restNotes[0].pos[0] : firstGrp ? firstGrp.pos[0] : director.pos[0] - PAD);
  const TOP = snap(engines.length ? Math.min(...engines.map((e) => e.pos[1])) : (firstGrp ? firstGrp.pos[1] : director.pos[1] - T - HEAD));
  for (const n of restNotes) n.size = [up(n.size[0]), up(n.size[1])];
  const rw = restNotes.length ? Math.max(...restNotes.map((n) => n.size[0])) : 0;
  const X0 = restNotes.length ? XR + rw + GAP : XR;

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
  // Cut's column: the Movie Analysis on top, the preview below, both full width in the film's format
  const oneCol = cut.length && cutFilms.length === 1;
  const sizes = row.map(([, ns, side], k) => colSize(ns, side, rowHelp[k]));
  // user 2026-11-13 ("groups modular, 2 or 3 widths, no more"): one module width U = a Cut column (Cut node + margins)
  // or the storyboard, whichever is wider. Settings and Director are U wide, Cut (Cut + preview side by side) 2U + GAP.
  const U = up(Math.max(inner678 + 2 * PAD, sizes[SET][0], sizes[DIR][0]));
  for (const k of [SET, DIR]) {
    sizes[k][0] = U;
    for (const n of row[k][1]) if (!isHelp(n)) n.size = [U - 2 * PAD, n.size[1]];
  }
  // Cut group: no fixed module width (user 2026-11-15: "close the gap, dynamic with variants") - Cut + PAD + the
  // preview column, so it grows and shrinks with Cut's variant columns
  // user 2026-11-13 ("1 wider"): the engine on top spans Settings + Director (2U + GAP); help stays on the left
  for (const [k, e] of engines.entries()) {
    if (engines.length !== 1) break;
    const w = Math.max(e.size[0], 2 * U + GAP);
    e.size = [w, e.size[1]];
  }
  row.forEach((_, k) => { const h = rowHelp[k]; if (h) h.size = [sizes[k][0] - 2 * PAD, HH]; });
  let x = X0;
  row.forEach(([grp, ns, side], k) => {
    if (!ns.length && !grp) return;
    placeCol(ns, side, rowHelp[k], x, Y, sizes[k][0]);
    if (grp) grp.pos = [x, Y];
    x += sizes[k][0] + GAP;
  });

  // user 2026-11-13 ("the bottom edge of the images is the bottom edge"): if the Settings column (Story Mode with its
  // big text fields) reaches lower than the Director's storyboard, Story Mode gets shorter (min 400) instead of the
  // row taller.
  const story = byType("InfiniteMovieStoryMode")[0];
  if (story && row[SET][0]) {
    const bDir = director.pos[1] + director.size[1];
    const bSet = Math.max(...row[SET][1].map((n) => n.pos[1] + n.size[1]));
    if (bSet > bDir) {
      // never below its own minimum: the frontend grows a node back to computeSize() after the layout and the
      // help note below would then cover it
      story.size = [story.size[0], Math.max(400, csH(story), story.size[1] - (bSet - bDir))];
      sizes[SET] = [sizes[SET][0], colSize(row[SET][1], row[SET][2], rowHelp[SET])[1]];
      placeCol(row[SET][1], row[SET][2], rowHelp[SET], row[SET][0].pos[0], Y, sizes[SET][0]);
    }
  }
  // user 2026-11-13 ("Director and Cut as tall as the layout allows, content as big as possible"): first both at
  // their natural height (so they never make the row taller), they grow to the group bottom after H123 is known.
  for (const n of [director, ...cut]) {
    n.properties ||= {};
    delete n.properties.imv_h;
    n.size = [n.size[0], csH(n)];
  }
  // Cut: top flush with the Director, its flexible head (im_twin) puts row i at prompt box i
  for (const c of cut) c.pos = [c.pos[0], director.pos[1]];
  // Cut: the preview sits at the right edge of the double-width group
  if (row[CUT][0]) for (const f of cutFilms) f.pos = [row[CUT][0].pos[0] + sizes[CUT][0] - PAD - f.size[0], f.pos[1]];
  // A single Film player beside Cut: the analysis top flush with Director and Cut, the preview below it - or lower,
  // level with the players of the groups behind (user 2026-11-15: "video preview same y, same size")
  const placeCutCol = (bottom = null) => {
    if (!oneCol) return;
    const f = cutFilms[0], a = cutAnas[0], top = a ? director.pos[1] + a.size[1] + NGAP + T : director.pos[1];
    if (a) a.pos = [f.pos[0], director.pos[1]];
    f.pos = [f.pos[0], Math.max(top, bottom != null ? bottom - f.size[1] : top)];
  };
  placeCutCol();
  // Group height from the real content: groups 1-3 keep the full row height, groups 4-6 share one lower height
  // (the smallest that fits all three).
  const bottom123 = Math.max(...row.slice(0, 3).flatMap(([, ns]) => ns.map((n) => n.pos[1] + n.size[1])),
    ...cutAnas.map((n) => n.pos[1] + n.size[1]));
  // Upscale content (block + Film players below) counts for the 4-6 height, not the 1-3 height
  const needUp = () => {
    if (!upGrp || !upMembers.length) return 0;
    const ms = upBlock.length ? upBlock : upMembers;
    const blockH = Math.max(...ms.map((n) => n.pos[1] + n.size[1])) - Math.min(...ms.map((n) => n.pos[1] - T));
    return HEAD + helpH(upHelp) + blockH + (upBlock.length ? upFilms.reduce((s, f) => s + NGAP + T + f.size[1], 0) : 0) + PAD;
  };
  let upNeed = needUp();
  // GIF: width = 6/7/8 (square preview), its full height counts for the 4-6 height
  let gifNeed = 0;
  if (gifGrp && gifNodes.length) {
    for (const n of gifNodes) { n.size = [inner678, n.size[1]]; n.size = [inner678, csH(n)]; }
    gifNeed = HEAD + helpH(gifHelp) + gifNodes.reduce((s, n) => s + T + n.size[1] + NGAP, 0) + PAD;
  }
  // user 2026-11-15 ("width!"): the players keep their full-width size, the groups grow with them. Groups 4-6 share
  // one height; Cut's preview ends level with their players, so 1-3 are at least that tall.
  const H456 = up(Math.max(sizes[3][1], upNeed, gifNeed, bottom123 - Y + PAD));
  placeCutCol(Y + H456 - PAD);   // Cut's preview level with the players behind
  const H123 = up(Math.max(sizes[SET][1], sizes[DIR][1], sizes[CUT][1], bottom123 - Y + PAD, oneCol ? H456 : 0));
  row.forEach(([grp, ns], k) => { if (grp && (ns.length || grp)) grp.size = [sizes[k][0], k <= CUT ? H123 : H456]; });
  // Film player(s) of 6 and 7 sit at the bottom edge of their group (user: "films at the bottom"); 6 is 1-3 tall, 7 is 4-6 tall
  for (const [fs, hh] of [[cutFilms.length === 1 && cut.length ? [] : cutFilms, H123], [asmFilms, H456]]) { let b = Y + hh - PAD; for (const f of [...fs].reverse()) { f.pos = [f.pos[0], b - f.size[1]]; b -= T + f.size[1] + NGAP; } }
  // user 2026-11-13 ("never collapse the graph, always open"): Even Motion reaches down to its Film player, so its
  // analysis graph (image preview below the widgets) always has room inside group 7 - also before the first run
  for (const a of asm) {
    a.size = [a.size[0], csH(a)];   // the graph in its own format at full width (im_viewer imvArea), no stretching
  }
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
    let b = Y + H456 - PAD;
    for (const f of upBlock.length ? [...upFilms].reverse() : []) { f.pos = [x + PAD, b - f.size[1]]; b -= T + f.size[1] + NGAP; }
    upGrp.pos = [x, Y];
    upGrp.size = [w, H456];
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
      if (k === gifNodes.length - 1) n.size = [inner678, Math.max(n.size[1], Y + H456 - PAD - gy)];
      n.pos = [gx + PAD, gy]; gy += n.size[1] + NGAP + T;
    });
    gifGrp.pos = [gx, Y];
    gifGrp.size = [w, H456];
  }

  // README at the front without a group: title bar level with the group tops, the last note reaches the group bottom
  // (the front groups 1-3 are the taller H123)
  let ry = Y + T;
  restNotes.forEach((n, k) => {
    const h = k === restNotes.length - 1 ? Math.max(100, Y + H123 - ry) : n.size[1];
    n.pos = [XR, ry]; n.size = [rw, h];
    ry += h + NGAP + T;
  });

  // grid: every node and group position on R (sizes are already multiples of R)
  for (const n of g._nodes || []) { n.pos = [snap(n.pos[0]), snap(n.pos[1])]; n.size = [up(n.size[0]), up(n.size[1])]; }
  for (const gr of groups) { gr.pos = [snap(gr.pos[0]), snap(gr.pos[1])]; gr.size = [up(gr.size[0]), up(gr.size[1])]; }
  g.setDirtyCanvas?.(true, true);
  // Second pass: newly created nodes only get their real height after the
  // first draw - without re-measuring they overlap.
  if (!second) setTimeout(() => fcWorkflowLayout(director, true), 250);
}

