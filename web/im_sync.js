// ---------------------------------------------------------------------------
// InfiniteMovie sync bus: shared state between the
// Cut node (tile hover) and the Film node (player). Window CustomEvents keep the
// two sides import-free of each other: im_cut.js -> im_sync.js <- im_film.js.
// This module imports no other im_* file (no import cycle).
// ---------------------------------------------------------------------------
// Source state: the whole film, or the segment under the mouse in Cut.
const imSyncState = { src: "film", seg: null };

// Set the source state and announce it to every listener via the "imv-src" event.
export function imSyncSet(src, seg = null) {
  imSyncState.src = src;
  imSyncState.seg = seg;
  window.dispatchEvent(new CustomEvent("imv-src", { detail: { ...imSyncState } }));
}

// Read the current source state (a copy, so callers cannot mutate the bus).
export function imSyncGet() {
  return { ...imSyncState };
}

// Ask the player to jump to time t (seconds); the Film node sets video.currentTime.
export function imvSeek(t) {
  window.dispatchEvent(new CustomEvent("imv-seek", { detail: { t } }));
}

// Report the player's current time t (seconds) for film node id (analysis side).
export function imvTime(t, film) {
  window.dispatchEvent(new CustomEvent("imv-time", { detail: { t, film } }));
}
