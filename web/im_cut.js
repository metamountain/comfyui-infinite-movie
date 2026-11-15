import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { FC_REVIEW_LINE_COLORS, fcQueueFixedSeeds, fcReviewToast, fcShotSecondsOf, getLink, imFilmCount, imParseStoryboard } from "./im_common.js";
import { fcChooseDirectorOf, fcChooseEditPrompt, fcChooseEditSeconds, fcRerenderMarked } from "./im_cut_edit.js";
import { FC_CHOOSE_BIG_H, FC_CHOOSE_GAP, FC_CHOOSE_PAD, FC_CHOOSE_ROW_GAP, FC_CHOOSE_STATUS_H, fcAsmFocus, fcChooseApplyActive, fcChooseEff, fcChooseEffective, fcChooseEntries, fcChooseFocus, fcChooseGetChoices, fcChooseLayout, fcChoosePick, fcChoosePlay, fcChooseQuality, fcChooseSig, fcChooseStableUrl, fcChooseStatus, fcChooseWidth, fcRun } from "./im_cut_state.js";
import { fcDownstreamOutputs } from "./im_film.js";
import { fmtTime, renderEstimate } from "./im_progress.js";
import { imToggleWidget } from "./im_settings.js";
import { imSyncSet } from "./im_sync.js";

// Cut marks of the Director's board: part of the redraw signature (a ✂ in the Director redraws Cut).
const fcCutSig = (node) => imParseStoryboard(fcChooseDirectorOf(node)).map((r) => (r.cut ? "1" : "0")).join("");
export function fcChooseRender(node) {
  let el = node._fc_choose_el;
  if (!el) {
    el = document.createElement("div");
    el.style.cssText = "width:100%;box-sizing:border-box;position:relative;display:flex;flex-direction:column;gap:" + FC_CHOOSE_GAP + "px;";
    const domW = node.addDOMWidget("fc_choose", "div", el, {
      serialize: false,
      getMinHeight: () => fcChooseLayout(node, fcChooseEntries(node)).domH,
      getMaxHeight: () => fcChooseLayout(node, fcChooseEntries(node)).domH,
    });
    domW.serialize = false;   // the option alone does not keep it out of widgets_values
    // 79 (user 2026-11-03: Choose „halved“): the frontend takes the frame width from widget.width
    // (DomWidgets updateWidgets: (n.width ?? node.width) - 2*margin). widget.width stayed at an old,
    // smaller value (624) when Choose grew -> right shots cut off. Always the node width.
    if (domW) Object.defineProperty(domW, "width", { get: () => node.size[0], set() {}, configurable: true });
    node._fc_choose_el = el;
    // 77 (user 2026-11-03: „half covered … was ok until I pressed Render“): the frontend clips
    // DOM widgets where the SELECTED element is (Comfy.DOMClippingEnabled, useDomClipping) –
    // a selected group/node over Choose made the right shots disappear. Off for Choose.
    const unclip = () => {
      const w = el.parentElement;
      if (w && w.style.clipPath && w.style.clipPath !== "none") w.style.clipPath = "none";
    };
    setTimeout(() => {
      const w = el.parentElement;
      if (!w) return;
      unclip();
      new MutationObserver(unclip).observe(w, { attributes: true, attributeFilter: ["style"] });
    }, 0);
  }
  const entries = fcChooseEntries(node);
  const sig = fcChooseSig(entries) + fcCutSig(node);
  node._fc_choose_sig = sig;
  const { iw, ih, row, boardH, tops, heights, cutY } = fcChooseLayout(node, entries);
  const nodeW = fcChooseWidth(node, entries);
  const marked = node.properties.marked || [];
  const choices = fcChooseGetChoices(node);
  el.innerHTML = "";

  if (entries.length) {
    // 124d: one row per film at the height of the Director's prompt box of that film (staggered half a row):
    // tiles on the left, info box on the right – Director and Cut read across.
    const board = document.createElement("div");
    board.style.cssText = `position:relative;height:${boardH}px;`;
    el.appendChild(board);
    // Director rows marked cut: that film ends open, a hard cut follows (live from the board, else the last run)
    const sb = imParseStoryboard(fcChooseDirectorOf(node));
    const isCut = (e, i) => (sb.length > 1 ? !!sb[i]?.cut : !!e.cut);
    entries.forEach((e, i) => {
      const top = tops[i], rh = heights[i];   // = the Director's prompt box i
      const cut = isCut(e, i);
      if (cut) {
        // the Director's cut line, mirrored: thin black line in the gap below this film's row
        const ln = document.createElement("div");
        ln.className = "fc-cut-line";
        ln.title = "Hard cut: this film ends open, the next one starts fresh at its own image";
        ln.style.cssText = `position:absolute;left:0;right:0;top:${(cutY[i] ?? top + ih + (row - ih) / 2) - 2}px;height:4px;` +
          "background:#000;border-radius:2px;pointer-events:none;";
        board.appendChild(ln);
      }

      const isMarked = !e.placeholder && marked.includes(e.number);
      const toggleRedo = () => {
        if (fcRun.running || e.placeholder) return;
        const m = (node.properties.marked || []).slice();
        const k = m.indexOf(e.number);
        if (k >= 0) m.splice(k, 1); else m.push(e.number);
        node.properties.marked = m;
        if (k >= 0) setRejected([]);   // KEEP again: forget the rejection
        fcChooseRender(node);
      };
      const rej = (node.properties.rejected ||= {});
      const rejected = rej[e.number] || [];
      const setRejected = (arr) => { if (arr.length) rej[e.number] = arr; else delete rej[e.number]; };
      const setMarked = (on) => {
        const m = (node.properties.marked || []).filter((x) => x !== e.number);
        if (on) m.push(e.number);
        node.properties.marked = m;
      };

      const eff = e.placeholder ? null : fcChooseEff(e, choices[i]);
      const isAuto = !e.placeholder && choices[i] !== "a" && choices[i] !== "b";
      const canPick = !e.placeholder && !!e.has_variants;
      const letters = e.has_variants ? ["a", "b"] : ["a"];
      for (const k of letters) {
        const v = e[k] || {};
        const sel = e.has_variants && eff === k;
        const pending = !e.placeholder && !!node._fc_redo_pending?.[e.number]?.includes(k);
        const dim = !e.placeholder && (pending || isMarked || (e.has_variants && !sel));
        const t = document.createElement("div");
        t.className = `fc-tile-${k}`;
        t.dataset.fcI = String(i);
        t.addEventListener("mouseenter", () => {
          node._fc_choose_active = i; fcChooseApplyActive(node);
          if (v.video) fcChoosePlay(node, e.number, e.has_variants ? k.toUpperCase() : "", v.video, true);   // player shows the hovered film
          imSyncSet("seg", i);
        });
        t.addEventListener("mouseleave", () => { node._fc_choose_active = -1; fcChooseApplyActive(node); imSyncSet("film", null); });
        t.style.cssText = `position:absolute;top:${top}px;left:${letters.indexOf(k) * (iw + FC_CHOOSE_ROW_GAP)}px;width:${iw}px;height:${rh}px;background:#1a1a1a;border-radius:3px;` +
          `overflow:hidden;box-sizing:border-box;cursor:${e.placeholder ? "default" : "pointer"};` +
          (e.placeholder ? "border:1px dashed #555;" : isMarked ? "outline:5px solid #d93025;outline-offset:-5px;"
            : sel || !e.has_variants ? "outline:5px solid #2ea043;outline-offset:-5px;" : "");
        t.title = v.info || "";
        const img = document.createElement("img");
        img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;" +
          (dim ? "opacity:0.35;filter:grayscale(0.8);" : "");
        t.appendChild(img);
        // 119: live middle frame while this segment is rendering (segment_done, per-shot JPEG).
        // fcChooseApplyActive never touches placeholder tiles (no v.still) -> the src stays.
        if (e.placeholder && node._fc_live?.[i]?.url) img.src = node._fc_live[i].url;
        if (!e.placeholder) {
          const lab = document.createElement("div");
          const on = sel || !e.has_variants;
          const no = isMarked || rejected.includes(k);
          const tag = `${e.number}${e.has_variants ? k.toUpperCase() : ""}`;   // film number + variant, e.g. "1A"
          lab.textContent = pending ? `↻ ${tag} new render…` : isMarked ? `✗ ${tag} REDO` : no ? `✗ ${tag}`
            : e.has_variants ? (sel ? `✓ ${tag}${isAuto && e.auto_strong ? " · AUTO" : ""}` : tag) : `✓ ${tag}`;
          lab.style.cssText = "position:absolute;top:8px;left:8px;padding:3px 10px;border-radius:12px;font:bold 16px sans-serif;" +
            `color:#fff;background:${pending ? "#1f6feb" : no ? "#d93025" : on ? "#2ea043" : "rgba(0,0,0,0.6)"};`;
          t.appendChild(lab);
        }
        if (isMarked) {
          const x = document.createElement("div");
          x.textContent = "✗";
          x.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
            "font:bold 110px sans-serif;color:rgba(217,48,37,0.85);pointer-events:none;";
          t.appendChild(x);
        }
        const line = document.createElement("div");
        line.style.cssText = `position:absolute;top:0;left:0;right:0;height:2px;background:${FC_REVIEW_LINE_COLORS[v.level] || "transparent"};`;
        t.appendChild(line);
        // 136: the same actions the tile click performs, callable from the preview overlay.
        const useVariant = () => {
          if (fcRun.running) return;
          if (!canPick) return toggleRedo();
          if (isMarked) { setRejected([]); setMarked(false); }
          else setRejected(rejected.filter((x) => x !== k));
          fcChoosePick(node, i, k);
        };
        const rejectVariant = () => {
          if (fcRun.running) return;
          if (!canPick) return toggleRedo();
          const other = k === "a" ? "b" : "a";
          if (eff === k) {
            if (rejected.includes(other)) { setRejected(["a", "b"]); setMarked(true); fcChooseRender(node); }
            else { setRejected([...rejected, k]); fcChoosePick(node, i, other); }
          } else {
            setRejected([...rejected, k]);
            if (rejected.includes(other)) { setMarked(true); fcChooseRender(node); }
            else fcChoosePick(node, i, other);
          }
        };
        // 136: eye icon top right -> the segment's video as a big overlay over the node DOM.
        if (!e.placeholder && v.video) {
          const eye = document.createElement("div");
          eye.className = "fc-eye";
          eye.style.cssText = "position:absolute;top:6px;right:6px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;" +
            "cursor:pointer;opacity:0.7;filter:drop-shadow(0 0 1px #000);";
          eye.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" stroke-width="1.25" ' +
            'stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/>' +
            '<circle cx="12" cy="12" r="3"/></svg>';
          eye.title = "Open preview";
          eye.addEventListener("mouseenter", () => { eye.style.opacity = "1"; });
          eye.addEventListener("mouseleave", () => { eye.style.opacity = "0.7"; });
          eye.addEventListener("click", (ev) => {
            ev.stopPropagation();   // the tile must not select/reject
            fcEyeOverlay(el, {
              url: fcChooseStableUrl(v.video),
              variants: e.has_variants
                ? { a: e.a?.video ? fcChooseStableUrl(e.a.video) : "", b: e.b?.video ? fcChooseStableUrl(e.b.video) : "" }
                : null,
              onUse: useVariant,
              onReject: rejectVariant,
            });
          });
          t.appendChild(eye);
        }
        if (!e.placeholder) t.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (fcRun.running) return;
          if (!canPick) return toggleRedo();
          // user 2026-11-03: „with 2, both must be rejectable, then rerender“
          if (isMarked) { setRejected([]); setMarked(false); fcChoosePick(node, i, k); return; }
          if (eff === k) {                       // reject the chosen variant
            const other = k === "a" ? "b" : "a";
            if (rejected.includes(other)) { setRejected(["a", "b"]); setMarked(true); fcChooseRender(node); }
            else { setRejected([...rejected, k]); fcChoosePick(node, i, other); }
          } else {                               // choose the other/rejected variant
            setRejected(rejected.filter((x) => x !== k));
            fcChoosePick(node, i, k);
          }
        });
        t.title = e.placeholder ? "" : (canPick
          ? (sel ? `Hover: play · click: reject ${k.toUpperCase()}` : `Hover: play · click: use ${k.toUpperCase()}`)
          : "Hover: play · click: keep / redo") + (v.info ? "\n" + v.info : "");
        board.appendChild(t);
      }
      // Info box right of the tiles: light, status, length / prompt / play, seam.
      const ix = letters.length * (iw + FC_CHOOSE_ROW_GAP);
      const info = document.createElement("div");
      info.className = "fc-info";
      info.style.cssText = `position:absolute;top:${top}px;left:${ix}px;width:${iw}px;height:${rh}px;` +
        "box-sizing:border-box;background:#262626;border:1px solid #4a4a4a;border-radius:5px;padding:6px;" +
        "display:flex;flex-direction:column;gap:6px;font:12px sans-serif;color:#bbb;overflow:hidden;";
      const effV = e.placeholder ? {} : (e[eff] || e.a || {});
      const pendingAny = !e.placeholder && !!node._fc_redo_pending?.[e.number]?.length;
      const light = isMarked || rejected.length ? "#d93025" : (pendingAny || (e.placeholder && fcRun.running)) ? "#44aaff"
        : e.placeholder ? "#e6c229" : "#2ea043";
      const nextNo = cut ? "open" : e.seam_next || (i + 1 < entries.length ? i + 2 : 1);
      const hd = document.createElement("div");
      hd.style.cssText = "display:flex;align-items:center;gap:6px;font:bold 12px sans-serif;color:#ddd;";
      hd.innerHTML = `<span style="width:10px;height:10px;border-radius:50%;background:${light};flex:none"></span>` +
        `<span>Film ${e.number} · ${e.number} → ${nextNo}</span>`;
      const q = e.placeholder ? null : fcChooseQuality(effV, e);
      const liveT = node._fc_live?.[i]?.seconds != null ? `⏱ ${fmtTime(node._fc_live[i].seconds)}` : "";
      const stx = document.createElement("div");
      stx.textContent = isMarked ? "✗ marked – re-render"
        : pendingAny ? (fcRun.running ? (liveT || "waiting for render…") : "queued for re-render")
        : e.placeholder ? (fcRun.running ? (liveT || "waiting for render…") : "not rendered yet")
        : `${e.has_variants ? eff.toUpperCase() + " used · " : ""}${q.text}`;
      if (q && !isMarked && !pendingAny) stx.style.color = q.color;
      stx.title = (e.auto_reason || "") + (effV.info ? "\n" + effV.info : "");
      const mkBtn = (txt, title, fn) => {
        const b = document.createElement("div");
        b.className = "fc-keep";
        b.textContent = txt;
        b.title = title;
        b.style.cssText = "padding:0 8px;height:22px;line-height:22px;font:bold 12px sans-serif;color:#ccc;background:#333;" +
          "border:1px solid #555;border-radius:4px;cursor:pointer;user-select:none;";
        b.style.opacity = fcRun.running ? "0.35" : "1";
        b.addEventListener("click", (ev) => { ev.stopPropagation(); if (!fcRun.running) fn(); });
        return b;
      };
      const ctl = document.createElement("div");
      ctl.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;";
      if (!e.placeholder) {
        const secs = fcShotSecondsOf(fcChooseDirectorOf(node), e.number);
        ctl.appendChild(mkBtn(`⏱ ${secs % 1 === 0 ? secs.toFixed(0) : secs.toFixed(1)} s`,
          "Set this film's length – saving marks it for re-render", () => fcChooseEditSeconds(node, info, e, setMarked)));
        ctl.appendChild(mkBtn("✎ prompt", "Edit this film's prompt – saving marks it for re-render",
          () => fcChooseEditPrompt(node, info, e, setMarked)));
        if (effV.video) ctl.appendChild(mkBtn("▶ play", "Play this film with sound in the Film player",
          () => fcChoosePlay(node, e.number, e.has_variants ? eff.toUpperCase() : "", effV.video)));
      }
      info.append(hd, stx, ctl);
      if (!e.placeholder && e.seam_next && !cut) {
        const sm = document.createElement("div");
        sm.textContent = `seam → Film ${e.seam_next} ${e.seam_bad ? "⚠" : "✓"} ${(+e.seam || 0).toFixed(1)}`;
        sm.style.color = e.seam_bad ? "#ff8a80" : "#8b949e";
        sm.title = "Jump between the last frame of this film and the first frame of the next (last run; red = hard jump).";
        info.appendChild(sm);
      }
      board.appendChild(info);
    });
  }

  const status = document.createElement("div");
  status.style.cssText = `height:${FC_CHOOSE_STATUS_H}px;display:flex;align-items:center;padding:0 8px;background:#202020;` +
    "border-radius:3px;font:13px sans-serif;white-space:nowrap;overflow:hidden;";
  const steps = document.createElement("div");
  // dark pill: the step labels stay readable on the neon progress fill behind them
  steps.style.cssText = "display:flex;align-items:center;gap:2px;font-size:11px;flex-shrink:0;background:rgba(20,20,20,0.85);padding:2px 6px;border-radius:3px;";
  const statusText = document.createElement("div");
  statusText.style.cssText = "margin-left:8px;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;";
  status.appendChild(steps);
  status.appendChild(statusText);
  el.appendChild(status);
  node._fc_choose_status = status;
  node._fc_choose_steps = steps;
  node._fc_choose_status_text = statusText;

  const btn = document.createElement("button");
  btn.style.cssText = `width:100%;height:${FC_CHOOSE_BIG_H}px;font:bold 18px sans-serif;color:#fff;border:1px solid;border-radius:4px;cursor:pointer;`;
  btn.addEventListener("click", () => {
    if (fcRun.running || btn._fc_mode === "busy") return;
    if (btn._fc_mode === "assemble") {
      node._fc_asm_t0 = Date.now();
      fcChooseStatus(node);
      // 116b4: partial run on Cut itself (it assembles the film, 116b2) + all active output nodes
      // downstream (Preview Image on last_frame, Movie to GIF, Save …) – otherwise they never run.
      // Seeds fixed -> the upstream chain comes from the cache. The old Film/Assemble search is gone.
      const targets = [String(node.id)];
      for (const id of fcDownstreamOutputs([String(node.id)])) if (!targets.includes(id)) targets.push(id);
      if (window.__fc_review_test_skip_queue) console.log("[InfiniteMovie] test: skipped queuePrompt (FILM)", JSON.stringify(targets));
      else Promise.resolve(fcQueueFixedSeeds(targets)).catch((err) => {
        node._fc_asm_t0 = null; fcChooseStatus(node);
        fcReviewToast("RENDER VIDEO could not be queued – see console", "#d93025");
        console.error("[InfiniteMovie] FILM queue failed", err);
      });
      fcReviewToast("RENDER VIDEO queued – building film…");
    } else if (btn._fc_mode === "rerender") {
      fcRerenderMarked(node, fcChooseRender);
    }
  });
  el.appendChild(btn);
  node._fc_choose_btn = btn;
  el.appendChild(status);   // 2026-11-05 (user): status/progress at the very bottom


  fcChooseStatus(node);
  fcChooseApplyActive(node);
  // Width = all shots (fixed image size), height = content.
  const want = [nodeW, node.computeSize()[1]];
  if (Math.abs(node.size[0] - want[0]) > 1 || Math.abs(node.size[1] - want[1]) > 1) node.setSize(want);
  node.setDirtyCanvas(true, true);
}

// 136: eye preview – the segment's own video as a big overlay over the whole Cut node DOM.
// The bottom buttons call the same functions as the tile click (use/reject), then the
// overlay closes. Close: ✕, Esc, or a click on the background.
function fcEyeOverlay(host, { url, variants = null, onUse, onReject }) {
  if (host.querySelector(":scope > .fc-eye-ov")) return null;   // one overlay at a time
  const ov = document.createElement("div");
  ov.className = "fc-eye-ov";
  ov.style.cssText = "position:absolute;inset:0;z-index:50;background:rgba(0,0,0,0.85);" +
    "display:flex;flex-direction:column;";
  const video = document.createElement("video");
  video.controls = true; video.autoplay = true; video.loop = true; video.muted = true; video.playsInline = true;
  video.style.cssText = "flex:1;width:100%;min-height:0;object-fit:contain;";
  video.src = url;
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;justify-content:center;gap:8px;padding:8px;flex:0 0 auto;";
  const mkBtn = (label, title, fn) => {
    const b = document.createElement("div");
    b.textContent = label;
    b.style.cssText = "min-width:64px;padding:4px 12px;display:flex;align-items:center;justify-content:center;" +
      "color:#fff;border:1px solid #fff;border-radius:4px;background:transparent;cursor:pointer;" +
      "font:bold 13px sans-serif;user-select:none;";
    b.title = title;
    b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
    btnRow.appendChild(b);
    return b;
  };
  const onKey = (ev) => {
    if (ev.key !== "Escape") return;
    if (!ov.isConnected) { document.removeEventListener("keydown", onKey); return; }
    close();
  };
  const close = () => {
    video.pause();
    video.removeAttribute("src");
    video.load();
    document.removeEventListener("keydown", onKey);
    ov.remove();
  };
  const act = (fn) => { close(); fn(); };
  mkBtn("✓ use", "Use this variant (same as clicking the tile)", () => act(onUse));
  mkBtn("✗ reject", "Reject this variant (same as clicking the tile)", () => act(onReject));
  if (variants) {
    const vbtns = [];
    let shown = "";
    for (const k of ["a", "b"]) {
      if (!variants[k]) continue;
      const b = mkBtn(k.toUpperCase(), `Switch to variant ${k.toUpperCase()}`, () => {
        if (shown === k) return;
        shown = k;
        video.src = variants[k];
        video.currentTime = 0;
        video.play().catch(() => {});
        vbtns.forEach(([kk, bb]) => { bb.style.opacity = kk === shown ? "0.5" : "1"; });
      });
      if (variants[k] === url) shown = k;
      vbtns.push([k, b]);
    }
    vbtns.forEach(([kk, bb]) => { bb.style.opacity = kk === shown ? "0.5" : "1"; });
  }
  const x = document.createElement("div");
  x.textContent = "✕";
  x.style.cssText = "position:absolute;top:8px;right:8px;z-index:2;width:28px;height:28px;" +
    "display:flex;align-items:center;justify-content:center;color:#fff;border:1px solid #fff;border-radius:4px;" +
    "background:transparent;cursor:pointer;font:16px sans-serif;";
  x.title = "Close preview";
  x.addEventListener("click", (ev) => { ev.stopPropagation(); close(); });
  ov.appendChild(video);
  ov.appendChild(btnRow);
  ov.appendChild(x);
  ov.addEventListener("click", (ev) => { if (ev.target === ov) close(); });
  document.addEventListener("keydown", onKey);
  host.appendChild(ov);
  return close;
}

app.registerExtension({
  name: "InfiniteMovie.Chooser",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "InfiniteMovieChooser") return;
    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const r = origCreated ? origCreated.apply(this, args) : undefined;
      this.properties = this.properties || {};
      if (!this.properties.marked) this.properties.marked = [];
      return r;
    };
    // onExecuted: entries after each run; remember the choice used (for „changed?“).
    const origExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      origExecuted?.apply(this, arguments);
      this._fc_choose_entries = (message && message.infinite_movie_choose) || [];
      this._fc_choose_active = -1;
      this._fc_redo_pending = null;   // new variants are there
      if (message?.film?.[0]) this._fc_film_ref = message.film[0];
      // Live run: film not built yet (set by Film/Assemble first). Restored on page load
      // (no run active): the film already exists -> not green „FILM“ again.
      this._fc_choose_ran = fcRun.running ? null : fcChooseEffective(this).join(",");
      if (this.properties) this.properties.rejected = {};   // new shots: forget the rejection   // film not built yet – set by Film/Assemble first (executed event)
      fcChooseRender(this);
    };
    // onConfigure: hide the choices widget (written by the frontend) + build the row.
    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const r = origConfigure ? origConfigure.apply(this, args) : undefined;
      const w = this.widgets?.find((x) => x.name === "choices");
      if (w && !w.hidden) {
        w.hidden = true;
        w.computeSize = () => [0, -4];
        w.computedHeight = 0;
      }
      setTimeout(() => fcChooseRender(this), 0);
      return r;
    };
    // Director changes (image connected/disconnected, loop, variants) → check the signature per draw.
    const origFg = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (...args) {
      const r = origFg ? origFg.apply(this, args) : undefined;
      if (fcChooseSig(fcChooseEntries(this)) + fcCutSig(this) !== this._fc_choose_sig) fcChooseRender(this);
      return r;
    };
    // Fixed size: width from the shot count, height from the content (dragging the corner is reset).
    const origResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      const r = origResize ? origResize.apply(this, arguments) : undefined;
      if (this._fc_choose_el) {
        const w = fcChooseWidth(this, fcChooseEntries(this));
        if (Math.abs(size[0] - w) > 1) size[0] = w;
      }
      return r;
    };
  },
});

// ---------------------------------------------------------------------------
// InfiniteMovie.SceneSeconds (task 41A+D): seconds field per scene + tail prompt
// + status row (estimate length) on the render node.
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "InfiniteMovie.SceneSeconds",
  nodeCreated(node) {
    if (node.comfyClass !== "InfiniteMovieRender") return;
    // 2026-11-04: reseed fills Choose (re-render of single shots) – hidden in the director.
    setTimeout(() => {
      imToggleWidget(node.widgets?.find((w) => w.name === "reseed"), false);
      node.setSize([node.size[0], node.computeSize()[1]]);
    }, 0);
    // Status row "Film  7 films · 14.0 s · ~337 frames", computed locally from seconds + shot_seconds (⏱ in Cut).
    const estWidget = node.addWidget("text", "Film", null, "");
    estWidget.serialize = false;
    estWidget._fc_est = true;

    const refreshEstimate = () => {
      const nShots = imFilmCount(node);
      if (nShots < 1) { estWidget.value = "needs at least 1 image"; node.setDirtyCanvas?.(true, true); return; }
      let total = 0;
      for (let i = 1; i <= nShots; i++) total += fcShotSecondsOf(node, i);
      const fps = 24; // LTX
      estWidget.value = `${nShots} film${nShots > 1 ? "s" : ""} · ${total.toFixed(1)} s · ~${Math.round(total * fps)} frames`;
      node.setDirtyCanvas?.(true, true);
    };

    for (const wn of ["seconds", "loop", "shot_seconds", "storyboard"]) {
      const w = node.widgets?.find((x) => x.name === wn);
      if (!w) continue;
      const origCb = w.callback;
      w.callback = function (...args) {
        const res = origCb?.apply(this, args);
        clearTimeout(node._fc_est_timer);
        node._fc_est_timer = setTimeout(refreshEstimate, 200);
        return res;
      };
    }
    // images added/removed (also mute via reconcileChain) -> recompute
    const origConn = node.onConnectionsChange;
    node.onConnectionsChange = function (...args) {
      const res = origConn?.apply(this, args);
      clearTimeout(this._fc_est_timer);
      this._fc_est_timer = setTimeout(refreshEstimate, 300);
      return res;
    };
    setTimeout(refreshEstimate, 1500);
  },
});

// ---------------------------------------------------------------------------
// InfiniteMovie.CutLive (task 119): finished segments appear live in the Cut
// tiles (middle frame as JPEG) with the per-shot render time (⏱ m:ss).
// `infinite_movie.segment_done` {node, index, total, seconds, view} comes from
// _send_segment_done in nodes.py (index 0-based, node = the render/Director id).
// ---------------------------------------------------------------------------
api.addEventListener("infinite_movie.segment_done", (e) => {
  const d = e.detail || {};
  const dir = d.node != null ? app.graph?.getNodeById?.(Number(d.node)) : null;
  if (!dir) return;
  for (const c of app.graph?._nodes || []) {
    if (c.comfyClass !== "InfiniteMovieChooser" || fcChooseDirectorOf(c) !== dir) continue;
    c._fc_live = c._fc_live || {};
    c._fc_live[d.index] = {
      url: d.view ? fcChooseStableUrl(d.view) + "&t=" + Date.now() : "",   // cache buster: the file is overwritten per run
      seconds: d.seconds ?? null,
    };
    c._fc_choose_sig = null;   // force fcChooseRender
    fcChooseRender(c);
  }
});
// New run start (first expansion event "<render>_…", like im_progress.chainOf):
// clear the live tiles once per run. NOT cleared at run end – real entries keep
// showing ⏱ m:ss from _fc_live[i].seconds.
api.addEventListener("executing", (e) => {
  const d = e.detail;
  if (d == null || (typeof d === "object" && d.node == null)) {   // run finished
    for (const n of app.graph?._nodes || []) if (n._fc_live_run) n._fc_live_run = false;
    return;
  }
  const m = String(typeof d === "object" ? d.node : d).match(/^(\d+)_/);
  if (!m) return;
  const dir = app.graph?.getNodeById?.(Number(m[1]));
  if (dir?.comfyClass !== "InfiniteMovieRender" || dir._fc_live_run) return;
  dir._fc_live_run = true;
  for (const c of app.graph?._nodes || []) {
    if (c.comfyClass !== "InfiniteMovieChooser" || fcChooseDirectorOf(c) !== dir) continue;
    c._fc_live = {};
    c._fc_choose_sig = null;
    fcChooseRender(c);
  }
});

