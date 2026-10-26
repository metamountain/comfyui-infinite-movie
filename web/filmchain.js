// FilmChain: wired prompt slots sit directly below their image slot
// (image 1, prompt 1->2, image 2, prompt 2->3, ...). Nutzer 2026-10-26.
// Both groups are Autogrow inputs (nodes.py: "images" and "shot_prompts"); this only
// reorders node.inputs for display and fixes the link target slots afterwards.
import { app } from "../../scripts/app.js";

const IMG = "images.image";
const PR = "shot_prompts.prompt";

function slotKey(name) {
  if (name?.startsWith(IMG)) return [parseInt(name.slice(IMG.length), 10), 0];
  if (name?.startsWith(PR)) return [parseInt(name.slice(PR.length), 10), 1];
  return null;
}

function getLink(graph, id) {
  const links = graph?.links;
  if (!links) return null;
  return typeof links.get === "function" ? links.get(id) : links[id];
}

function interleave(node) {
  const ins = node.inputs;
  if (!ins?.length) return;
  const pos = [];
  ins.forEach((inp, k) => { if (slotKey(inp.name)) pos.push(k); });
  const sorted = pos.map((k) => ins[k]).sort((a, b) => {
    const x = slotKey(a.name), y = slotKey(b.name);
    return x[0] - y[0] || x[1] - y[1];
  });
  let changed = false;
  pos.forEach((k, j) => {
    if (ins[k] !== sorted[j]) { ins[k] = sorted[j]; changed = true; }
  });
  for (const inp of sorted) {
    const [i, kind] = slotKey(inp.name);
    inp.label = kind === 0 ? `image ${i + 1}` : `prompt ${i + 1} → ${i + 2}`;
  }
  if (!changed) return;
  ins.forEach((inp, k) => {
    if (inp.link != null) {
      const l = getLink(node.graph, inp.link);
      if (l) l.target_slot = k;
    }
  });
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "FilmChain.InterleavedPrompts",
  nodeCreated(node) {
    if (node.comfyClass !== "FilmChain") return;
    const onConn = node.onConnectionsChange;
    node.onConnectionsChange = function (...args) {
      const r = onConn?.apply(this, args);
      setTimeout(() => interleave(this), 0);
      return r;
    };
    const onConf = node.onConfigure;
    node.onConfigure = function (...args) {
      const r = onConf?.apply(this, args);
      setTimeout(() => interleave(this), 0);
      return r;
    };
    setTimeout(() => interleave(node), 0);
  },
});
