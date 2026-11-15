// The Director storyboard as data - pure functions, no DOM, no ComfyUI (storyboard.py holds the same rules).
// A row = one image and the film that starts there: {image, prompt, own, pair, sec, cut}.
//   pair = the two images the prompt was written for (stale = no longer its current neighbours, shown red)
//   sec  = own length of that film in seconds (0 = the Director's `seconds`)
//   cut  = hard cut after this image: empty prompt = no film, text = open film (no end image), then the cut

export const MAX_IMAGES = 24;
export const DEFAULT_IMAGES = 4;
export const emptyRow = () => ({ image: "", prompt: "", prompt_b: "", prompt_c: "", prompt_d: "", own: false, pair: null, sec: 0, cut: false });

// Film i runs from image i to image nextOf(i): the next one, with loop the last one back to the first.
// A single image is an open film (no end image), so it is its own "next". -1 = row i starts no film.
export const nextOf = (n, i, loop) => (n === 1 ? 0 : i < n - 1 ? i + 1 : loop ? 0 : -1);
export const hasFilm = (n, i, loop) => nextOf(n, i, loop) >= 0;
// Films rendered: one per row that starts one; a single image with loop also gets the way back.
export const filmCount = (n, loop) => (n < 1 ? 0 : n === 1 ? (loop ? 2 : 1) : loop ? n : n - 1);

// A cut (user 2026-11-15) on row i = a hard cut after image i. Every row keeps its prompt box ("no image without
// a prompt"): an empty A prompt = no film i (image i only ends the film before), text = an OPEN film from image i
// (no end image), then the hard cut. Needs more than one image (a single image is open anyway). Only A decides.
export const isCut = (rows, i, loop) => rows.length > 1 && hasFilm(rows.length, i, loop) && !!rows[i].cut;
export const isOpen = (rows, i, loop) => isCut(rows, i, loop) && !!String(rows[i].prompt || "").trim();
// Film ids that are rendered (= storyboard.film_rows): the row stays the id, an empty cut row has none.
export const filmRows = (rows, loop) => {
  const n = rows.length;
  return Array.from({ length: filmCount(n, loop) }, (_, k) => k).filter((k) => {
    const r = Math.min(k, n - 1);
    return !isCut(rows, r, loop) || isOpen(rows, r, loop);
  });
};

// Cell layout (user 2026-11-15): every prompt is one film = one Cut row, every box sits between its image and the
// next (img[i] + row/2) with the same height - a cut row too. The cut is two black lines: cut[i] in the image
// column (gap below image i), cutBox[i] in the prompt column and in Cut (gap below box i, where film i ends).
// Film ids / seconds / seeds never shift. Cut mirrors box[], cutBox[].
export function cellTops(rows, loop, row, gapPx = 10) {
  const n = rows.length, img = [], box = [], cut = [], cutBox = [];
  for (let i = 0; i < n; i++) {
    const c = isCut(rows, i, loop);
    img.push(i * row);
    box.push(hasFilm(n, i, loop) ? img[i] + row / 2 : null);
    cut.push(c ? img[i] + row - gapPx / 2 : null);
    cutBox.push(c ? img[i] + row * 1.5 - gapPx / 2 : null);
  }
  return { img, box, cut, cutBox, end: n * row };
}

// One height system for the Director and Cut (user 2026-11-15): the tile = the film format contain-fitted into the
// Load Image box, row = tile + gap, every prompt box / Cut row at tops[i], one height ih.
export const TILE_W = 283, TILE_H = 205, ROW_GAP = 10;
export function boardGeometry(fmt, rows, loop) {
  const k = Math.min(TILE_W / fmt.w, TILE_H / fmt.h);
  const iw = Math.round(fmt.w * k), ih = Math.round(fmt.h * k), row = ih + ROW_GAP;
  const cells = cellTops(rows, loop, row, ROW_GAP);
  const heights = cells.box.map((t) => (t == null ? null : ih));
  return { iw, ih, row, cells, tops: cells.box, heights };
}

export function pairOf(rows, i, loop) {
  const j = nextOf(rows.length, i, loop);
  if (isCut(rows, i, loop)) return rows[i].image ? [rows[i].image, ""] : null;   // open end: no end image
  return j >= 0 && rows[i].image && rows[j].image ? [rows[i].image, rows[j].image] : null;
}

export const samePair = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

// Red light: there is a prompt, but it was written for other images.
export const isStale = (rows, i, loop) => !!rows[i].prompt.trim() && !samePair(rows[i].pair, pairOf(rows, i, loop));

// Row from the stored JSON entry plus its seconds.
export const toRow = (e, sec) => ({
  image: String(e?.image || ""), prompt: String(e?.prompt || ""), prompt_b: String(e?.prompt_b || ""),
  prompt_c: String(e?.prompt_c || ""), prompt_d: String(e?.prompt_d || ""), own: !!e?.own,
  pair: Array.isArray(e?.pair) && e.pair.length === 2 ? e.pair.map(String) : null, sec: sec > 0 ? sec : 0, cut: !!e?.cut,
});

// Drag: row `from` lands in gap `gap` (0 = above the first row). The row keeps its prompt and seconds - the film
// below the image travels with it. Returns the new index, or -1 when nothing moves.
export function moveRow(rows, from, gap) {
  if (gap === from || gap === from + 1) return -1;
  const to = gap > from ? gap - 1 : gap;
  rows.splice(to, 0, rows.splice(from, 1)[0]);
  return to;
}
