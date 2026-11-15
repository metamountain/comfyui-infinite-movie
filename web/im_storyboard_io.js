// Director storyboard <-> widgets, server and Settings (the view is web/im_storyboard.js, the rules
// web/im_storyboard_model.js). Widget `storyboard` = JSON [{image, prompt, own, pair, cut?}], image relative to ComfyUI's
// input folder ("" = empty); the seconds of each film live in the `shot_seconds` widget (Cut's ⏱ edits it too).
import { api } from "../../scripts/api.js";
import { fcParseShotSeconds, fcReviewToast, imParseStoryboard, imWidget, settingsNodeOf } from "./im_common.js";
import { imResolveSize } from "./im_settings.js";
import { DEFAULT_IMAGES, MAX_IMAGES, emptyRow, toRow } from "./im_storyboard_model.js";

function setWidget(node, name, text) {
  const w = imWidget(node, name);
  if (!w || w.value === text) return;
  const old = w.value;
  w.value = text;
  w.callback?.(text);
  node.onWidgetChanged?.(name, text, old, w);
  node.graph?.incrementVersion?.();
}

export function readRows(node) {
  const secs = fcParseShotSeconds(imWidget(node, "shot_seconds")?.value);
  const rows = imParseStoryboard(node).slice(0, MAX_IMAGES).map((e, i) => toRow(e, secs[i]));
  return rows.length ? rows : Array.from({ length: DEFAULT_IMAGES }, emptyRow);
}

export function writeRows(node, rows) {
  rows = rows.slice(0, MAX_IMAGES);
  setWidget(node, "storyboard", JSON.stringify(rows.map(({ image, prompt, own, pair, cut }) =>
    (cut ? { image, prompt, own, pair, cut } : { image, prompt, own, pair }))));
  const secs = rows.map((r) => r.sec);
  while (secs.length && !secs.at(-1)) secs.pop();
  setWidget(node, "shot_seconds", secs.join(", "));
}

export const isLoop = (node) => !!imWidget(node, "loop")?.value;

export function defaultSeconds(node) {
  const g = parseFloat(imWidget(node, "seconds")?.value);
  return g > 0 ? g : 1;
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

// Film format from the Settings node in the Director's settings chain (user: "format comes from settings") -
// the same node the render reads. Not connected -> the render defaults (4:5).
export function boardFormat(node, firstImg) {
  const s = settingsNodeOf(node);
  const aspect = imWidget(s, "aspect")?.value, long = imWidget(s, "long_side")?.value;
  if (aspect === "from images") {
    const w = firstImg?.naturalWidth, h = firstImg?.naturalHeight;
    return w && h ? { w, h, label: `from image 1 · ${w}×${h}` } : { w: 4, h: 5, label: "from image 1" };
  }
  const [w, h] = imResolveSize(aspect || "4:5", long || 960);
  return { w, h, label: `${(/^\d+:\d+/.exec(aspect || "") || ["4:5"])[0]} · ${w}×${h}` };
}
