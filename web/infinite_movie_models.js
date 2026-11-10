// 91 (2026-11-09): Button "📦 Check models" on Infinite Movie · Settings.
// Shows the missing model files (catalog models.json on the server), warns about the
// total download size vs. free disk space, and downloads with a progress bar.
// The server runs the download in a background thread (model_check.py); this file only
// polls /infinite_movie/models/status once per second.
// No alert/confirm/prompt – own DOM dialog (pitfall: native dialogs from the server
// are not visible in the browser).
// 2026-11-09 (Claude-Review): pre-selected is only what the open workflow needs (active nodes);
// warning + space check are computed from the selection. Calls via api.fetchApi (base path).
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
(() => {
  const GB = 1e9;   // decimal GB like Hugging Face and the README (42.0 GB), not GiB
  const MB = 1e6;
  const BTN_NAME = "📦 Check models";

  const fmtGB = (b) => (b / GB).toFixed(1) + " GB";
  const fmtSpeed = (bps) => (bps > 0 ? (bps / MB).toFixed(0) + " MB/s" : "–");

  function el(tag, css, text) {
    const d = document.createElement(tag);
    if (css) d.style.cssText = css;
    if (text != null) d.textContent = text;
    return d;
  }

  async function call(path, opts) {
    const r = await api.fetchApi(path, opts);
    return r.json();
  }

  // Model file names the open workflow needs: widget values and properties.models of active nodes
  // (muted/bypassed = not needed). Files in subfolders count by their file name.
  function usedModelNames() {
    const used = new Set();
    const base = (v) => String(v).split(/[\/]/).pop();
    const visit = (g) => {
      for (const n of g?._nodes || g?.nodes || []) {
        if ((n.mode ?? 0) !== 0) continue;
        for (const w of n.widgets || []) if (typeof w.value === "string" && w.value) used.add(base(w.value));
        for (const m of n.properties?.models || []) if (m?.name) used.add(base(m.name));
        if (n.subgraph) visit(n.subgraph);
      }
    };
    visit(app.graph);
    return used;
  }

  app.registerExtension({
    name: "InfiniteMovie.ModelCheck",
    nodeCreated(node) {
      if (node.comfyClass !== "InfiniteMovieSettings") return;
      if (node.widgets?.some((x) => x.name === BTN_NAME)) return; // already added
      const btn = node.addWidget("button", BTN_NAME, null, () => openModelCheck());
      btn.serialize = false;
      btn.tooltip =
        "Check which model files are missing, warn about the total download size, and download them into the ComfyUI model folders.";
    },
  });

  function openModelCheck() {
    const overlay = el("div",
      "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center");
    const box = el("div",
      "background:#1e1e24;color:#eee;border:1px solid #444;border-radius:8px;width:min(880px,92vw);max-height:86vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.6)");
    const head = el("div",
      "padding:10px 14px;font-weight:600;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center",
      "📦 Model check");
    const closeBtn = el("button", "cursor:pointer;background:none;border:none;color:#aaa;font-size:16px", "✕");
    head.append(closeBtn);
    const body = el("div", "padding:12px 14px;overflow:auto;flex:1");
    const foot = el("div",
      "padding:10px 14px;border-top:1px solid #333;display:flex;gap:10px;align-items:center;flex-wrap:wrap");
    box.append(head, body, foot);
    overlay.append(box);
    document.body.append(overlay);

    let pollTimer = null;
    const stop = () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      overlay.remove();
    };
    closeBtn.onclick = stop;
    overlay.onclick = (e) => { if (e.target === overlay) stop(); };

    const loading = el("div", "padding:20px;color:#aaa", "Checking models…");
    body.append(loading);

    call("/infinite_movie/models/check")
      .then((j) => {
        loading.remove();
        if (!j || !Array.isArray(j.missing)) throw new Error(j?.error || "check failed");
        if (!j.missing.length) {
          body.append(el("div", "padding:16px;font-size:15px", "All models are installed ✓"));
          return;
        }
        renderTable(j);
      })
      .catch((e) => {
        loading.remove();
        body.append(el("div", "padding:16px;color:#f88", "Check failed: " + e.message));
      });

    function repoLink(url) {
      const i = url.indexOf("/resolve/");
      return i > 0 ? url.slice(0, i) : url;
    }

    function renderTable(j) {
      const s = j.summary || {};
      const used = usedModelNames();
      // Used ones first, then the rest (other engines)
      j.missing.sort((a, b) => (used.has(b.name) ? 1 : 0) - (used.has(a.name) ? 1 : 0));
      body.append(el("div", "margin-bottom:8px;color:#ccc;font-size:13px",
        "Pre-selected: the files this workflow uses. Other engines are listed below, not selected."));
      // Warning line (updated with the selection): bold orange, red if not enough disk space.
      const warn = el("div", "font-weight:700;margin-bottom:10px;font-size:15px");
      body.append(warn);

      // Table: File · Folder · Size · Engine (gated rows get 🔒 + repo link).
      const table = el("table", "width:100%;border-collapse:collapse;font-size:13px");
      const thead = el("thead");
      const hrow = el("tr");
      for (const h of ["", "File", "Folder", "Size", "Engine"]) {
        const th = el("th", "text-align:left;padding:4px 6px;border-bottom:1px solid #444;color:#aaa", h);
        hrow.append(th);
      }
      thead.append(hrow);
      table.append(thead);
      const tbody = el("tbody");
      const boxes = [];
      for (const m of j.missing) {
        const tr = el("tr");
        const tdBox = el("td", "padding:4px 6px");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = used.has(m.name) && !m.gated; // default: what this workflow uses and is not locked
        tdBox.append(cb);
        boxes.push({ cb, m });
        const tdName = el("td", "padding:4px 6px;word-break:break-all",
          (m.gated ? "🔒 " : "") + m.name);
        if (m.gated) {
          const a = el("a", "color:#6ab0f3;text-decoration:underline", repoLink(m.url || ""));
          a.href = repoLink(m.url || "");
          a.target = "_blank";
          a.rel = "noopener";
          tdName.append(" ");
          tdName.append(a);
        }
        const tdDir = el("td", "padding:4px 6px;color:#aaa", m.directory || "");
        const tdSize = el("td", "padding:4px 6px;white-space:nowrap", fmtGB(m.size || 0));
        const tdEng = el("td", "padding:4px 6px;color:#aaa",
          (m.engine || "") + (used.has(m.name) ? " · used here" : ""));
        tr.append(tdBox, tdName, tdDir, tdSize, tdEng);
        tbody.append(tr);
      }
      table.append(tbody);
      body.append(table);

      // Footer: "Download selected (X GB)" + "Close".
      const dlBtn = el("button",
        "padding:6px 14px;border-radius:6px;border:1px solid #444;cursor:pointer;font-weight:600",
        "Download selected");
      const closeFoot = el("button",
        "padding:6px 14px;border-radius:6px;border:1px solid #444;cursor:pointer", "Close");
      closeFoot.onclick = stop;
      foot.append(dlBtn, closeFoot);

      const updateBtn = () => {
        const sel = boxes.filter((b) => b.cb.checked);
        const total = sel.reduce((a, b) => a + (b.m.size || 0), 0);
        const free = s.free_bytes || 0;
        const enough = free > total * 1.05;
        warn.style.color = enough ? "#ff9f43" : "#ff5555";
        warn.textContent = !sel.length ? "Nothing selected."
          : enough ? `⚠ Download: ${fmtGB(total)} (${sel.length} files) · free on disk: ${fmtGB(free)}`
            : `⚠ Not enough disk space – download needs ${fmtGB(total)}, only ${fmtGB(free)} free`;
        dlBtn.textContent = `Download selected (${fmtGB(total)})`;
        dlBtn.disabled = !enough || sel.length === 0;
      };
      boxes.forEach((b) => { b.cb.onchange = updateBtn; });
      updateBtn();

      dlBtn.onclick = () => {
        const names = boxes.filter((b) => b.cb.checked).map((b) => b.m.name);
        if (!names.length) return;
        startDownload(names);
      };
    }

    function startDownload(names) {
      // Remove the table, show the progress area.
      const progress = el("div", "padding:8px 0");
      const barOuter = el("div",
        "height:14px;background:#333;border-radius:7px;overflow:hidden;margin:10px 0");
      const barInner = el("div", "height:100%;width:0%;background:#2f9e44;transition:width .4s");
      barOuter.append(barInner);
      const line = el("div", "font-size:14px");
      const errBox = el("div", "margin-top:10px;color:#f88;font-size:13px;white-space:pre-wrap");
      progress.append(barOuter, line, errBox);
      body.replaceChildren(progress);

      const cancelBtn = el("button",
        "padding:6px 14px;border-radius:6px;border:1px solid #444;cursor:pointer", "Cancel");
      const closeFoot = el("button",
        "padding:6px 14px;border-radius:6px;border:1px solid #444;cursor:pointer", "Close");
      closeFoot.onclick = stop;
      foot.replaceChildren(cancelBtn, closeFoot);

      let cancelled = false;
      cancelBtn.onclick = async () => {
        cancelled = true;
        cancelBtn.disabled = true;
        try { await call("/infinite_movie/models/cancel", { method: "POST" }); } catch (_) {}
      };

      const render = (st) => {
        const done = st.done_bytes || 0;
        const total = st.total_bytes || 0;
        barInner.style.width = total > 0 ? Math.min(100, (done / total) * 100).toFixed(1) + "%" : "0%";
        const idx = st.running ? (st.finished?.length || 0) + 1 : (st.finished?.length || 0);
        const parts = [`file ${idx}/${names.length}`];
        if (st.current) parts.push("· " + st.current);
        parts.push(`· ${fmtGB(done)} / ${fmtGB(total)}`);
        parts.push("· " + fmtSpeed(st.speed_bps || 0));
        if (st.running && (st.speed_bps || 0) > 0 && total > done) {
          const secs = (total - done) / st.speed_bps;
          parts.push(`· ~${Math.max(1, Math.round(secs / 60))} min left`);
        }
        if (!st.running) parts.push(st.finished?.length === names.length ? " · done ✓" : " · stopped");
        line.textContent = parts.join(" ");
        errBox.textContent = (st.errors || []).join("\n");
        if (!st.running && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      };

      call("/infinite_movie/models/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      })
        .then((r) => {
          if (!r || !r.started) {
            line.textContent = r?.busy ? "A download is already running." : "Download not started.";
            return;
          }
          render({ running: true, finished: [], errors: [] });
          pollTimer = setInterval(async () => {
            try {
              const st = await call("/infinite_movie/models/status");
              render(st);
            } catch (_) { /* keep polling on a single failed poll */ }
          }, 1000);
        })
        .catch((e) => {
          line.textContent = "Download failed to start: " + e.message;
        });
    }
  }
})();
