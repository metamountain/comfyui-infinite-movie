"""Generic GPU check for the Infinite Movie nodes.

The pack is public: no machine-specific LLM servers, ports or other programs are touched.

- check: free GPU memory (nvidia-smi) PLUS what this ComfyUI process holds itself (ComfyUI offloads
  its own models when it needs the room) must reach the required amount. The requirement is capped
  at 85 % of the card, so smaller GPUs are not blocked forever.
- wait_acquire: repeat the check until it passes; if another program keeps the GPU busy, stop BEFORE
  the render with a clear message naming that program (instead of an OOM halfway through).
- do_cleanup: after the film, optionally unload ComfyUI's models and run gc.

No nvidia-smi (AMD, Apple, no driver tools) -> the check passes; ComfyUI manages memory itself.
All system access goes through small injectable helpers so the logic is unit-testable offline.
"""

from __future__ import annotations

import subprocess
import time

_POLL_S = 5.0
MAX_SHARE_OF_TOTAL = 0.85


class VRAMTimeoutError(RuntimeError):
    """Raised when the GPU does not become free in time."""


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
# Injectable system helpers
# ---------------------------------------------------------------------------

def _smi(query: str) -> int | None:
    try:
        out = subprocess.run(
            ["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=15,
        ).stdout.strip().splitlines()
        values = [int(x) for x in out if x.strip().isdigit()]
        return min(values) if values else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def gpu_free_mb() -> int | None:
    """Free GPU memory in MB via nvidia-smi, or None on failure."""
    return _smi("memory.free")


def gpu_total_mb() -> int | None:
    """Total GPU memory in MB via nvidia-smi, or None on failure."""
    return _smi("memory.total")


def own_reserved_mb() -> int:
    """GPU memory this ComfyUI process holds (torch caching allocator) – ComfyUI can reuse/offload it."""
    try:
        import torch
        if torch.cuda.is_available():
            return int(torch.cuda.memory_reserved() // (1024 * 1024))
    except Exception:  # noqa: BLE001 – ohne torch/CUDA
        pass
    return 0


def unload_comfyui_models() -> None:
    """Ask ComfyUI to unload all models once the current prompt has finished (same as the core /free endpoint).

    Never unload directly from inside a node: nodes run in torch.inference_mode, and unloading there (or with
    inference mode switched off) corrupts LoRA-patched models -> the next film crashes with "Cannot set
    version_counter for inference tensor" / "Inference tensors do not track version counter" (Wan, LTX).
    The prompt worker handles the flag between prompts, outside inference mode (main.py prompt_worker).
    """
    try:
        from server import PromptServer
        PromptServer.instance.prompt_queue.set_flag("unload_models", True)
        PromptServer.instance.prompt_queue.set_flag("free_memory", True)
    except Exception as exc:  # pragma: no cover - depends on ComfyUI runtime
        print(f"[InfiniteMovie] model unload request failed: {exc!r}")


# ---------------------------------------------------------------------------
# Memory status display (VRAM + RAM)
# ---------------------------------------------------------------------------

def get_memory_status() -> str:
    """One-line memory status: ComfyUI's view, nvidia-smi (all processes), RAM."""
    parts: list[str] = []
    try:
        import comfy.model_management as mm
        free = mm.get_free_memory()
        total = mm.get_total_memory()
        if total:
            parts.append(f"VRAM free {free / 1e9:.1f} / {total / 1e9:.1f} GB")
    except Exception:  # noqa: BLE001
        pass
    smi = gpu_free_mb()
    if smi is not None:
        parts.append(f"nvidia-smi free {smi / 1024:.1f} GB")
    try:
        import psutil
        vm = psutil.virtual_memory()
        parts.append(f"RAM free {vm.available / 1e9:.1f} / {vm.total / 1e9:.1f} GB")
    except Exception:  # noqa: BLE001
        pass
    return " | ".join(parts) if parts else "memory: no backend available"


# ---------------------------------------------------------------------------
# Check / acquire
# ---------------------------------------------------------------------------

def gpu_holders(own_pid=None) -> list:
    """Processes using the GPU (nvidia-smi compute-apps), without this ComfyUI.
    On Windows (WDDM) the per-process memory is often missing - then only the name."""
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


def gpu_blocked_message(free, need, why: str = "", holders=None) -> str:
    """Readable message when the GPU is not free (Director error + Run preflight)."""
    holders = gpu_holders() if holders is None else holders
    shown = max(free, 0) if isinstance(free, int) else "?"
    lines = [f"GPU not free: {shown} MB available, {need} MB needed"
             + (f" ({why})" if why else "") + ". Render NOT started."]
    if holders:
        lines.append("Using the GPU: " + ", ".join(holders))
    lines.append("Close the other program or unload its model, then press Run again.")
    return "\n".join(lines)


def required_mb(min_free_mb: int, total=None) -> int:
    """min_free_mb, capped at MAX_SHARE_OF_TOTAL of the card (a 16 GB GPU never has 20 GB free)."""
    need = int(min_free_mb or 0)
    if isinstance(total, int) and total > 0:
        need = min(need, int(total * MAX_SHARE_OF_TOTAL))
    return need


def gpu_check(min_free_mb: int, gpu=gpu_free_mb, total=gpu_total_mb, own=own_reserved_mb) -> tuple:
    """One measurement, never waits. Returns (ok, available_mb_or_None, need_mb, text)."""
    free = gpu()
    if free is None:
        return True, None, int(min_free_mb or 0), "GPU check skipped (no nvidia-smi)"
    mine = own()
    avail = free + mine
    need = required_mb(min_free_mb, total())
    text = f"{avail} MB available ({free} free + {mine} held by ComfyUI), need {need}"
    return avail >= need, avail, need, text


def wait_acquire(min_free_mb: int = 20000,
                 timeout_s: int = 120,
                 sleep: float = _POLL_S,
                 stall_s: float = 150.0,
                 gpu=gpu_free_mb,
                 total=gpu_total_mb,
                 own=own_reserved_mb,
                 log=print) -> str:
    """Wait until gpu_check passes. Raises VRAMTimeoutError (with the holder message) when the
    available memory does not grow for `stall_s` or `timeout_s` is over."""
    start = time.time()
    best, best_at = -1, start
    while True:
        ok, avail, need, text = gpu_check(min_free_mb, gpu=gpu, total=total, own=own)
        if ok:
            log(f"[InfiniteMovie] GPU ok: {text}")
            return f"acquired: {text}"
        now = time.time()
        if avail > best + 500:
            best, best_at = avail, now
        elif now - best_at > stall_s:
            raise VRAMTimeoutError(gpu_blocked_message(avail, need, f"no progress for {int(stall_s)}s"))
        if now - start > timeout_s:
            raise VRAMTimeoutError(gpu_blocked_message(avail, need, f"timed out after {int(timeout_s)}s"))
        log(f"[InfiniteMovie] GPU busy: {text} - waiting")
        _sleep(sleep)


# ---------------------------------------------------------------------------
# Cleanup after the film
# ---------------------------------------------------------------------------

def do_cleanup(free_vram: bool = True,
               free_ram: bool = False,
               unload=unload_comfyui_models,
               collect=None,
               log=print) -> str:
    """free_vram: unload ComfyUI's models after this prompt (core flag, like /free).
    free_ram: gc.collect(). The core /free endpoint additionally resets the executor cache; that cannot
    be done safely from inside a running node, so it is not replicated here."""
    import gc
    if collect is None:
        collect = gc.collect
    parts = []
    if free_vram:
        log("[InfiniteMovie] cleanup: ComfyUI models unload after this prompt")
        unload()
        parts.append("models unloaded")
    if free_ram:
        log("[InfiniteMovie] cleanup: gc.collect() to free RAM")
        collect()
        parts.append("RAM freed")
    if not parts:
        return "cleanup: nothing to do (free_vram=false, free_ram=false)"
    return "cleanup: " + ", ".join(parts)
