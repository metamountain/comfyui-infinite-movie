import { app } from "../../scripts/app.js";
import { IMG, fcActive, fcReviewToast, getLink, interleave } from "./im_common.js";
import { addImageCounter, addImageLayers } from "./im_images.js";
import { _fcSetupWidgetHooks, addPromptForNewImage, layoutPrompts, pruneStaleInputs, reconcileChain, removeStaleModeAPs, slotIndex } from "./im_prompts.js";
import { imToggleWidget } from "./im_settings.js";
function addLayoutButton(node) {
  if (node.widgets?.find((w) => w.name === "🔗 AUTO LAYOUT")) return;
  const w = node.addWidget("button", "🔗 AUTO LAYOUT", null, () => {
    // (a) check the prompt chain
    reconcileChain(node);
    // (b) sync: Director → Cut → Even Motion, each only if the input is free (116, 2026-11-13).
    // By TYPE: the output name is the display name ("sync ▶ Cut"), not "sync".
    const assemble = node.graph?._nodes?.find((n) => n.comfyClass === "InfiniteMovieAssemble");
    const cutNode = node.graph?._nodes?.find((n) => n.comfyClass === "InfiniteMovieChooser");
    const syncLink = (from, to) => {
      if (!from || !to) return;
      const oi = (from.outputs || []).findIndex((o) => o.type === "SYNC");
      const ii = (to.inputs || []).findIndex((i) => i.type === "SYNC" || i.name === "sync");
      if (oi >= 0 && ii >= 0 && to.inputs[ii].link == null) from.connect(oi, to, ii);
    };
    if (cutNode) {
      syncLink(node, cutNode);
      syncLink(cutNode, assemble);
    } else {
      console.warn("[InfiniteMovie] AUTO LAYOUT: no Cut node found.");
      fcReviewToast("AUTO LAYOUT: no Cut node found", "#d93025");
    }
    // (c) 57e 14e: the sync pipe wins – redundant STRING links Director→Assemble
    // (segment_paths/save_folder/save_name) are removed once sync is connected.
    if (assemble) {
      const g = node.graph;
      // 73: segments/save_folder/save_name are no longer Assemble inputs ->
      // no redundant links possible anymore (list empty).
      const redundant = [];
      const toRemove = [];
      for (const lid of Object.keys(g.links || {})) {
        const l = g.links[lid];
        if (!l || l.origin_id !== node.id || l.target_id !== assemble.id) continue;
        if (l.type !== "STRING") continue;
        const tname = assemble.inputs?.[l.target_slot]?.name;
        if (redundant.includes(tname)) toRemove.push(lid);
      }
      for (const lid of toRemove) {
        const l = g.links[lid];
        const tslot = l.target_slot;
        if (assemble.inputs?.[tslot]) assemble.inputs[tslot].link = null;
        g.removeLink(lid);
      }
    }
    // (d) 57c2: wire the settings chain (replaces the star wiring)
    wireSettingsChain(node);
    // (e) layout of the whole workflow WITHOUT the engine (user 2026-11-03: „exclude the engine, but the rest“),
    // web/infinite_movie_layout.js; fallback the old prompt arrangement. layoutEngines is no longer called.
    if (window.fcWorkflowLayout) window.fcWorkflowLayout(node);
    else layoutPrompts(node);
    node.setDirtyCanvas?.(true, true);
  });
  // 2026-11-11 (user: "auto layout button really big? 3 rows? it is important"): the core button widget draws with
  // a fixed row height, so it is swapped for a custom widget: three rows high, green, bold. Same name + callback
  // (other code calls widgets.find(name).callback()).
  const cb = w.callback;
  node.widgets.splice(node.widgets.indexOf(w), 1);
  const H = 3 * (globalThis.LiteGraph?.NODE_WIDGET_HEIGHT || 20) + 10;
  node.addCustomWidget({
    name: "🔗 AUTO LAYOUT",
    type: "im_bigbutton",
    value: null,
    serialize: false,
    callback: cb,
    tooltip: "Check & arrange: prompt count, wiring, positions. Connects the settings chain up to the Director and sync: Director → Cut → Even Motion.",
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
      ctx.fillText("🔗 AUTO LAYOUT", x + bw / 2, yy + h / 2);
      ctx.restore();
    },
    mouse(e, pos, n) {
      const t = e.type;
      if (t === "pointerdown" || t === "mousedown") { this._down = true; n.setDirtyCanvas(true, false); return true; }
      if (t === "pointerup" || t === "mouseup") {
        if (this._down) { this._down = false; this.callback?.(); n.setDirtyCanvas(true, true); }
        return true;
      }
      return false;
    },
  });
}

// New image on InfiniteMovieRender -> automatically create a film Auto Prompt (user 2026-10-26, task 23 package A).
// Wiring only via input names. Loop: the closing prompt (last image -> image 1) moves to the
// new last slot and gets the new image as start; the new prompt fills the gap before it.
// 57c2: settings chain – Settings → Auto Prompts (in director input order,
// intro top … closing bottom) → Director → Assemble. Replaces the
// star wiring (57d): every consumer passes the settings on to the next,
// hence no more crossings. Only if EXACTLY ONE settings node exists, otherwise
// toast + touch nothing. Idempotent: computes the target chain and wires it
// (connect replaces existing settings links at the target). New/removed prompts slot in
// automatically or are bridged (predecessor directly with successor).
// 57c2: settings output index. The display name is "settings ▶ chain" (not "settings"),
// hence look up by type SETTINGS (or prefix), never by exact name.
function settingsOutIdx(node) {
  const outs = node.outputs || [];
  const byType = outs.findIndex((o) => o.type === "SETTINGS");
  if (byType >= 0) return byType;
  return outs.findIndex((o) => o.name && o.name.indexOf("settings") === 0);
}

export function wireSettingsChain(director) {
  const g = director?.graph;
  if (!g) return false;
  const nodes = g._nodes || [];
  const snodes = nodes.filter((n) => n.comfyClass === "InfiniteMovieSettings");
  if (snodes.length !== 1) {
    if (snodes.length > 1) fcReviewToast("Settings-Kette: genau EINE Settings-Node erwartet (" + snodes.length + " gefunden)", "#d93025");
    return false;
  }
  const snode = snodes[0];
  const soi = settingsOutIdx(snode);
  if (soi < 0) return false;
  // APs in director input order (prompt target slot; unconnected ones to the end by pos).
  const aps = [];
  for (const n of nodes) {
    if (n.comfyClass !== "InfiniteMovieAutoPrompt" || !fcActive(n)) continue;
    const outIdx = (n.outputs || []).findIndex((o) => o.name === "prompt");
    let slot = -1;
    if (outIdx >= 0 && n.outputs[outIdx].links?.length) {
      for (const lid of n.outputs[outIdx].links) {
        const l = getLink(g, lid);
        if (l && l.target_id === director.id) { slot = l.target_slot; break; }
      }
    }
    aps.push({ node: n, slot: slot });
  }
  aps.sort((a, b) => {
    if (a.slot >= 0 && b.slot >= 0) return a.slot - b.slot;
    if (a.slot >= 0) return -1;
    if (b.slot >= 0) return 1;
    return a.node.pos[1] - b.node.pos[1];
  });
  // Kette: Settings → AP0 → … → APn → Director → Assemble.
  // 66: Prompt Style (falls vorhanden) direkt hinter Settings
  const style = nodes.find((n) => n.comfyClass === "InfiniteMovieStyle" && (n.mode ?? 0) === 0);
  // 2026-11-11: Story Mode (LLM) is not in the chain - it plugs into Settings › "LLM".
  const story = nodes.find((n) => n.comfyClass === "InfiniteMovieStoryMode");
  const llmIn = slotIndex(snode, "llm");
  if (story && llmIn >= 0 && snode.inputs[llmIn].link == null && story.outputs?.length) story.connect(0, snode, llmIn);
  const chainNodes = [snode, ...(style ? [style] : []), ...aps.map((a) => a.node), director];
  // 2026-11-13 (user: "settings in sync absorbieren"): the chain ends at the Director - behind it the settings travel
  // inside sync (Director → Cut → Even Motion is wired by syncLink in the AUTO LAYOUT button).
  for (let i = 0; i < chainNodes.length - 1; i++) {
    const prev = chainNodes[i];
    const next = chainNodes[i + 1];
    const pi = settingsOutIdx(prev);
    const ni = slotIndex(next, "settings");
    if (pi < 0 || ni < 0) continue;
    const cur = next.inputs[ni].link != null ? getLink(g, next.inputs[ni].link) : null;
    if (cur && cur.origin_id === prev.id && cur.origin_slot === pi) continue; // already correct
    prev.connect(pi, next, ni);
  }
  g.setDirtyCanvas?.(true, true);
  return true;
}

app.registerExtension({
  name: "InfiniteMovie.InterleavedPrompts",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "InfiniteMovieRender") return;
    const prevOnConf = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      this._fcReady = false;
      const r = prevOnConf?.apply(this, args);
      // 57b2 fix: warning if the first widget value is a preset name
      // (widget shift: saved OLD set vs. current NEW set).
      const wv = this.widgets?.[0]?.value;
      if (typeof wv === "string" && /^(ltx25|wan22|hunyuan_video)/.test(wv)) {
        console.warn(
          `[InfiniteMovie] Director-Node ${this.id}: erster Widget-Wert "${wv}" sieht aus wie ein ` +
          `Preset-Name (alter Stand). widgets_values könnten verschoben sein – ` +
          `tools/migrate_workflows.py ausführen.`
        );
      }
      setTimeout(() => {
        try {
          pruneStaleInputs(this);
          reconcileChain(this);
          interleave(this);
          _fcSetupWidgetHooks(this);
          addLayoutButton(this);
          addImageCounter(this);
          addImageLayers(this);
          // 82: shot_seconds is edited in Choose (⏱) – hidden in the node.
          imToggleWidget(this.widgets?.find((w) => w.name === "shot_seconds"), false);
          this.setSize([this.size[0], this.computeSize()[1]]);
          this._fcReady = true;
        } catch (e) { console.error("[InfiniteMovie] onConfigure error:", e); }
      }, 500);
      return r;
    };
  },
  setup() {
    // Mute/bypass of a LoadImage (Ctrl+M/B sets node.mode directly, no event) -> reconcile.
    let fcModeSig = "";
    setInterval(() => {
      const gr = app.graph;
      if (!gr?._nodes) return;
      const sig = gr._nodes.filter((n) => (n.outputs || []).some((o) => o.type === "IMAGE"))
        .map((n) => n.id + ":" + (n.mode ?? 0)).join(",");
      if (sig === fcModeSig) return;
      const first = fcModeSig === "";
      fcModeSig = sig;
      if (first) return;                      // on load, onConfigure does the reconcile
      for (const n of gr._nodes) {
        if (n.comfyClass === "InfiniteMovieRender" && n._fcReady) {
          reconcileChain(n);
          removeStaleModeAPs(n);
          gr.setDirtyCanvas?.(true, true);
        }
      }
    }, 400);
    // Parity after manual deletion (user 2026-10-28: "when I delete them manually, they
    // get replaced automatically"): removed AutoPrompt/LoadImage nodes trigger the reconcile.
    const g = app.graph;
    if (g && !g._fcRemovedWrapped) {
      g._fcRemovedWrapped = true;
      const orig = g.onNodeRemoved;
      g.onNodeRemoved = function (node, ...rest) {
        const r = orig?.apply(this, [node, ...rest]);
        if (node && (node.comfyClass === "InfiniteMovieAutoPrompt" || (node.outputs || []).some((o) => o.type === "IMAGE"))) {
          for (const n of this._nodes || []) {
            if (n.comfyClass === "InfiniteMovieRender") {
              clearTimeout(n._fcRecT);
              n._fcRecT = setTimeout(() => reconcileChain(n), 120);
            }
          }
        }
        return r;
      };
    }
  },
  nodeCreated(node) {
    if (node.comfyClass !== "InfiniteMovieRender") return;
    addLayoutButton(node);
    addImageCounter(node);
    addImageLayers(node);
    // 82: shot_seconds is edited in Choose (⏱) – hidden in the node.
    setTimeout(() => {
      imToggleWidget(node.widgets?.find((w) => w.name === "shot_seconds"), false);
      node.setSize([node.size[0], node.computeSize()[1]]);
    }, 0);
    const onConn = node.onConnectionsChange;
    node.onConnectionsChange = function (type, slot, connected, ...rest) {
      const r = onConn?.apply(this, [type, slot, connected, ...rest]);
      const name = this.inputs?.[slot]?.name;
      if (this._fcReady && connected && type === (globalThis.LiteGraph?.INPUT ?? 1) && name?.startsWith(IMG)) {
        setTimeout(() => addPromptForNewImage(this, name), 0);
      }
      setTimeout(() => interleave(this), 0);
      return r;
    };
  },
});

// 116a (2026-11-13): the 57b/57b2 load migration (movie -> shots, old pipe type name)
// was removed without replacement (user decision: no users, no backward compatibility).

