"""91: Model check – find missing model files, warn about size, download with progress.

Button "📦 Check models" on Infinite Movie · Settings (web/infinite_movie_models.js).
Catalog: models.json next to this file (name, url, directory, size, engine, gated).

Only stdlib + folder_paths (imported inside functions so unit tests can fake it).
No nodes in this module – routes only, registered at import time (see _register_routes).
Downloads run in ONE background thread; routes answer immediately (pitfall: heavy work
inside an aiohttp route blocks the server, the frontend aborts fetches after ~60 s).
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

_CATALOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models.json")
_CHUNK = 8 * 1024 * 1024  # 8 MiB blocks

# Download state – single background thread, guarded by _LOCK.
_STATE = {
    "running": False,
    "current": None,
    "done_bytes": 0,
    "total_bytes": 0,
    "speed_bps": 0.0,
    "finished": [],
    "errors": [],
    "cancel": False,
}
_LOCK = threading.Lock()


class DownloadCancelled(Exception):
    """Raised inside download() when the cancel flag is set (.part is kept)."""


def load_catalog() -> list:
    """All entries of models.json next to this file."""
    with open(_CATALOG_PATH, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("models", [])


def _target_dir(directory: str) -> str:
    """First search path for a ComfyUI model folder name (e.g. 'unet')."""
    import folder_paths
    paths = folder_paths.get_folder_paths(directory)
    return paths[0] if paths else directory


def find_missing(catalog, engines=None) -> list:
    """Catalog entries whose file is NOT in the ComfyUI model folder.

    Missing = folder_paths.get_full_path(dir, name) finds nothing AND no entry of
    folder_paths.get_filename_list(dir) has the same basename (users keep files in
    subfolders, e.g. LTX\\ltx-….safetensors). `engines` filters by the engine field
    (string or list).
    """
    import folder_paths
    if engines is not None and not isinstance(engines, (list, tuple, set)):
        engines = [engines]
    out = []
    lists = {}
    for m in catalog:
        if engines is not None and m.get("engine") not in engines:
            continue
        name = m["name"]
        if folder_paths.get_full_path(m["directory"], name):
            continue
        key = m["directory"]
        if key not in lists:
            try:
                lists[key] = [os.path.basename(p) for p in folder_paths.get_filename_list(key)]
            except Exception:  # noqa: BLE001
                lists[key] = []
        if os.path.basename(name) in lists[key]:
            continue
        out.append(m)
    return out


def summary(missing, target_dir) -> dict:
    """{count, total_bytes, free_bytes (shutil.disk_usage on target_dir), enough_space}."""
    total = sum(int(m.get("size") or 0) for m in missing)
    try:
        free = int(shutil.disk_usage(target_dir).free)
    except OSError:
        free = 0
    return {
        "count": len(missing),
        "total_bytes": total,
        "free_bytes": free,
        "enough_space": free > total * 1.05,
    }


def _repo_link(url: str) -> str:
    """Hugging Face repo URL (url cut before /resolve/), else the url itself."""
    i = url.find("/resolve/")
    return url[:i] if i > 0 else url


def _gated_error(entry) -> str:
    return (
        f"{entry['name']}: gated model – accept the license on Hugging Face first "
        f"({_repo_link(entry['url'])}), then set HF_TOKEN"
    )


def download(entry, token=None, progress=None):
    """Stream entry['url'] to <target>/<name> (via <name>.part, 8 MiB blocks).

    Resumes with `Range: bytes=<existing>-` when a .part file exists; if the server
    ignores Range (plain 200) the download restarts from scratch. token (or the
    HF_TOKEN env var) is sent as Bearer ONLY for huggingface.co URLs. progress(done,
    total) is called per block. The .part file is NEVER deleted (resume).
    Raises DownloadCancelled when the cancel flag is set; HTTP 401/403 on a gated
    model raises RuntimeError with the license hint.
    """
    if entry.get("gated") and not (token or os.environ.get("HF_TOKEN")):
        raise RuntimeError(_gated_error(entry))
    target = _target_dir(entry["directory"])
    os.makedirs(target, exist_ok=True)
    final = os.path.join(target, entry["name"])
    part = final + ".part"

    req = urllib.request.Request(entry["url"])
    tok = token or os.environ.get("HF_TOKEN")
    host = (urlparse(entry["url"]).hostname or "").lower()
    if tok and (host == "huggingface.co" or host.endswith(".huggingface.co")):
        # unredirected: HF redirects to a CDN - the token must not go to the foreign host
        req.add_unredirected_header("Authorization", f"Bearer {tok}")
    existing = os.path.getsize(part) if os.path.isfile(part) else 0
    if existing:
        req.add_header("Range", f"bytes={existing}-")
    try:
        resp = urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403) and entry.get("gated"):
            raise RuntimeError(_gated_error(entry)) from e
        raise
    resume = resp.status == 206
    cl = resp.headers.get("Content-Length")
    total = 0
    if cl:
        total = (existing + int(cl)) if resume else int(cl)
    done = existing if resume else 0
    if progress:
        progress(done, total)
    with open(part, "ab" if resume else "wb") as f:
        while True:
            if _STATE["cancel"]:
                raise DownloadCancelled(entry["name"])
            block = resp.read(_CHUNK)
            if not block:
                break
            f.write(block)
            done += len(block)
            if progress:
                progress(done, total)
    os.replace(part, final)


def _make_progress(base: int):
    """progress callback: cumulative done_bytes (base = bytes of finished files)
    and a smoothed download speed in _STATE."""
    st = {"b": 0, "t": time.time(), "s": 0.0}

    def progress(done, total):
        now = time.time()
        dt = now - st["t"]
        if dt > 0:
            inst = max(0.0, (done - st["b"]) / dt)
            st["s"] = inst if st["s"] == 0.0 else 0.7 * inst + 0.3 * st["s"]
        st["b"], st["t"] = done, now
        with _LOCK:
            _STATE["done_bytes"] = base + done
            _STATE["speed_bps"] = st["s"]

    return progress


def _worker(names):
    """Background thread: download the given catalog names one after another."""
    catalog = {m["name"]: m for m in load_catalog()}
    base = 0
    try:
        for name in names:
            if _STATE["cancel"]:
                break
            entry = catalog.get(name)
            if entry is None:
                with _LOCK:
                    _STATE["errors"].append(f"{name}: not in models.json")
                continue
            _STATE["current"] = name
            try:
                download(entry, progress=_make_progress(base))
                with _LOCK:
                    _STATE["finished"].append(name)
                try:   # progress cumulative: add the size of the finished file (do not replace)
                    base += os.path.getsize(os.path.join(_target_dir(entry["directory"]), name))
                except OSError:
                    base += int(entry.get("size") or 0)
            except DownloadCancelled:
                with _LOCK:
                    _STATE["errors"].append(f"{name}: cancelled (partial .part kept for resume)")
                break
            except Exception as e:  # noqa: BLE001
                with _LOCK:
                    _STATE["errors"].append(f"{name}: {type(e).__name__}: {e}")
    finally:
        with _LOCK:
            _STATE["running"] = False
            _STATE["current"] = None
            _STATE["speed_bps"] = 0.0


def _register_routes():
    try:
        from aiohttp import web
        from server import PromptServer

        @PromptServer.instance.routes.get("/infinite_movie/models/check")
        async def _check(request):
            import asyncio
            engine = request.query.get("engine") or None

            def _run():
                catalog = load_catalog()
                missing = find_missing(catalog, engine)
                if missing:
                    target = _target_dir(missing[0]["directory"])
                elif catalog:
                    target = _target_dir(catalog[0]["directory"])
                else:
                    target = "."
                return {
                    "missing": [
                        {k: m.get(k) for k in ("name", "directory", "size", "engine", "gated", "url")}
                        for m in missing
                    ],
                    "summary": summary(missing, target),
                }

            return web.json_response(await asyncio.to_thread(_run))

        @PromptServer.instance.routes.post("/infinite_movie/models/download")
        async def _download(request):
            try:
                data = await request.json()
            except Exception:  # noqa: BLE001
                data = {}
            names = [str(n) for n in (data.get("names") or [])]
            with _LOCK:
                if _STATE["running"] or not names:
                    return web.json_response({"started": False, "busy": _STATE["running"]})
                _STATE.update(running=True, current=None, done_bytes=0,
                              finished=[], errors=[], cancel=False, speed_bps=0.0)
                _STATE["total_bytes"] = sum(
                    int(m.get("size") or 0) for m in load_catalog() if m["name"] in names
                )
            threading.Thread(target=_worker, args=(names,), daemon=True).start()
            return web.json_response({"started": True})

        @PromptServer.instance.routes.get("/infinite_movie/models/status")
        async def _status(request):
            with _LOCK:
                return web.json_response({
                    "running": _STATE["running"],
                    "current": _STATE["current"],
                    "done_bytes": _STATE["done_bytes"],
                    "total_bytes": _STATE["total_bytes"],
                    "speed_bps": _STATE["speed_bps"],
                    "finished": list(_STATE["finished"]),
                    "errors": list(_STATE["errors"]),
                })

        @PromptServer.instance.routes.post("/infinite_movie/models/cancel")
        async def _cancel(request):
            with _LOCK:
                _STATE["cancel"] = True
            return web.json_response({"ok": True})
    except Exception as e:  # noqa: BLE001
        print(f"[InfiniteMovie] model check routes not registered: {e}")


_register_routes()
