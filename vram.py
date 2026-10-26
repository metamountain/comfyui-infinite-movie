"""VRAM handoff logic for FilmChain.

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
logic can be unit-tested offline (tools/filmchain_test.py).
"""

from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.request

DEFAULT_LLM_URL = "http://127.0.0.1:8080"

# Polling cadence (seconds)
_POLL_S = 5.0
_RECHECK_AFTER_UNLOAD_S = 10.0
_WAKE_PRECOMPLETION_TIMEOUT_S = 120.0
_WAKE_TIMEOUT_S = 180.0
_UNLOAD_PROBE_INTERVAL_S = 60.0


class VRAMTimeoutError(RuntimeError):
    """Raised when the acquire/release wait exceeds the configured timeout."""


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
        print(f"[FilmChain] model unload failed: {exc}")


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

def wait_acquire(llm_url: str = DEFAULT_LLM_URL,
                 min_free_mb: int = 20000,
                 timeout_s: int = 3600,
                 sleep: float = _POLL_S,
                 recheck_after_unload_s: float = _RECHECK_AFTER_UNLOAD_S,
                 unload_probe_interval_s: float = _UNLOAD_PROBE_INTERVAL_S,
                 http=http_json,
                 gpu=gpu_free_mb,
                 unload=unload_comfyui_models,
                 log=print) -> str:
    """Wait until the GPU is free for ComfyUI rendering.

    Conditions: BeeLlama (llm_url) reports is_sleeping == true AND nvidia-smi
    free memory >= min_free_mb.

    - BeeLlama awake: just wait (it sleeps on its own after idle).
    - BeeLlama sleeping but VRAM still low: ComfyUI likely holds models ->
      unload them, wait, re-measure (repeatedly, at most once per minute).
    - BeeLlama unreachable: pass through with a warning (we cannot block the
      render on a dead LLM).
    - Timeout: raise VRAMTimeoutError.

    Returns a short status string for logging / node output.
    """
    deadline = time.time() + timeout_s
    last_unload_probe = 0.0
    bee_gone = False

    while True:
        now = time.time()
        if now > deadline:
            raise VRAMTimeoutError(
                f"VRAM acquire timed out after {timeout_s}s "
                f"(min_free_mb={min_free_mb}, llm_url={llm_url})")

        ok, props = http(f"{llm_url}/props")
        if not ok:
            if not bee_gone:
                log(f"[FilmChain] BeeLlama unreachable at {llm_url} "
                    f"({props}) - continuing without waiting.")
                bee_gone = True
            return "bee_unreachable: passed through"

        is_sleeping = bool(props.get("is_sleeping", False))
        free = gpu()
        free_str = f"{free} MB" if free is not None else "unknown"
        log(f"[FilmChain] acquire: sleeping={is_sleeping}, free={free_str}, "
            f"need>={min_free_mb} MB")

        if is_sleeping and free is not None and free >= min_free_mb:
            return f"acquired: sleeping, free={free} MB"

        if is_sleeping and free is not None and free < min_free_mb:
            # ComfyUI still holds models -> unload, wait, re-measure.
            if now - last_unload_probe >= unload_probe_interval_s:
                log(f"[FilmChain] sleeping but only {free} MB free -> "
                    f"unloading ComfyUI models")
                unload()
                last_unload_probe = now
                time.sleep(recheck_after_unload_s)
                continue

        time.sleep(sleep)


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

    log("[FilmChain] release: unloading ComfyUI models + emptying cache")
    unload()

    # Wait until enough VRAM is free.
    while True:
        now = time.time()
        if now > deadline:
            raise VRAMTimeoutError(
                f"VRAM release timed out after {timeout_s}s "
                f"(min_free_mb={min_free_mb})")
        free = gpu()
        free_str = f"{free} MB" if free is not None else "unknown"
        log(f"[FilmChain] release: free={free_str}, need>={min_free_mb} MB")
        if free is not None and free >= min_free_mb:
            break
        time.sleep(sleep)

    if not wake_llm:
        return "released: models unloaded, LLM not woken"

    # Pre-wake: small completion request so the server starts loading the
    # model, then wait until it reports awake.
    log(f"[FilmChain] release: waking BeeLlama at {llm_url}")
    ok, err = http(f"{llm_url}/completion",
                   data={"prompt": "OK", "n_predict": 1},
                   timeout=_WAKE_PRECOMPLETION_TIMEOUT_S)
    if not ok:
        log(f"[FilmChain] release: pre-wake request failed ({err}) - "
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
        time.sleep(sleep)


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

    All I/O is injectable for offline testing (tools/filmchain_test.py).
    """
    import gc
    if collect is None:
        collect = gc.collect

    did_vram = False
    if free_vram:
        log("[FilmChain] cleanup: unloading ComfyUI models + emptying cache")
        unload()
        deadline = time.time() + timeout_s
        while True:
            now = time.time()
            if now > deadline:
                raise VRAMTimeoutError(
                    f"cleanup timed out after {timeout_s}s "
                    f"(min_free_mb={min_free_mb})")
            free = gpu()
            free_str = f"{free} MB" if free is not None else "unknown"
            log(f"[FilmChain] cleanup: free={free_str}, need>={min_free_mb} MB")
            if free is not None and free >= min_free_mb:
                break
            time.sleep(sleep)
        did_vram = True

    if free_ram:
        log("[FilmChain] cleanup: gc.collect() to free RAM")
        collect()

    if wake_llm and did_vram:
        # Pre-wake: small completion request so the server starts loading the
        # model, then wait until it reports awake (mirrors do_release).
        log(f"[FilmChain] cleanup: waking BeeLlama at {llm_url}")
        ok, err = http(f"{llm_url}/completion",
                       data={"prompt": "OK", "n_predict": 1},
                       timeout=_WAKE_PRECOMPLETION_TIMEOUT_S)
        if not ok:
            log(f"[FilmChain] cleanup: pre-wake request failed ({err}) - "
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
            time.sleep(sleep)

    if wake_llm and not did_vram:
        log("[FilmChain] cleanup: wake_llm ignored (free_vram=false)")

    parts = []
    if did_vram:
        parts.append("models unloaded")
    if free_ram:
        parts.append("RAM freed")
    if not parts:
        return "cleanup: nothing to do (free_vram=false, free_ram=false)"
    return "cleanup: " + ", ".join(parts) + \
        (", LLM not woken" if not (wake_llm and did_vram) else "")
