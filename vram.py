"""VRAM handoff logic for InfiniteMovieRender.

Mirrors the proven patterns from tools/loop_render.py (wait_ready_for_send,
line 250) and tools/bee_watchdog.py (wake_bee, line 231):

- Acquire: wait until the local LLM (BeeLlama) is sleeping AND enough GPU
  memory is free. If BeeLlama is sleeping but ComfyUI still holds models,
  unload them directly (NOT via the /free endpoint, which only sets flags on
  the prompt queue - server.py:1289) and re-measure.
- Release: unload ComfyUI models + empty the cache, wait until enough VRAM is
  free, then wake BeeLlama (pre-wake completion request, then wait until it is
  awake again).

NEVER kills llama-server and never forces it to sleep; it only waits and
wakes.

All HTTP / nvidia-smi access goes through small, injectable helpers so the
logic can be unit-tested offline (tools/infinite_movie_test.py).
"""

from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.request

DEFAULT_LLM_URL = "http://127.0.0.1:8080"

# 57a: BeeLlama-Modell-ID (AGENTS.md: immer per ID suchen, NIE data[0]).
# Der Router listet ~10 Profile; nur dieses Modell wird entladen/geprueft.
BEE_MODEL_ID = "Qwen3.8-27B-IQ4-kvarn6-1slot"

# Polling cadence (seconds)
_POLL_S = 5.0
_RECHECK_AFTER_UNLOAD_S = 10.0
_WAKE_PRECOMPLETION_TIMEOUT_S = 120.0
_WAKE_TIMEOUT_S = 180.0
_UNLOAD_PROBE_INTERVAL_S = 60.0


class VRAMTimeoutError(RuntimeError):
    """Raised when the acquire/release wait exceeds the configured timeout."""


def _check_interrupt() -> None:
    """Abbrechen in ComfyUI (Queue-Knopf) sofort durchreichen. Ausserhalb von ComfyUI (Tests) nichts."""
    try:
        import comfy.model_management as mm
    except Exception:  # noqa: BLE001
        return
    mm.throw_exception_if_processing_interrupted()


def _sleep(seconds: float) -> None:
    """time.sleep in kurzen Schritten, damit Abbrechen nicht bis zum Ende der Wartezeit haengt."""
    end = time.time() + seconds
    while True:
        _check_interrupt()
        left = end - time.time()
        if left <= 0:
            return
        time.sleep(min(left, 0.25))


# ---------------------------------------------------------------------------
# Injectable I/O helpers (default implementations hit the real system).
# ---------------------------------------------------------------------------

def http_json(url: str, data=None, timeout: float = 10.0):
    """GET (data is None) or POST (data is a dict) and parse JSON.

    Returns (ok: bool, payload_or_error). Never raises on network errors.
    """
    body = None
    headers = {"Content-Type": "application/json"}
    if data is not None:
        body = json.dumps(data).encode("utf-8")
    try:
        req = urllib.request.Request(url, data=body, headers=headers,
                                     method="POST" if data is not None else "GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return True, json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
            OSError, json.JSONDecodeError) as exc:
        return False, str(exc)


def gpu_free_mb() -> int | None:
    """Free GPU memory in MB via nvidia-smi, or None on failure."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=15,
        ).stdout.strip().splitlines()
        values = [int(x) for x in out if x.strip().isdigit()]
        return min(values) if values else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def unload_comfyui_models() -> None:
    """Unload all ComfyUI models and empty the CUDA cache, immediately.

    Uses comfy.model_management directly because the /free HTTP endpoint only
    sets flags on the prompt queue (server.py:1289) that the execution loop
    processes later - too slow / not immediate for our needs.

    Core functions (comfy/model_management.py):
    - unload_all_models() line 2171: free_memory(1e30, dev) per device ->
      unloads every model from VRAM and RAM.
    - soft_empty_cache() line 2153: synchronize + torch.cuda.empty_cache +
      ipc_collect.
    """
    try:
        import comfy.model_management as mm
        mm.unload_all_models()
        mm.soft_empty_cache()
    except Exception as exc:  # pragma: no cover - depends on ComfyUI runtime
        print(f"[InfiniteMovie] model unload failed: {exc}")


# ---------------------------------------------------------------------------
# Memory status display (VRAM + RAM)
# ---------------------------------------------------------------------------

def get_memory_status() -> str:
    """Return a one-line memory status string.

    Format (Auftrag 16, point 2):
        VRAM free <free> / <total> GB | nvidia-smi free <x> GB | RAM free <a> / <b> GB

    VRAM (torch view): comfy.model_management.get_free_memory() /
    get_total_memory() (model_management.py:1821 / 316). This is what ComfyUI
    sees; it does NOT include memory held by other processes such as BeeLlama.
    VRAM (OS view): nvidia-smi (gpu_free_mb, this file line 66) - shows the
    true free memory including BeeLlama's usage.
    RAM: psutil.virtual_memory() (.total / .available).

    Every source is wrapped in try/except so the display degrades gracefully
    when a backend is unavailable (e.g. offline test without CUDA).
    """
    parts: list[str] = []

    # 1. VRAM via model_management (torch view).
    try:
        import comfy.model_management as mm
        free = mm.get_free_memory()
        total = mm.get_total_memory()
        if total:
            parts.append(f"VRAM free {free / 1e9:.1f} / {total / 1e9:.1f} GB")
    except Exception:
        pass

    # 2. VRAM via nvidia-smi (OS view, includes BeeLlama).
    smi = gpu_free_mb()
    if smi is not None:
        parts.append(f"nvidia-smi free {smi / 1024:.1f} GB")

    # 3. RAM via psutil.
    try:
        import psutil
        vm = psutil.virtual_memory()
        parts.append(f"RAM free {vm.available / 1e9:.1f} / {vm.total / 1e9:.1f} GB")
    except Exception:
        pass

    return " | ".join(parts) if parts else "memory: no backend available"


# ---------------------------------------------------------------------------
# Acquire
# ---------------------------------------------------------------------------

def is_router_props(props) -> bool:
    return isinstance(props, dict) and props.get("role") == "router"


def llm_sleeping(llm_url: str, props, http=http_json) -> bool:
    """True, wenn das LLM die GPU nicht belegt.

    Router-Modus (BeeLlama 2026-10): GET /props liefert {"role":"router"} OHNE
    is_sleeping. Dann gilt: kein Modell geladen, oder jedes geladene Modell meldet
    GET /props?model=<id> -> is_sleeping true (wie tools/llm_gate.py gpu_ready).
    Ohne diese Pruefung wartete das Gate bis zum Timeout (2026-10-26).
    Sonst: altes /props is_sleeping."""
    if not is_router_props(props):
        return bool(props.get("is_sleeping", False)) if isinstance(props, dict) else False
    ok, models = http(f"{llm_url}/models")
    if not ok or not isinstance(models, dict):
        return False
    loaded = [m.get("id") for m in models.get("data") or []
              if (m.get("status") or {}).get("value") == "loaded"]
    for mid in loaded:
        ok, p = http(f"{llm_url}/props?model={mid}&autoload=false")
        if isinstance(p, list):
            p = p[0] if p else None
        if not ok or not isinstance(p, dict) or p.get("is_sleeping") is not True:
            return False
    return True


_LLM_LOADED_CACHE: dict = {}


def _loaded_model_ids(llm_url: str, http=http_json, refresh: bool = False) -> list:
    """IDs of models currently loaded in the router (status.value == 'loaded').

    Cached per llm_url to avoid pinging /models on every acquire-loop
    iteration. Pass refresh=True to force a re-fetch.
    """
    if not refresh and llm_url in _LLM_LOADED_CACHE:
        return _LLM_LOADED_CACHE[llm_url]
    ok, models = http(f"{llm_url}/models")
    if not ok or not isinstance(models, dict):
        return []
    ids = [m.get("id") for m in models.get("data") or []
           if (m.get("status") or {}).get("value") == "loaded"]
    _LLM_LOADED_CACHE[llm_url] = ids
    return ids


def llm_model_status(http, llm_url: str, model_id: str = BEE_MODEL_ID):
    """57a: Status of the BeeLlama model via GET /v1/models (source of truth).

    Returns 'loaded' / 'sleeping' / 'unloaded', or None if the model is not
    listed (e.g. in the offline test mock, which uses id 'mock'). The model is
    looked up BY ID (never data[0]) per AGENTS.md.
    """
    ok, models = http(f"{llm_url}/v1/models")
    if not ok or not isinstance(models, dict):
        return None
    for m in models.get("data") or []:
        if m.get("id") == model_id:
            return (m.get("status") or {}).get("value")
    return None


def _loaded_llm_ids(http, llm_url: str) -> list:
    """IDs aller Profile mit status 'loaded' laut GET /v1/models (Router listet ~10 Profile)."""
    ok, models = http(f"{llm_url}/v1/models")
    if not ok or not isinstance(models, dict):
        return []
    return [m.get("id") for m in models.get("data") or []
            if (m.get("status") or {}).get("value") == "loaded" and m.get("id")]


def gpu_holders(own_pid=None) -> list:
    """65: Prozesse, die gerade die GPU benutzen (nvidia-smi compute-apps), ohne ComfyUI selbst.
    Unter Windows (WDDM) fehlt oft der Speicher je Prozess - dann nur der Name."""
    import os
    own = own_pid if own_pid is not None else os.getpid()
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,process_name,used_memory",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=15).stdout.strip().splitlines()
    except (OSError, subprocess.SubprocessError):
        return []
    res = []
    for line in out:
        parts = [x.strip() for x in line.split(",")]
        if len(parts) < 2 or not parts[0].isdigit() or int(parts[0]) == own:
            continue
        name = parts[1].replace("\\", "/").split("/")[-1]
        mem = parts[2] if len(parts) > 2 and parts[2].isdigit() else ""
        res.append(name + (f" ({mem} MB)" if mem else "") + f" [PID {parts[0]}]")
    return res


def gpu_blocked_message(free, min_free_mb, why: str = "", holders=None) -> str:
    """65: verstaendliche Meldung, wenn die GPU nicht frei wird (Fehler + Run-Vorabpruefung)."""
    holders = gpu_holders() if holders is None else holders
    shown = max(free, 0) if isinstance(free, int) else "?"
    lines = [f"GPU not free: {shown} MB free, {min_free_mb} MB needed"
             + (f" ({why})" if why else "") + ". Render NOT started."]
    if holders:
        lines.append("Using the GPU: " + ", ".join(holders))
    lines.append("Close or unload the other program's model first: LM Studio -> Eject "
                 "(or 'lms unload --all'), Ollama -> 'ollama stop <model>', other apps -> close them. "
                 "On a smaller GPU lower Settings > all settings > min_free_mb.")
    return "\n".join(lines)


def free_other_llms(ollama_url="http://127.0.0.1:11434", http=http_json, log=print) -> list:
    """65: andere lokale LLMs entladen, die VRAM halten. Wirft nie.
    - Ollama: GET /api/ps + keep_alive=0 (ollama_unload).
    - LM Studio: CLI 'lms unload --all', nur wenn 'lms' installiert ist."""
    import shutil as _sh
    done = []
    if ollama_url:
        try:
            st = ollama_unload(url=ollama_url, http=http, log=log)
            if "unloaded" in st:
                done.append(st)
        except Exception as exc:  # noqa: BLE001
            log(f"[InfiniteMovie] Ollama unload failed: {exc}")
    lms = _sh.which("lms")
    if lms:
        try:
            res = subprocess.run([lms, "unload", "--all"], capture_output=True, text=True, timeout=30)
            log(f"[InfiniteMovie] LM Studio: lms unload --all -> {res.returncode}")
            done.append("lmstudio: unload --all")
        except (OSError, subprocess.SubprocessError) as exc:
            log(f"[InfiniteMovie] LM Studio unload failed: {exc}")
    return done


def wait_acquire(llm_url: str = DEFAULT_LLM_URL,
                 min_free_mb: int = 20000,
                 timeout_s: int = 120,
                 sleep: float = _POLL_S,
                 recheck_after_unload_s: float = _RECHECK_AFTER_UNLOAD_S,
                 unload_probe_interval_s: float = _UNLOAD_PROBE_INTERVAL_S,
                 llm_unload_cooldown_s: float = 30.0,
                 http=http_json,
                 gpu=gpu_free_mb,
                 unload=unload_comfyui_models,
                 log=print,
                 ollama_url: str | None = "http://127.0.0.1:11434",
                 stall_s: float = 150.0,
                 others=None) -> str:
    """Wait until the GPU is free for ComfyUI rendering.

    65 (crash-fest): BeeLlama nicht erreichbar heisst NICHT mehr "durchwinken" - die VRAM-Pruefung
    gilt immer. Andere LLMs (Ollama, LM Studio) werden mit entladen (`others`, Standard
    free_other_llms). Kommt der freie Speicher `stall_s` lang nicht weiter, bricht der Render VOR
    dem ersten Loader mit einer klaren Meldung ab (wer die GPU haelt, was zu tun ist), statt mitten
    im Render mit OOM abzustuerzen. nvidia-smi liefert nichts -> durchwinken mit Warnung.

    Conditions: BeeLlama (llm_url) reports is_sleeping == true AND nvidia-smi
    free memory >= min_free_mb.

    - BeeLlama AWAKE (holding VRAM): actively unload it via POST /models/unload
      (with a cooldown to avoid thrashing). This breaks the deadlock where the
      loop used to wait forever for VRAM the loaded LLM would never release.
      The router auto-reloads the model on the next request, so unloading is
      safe and reversible.
    - BeeLlama sleeping but VRAM still low: ComfyUI likely holds models ->
      unload them, wait, re-measure (repeatedly, at most once per minute).
    - BeeLlama unreachable: pass through with a warning (we cannot block the
      render on a dead LLM).
    - Timeout: raise VRAMTimeoutError (120 s, so a stuck acquire fails fast
      instead of spinning for an hour).

    Returns a short status string for logging / node output.
    """
    if others is None:
        others = lambda: free_other_llms(ollama_url, http=http, log=log)  # noqa: E731
    start = time.time()
    deadline = start + timeout_s
    last_unload_probe = 0.0
    bee_gone = False
    best_free = -1
    best_at = start

    while True:
        now = time.time()
        if now > deadline:
            raise VRAMTimeoutError(gpu_blocked_message(best_free, min_free_mb,
                                                       f"timed out after {timeout_s}s"))

        ok, props = http(f"{llm_url}/props")
        if not ok and not bee_gone:
            log(f"[InfiniteMovie] BeeLlama unreachable at {llm_url} ({props}) - "
                f"checking VRAM anyway.")
            bee_gone = True
        bee_ok = ok

        # 57a: VRAM-basierte Entscheidung (Auftrag 53/54): Genug frei -> sofort
        # acquired, UNABHAENGIG vom LLM-Zustand. Der LLM-Zustand wird nur geloggt.
        is_sleeping = llm_sleeping(llm_url, props, http) if bee_ok else None
        free = gpu()
        if free is None:
            log("[InfiniteMovie] nvidia-smi gave no value - cannot check VRAM, continuing.")
            return "gpu_unknown: passed through" + ("" if bee_ok else " (bee_unreachable)")
        log(f"[InfiniteMovie] acquire: sleeping={is_sleeping}, free={free} MB, "
            f"need>={min_free_mb} MB")

        if free >= min_free_mb:
            return (f"acquired: free={free} MB (sleeping={is_sleeping})"
                    + ("" if bee_ok else " (bee_unreachable)"))

        # 65: kein Fortschritt seit stall_s -> klar abbrechen statt eine Stunde warten
        if free > best_free + 500:
            best_free, best_at = free, now
        elif now - best_at > stall_s:
            raise VRAMTimeoutError(gpu_blocked_message(free, min_free_mb,
                                                       f"no progress for {int(stall_s)}s"))

        # free < min: ComfyUI-Modelle entladen + (falls LLM geladen) LLM per
        # POST /models/unload entladen, dann neu messen.
        if free is not None and free < min_free_mb:
            if now - last_unload_probe >= unload_probe_interval_s:
                log(f"[InfiniteMovie] only {free} MB free -> unloading "
                    f"ComfyUI models (+ LLM if loaded)")
                try:
                    unload()
                except Exception as exc:  # noqa: BLE001 - Entladen darf den Render nie crashen
                    log(f"[InfiniteMovie] ComfyUI unload failed: {exc}")
                try:
                    others()
                except Exception as exc:  # noqa: BLE001
                    log(f"[InfiniteMovie] other-LLM unload failed: {exc}")
                # 2026-11-03: JEDES geladene Profil entladen, nicht nur BEE_MODEL_ID –
                # mit think32k geladen hing der 61-Smoke 7 min bei 513 MB frei.
                for mid in (_loaded_llm_ids(http, llm_url) if bee_ok else []):
                    log(f"[InfiniteMovie] LLM loaded -> POST /models/unload "
                        f"({mid})")
                    http(f"{llm_url}/models/unload",
                         {"model": mid}, timeout=60)
                last_unload_probe = now
                _sleep(recheck_after_unload_s)
                continue

        _sleep(sleep)


# ---------------------------------------------------------------------------
# Release
# ---------------------------------------------------------------------------

def do_release(llm_url: str = DEFAULT_LLM_URL,
               wake_llm: bool = True,
               min_free_mb: int = 18000,
               timeout_s: int = 300,
               sleep: float = _POLL_S,
               wake_timeout_s: float = _WAKE_TIMEOUT_S,
               http=http_json,
               gpu=gpu_free_mb,
               unload=unload_comfyui_models,
               log=print) -> str:
    """Free GPU memory for the LLM and (optionally) wake BeeLlama.

    Steps (mirrors tools/bee_watchdog.py wake_bee, line 231):
    1. Unload ComfyUI models + empty cache (immediately).
    2. Wait until free VRAM >= min_free_mb.
    3. If wake_llm: send a small pre-wake completion request, then wait until
       is_sleeping == false.

    Never kills llama-server.
    """
    deadline = time.time() + timeout_s

    log("[InfiniteMovie] release: unloading ComfyUI models + emptying cache")
    unload()

    # 57a: Deadlock-Fix (Auftrag 54): LLM loaded ODER sleeping -> NICHT auf
    # free>=min_free_mb warten (loaded: belegt VRAM legitim; sleeping: belegt
    # praktisch nichts, Gemessen 2026-11-01: 794 MiB).
    llm_status = llm_model_status(http, llm_url)
    skip_wait = wake_llm and llm_status in ("loaded", "sleeping")
    if skip_wait:
        log(f"[InfiniteMovie] release: LLM {llm_status} -> skipping free>=min wait")
    else:
        # Wait until enough VRAM is free.
        while True:
            now = time.time()
            if now > deadline:
                raise VRAMTimeoutError(
                    f"VRAM release timed out after {timeout_s}s "
                    f"(min_free_mb={min_free_mb})")
            free = gpu()
            free_str = f"{free} MB" if free is not None else "unknown"
            log(f"[InfiniteMovie] release: free={free_str}, need>={min_free_mb} MB")
            if free is not None and free >= min_free_mb:
                break
            _sleep(sleep)

    if not wake_llm:
        return "released: models unloaded, LLM not woken"

    # Router-Modus: /completion ohne Modell geht nicht und /props hat kein
    # is_sleeping -> der Router laedt das Modell bei der naechsten Anfrage selbst.
    ok, props = http(f"{llm_url}/props")
    if not ok:
        log(f"[InfiniteMovie] release: no LLM server at {llm_url} - nothing to wake")
        return "released: models unloaded, no LLM server running"
    if ok and is_router_props(props):
        return "released: models unloaded, router loads the LLM on demand"

    # Pre-wake: small completion request so the server starts loading the
    # model, then wait until it reports awake.
    log(f"[InfiniteMovie] release: waking BeeLlama at {llm_url}")
    ok, err = http(f"{llm_url}/completion",
                   data={"prompt": "OK", "n_predict": 1},
                   timeout=_WAKE_PRECOMPLETION_TIMEOUT_S)
    if not ok:
        log(f"[InfiniteMovie] release: pre-wake request failed ({err}) - "
            f"waiting for wake anyway")

    wake_deadline = time.time() + wake_timeout_s
    while True:
        now = time.time()
        if now > wake_deadline:
            raise VRAMTimeoutError(
                f"BeeLlama did not wake within {wake_timeout_s}s")
        ok, props = http(f"{llm_url}/props")
        if ok and not bool(props.get("is_sleeping", True)):
            return "released: models unloaded, LLM awake"
        _sleep(sleep)


# ---------------------------------------------------------------------------
# Cleanup switches (Auftrag 16, point 3)
# ---------------------------------------------------------------------------

def do_cleanup(free_vram: bool = True,
               free_ram: bool = False,
               wake_llm: bool = True,
               llm_url: str = DEFAULT_LLM_URL,
               min_free_mb: int = 18000,
               timeout_s: int = 300,
               sleep: float = _POLL_S,
               wake_timeout_s: float = _WAKE_TIMEOUT_S,
               http=http_json,
               gpu=gpu_free_mb,
               unload=unload_comfyui_models,
               collect=None,
               log=print) -> str:
    """Run the cleanup switches.

    free_vram (default True):
        Unload all ComfyUI models + empty the CUDA cache, then wait until free
        VRAM >= min_free_mb. Core: model_management.unload_all_models
        (model_management.py:2171) + soft_empty_cache (model_management.py:2153).
    free_ram (default False):
        Additionally free RAM: gc.collect() to release Python objects. The core
        /free endpoint with free_memory (server.py:1289) additionally calls
        PromptExecutor.reset() (main.py:424-427 -> execution.py:675-678) which
        drops ALL cached node outputs/tensors; that cannot be safely replaced
        on the live executor from inside a running node, so it is NOT replicated
        here (documented, not silently omitted).
    wake_llm (default True):
        Wake BeeLlama afterwards. Only effective when free_vram is True, because
        waking needs the VRAM that freeing provides (a sleeping BeeLlama holds
        the GPU; we free ComfyUI's share first).

    All I/O is injectable for offline testing (tools/infinite_movie_test.py).
    """
    import gc
    if collect is None:
        collect = gc.collect

    did_vram = False
    if free_vram:
        log("[InfiniteMovie] cleanup: unloading ComfyUI models + emptying cache")
        unload()
        # 57a: Deadlock-Fix (Auftrag 54): LLM loaded ODER sleeping -> NICHT auf
        # free>=min_free_mb warten.
        llm_status = llm_model_status(http, llm_url)
        skip_wait = wake_llm and llm_status in ("loaded", "sleeping")
        if skip_wait:
            log(f"[InfiniteMovie] cleanup: LLM {llm_status} -> skipping free>=min wait")
        else:
            deadline = time.time() + timeout_s
            while True:
                now = time.time()
                if now > deadline:
                    raise VRAMTimeoutError(
                        f"cleanup timed out after {timeout_s}s "
                        f"(min_free_mb={min_free_mb})")
                free = gpu()
                free_str = f"{free} MB" if free is not None else "unknown"
                log(f"[InfiniteMovie] cleanup: free={free_str}, need>={min_free_mb} MB")
                if free is not None and free >= min_free_mb:
                    break
                _sleep(sleep)
        did_vram = True

    if free_ram:
        log("[InfiniteMovie] cleanup: gc.collect() to free RAM")
        collect()

    if wake_llm and did_vram:
        # Router (BeeLlama --models-max 1): kein /completion ohne Modell (HTTP 400), kein is_sleeping im
        # Router-/props -> nicht wecken, der Router laedt das Modell bei der naechsten Anfrage selbst
        # (2026-10-26: InfiniteMovieAssemble wartete 180 s und brach ab, Film war schon fertig).
        ok, props = http(f"{llm_url}/props")
        if not ok:
            log(f"[InfiniteMovie] cleanup: no LLM server at {llm_url} - nothing to wake")
            return "cleanup: models unloaded" + (", RAM freed" if free_ram else "") + \
                ", no LLM server running"
        if ok and is_router_props(props):
            log("[InfiniteMovie] cleanup: router - LLM is loaded on demand, no wake")
            return "cleanup: models unloaded" + (", RAM freed" if free_ram else "") + \
                ", router loads the LLM on demand"
        # Pre-wake: small completion request so the server starts loading the
        # model, then wait until it reports awake (mirrors do_release).
        log(f"[InfiniteMovie] cleanup: waking BeeLlama at {llm_url}")
        ok, err = http(f"{llm_url}/completion",
                       data={"prompt": "OK", "n_predict": 1},
                       timeout=_WAKE_PRECOMPLETION_TIMEOUT_S)
        if not ok:
            log(f"[InfiniteMovie] cleanup: pre-wake request failed ({err}) - "
                f"waiting for wake anyway")
        wake_deadline = time.time() + wake_timeout_s
        while True:
            now = time.time()
            if now > wake_deadline:
                raise VRAMTimeoutError(
                    f"BeeLlama did not wake within {wake_timeout_s}s")
            ok, props = http(f"{llm_url}/props")
            if ok and not bool(props.get("is_sleeping", True)):
                return "cleanup: models unloaded" + \
                    (", RAM freed" if free_ram else "") + ", LLM awake"
            _sleep(sleep)

    if wake_llm and not did_vram:
        log("[InfiniteMovie] cleanup: wake_llm ignored (free_vram=false)")

    parts = []
    if did_vram:
        parts.append("models unloaded")
    if free_ram:
        parts.append("RAM freed")
    if not parts:
        return "cleanup: nothing to do (free_vram=false, free_ram=false)"
    return "cleanup: " + ", ".join(parts) + \
        (", LLM not woken" if not (wake_llm and did_vram) else "")


# ---------------------------------------------------------------------------
# Ollama check
# ---------------------------------------------------------------------------

def ollama_unload(url: str = "http://127.0.0.1:11434",
                  http=http_json,
                  log=print) -> str:
    """Check if Ollama has models loaded and unload them.

    Steps:
    1. GET /api/ps to list loaded models.
    2. If any models are loaded, POST /api/generate with keep_alive=0 for
       each model to unload it.

    Returns a short status string.
    """
    ok, data = http(f"{url}/api/ps")
    if not ok:
        log(f"[InfiniteMovie] Ollama unreachable at {url} ({data}) - skipping.")
        return f"ollama_unreachable: {data}"

    models = data.get("models", []) if isinstance(data, dict) else []
    if not models:
        return "ollama: no models loaded"

    unloaded = []
    for m in models:
        name = m.get("name", "unknown")
        # 65-FIX: http_json kennt kein method=/body= (TypeError) – POST = data-Dict.
        ok2, _ = http(f"{url}/api/generate",
                      {"model": name, "prompt": "", "keep_alive": 0}, timeout=30)
        if ok2:
            unloaded.append(name)
        else:
            log(f"[InfiniteMovie] Ollama unload failed for {name}")

    if unloaded:
        log(f"[InfiniteMovie] Ollama unloaded: {', '.join(unloaded)}")
        return f"ollama: unloaded {len(unloaded)} model(s)"
    return "ollama: no models to unload"
