// The Director storyboard as data - pure functions, no DOM, no ComfyUI (storyboard.py holds the same rules).
// A row = one image and the film that starts there: {image, prompt, own, pair, sec, cut}.
//   pair = the two images the prompt was written for (stale = no longer its current neighbours, shown red)
//   sec  = own length of that film in seconds (0 = the Director's `seconds`)
//   cut  = the film starts at this image and ends open (no end image), a hard cut to the next film follows

export const MAX_IMAGES = 24;
export const DEFAULT_IMAGES = 4;
export const emptyRow = () => ({ image: "", prompt: "", own: false, pair: null, sec: 0, cut: false });

// Film i runs from image i to image nextOf(i): the next one, with loop the last one back to the first.
// A single image is an open film (no end image), so it is its own "next". -1 = row i starts no film.
export const nextOf = (n, i, loop) => (n === 1 ? 0 : i < n - 1 ? i + 1 : loop ? 0 : -1);
export const hasFilm = (n, i, loop) => nextOf(n, i, loop) >= 0;
// Films rendered: one per row that starts one; a single image with loop also gets the way back.
export const filmCount = (n, loop) => (n < 1 ? 0 : n === 1 ? (loop ? 2 : 1) : loop ? n : n - 1);

// A cut film can only exist with more than one image (a single image is open anyway).
export const isCut = (rows, i, loop) => rows.length > 1 && hasFilm(rows.length, i, loop) && !!rows[i].cut;

// Cell layout: the images stay one stack (user 2026-11-15). A prompt box sits between its image and the next
// (img[i] + row/2); the box of a cut film sits next to its own image (img[i]) and the transition box above it ends
// where it starts (short[i]: half height). A cut is only drawn: a thin black line in the gap below its image
// (cut[i] = y of the gap's middle) - no storyboard row of its own, film numbers / seconds / seeds never shift.
// Cut mirrors box[], short[] and cut[].
export function cellTops(rows, loop, row, gapPx = 10) {
  const n = rows.length, img = [], box = [], cut = [], short = [];
  for (let i = 0; i < n; i++) {
    const c = isCut(rows, i, loop);
    img.push(i * row);
    box.push(hasFilm(n, i, loop) ? img[i] + (c ? 0 : row / 2) : null);
    cut.push(c ? img[i] + row - gapPx / 2 : null);
    short.push(hasFilm(n, i, loop) && !c && i + 1 < n && isCut(rows, i + 1, loop));
  }
  return { img, box, cut, short, end: n * row };
}

export function pairOf(rows, i, loop) {
  const j = nextOf(rows.length, i, loop);
  if (j >= 0 && isCut(rows, i, loop)) return rows[i].image ? [rows[i].image, "open"] : null;
  return j >= 0 && rows[i].image && rows[j].image ? [rows[i].image, rows[j].image] : null;
}

export const samePair = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

// Red light: there is a prompt, but it was written for other images.
export const isStale = (rows, i, loop) => !!rows[i].prompt.trim() && !samePair(rows[i].pair, pairOf(rows, i, loop));

// Row from the stored JSON entry plus its seconds.
export const toRow = (e, sec) => ({
  image: String(e?.image || ""), prompt: String(e?.prompt || ""), own: !!e?.own,
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
