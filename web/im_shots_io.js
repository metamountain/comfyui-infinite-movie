// 124c (2026-11-14): data + I/O of the Director storyboard (web/im_shots.js).
// shots widget = JSON list [{image, prompt, own, pair}], image relative to ComfyUI's input folder ("" = empty).
// Prompt i = film from image i to image i+1 (loop: last -> image 1). pair = the two images the prompt was
// written for; when it no longer matches the current neighbours the prompt is shown red (stale).
import { api } from "../../scripts/api.js";
import { fcParseShotSeconds, fcReviewToast } from "./im_common.js";
import { fcPickFolder, imResolveSize } from "./im_settings.js";

export const MAX_SHOTS = 24;
export const DEFAULT_SHOTS = 4;
export const emptyShot = () => ({ image: "", prompt: "", own: false, pair: null });

const W = (node, name) => node.widgets?.find((w) => w.name === name);

function setWidget(node, name, text) {
  const w = W(node, name);
  if (!w) return;
  const old = w.value;
  w.value = text;
  w.callback?.(text);
  node.onWidgetChanged?.(name, text, old, w);
  node.graph?.incrementVersion?.();
}

export function readShots(node) {
  let data = [];
  try { data = JSON.parse(W(node, "shots")?.value || "[]"); } catch { data = []; }
  if (!Array.isArray(data)) data = [];
  const list = data.filter((e) => e && typeof e === "object").slice(0, MAX_SHOTS).map((e) => ({
    image: String(e.image || ""), prompt: String(e.prompt || ""), own: !!e.own,
    pair: Array.isArray(e.pair) && e.pair.length === 2 ? e.pair.map(String) : null,
  }));
  if (!list.length) for (let i = 0; i < DEFAULT_SHOTS; i++) list.push(emptyShot());
  return list;
}

export function writeShots(node, list) {
  setWidget(node, "shots", JSON.stringify(list.slice(0, MAX_SHOTS)));
}

export const isLoop = (node) => !!W(node, "loop")?.value;

// Current pair of shot i, or null when shot i has no film (last shot without loop, or an empty image).
export function pairOf(list, i, loop) {
  const n = list.length;
  if (i < n - 1 || (loop && n > 1)) {
    const a = list[i].image, b = list[(i + 1) % n].image;
    return a && b ? [a, b] : null;
  }
  return null;
}

export const hasFilm = (list, i, loop) => i < list.length - 1 || (loop && list.length > 1);

// Red light: prompt text exists but was written for another pair of images.
export function isStale(list, i, loop) {
  const s = list[i];
  if (!s.prompt.trim()) return false;
  const p = pairOf(list, i, loop);
  return !p || !s.pair || s.pair[0] !== p[0] || s.pair[1] !== p[1];
}

// Seconds per shot: entry in shot_seconds (0 = default) and the default from `seconds`.
export function readSecs(node) {
  const g = parseFloat(W(node, "seconds")?.value);
  return { def: isNaN(g) || g <= 0 ? 1 : g, list: fcParseShotSeconds(W(node, "shot_seconds")?.value) };
}

export function writeSecs(node, list) {
  const out = list.map((v) => (v > 0 ? v : 0));
  while (out.length && out[out.length - 1] === 0) out.pop();
  setWidget(node, "shot_seconds", out.join(", "));
}

export function imageUrl(name) {
  const k = name.lastIndexOf("/");
  const sub = k >= 0 ? name.slice(0, k) : "", file = k >= 0 ? name.slice(k + 1) : name;
  return api.apiURL(`/view?filename=${encodeURIComponent(file)}&subfolder=${encodeURIComponent(sub)}&type=input`);
}

export async function uploadImage(file) {
  const fd = new FormData();
  fd.append("image", file);
  fd.append("subfolder", "infinite_movie");
  fd.append("type", "input");
  const r = await api.fetchApi("/upload/image", { method: "POST", body: fd });
  if (r.status !== 200) { fcReviewToast(`Upload failed: ${r.status}`, "#d93025"); return null; }
  const j = await r.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

export async function importFolder() {
  const path = await fcPickFolder("", "Folder with the images for the film");
  if (!path) return null;
  const r = await api.fetchApi("/infinite_movie/import_folder", { method: "POST", body: JSON.stringify({ path }) });
  let j = {};
  try { j = await r.json(); } catch { j = { ok: false, error: `HTTP ${r.status}` }; }
  if (!j.ok) { fcReviewToast(j.error || "Folder import failed", "#d93025"); return null; }
  if (j.skipped) fcReviewToast(`${j.skipped} more images skipped (max ${MAX_SHOTS})`, "#e68929");
  return j.images || [];
}

// Film format from the Settings node (user: "format comes from settings"). Ratio only matters for the tiles.
export function shotFormat(node, firstImg) {
  const s = node.graph?._nodes?.find((n) => n.comfyClass === "InfiniteMovieSettings" && (n.mode ?? 0) === 0);
  const aspect = W(s || {}, "aspect")?.value, long = W(s || {}, "long_side")?.value;
  if (aspect === "from images") {
    const w = firstImg?.naturalWidth, h = firstImg?.naturalHeight;
    if (w && h) return { w, h, label: `from image 1 · ${w}×${h}` };
    return { w: 4, h: 5, label: "from image 1" };
  }
  const [w, h] = imResolveSize(aspect || "4:5", long || 960);
  return { w, h, label: `${(/^\d+:\d+/.exec(aspect || "") || ["4:5"])[0]} · ${w}×${h}` };
}
