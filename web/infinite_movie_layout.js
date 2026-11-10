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
  const CORE = new Set(["InfiniteMovieSettings", "InfiniteMovieStyle", "InfiniteMovieAutoPrompt", "InfiniteMovieRender",
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
  const nodes = (g._nodes || []).filter((n) => !inEngine(n) && !upSet.has(n));
  const byType = (t) => nodes.filter((n) => n.comfyClass === t || n.type === t);

  const prompts = linkedOrigins(g, director, "shot_prompts.");
  for (const p of byType("InfiniteMovieAutoPrompt")) if (!prompts.includes(p)) prompts.push(p);
  const G = (re) => findGroup(groups.filter((x) => !isEngineGroup(x)), re);
  // ONE row, order = numbers 2…7
  const row = [
    [G(/settings/i), byType("InfiniteMovieSettings")],
    [G(/images/i), imgRows.flat()],
    [G(/prompt/i), [...byType("InfiniteMovieStyle"), ...prompts]],
    [G(/director/i), [director]],
    [G(/choose/i), byType("InfiniteMovieChooser")],
    [G(/assemble/i), [...byType("InfiniteMovieAssemble"), ...byType("InfiniteMovieFilm")], true],
  ];
  const used = new Set([...engineHelp, upHelp].filter(Boolean));
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
    engines.forEach((e, k) => {
      const ms = engineMembers[k], help = engineHelp[k];
      const minX = ms.length ? Math.min(...ms.map((n) => n.pos[0])) : 0;
      const minY = ms.length ? Math.min(...ms.map((n) => n.pos[1] - T)) : 0;
      const maxX = ms.length ? Math.max(...ms.map((n) => n.pos[0] + n.size[0])) : 0;
      const maxY = ms.length ? Math.max(...ms.map((n) => n.pos[1] + n.size[1])) : 0;
      const bw = maxX - minX, bh = maxY - minY;
      const w = Math.max(MINW, bw + 2 * PAD, (help ? help.size[0] : 0) + 2 * PAD);
      const h = HEAD + helpH(help) + bh + PAD;
      if (help) help.pos = [ex + (w - help.size[0]) / 2, TOP + HEAD + T];
      const dx = ex + PAD - minX, dy = TOP + HEAD + helpH(help) - minY;
      for (const n of ms) n.pos = [n.pos[0] + dx, n.pos[1] + dy];
      e.pos = [ex, TOP]; e.size = [w, h];
      ex += w + GAP; HE = Math.max(HE, h);
    });
    Y = TOP + HE + GAP;
  }

  // 2…7 ONE row, same height, help centered on top each. Images: one row per image (chain side by side).
  const rowW = (r) => r.reduce((s, n) => s + n.size[0], 0) + PAD * (r.length - 1);
  const rowH = (r) => T + Math.max(...r.map((n) => n.size[1]));
  const sizes = row.map(([, ns, side], k) => {
    if (k !== 1 || !imgRows.length) return colSize(ns, side, rowHelp[k]);
    const help = rowHelp[k];
    const w = Math.max(MINW, ...imgRows.map((r) => rowW(r) + 2 * PAD), (help ? help.size[0] : 0) + 2 * PAD);
    const h = HEAD + helpH(help) + imgRows.reduce((s, r) => s + rowH(r), 0) + NGAP * (imgRows.length - 1) + PAD;
    return [w, h];
  });
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
  // Group height from the real content (prompts can reach below the last image)
  const bottom = Math.max(...row.flatMap(([, ns]) => ns.map((n) => n.pos[1] + n.size[1])));
  const H = Math.max(...sizes.map((s) => s[1]), bottom - Y + PAD);
  row.forEach(([grp, ns], k) => { if (grp && (ns.length || grp)) grp.size = [sizes[k][0], H]; });
  // 8 Upscale right of 7, content as a block, help centered on top, same height as the row
  if (upGrp && upMembers.length) {
    const ms = upMembers;
    const minX = Math.min(...ms.map((n) => n.pos[0])), minY = Math.min(...ms.map((n) => n.pos[1] - T));
    const maxX = Math.max(...ms.map((n) => n.pos[0] + n.size[0])), maxY = Math.max(...ms.map((n) => n.pos[1] + n.size[1]));
    const w = Math.max(MINW, maxX - minX + 2 * PAD, (upHelp ? upHelp.size[0] : 0) + 2 * PAD);
    if (upHelp) upHelp.pos = [x + (w - upHelp.size[0]) / 2, Y + HEAD + T];
    const dx = x + PAD - minX, dy = Y + HEAD + helpH(upHelp) - minY;
    for (const n of ms) n.pos = [n.pos[0] + dx, n.pos[1] + dy];
    upGrp.pos = [x, Y];
    upGrp.size = [w, Math.max(H, HEAD + helpH(upHelp) + maxY - minY + PAD)];
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
