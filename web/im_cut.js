import { app } from "../../scripts/app.js";
import { FC_REVIEW_LINE_COLORS, IMG, fcQueueFixedSeeds, fcReviewToast, fcShotSecondsOf } from "./im_common.js";
import { FC_CHOOSE_BIG_H, FC_CHOOSE_BTNROW_H, FC_CHOOSE_GAP, FC_CHOOSE_HEAD_H, FC_CHOOSE_SEAM_H, FC_CHOOSE_STATUS_H, FC_CHOOSE_STAT_H, fcAsmFocus, fcChooseApplyActive, fcChooseDirectorOf, fcChooseEditPrompt, fcChooseEditSeconds, fcChooseEff, fcChooseEffective, fcChooseEntries, fcChooseFocus, fcChooseGetChoices, fcChooseLayout, fcChoosePick, fcChoosePlay, fcChoosePlayH, fcChooseQuality, fcChooseSig, fcChooseStableUrl, fcChooseStatus, fcChooseUpdateSheet, fcChooseWidth, fcRerenderMarked, fcRun } from "./im_cut_edit.js";
import { fcDownstreamOutputs } from "./im_film.js";
import { imToggleWidget } from "./im_settings.js";
import { imvDraw } from "./im_viewer.js";
export function fcChooseRender(node) {
  let el = node._fc_choose_el;
  if (!el) {
    el = document.createElement("div");
    el.style.cssText = "width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:" + FC_CHOOSE_GAP + "px;";
    const domW = node.addDOMWidget("fc_choose", "div", el, {
      serialize: false,
      getMinHeight: () => fcChooseLayout(node, fcChooseEntries(node)).domH,
      getMaxHeight: () => fcChooseLayout(node, fcChooseEntries(node)).domH,
    });
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
  // 116c2: the shot-analysis viewer sits BELOW the play field – DOM widgets stack in
  // node.widgets order, so imvEnsure (via imvDraw) must run AFTER the fc_choose widget
  // exists, not in onNodeCreated (that would put the viewer above the play field).
  imvDraw(node);
  const entries = fcChooseEntries(node);
  const sig = fcChooseSig(entries);
  node._fc_choose_sig = sig;
  const { colW, tileH } = fcChooseLayout(node, entries);
  const marked = node.properties.marked || [];
  const choices = fcChooseGetChoices(node);
  el.innerHTML = "";

  if (entries.length) {
    const row = document.createElement("div");
    row.style.cssText = `display:flex;gap:${FC_CHOOSE_GAP}px;overflow:hidden;`;
    el.appendChild(row);
    entries.forEach((e, i) => {
      const col = document.createElement("div");
      col.className = "fc-choose-col";
      col.style.cssText = `display:flex;flex-direction:column;gap:${FC_CHOOSE_GAP}px;width:${colW}px;flex:0 0 ${colW}px;min-width:0;position:relative;`;
      col.addEventListener("mouseenter", () => { node._fc_choose_active = i; fcChooseApplyActive(node); });
      col.addEventListener("mouseleave", () => { node._fc_choose_active = -1; fcChooseApplyActive(node); });

      const head = document.createElement("div");
      head.style.cssText = `display:flex;align-items:center;height:${FC_CHOOSE_HEAD_H}px;font:bold 13px sans-serif;color:#fff;`;
      head.className = "fc-choose-head";
      head.textContent = `Shot ${e.number}`;
      if (node._fc_choose_focus === e.number) head.style.color = "#58a6ff";
      if (!e.placeholder) {
        head.style.cursor = "pointer";
        head.title = "Show this shot in Even Motion's viewer (Sheet / Frames / Particles)";
        head.addEventListener("click", (ev) => {
          if (ev.target !== head) return;
          ev.stopPropagation(); fcChooseFocus(e.number); fcAsmFocus(e.number);
        });
      }
      col.appendChild(head);
      // 74 (user 2026-11-03: „clearly where hop or top“): KEEP/REDO big below the images, click on the image.
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
        t.addEventListener("mouseenter", () => { node._fc_sheet_hover = [i, k]; fcChooseUpdateSheet(node, i); });
        t.addEventListener("mouseleave", () => { node._fc_sheet_hover = null; fcChooseUpdateSheet(node, i); });
        t.style.cssText = `position:relative;width:${colW}px;height:${tileH}px;background:#1a1a1a;border-radius:3px;` +
          `overflow:hidden;box-sizing:border-box;cursor:${e.placeholder ? "default" : "pointer"};` +
          (e.placeholder ? "border:1px dashed #555;" : isMarked ? "outline:5px solid #d93025;outline-offset:-5px;"
            : sel || !e.has_variants ? "outline:5px solid #2ea043;outline-offset:-5px;" : "");
        t.title = v.info || "";
        const img = document.createElement("img");
        img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;" +
          (dim ? "opacity:0.35;filter:grayscale(0.8);" : "");
        t.appendChild(img);
        if (!e.placeholder) {
          const lab = document.createElement("div");
          const on = sel || !e.has_variants;
          const no = isMarked || rejected.includes(k);
          lab.textContent = pending ? `↻ ${e.has_variants ? k.toUpperCase() + " " : ""}new render…` : isMarked ? "✗ REDO" : no ? `✗ ${k.toUpperCase()}`
            : e.has_variants ? (sel ? `✓ ${k.toUpperCase()}${isAuto && e.auto_strong ? " · AUTO" : ""}` : k.toUpperCase()) : "✓";
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
        col.appendChild(t);
        const st = document.createElement("div");
        // 75 (user 2026-11-03: „features bigger so you can recognize them“): finding in plain text + color
        const q = fcChooseQuality(v, e);
        st.style.cssText = `height:${FC_CHOOSE_STAT_H}px;display:flex;align-items:center;` +
          `font:bold 13px/${FC_CHOOSE_STAT_H}px sans-serif;white-space:nowrap;` +
          `overflow:hidden;text-overflow:ellipsis;padding:0 4px;border-radius:3px;color:${q.color};background:${q.bg};`;
        const stx = document.createElement("span");
        stx.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;";
        stx.textContent = pending ? (fcRun.running ? "waiting for render…" : "queued for re-render")
          : v.score === undefined ? (e.placeholder ? (fcRun.running ? "waiting for render…" : "") : "") : q.text;
        st.appendChild(stx);
        // 115: "▶ play" – this shot's full video (with sound) in the preview field below
        if (v.video && !e.placeholder) {
          const pb = document.createElement("div");
          pb.textContent = "▶ play";
          pb.style.cssText = "flex:0 0 auto;padding:0 8px;height:20px;line-height:20px;font:bold 12px sans-serif;" +
            "color:#fff;background:#1f6feb;border-radius:3px;cursor:pointer;";
          pb.title = "Play this video with sound in the big preview below";
          pb.addEventListener("click", (ev) => {
            ev.stopPropagation();
            fcChoosePlay(node, e.number, e.has_variants ? k.toUpperCase() : "", v.video);
          });
          st.appendChild(pb);
        }
        if (pending) { st.style.color = "#4fc3f7"; st.style.background = "transparent"; }
        st.title = (e.auto_reason || "") + (v.info ? "\n" + v.info : "");
        col.appendChild(st);
      }
      // 2026-11-08: make the seam to the next shot visible – last image of the chosen variant of this shot
      // next to the first image of the chosen variant of the next one (loop: shot 1). Follows the A/B choice immediately;
      // the metric comes from the last run (red from JERK_HARD, like the row 78 before).
      if (!e.placeholder && e.seam_next) {
        const ni = e.seam_next - 1, ne = entries[ni];
        const pick = (en, idx) => fcChooseEff(en, choices[idx]);
        const lastIm = (e[pick(e, i)] || e.a)?.last;
        const firstIm = ne ? ((ne[pick(ne, ni)] || ne.a)?.still) : null;
        const bad = !!e.seam_bad;
        const sr = document.createElement("div");
        sr.style.cssText = `height:${FC_CHOOSE_SEAM_H}px;display:flex;align-items:center;gap:6px;padding:2px;box-sizing:border-box;` +
          `border-radius:3px;background:${bad ? "#3a1512" : "#202020"};border:1px solid ${bad ? "#b3261e" : "#333"};`;
        const thumb = (im) => {
          const t = document.createElement(im ? "img" : "div");
          t.style.cssText = "width:70px;height:70px;object-fit:contain;border-radius:2px;background:#111;flex:none;";
          if (im) t.src = fcChooseStableUrl(im);
          return t;
        };
        const mid = document.createElement("div");
        mid.style.cssText = `flex:1;min-width:0;text-align:center;font:bold 12px sans-serif;color:${bad ? "#ff8a80" : "#8b949e"};line-height:1.35;`;
        mid.innerHTML = `seam → Shot ${e.seam_next}<br><span style="font-size:15px">${bad ? "⚠" : "✓"} ${(+e.seam || 0).toFixed(1)}</span>`;
        sr.title = "Last frame of this shot | first frame of the next shot – the cut the film makes here. " +
          "Value from the last run (red = hard jump).";
        sr.appendChild(thumb(lastIm)); sr.appendChild(mid); sr.appendChild(thumb(firstIm));
        col.appendChild(sr);
      }
      if (!e.placeholder) {
        // Button row: ✓ KEEP / ✗ REDO (big) + „✎ prompt" (80: edit the prompt of this transition)
        const krow = document.createElement("div");
        krow.style.cssText = `display:flex;gap:${FC_CHOOSE_GAP}px;height:${FC_CHOOSE_BTNROW_H}px;`;
        const kb = document.createElement("div");
        kb.className = "fc-keep";
        kb.textContent = isMarked ? "✗ REDO – click to keep" : "✓ KEEP – click to redo";
        kb.style.cssText = `flex:1;display:flex;align-items:center;justify-content:center;` +
          `font:bold 15px sans-serif;color:#fff;border-radius:4px;cursor:pointer;user-select:none;` +
          `background:${isMarked ? "#d93025" : "#2ea043"};`;
        kb.style.opacity = fcRun.running ? "0.35" : "1";
        kb.title = isMarked ? "Marked: re-render this shot with new seeds (RERENDER below)" : "Mark this shot to re-render it with new seeds";
        kb.addEventListener("click", (ev) => { ev.stopPropagation(); toggleRedo(); });
        const pb = document.createElement("div");
        pb.className = "fc-keep";   // greyed out like KEEP/REDO during a run
        pb.textContent = "✎ prompt";
        pb.style.cssText = `flex:0 0 auto;min-width:62px;display:flex;align-items:center;justify-content:center;` +
          `font:bold 12px sans-serif;color:#ccc;background:#333;border:1px solid #555;border-radius:4px;cursor:pointer;user-select:none;`;
        pb.style.opacity = fcRun.running ? "0.35" : "1";
        pb.title = "Edit this shot's prompt (its Auto Prompt node) – saving marks ✗ REDO so RERENDER re-renders it";
        pb.addEventListener("click", (ev) => { ev.stopPropagation(); if (fcRun.running) return; fcChooseEditPrompt(node, col, e, setMarked); });
        // 82: „⏱ X s“ – length of this shot (entry in shot_seconds or global seconds)
        const dir = fcChooseDirectorOf(node);
        const secs = fcShotSecondsOf(dir, e.number);
        const sb = document.createElement("div");
        sb.className = "fc-keep";   // greyed out like KEEP/REDO during a run
        sb.textContent = `⏱ ${secs % 1 === 0 ? secs.toFixed(0) : secs.toFixed(1)} s`;
        sb.style.cssText = `flex:0 0 auto;min-width:62px;display:flex;align-items:center;justify-content:center;` +
          `font:bold 12px sans-serif;color:#ccc;background:#333;border:1px solid #555;border-radius:4px;cursor:pointer;user-select:none;`;
        sb.style.opacity = fcRun.running ? "0.35" : "1";
        sb.title = "Set this shot's length (0.5–20 s, or 'global' = the Director's 'seconds') – saving marks ✗ REDO so RERENDER re-renders it";
        sb.addEventListener("click", (ev) => { ev.stopPropagation(); if (fcRun.running) return; fcChooseEditSeconds(node, col, e, setMarked); });
        krow.appendChild(kb);
        krow.appendChild(pb);
        krow.appendChild(sb);
        col.appendChild(krow);
      }
      row.appendChild(col);
    });
  }

  const status = document.createElement("div");
  status.style.cssText = `height:${FC_CHOOSE_STATUS_H}px;display:flex;align-items:center;padding:0 8px;background:#202020;` +
    "border-radius:3px;font:13px sans-serif;white-space:nowrap;overflow:hidden;";
  const steps = document.createElement("div");
  steps.style.cssText = "display:flex;align-items:center;gap:2px;font-size:11px;flex-shrink:0;";
  const statusText = document.createElement("div");
  statusText.style.cssText = "margin-left:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;";
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
        fcReviewToast("FILM could not be queued – see console", "#d93025");
        console.error("[InfiniteMovie] FILM queue failed", err);
      });
      fcReviewToast("FILM queued – building film…");
    } else if (btn._fc_mode === "rerender") {
      fcRerenderMarked(node, fcChooseRender);
    }
  });
  el.appendChild(btn);
  node._fc_choose_btn = btn;
  el.appendChild(status);   // 2026-11-05 (user): status/progress at the very bottom
  // 3×3 sheets at the very bottom, per shot under its column
  const sz = fcChooseLayout(node, entries).sheet;
  node._fc_sheet_cells = [];
  if (sz) {
    const srow = document.createElement("div");
    srow.style.cssText = `display:flex;gap:${FC_CHOOSE_GAP}px;overflow:hidden;`;
    entries.forEach(() => {
      const cell = document.createElement("div");
      cell.style.cssText = `position:relative;width:${sz[0]}px;height:${sz[1]}px;flex:0 0 ${sz[0]}px;background:#121212;border-radius:3px;overflow:hidden;`;
      const img = document.createElement("img");
      img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;";
      const lbl = document.createElement("div");
      lbl.style.cssText = "position:absolute;left:4px;bottom:4px;padding:1px 6px;font:bold 11px sans-serif;color:#ddd;" +
        "background:rgba(0,0,0,0.6);border-radius:3px;pointer-events:none;";
      cell.appendChild(img); cell.appendChild(lbl);
      srow.appendChild(cell);
      node._fc_sheet_cells.push({ img, lbl });
    });
    el.appendChild(srow);
    fcChooseUpdateSheet(node);
  }

  // 115: big preview field at the very bottom. Built ONCE (node._fc_play) and re-appended here –
  // el.innerHTML="" above dropped it; re-adding the SAME element in the same synchronous pass
  // keeps a running video playing.
  if (!node._fc_play) {
    const box = document.createElement("div");
    box.style.cssText = "width:100%;display:flex;flex-direction:column;gap:0;";
    const trow = document.createElement("div");
    trow.style.cssText = "height:20px;display:flex;align-items:center;gap:6px;";
    const title = document.createElement("span");
    title.style.cssText = "flex:1;min-width:0;font:bold 13px sans-serif;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    // 116b4: "▶ film" – the built film (with sound) in the preview field; shown once the film ref is known.
    const fbtn = document.createElement("div");
    fbtn.textContent = "▶ film";
    fbtn.style.cssText = "flex:0 0 auto;padding:0 8px;height:20px;line-height:20px;font:bold 12px sans-serif;" +
      "color:#fff;background:#1f6feb;border-radius:3px;cursor:pointer;display:none;";
    fbtn.title = "Play the built film with sound in the big preview below";
    fbtn.addEventListener("click", () => {
      fcChoosePlay(node, "", "", node._fc_film_ref);
      node._fc_play.title.textContent = "Film";
    });
    trow.appendChild(title); trow.appendChild(fbtn);
    const video = document.createElement("video");
    video.controls = true; video.loop = true; video.playsInline = true;
    video.style.cssText = `width:100%;height:${fcChoosePlayH(node)}px;object-fit:contain;background:#000;display:none;`;
    const hint = document.createElement("div");
    hint.style.cssText = `height:${fcChoosePlayH(node)}px;display:flex;align-items:center;justify-content:center;` +
      "background:#000;color:#888;font:14px sans-serif;";
    hint.textContent = "▶ play under a shot shows it here – big, with sound";
    box.appendChild(trow); box.appendChild(video); box.appendChild(hint);
    node._fc_play = { box, trow, title, video, hint, fbtn };
  }
  el.appendChild(node._fc_play.box);

  fcChooseStatus(node);
  fcChooseApplyActive(node);
  // Width = all shots (fixed image size), height = content.
  const want = [fcChooseWidth(entries.length), node.computeSize()[1]];
  if (Math.abs(node.size[0] - want[0]) > 1 || Math.abs(node.size[1] - want[1]) > 1) node.setSize(want);
  // 116c2: the square play-field height depends on the node width – on the first render
  // fcChooseLayout ran before _fc_play existed, and a width change here changes the height;
  // re-apply it to the video/hint divs.
  if (node._fc_play) {
    const ph = fcChoosePlayH(node) + "px";
    node._fc_play.video.style.height = ph;
    node._fc_play.hint.style.height = ph;
  }
  node.setDirtyCanvas(true, true);
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
      // 116b4: Cut wrote the film -> remember the ref, show "▶ film" in the preview title row.
      if (message?.film?.[0]) {
        this._fc_film_ref = message.film[0];
        if (this._fc_play) this._fc_play.fbtn.style.display = "";
      }
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
      if (fcChooseSig(fcChooseEntries(this)) !== this._fc_choose_sig) fcChooseRender(this);
      return r;
    };
    // Fixed size: width from the shot count, height from the content (dragging the corner is reset).
    const origResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      const r = origResize ? origResize.apply(this, arguments) : undefined;
      if (this._fc_choose_el) {
        const w = fcChooseWidth(fcChooseEntries(this).length);
        if (Math.abs(size[0] - w) > 1) size[0] = w;
      }
      return r;
    };
  },
});

// ---------------------------------------------------------------------------
// InfiniteMovie.AutoBatch (task 39D): status row on the FramesCollect node,
// fetches video info from /infinite_movie/video_info, computes frames_per_batch.
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "InfiniteMovie.AutoBatch",
  nodeCreated(node) {
    if (node.comfyClass !== "InfiniteMovieFramesCollect") return;
    const drawFg = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
      const r = drawFg?.apply(this, arguments);
      const info = this._fc_video_info;
      if (!info || this.flags?.collapsed) return r;
      const maxGb = this.widgets?.find((w) => w.name === "max_images_gb")?.value ?? 0;
      const w = info.width || 768, h = info.height || 960;
      const bytesPerFrame = w * h * 3 * 4;
      const maxFrames = maxGb > 0 ? Math.floor((maxGb * 1024 ** 3) / bytesPerFrame) : info.frames;
      const batches = maxFrames > 0 ? Math.ceil(info.frames / maxFrames) : 1;
      const lines = [
        `${info.frames} frames · ${info.width}×${info.height} · ${info.fps?.toFixed(1) || "?"} fps`,
        maxGb > 0
          ? `~${(info.frames * bytesPerFrame / 1024 ** 3).toFixed(1)} GB → ${batches} batch(es) of ${maxFrames}`
          : `~${(info.frames * bytesPerFrame / 1024 ** 3).toFixed(1)} GB (no limit)`,
      ];
      const x = 8, bw = this.size[0] - 16, bh = 14 + lines.length * 16;
      const y = (this.computeSize?.()[1] || 200) + 4;
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(x - 2, y - 2, bw + 4, bh + 4);
      ctx.fillStyle = "#ddd";
      ctx.font = "12px sans-serif";
      lines.forEach((t, i) => ctx.fillText(t, x, y + 16 + i * 16));
      ctx.restore();
      return r;
    };
    // Fetch video info if a path widget is present
    const refresh = async () => {
      const paths = node.widgets?.find((w) => w.name === "paths")?.value ?? "";
      const first = paths.split("\n").map((s) => s.trim()).filter(Boolean)[0];
      if (!first) { node._fc_video_info = null; node.setDirtyCanvas(true, true); return; }
      try {
        const r = await fetch(`/infinite_movie/video_info?path=${encodeURIComponent(first)}`);
        const j = await r.json();
        if (r.ok) {
          node._fc_video_info = j;
          node.setDirtyCanvas(true, true);
        }
      } catch (e) {
        console.warn("[InfiniteMovie.AutoBatch]", e);
      }
    };
    const pathsWidget = node.widgets?.find((w) => w.name === "paths");
    if (pathsWidget) {
      const origCb = pathsWidget.callback;
      pathsWidget.callback = function (...args) {
        const res = origCb?.apply(this, args);
        clearTimeout(this._fc_batch_timer);
        this._fc_batch_timer = setTimeout(refresh, 500);
        return res;
      };
    }
    setTimeout(refresh, 1500);
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
    // Status row „Film: 7 shots · 14.0 s · 337 frames“ (2026-11-04: computed locally from seconds +
    // shot_seconds (⏱ in Choose); the old server estimate from the one-pass time is removed).
    const estWidget = node.addWidget("text", "Film:", null, "");
    estWidget.serialize = false;
    estWidget._fc_est = true;

    const refreshEstimate = () => {
      const val = (n) => node.widgets?.find((w) => w.name === n)?.value;
      const seconds = Number(val("seconds")) || 2.0;
      const loop = !!val("loop");
      const nImg = (node.inputs || []).filter((i) => i.name?.startsWith(IMG) && i.link != null).length;
      const nShots = nImg < 1 ? 0 : nImg === 1 ? (loop ? 2 : 1) : (loop ? nImg : nImg - 1);   // 1 image: open shot (+ return shot)
      if (nShots < 1) { estWidget.value = "Film: needs at least 1 image"; node.setDirtyCanvas?.(true, true); return; }
      const per = String(val("shot_seconds") || "").split(",").map((x) => parseFloat(x) || 0);
      let total = 0;
      for (let i = 0; i < nShots; i++) total += per[i] > 0 ? per[i] : seconds;
      const fps = 24; // LTX
      estWidget.value = `Film: ${nShots} shot${nShots > 1 ? "s" : ""} · ${total.toFixed(1)} s · ~${Math.round(total * fps)} frames`;
      node.setDirtyCanvas?.(true, true);
    };

    for (const wn of ["seconds", "loop", "shot_seconds"]) {
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

