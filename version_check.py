"""Update hint: installed version (pyproject.toml) vs. newest released version in the Comfy Registry.

Route GET /infinite_movie/version → {installed, latest, update}. The Registry is asked at most every 6 h,
in a thread (never blocks the server); no network → latest None, update False. Only released versions count
(status Active) – a version still in review cannot be installed via the Manager yet.
Updating itself is left to ComfyUI-Manager (no git pull from the browser).
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.request

NODE_ID = "comfyui-infinite-movie"
_URL = f"https://api.comfy.org/nodes/{NODE_ID}/versions"
_TTL = 6 * 3600
_CACHE = {"t": 0.0, "latest": None}


def installed_version() -> str:
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pyproject.toml")
    try:
        with open(p, encoding="utf-8") as f:
            m = re.search(r'^version\s*=\s*"([^"]+)"', f.read(), re.M)
        return m.group(1) if m else "0"
    except OSError:
        return "0"


def vtuple(v) -> tuple:
    """'0.10.2' → (0, 10, 2); non-numeric parts count as 0."""
    return tuple(int(x) if x.isdigit() else 0 for x in re.split(r"[.\-+]", str(v or "0"))[:3])


def newest_released(versions) -> str | None:
    ok = [v.get("version") for v in versions or []
          if v.get("status") == "NodeVersionStatusActive" and not v.get("deprecated") and v.get("version")]
    return max(ok, key=vtuple) if ok else None


def latest_version() -> str | None:
    now = time.time()
    if now - _CACHE["t"] < _TTL:
        return _CACHE["latest"]
    _CACHE["t"] = now
    try:
        req = urllib.request.Request(_URL, headers={"User-Agent": "comfyui-infinite-movie"})
        with urllib.request.urlopen(req, timeout=8) as r:
            _CACHE["latest"] = newest_released(json.loads(r.read().decode("utf-8")))
    except Exception:  # noqa: BLE001 – offline etc.: no hint
        _CACHE["latest"] = None
    return _CACHE["latest"]


def status() -> dict:
    inst = installed_version()
    latest = latest_version()
    return {"installed": inst, "latest": latest,
            "update": bool(latest) and vtuple(latest) > vtuple(inst)}


def _register_routes():
    try:
        import asyncio
        from aiohttp import web
        from server import PromptServer

        @PromptServer.instance.routes.get("/infinite_movie/version")
        async def _version(request):
            return web.json_response(await asyncio.to_thread(status))
    except Exception as e:  # noqa: BLE001
        print(f"[InfiniteMovie] version route not registered: {e}")


_register_routes()
