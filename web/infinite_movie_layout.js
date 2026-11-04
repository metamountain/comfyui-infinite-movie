// Infinite Movie · Workflow-Layout. Aufgerufen vom Knopf „🔗 AUTO LAYOUT“ am Director
// (web/infinite_movie.js → window.fcWorkflowLayout).
//
// Nutzer 2026-11-03 („engine ganz oben“, „help immer in der Mitte über den Feldern“, „Box vorne separat“):
//                 ┌ 1 ENGINE (Hilfe mittig oben, Inhalt als Block) ┐
//                 └─────────────────────────────────────────────────┘
//   ┌ 0 README ┐  ┌ 2 Settings ┐┌ 3 Images ┐┌ 4 Prompts ┐┌ 5 Director ┐┌ 6 Choose ┐┌ 7 Assemble + Film ┐┌ 8 Upscale ┐
//   │          │  │  Hilfe     ││  Hilfe   ││  Hilfe    ││  Hilfe     ││  Hilfe   ││  Hilfe            │  ← EINE Reihe
//   └──────────┘  │  Nodes     ││  Nodes   ││  Nodes    ││  Nodes     ││  Nodes   ││  Nodes            │
// Jede Hilfe-Notiz „Help: N · …“ liegt mittig oben IN ihrer Gruppe „N · …“. Notizen ohne passende Gruppe
// bleiben beim README. Anker: x = README-Gruppe, y = Oberkante der Engine.
import { app } from "../../scripts/app.js";

const T = 30;        // Node-Titelleiste
const HEAD = 64;     // Gruppenkopf: Titel (32) + Platz für das Node-Badge (#id …)
const PAD = 20;      // Rand links/rechts/unten
const GAP = 40;      // zwischen Gruppen
const NGAP = 40;     // zwischen Nodes in einer Gruppe
const MINW = 420;    // Mindestbreite einer Gruppe

const inRect = (n, r) => n.pos[0] >= r[0] - 5 && n.pos[1] >= r[1] - 5 && n.pos[0] < r[0] + r[2] && n.pos[1] < r[1] + r[3];
const gRect = (g) => [g.pos[0], g.pos[1], g.size[0], g.size[1]];
const findGroup = (groups, re) => groups.find((g) => re.test(g.title || ""));
const isEngineGroup = (g) => /ENGINE/i.test(g.title || "");
const isNote = (n) => /Note/i.test(n.type || "");
const isHelp = (n) => /^\s*help/i.test(n.title || "");
// „Help: 4 · Prompts“ / „4 · Prompts“ → Nummer 4 und Schlüssel „prompts“
const numOf = (t) => { const m = /(\d+)/.exec(t || ""); return m ? +m[1] : null; };
const keyOf = (t) => (t || "").replace(/^\s*help\s*:?/i, "").replace(/[\d·:.\-]+/g, " ").trim().toLowerCase();
const helpFits = (note, grp) => {
  const a = numOf(note.title), b = numOf(grp.title);
  if (a != null && b != null) return a === b;
  return keyOf(note.title) === keyOf(grp.title);
};

function linkedOrigins(g, node, prefix) {
  // Ursprungs-Nodes der Eingänge prefix.* in Slot-Reihenfolge (images.image0.. / shot_prompts.prompt0..)
  const out = [];
  for (const inp of node.inputs || []) {
    if (!inp.name?.startsWith(prefix) || inp.link == null) continue;
    const l = g.links?.[inp.link] ?? g.links?.get?.(inp.link);
    const o = l && g.getNodeById(l.origin_id);
    if (o && !out.includes(o)) out.push(o);
  }
  return out;
}

// Höhe des Hilfe-Blocks oben in einer Gruppe (Titelleiste + Notiz + Abstand)
const helpH = (help) => (help ? T + help.size[1] + NGAP : 0);

// Gruppe: Hilfe mittig oben, darunter Nodes untereinander (stack) oder nebeneinander (side).
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
  // Aufräumen: Auto Prompts, deren prompt-Ausgang an nichts mehr hängt (Bild entfernt), entfernen.
  // Gemutete bleiben (Bild gemutet / loop aus): sie behalten ihren Text für später (Nutzer 2026-11-04).
  for (const ap of (g._nodes || []).filter((n) => n.comfyClass === "InfiniteMovieAutoPrompt" && (n.mode ?? 0) === 0)) {
    const out = (ap.outputs || []).find((o) => o.name === "prompt");
    if (out && !(out.links || []).length) g.remove(ap);
  }
  // Choose an die aktuelle Shot-Zahl anpassen, dann messen.
  if (window.fcChooseRefreshAll) window.fcChooseRefreshAll();
  const groups = g._groups || [];
  const engines = groups.filter(isEngineGroup);
  // Kern-Nodes gehören NIE zur Engine, auch wenn sie gerade über einer Engine-Gruppe liegen.
  const CORE = new Set(["InfiniteMovieSettings", "InfiniteMovieStyle", "InfiniteMovieAutoPrompt", "InfiniteMovieRender",
    "InfiniteMovieChooser", "InfiniteMovieAssemble", "InfiniteMovieFilm"]);
  const coreImages = new Set(linkedOrigins(g, director, "images."));
  const allNotes = (g._nodes || []).filter(isNote);
  const engineHelp = engines.map((e) => allNotes.find((n) => isHelp(n) && helpFits(n, e)) || null);
  const inEngine = (n) => !CORE.has(n.comfyClass) && !coreImages.has(n) && !isNote(n)
    && engines.some((e) => inRect(n, gRect(e)));
  // Mitglieder VOR jedem Verschieben bestimmen (die Engine landet dort, wo vorher anderes lag).
  const engineMembers = engines.map((e) => (g._nodes || []).filter((n) => inEngine(n) && inRect(n, gRect(e))));
  // 8 Upscale (optional, B3 2026-11-04): Block wie die Engine, Mitglieder VOR dem Verschieben bestimmen.
  const upGrp = groups.find((x) => !isEngineGroup(x) && /upscale/i.test(x.title || ""));
  const upMembers = upGrp ? (g._nodes || []).filter((n) => !isNote(n) && !inEngine(n) && inRect(n, gRect(upGrp))) : [];
  const upHelp = upGrp ? allNotes.find((n) => isHelp(n) && helpFits(n, upGrp)) || null : null;
  const upSet = new Set(upMembers);
  const nodes = (g._nodes || []).filter((n) => !inEngine(n) && !upSet.has(n));
  const byType = (t) => nodes.filter((n) => n.comfyClass === t || n.type === t);

  const prompts = linkedOrigins(g, director, "shot_prompts.");
  for (const p of byType("InfiniteMovieAutoPrompt")) if (!prompts.includes(p)) prompts.push(p);
  const G = (re) => findGroup(groups.filter((x) => !isEngineGroup(x)), re);
  // EINE Reihe, Reihenfolge = Nummern 2…7
  const row = [
    [G(/settings/i), byType("InfiniteMovieSettings")],
    [G(/images/i), linkedOrigins(g, director, "images.")],
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
  // README-Gruppe: README + alle Notizen ohne eigene Gruppe, untereinander
  const readme = G(/readme/i);
  const restNotes = allNotes.filter((n) => !used.has(n))
    .sort((a, b) => (/readme/i.test(b.title || "") ? 1 : 0) - (/readme/i.test(a.title || "") ? 1 : 0));

  // Anker: x = README-Gruppe (sonst Settings-/erste Gruppe der Reihe), y = Oberkante der Engine (ganz oben)
  const anchor = readme || row.find(([grp]) => grp)?.[0];
  const XR = anchor ? anchor.pos[0] : director.pos[0] - PAD;
  const TOP = engines.length ? Math.min(...engines.map((e) => e.pos[1])) : (anchor ? anchor.pos[1] : director.pos[1] - T - HEAD);
  const [rw, rh] = colSize(restNotes, false, null);
  const X0 = (readme || restNotes.length) ? XR + rw + GAP : XR;

  // 1 Engine ganz oben: Gruppen nebeneinander, Hilfe mittig oben, Inhalt als Block darunter
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

  // 2…7 EINE Reihe, gleiche Höhe, Hilfe jeweils mittig oben
  const sizes = row.map(([, ns, side], k) => colSize(ns, side, rowHelp[k]));
  let x = X0;
  row.forEach(([grp, ns, side], k) => {
    if (!ns.length && !grp) return;
    placeCol(ns, side, rowHelp[k], x, Y, sizes[k][0]);
    if (grp) grp.pos = [x, Y];
    x += sizes[k][0] + GAP;
  });

  // Prompt k exakt zwischen Bild k und Bild k+1 (Loop-Prompt n→1 einen halben Schritt unter dem letzten Bild):
  // so liest man den Übergang direkt ab (Nutzer 2026-11-03: „exakt zwischen Bildern … wichtig“).
  const imgs = row[1][1];
  const linkedPrompts = linkedOrigins(g, director, "shot_prompts.");
  if (imgs.length >= 2 && linkedPrompts.length) {
    const mid = (n) => n.pos[1] + (n.size[1] - T) / 2;          // Mitte des Kastens inkl. Titelleiste
    const c = imgs.map(mid);
    const step = c[1] - c[0];
    linkedPrompts.forEach((p, k) => {
      const target = k + 1 < c.length ? (c[k] + c[k + 1]) / 2 : c[c.length - 1] + step / 2;
      p.pos = [p.pos[0], target - (p.size[1] - T) / 2];
    });
    // Prompt Style steht oben in der Prompt-Spalte: Bilder + Prompts so weit nach unten, dass nichts überlappt.
    const style = byType("InfiniteMovieStyle")[0];
    if (style) {
      const need = style.pos[1] + style.size[1] + NGAP + T;
      const shift = Math.max(0, need - Math.min(...linkedPrompts.map((p) => p.pos[1])));
      if (shift) for (const n of [...imgs, ...linkedPrompts]) n.pos = [n.pos[0], n.pos[1] + shift];
    }
  }
  // Gruppenhöhe nach dem echten Inhalt (Prompts können unter das letzte Bild reichen)
  const bottom = Math.max(...row.flatMap(([, ns]) => ns.map((n) => n.pos[1] + n.size[1])));
  const H = Math.max(...sizes.map((s) => s[1]), bottom - Y + PAD);
  row.forEach(([grp, ns], k) => { if (grp && (ns.length || grp)) grp.size = [sizes[k][0], H]; });
  // 8 Upscale rechts neben 7, Inhalt als Block, Hilfe mittig oben, gleiche Höhe wie die Reihe
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

  // 0 README vorne, separat, auf Höhe der Reihe
  if (readme || restNotes.length) {
    placeCol(restNotes, false, null, XR, Y, rw);
    if (readme) { readme.pos = [XR, Y]; readme.size = [rw, rh]; }
  }

  g.setDirtyCanvas?.(true, true);
  console.log("[InfiniteMovie] layout: README left / engine top / row 2-7 with help", { XR, X0, TOP, Y, H, second });
  // Zweiter Durchgang: neu angelegte Nodes (z. B. Auto Prompts) bekommen ihre echte Höhe erst nach dem
  // ersten Zeichnen – ohne Nachmessen überlappen sie.
  if (!second) setTimeout(() => fcWorkflowLayout(director, true), 250);
}

window.fcWorkflowLayout = fcWorkflowLayout;
