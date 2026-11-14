// Director node (InfiniteMovieRender): the storyboard (im_storyboard.js) and the big AUTO LAYOUT button, which wires
// Settings → Prompt Style → Director and sync Director → Cut → Even Motion, then arranges the workflow.
import { app } from "../../scripts/app.js";
import { fcReviewToast, getLink, imWidget } from "./im_common.js";
import { imToggleWidget } from "./im_settings.js";
import { addStoryboard, render as renderStoryboard } from "./im_storyboard.js";
import { fcWorkflowLayout } from "./infinite_movie_layout.js";

const LAYOUT = "🔗 AUTO LAYOUT";
const slotIndex = (node, name) => (node.inputs || []).findIndex((i) => i.name === name);
// Output slots by type: their names are display names ("settings ▶ chain", "sync ▶ Cut").
const outByType = (node, type) => (node.outputs || []).findIndex((o) => o.type === type);

// Connect `from`'s output of `type` to `to`'s input `name`, unless that link is already there.
function link(from, type, to, name) {
  const oi = outByType(from, type), ii = slotIndex(to, name);
  if (oi < 0 || ii < 0) return;
  const cur = to.inputs[ii].link != null ? getLink(to.graph, to.inputs[ii].link) : null;
  if (!cur || cur.origin_id !== from.id || cur.origin_slot !== oi) from.connect(oi, to, ii);
}

// Settings chain: Settings → Prompt Style (if active) → Director; behind the Director the settings travel in sync.
// Story Mode is not in the chain - it plugs into Settings › llm (only if that input is free).
function wireSettingsChain(director) {
  const nodes = director.graph?._nodes || [];
  const settings = nodes.filter((n) => n.comfyClass === "InfiniteMovieSettings");
  if (settings.length !== 1) {
    if (settings.length > 1) fcReviewToast(`Settings chain: exactly ONE Settings node expected (${settings.length} found)`, "#d93025");
    return;
  }
  const [s] = settings;
  const story = nodes.find((n) => n.comfyClass === "InfiniteMovieStoryMode");
  const llmIn = slotIndex(s, "llm");
  if (story?.outputs?.length && llmIn >= 0 && s.inputs[llmIn].link == null) story.connect(0, s, llmIn);
  const style = nodes.find((n) => n.comfyClass === "InfiniteMovieStyle" && (n.mode ?? 0) === 0);
  const chain = [s, ...(style ? [style] : []), director];
  for (let i = 0; i < chain.length - 1; i++) link(chain[i], "SETTINGS", chain[i + 1], "settings");
}

// sync Director → Cut → Even Motion, each only into a free input.
function wireSync(director) {
  const find = (cls) => director.graph?._nodes?.find((n) => n.comfyClass === cls);
  const cut = find("InfiniteMovieChooser"), even = find("InfiniteMovieAssemble");
  if (!cut) { fcReviewToast("AUTO LAYOUT: no Cut node found", "#d93025"); return; }
  for (const [from, to] of [[director, cut], [cut, even]]) {
    if (to && to.inputs?.[slotIndex(to, "sync")]?.link == null) link(from, "SYNC", to, "sync");
  }
}

function autoLayout(node) {
  wireSync(node);
  wireSettingsChain(node);
  fcWorkflowLayout(node);
  node.setDirtyCanvas?.(true, true);
}

// User 2026-11-11 ("auto layout button really big? 3 rows? it is important"): a core button widget has a fixed row
// height, so this is a custom widget - three rows high, green, bold.
function addLayoutButton(node) {
  if (imWidget(node, LAYOUT)) return;
  const H = 3 * (globalThis.LiteGraph?.NODE_WIDGET_HEIGHT || 20) + 10;
  node.addCustomWidget({
    name: LAYOUT,
    type: "im_bigbutton",
    value: null,
    serialize: false,
    callback: () => autoLayout(node),
    tooltip: "Wires Settings → Prompt Style → Director and sync Director → Cut → Even Motion, then arranges the workflow.",
    computeSize: (width) => [width, H],
    draw(ctx, n, width, y) {
      const m = 15, h = H - 8, x = m, bw = width - 2 * m, yy = y + 4;
      ctx.save();
      ctx.fillStyle = this._down ? "#1d7a48" : "#2a6";
      ctx.strokeStyle = "#7fd8a6";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, yy, bw, h, 8); else ctx.rect(x, yy, bw, h);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 22px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(LAYOUT, x + bw / 2, yy + h / 2);
      ctx.restore();
    },
    mouse(e, pos, n) {
      const t = e.type;
      if (t === "pointerdown" || t === "mousedown") { this._down = true; n.setDirtyCanvas(true, false); return true; }
      if (t === "pointerup" || t === "mouseup") {
        if (this._down) { this._down = false; this.callback(); n.setDirtyCanvas(true, true); }
        return true;
      }
      return false;
    },
  });
}

// storyboard (JSON), shot_seconds and regen are written by the storyboard - hidden as widgets.
function hideDataWidgets(node) {
  for (const k of ["storyboard", "shot_seconds", "regen"]) imToggleWidget(imWidget(node, k), false);
  node.setSize([node.size[0], node.computeSize()[1]]);
}

app.registerExtension({
  name: "InfiniteMovie.Director",
  nodeCreated(node) {
    if (node.comfyClass !== "InfiniteMovieRender") return;
    addLayoutButton(node);
    addStoryboard(node);
    setTimeout(() => hideDataWidgets(node), 0);
    // A loaded workflow sets the widget values after nodeCreated: draw the storyboard from them.
    const onConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
      const r = onConfigure?.apply(this, args);
      setTimeout(() => { renderStoryboard(this); hideDataWidgets(this); }, 0);
      return r;
    };
  },
});
