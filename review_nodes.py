"""InfiniteMovieReview (Auftrag 31): Segment-Kacheln mit Nummern, markieren, nur
Schadhaftes neu rendern.

Backend-Node: erzeugt je Segment eine animierte WebP-Vorschau (160 px, jedes
2. Frame, 12 fps) und faehrt 3 billige Pruefungen (CUT / FLICKER / PARTICLES)
im Graustufen-Kleinformat (96x120, Frames stueckweise, nie als IMAGE-Batch).
Das Ergebnis geht als ui-Dict an das Frontend (web/infinite_movie.js, Extension
InfiniteMovieRender.Review), das die Kacheln rendert. Der Node blockiert nichts: der
segments-Eingang wird unveraendert durchgereicht.

Vorschau + Pruefung werden gecacht (JSON-Sidecar, Dateigroesse/mtime): ein
Review-Lauf dauert Sekunden, nicht Minuten.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess

import numpy as np

from comfy_api.latest import io

from .nodes import _count_frames, _ffmpeg, _motion_check, _no_window, _run_ffmpeg_to, SHOTS
# 75: particle helpers moved here from ghost_nodes.py (ghost_nodes.py -> tools/ghost_check.py)
import cv2

HP_SIGMA = 3.0      # Hochpass-Radius
BLOB_T = 10         # Mindestkontrast (Grauwert) eines Partikels
AREA_MIN, AREA_MAX = 2, 60
SMOOTH_T = 6.0      # max. lokale Std im Median-Frame fuer "glatt" (Himmel)
MATCH_R = 14.0      # px, max. Sprung je Frame
STILL_PX = 2.5      # Gesamtweg-Schwelle fuer "steht"


def _sky_mask(gray: np.ndarray) -> np.ndarray:
    med = np.median(gray, axis=0).astype(np.float32)
    mu = cv2.blur(med, (15, 15))
    var = cv2.blur(med * med, (15, 15)) - mu * mu
    m = (np.sqrt(np.maximum(var, 0)) < SMOOTH_T).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    _, lab = cv2.connectedComponents(m, 8)
    top = set(np.unique(lab[0, :])) - {0}
    m = np.isin(lab, list(top)).astype(np.uint8)
    return cv2.erode(m, np.ones((9, 9), np.uint8))


def _detect(frame: np.ndarray, mask: np.ndarray) -> np.ndarray:
    f = frame.astype(np.float32)
    hp = np.abs(f - cv2.GaussianBlur(f, (0, 0), HP_SIGMA))
    bw = ((hp > BLOB_T) & (mask > 0)).astype(np.uint8)
    n, _, stats, cent = cv2.connectedComponentsWithStats(bw, 8)
    keep = [cent[i] for i in range(1, n) if AREA_MIN <= stats[i, cv2.CC_STAT_AREA] <= AREA_MAX]
    return np.array(keep, np.float32).reshape(-1, 2)


def _track(dets: list[np.ndarray]) -> list[list[tuple[int, float, float]]]:
    tracks: list[list[tuple[int, float, float]]] = []
    active: list[int] = []
    for t, pts in enumerate(dets):
        used = np.zeros(len(pts), bool)
        nxt = []
        for ti in active:
            if len(pts) == 0:
                continue
            _, x, y = tracks[ti][-1]
            d = np.hypot(pts[:, 0] - x, pts[:, 1] - y)
            d[used] = 1e9
            j = int(np.argmin(d))
            if d[j] <= MATCH_R:
                used[j] = True
                tracks[ti].append((t, float(pts[j, 0]), float(pts[j, 1])))
                nxt.append(ti)
        for j in np.where(~used)[0]:
            tracks.append([(t, float(pts[j, 0]), float(pts[j, 1]))])
            nxt.append(len(tracks) - 1)
        active = nxt
    return tracks


def _is_still(t) -> bool:
    path = sum(np.hypot(t[i][1] - t[i - 1][1], t[i][2] - t[i - 1][2]) for i in range(1, len(t)))
    net = np.hypot(t[-1][1] - t[0][1], t[-1][2] - t[0][2])
    return path < STILL_PX * 2 and net < STILL_PX

# ---------------------------------------------------------------------------
# Schwellwerte (Konstanten oben in der Datei, Auftrag 31)
# ---------------------------------------------------------------------------
# CUT: groesster Schritt >= 35 % der Start->End-Aenderung UND > 8
# (dieselbe Regel wie InfiniteMovieAssemble-`check`, _motion_check wiederverwendet).
CUT_SHARE_MIN = 0.35
CUT_STEP_MIN = 8.0
# FLICKER: mittlere Helligkeit je Frame L[t] (0-255), d = diff(L),
# Vorzeichenwechsel von d mit |d| > 1.5 in beiden Nachbarschritten;
# FLICKER wenn Anzahl >= 3.
FLICKER_DELTA_MIN = 1.5
FLICKER_COUNT_MIN = 3
# PARTICLES: Partikel-Erkennung (ghost_nodes) auf jedes 2. Frame;
# PARTICLES wenn >= 5 stehende Partikel-Tracks mit Laenge >= 6.
PARTICLES_TRACKS_MIN = 5
PARTICLES_LEN_MIN = 6
# Verdachts-Stufe (level 0-3) je Pruefung:
#   CUT:       groesster Schritt 35-50 % -> 2, > 50 % -> 3
#   FLICKER:   3-5 Wechsel -> 1, 6-9 -> 2, >= 10 -> 3
#   PARTICLES: 5-9 Tracks -> 1, 10-19 -> 2, >= 20 -> 3
#   level = Maximum der Einzelstufen; >= 2 Flags -> mindestens 2.
GRAY_W, GRAY_H = 96, 120  # Kleinformat wie _motion_check


def _cut_level(share: float) -> int:
    if share > 0.50:
        return 3
    if share >= CUT_SHARE_MIN:
        return 2
    return 0


def _flicker_level(count: int) -> int:
    if count >= 10:
        return 3
    if count >= 6:
        return 2
    if count >= FLICKER_COUNT_MIN:
        return 1
    return 0


def _particles_level(tracks: int) -> int:
    if tracks >= 20:
        return 3
    if tracks >= 10:
        return 2
    if tracks >= PARTICLES_TRACKS_MIN:
        return 1
    return 0


def _read_gray_frames(path: str, every: int = 1) -> np.ndarray:
    """Read every `every`-th frame as gray GRAY_W x GRAY_H, shape (n, H, W) float32.
    Frames stueckweise (ein ffmpeg-Aufruf, rawvideo) – nie als IMAGE-Batch."""
    raw = _ffmpeg_run_gray(path, every)
    a = np.frombuffer(raw, np.uint8)
    n = a.size // (GRAY_W * GRAY_H)
    if n < 1:
        return np.zeros((0, GRAY_H, GRAY_W), np.float32)
    return a[: n * GRAY_W * GRAY_H].reshape(n, GRAY_H, GRAY_W).astype(np.float32)


def _ffmpeg_run_gray(path: str, every: int) -> bytes:
    """ffmpeg: decode, take every `every`-th frame, scale to gray GRAY_W x GRAY_H."""
    sel = f"select=not(mod(n\\,{every}))" if every > 1 else None
    vf = f"{sel},scale={GRAY_W}:{GRAY_H}" if sel else f"scale={GRAY_W}:{GRAY_H}"
    res = subprocess.run(
        [_ffmpeg(), "-v", "error", "-i", path, "-vf", vf,
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True, **_no_window())
    return res.stdout


def _check_cut(path: str) -> tuple[bool, int, str]:
    """CUT via _motion_check (wiederverwendet, nicht kopiert).
    Returns (is_cut, level, info)."""
    jump, k, total = _motion_check(path)
    share = jump / max(total, 1.0)
    is_cut = jump > CUT_STEP_MIN and share >= CUT_SHARE_MIN
    level = _cut_level(share) if is_cut else 0
    info = f"largest step {share:.0%} of the transition (at frame {k}->{k + 1})"
    return is_cut, level, info


def _check_flicker(frames: np.ndarray) -> tuple[bool, int, str]:
    """FLICKER: mittlere Helligkeit je Frame, Vorzeichenwechsel von d mit |d|>1.5."""
    if frames.shape[0] < 3:
        return False, 0, "too few frames"
    L = frames.mean(axis=(1, 2))  # (n,) mittlere Helligkeit je Frame
    d = np.diff(L)
    # Vorzeichenwechsel in beiden Nachbarschritten: d[i] und d[i+1] haben
    # unterschiedliches Vorzeichen UND beide |d| > FLICKER_DELTA_MIN.
    big = np.abs(d) > FLICKER_DELTA_MIN
    changes = 0
    for i in range(len(d) - 1):
        if big[i] and big[i + 1] and d[i] * d[i + 1] < 0:
            changes += 1
    is_flicker = changes >= FLICKER_COUNT_MIN
    level = _flicker_level(changes) if is_flicker else 0
    info = f"{changes} flicker steps (brightness sign changes)"
    return is_flicker, level, info


def _check_particles(frames: np.ndarray) -> tuple[bool, int, str]:
    """PARTICLES: ghost_nodes-Erkennung auf die (alle 2. Frame) Frames."""
    if frames.shape[0] < PARTICLES_LEN_MIN:
        return False, 0, "too few frames"
    mask = _sky_mask(frames)
    dets = [_detect(f, mask) for f in frames]
    tracks = _track(dets)
    still = [t for t in tracks if len(t) >= PARTICLES_LEN_MIN and _is_still(t)]
    is_particles = len(still) >= PARTICLES_TRACKS_MIN
    level = _particles_level(len(still)) if is_particles else 0
    info = f"{len(still)} still particles (tracks >= {PARTICLES_LEN_MIN})"
    return is_particles, level, info


def _review_segment(path: str, out_webp: str) -> dict:
    """Vorschau (WebP) + 3 Pruefungen fuer ein Segment. Returns the ui-entry."""
    # 1. Vorschau: animierte WebP (160 px, jedes 2. Frame, 12 fps, Endlosschleife).
    ff = _ffmpeg()
    cmd = [ff, "-y", "-i", path,
           "-vf", "select=not(mod(n\\,2)),scale=160:-2",
           "-loop", "0", "-c:v", "libwebp", "-quality", "60", out_webp]
    _run_ffmpeg_to(cmd, out_webp)
    # 2. Pruefungen (Graustufen 96x120, stueckweise). FLICKER braucht jedes
    #    Frame (every=1, sonst wird die Abwechselung uebersprungen);
    #    PARTICLES jedes 2. Frame (wie in der Doku).
    frames_all = _read_gray_frames(path, every=1)
    frames = frames_all[::2]
    flags: list[str] = []
    levels: list[int] = []
    infos: list[str] = []
    cut, cut_lv, cut_info = _check_cut(path)
    flick, flick_lv, flick_info = _check_flicker(frames)
    part, part_lv, part_info = _check_particles(frames)
    if cut:
        flags.append("CUT"); levels.append(cut_lv); infos.append(cut_info)
    if flick:
        flags.append("FLICKER"); levels.append(flick_lv); infos.append(flick_info)
    if part:
        flags.append("PARTICLES"); levels.append(part_lv); infos.append(part_info)
    level = max(levels) if levels else 0
    if len(flags) >= 2:
        level = max(level, 2)
    return {"flags": flags, "level": level, "info": "; ".join(infos) or "ok"}


def _segment_sig(path: str) -> tuple[int, float]:
    st = os.stat(path)
    return int(st.st_size), st.st_mtime


# 75: InfiniteMovieReview removed (not used by any workflow).
# The helper functions (_check_cut, _check_flicker, _check_particles, _review_segment,
# _segment_sig) remain - they are used by InfiniteMovieChooser.


# ---------------------------------------------------------------------------
# InfiniteMovieChooser (Auftrag 61): Variants-Builder
# ---------------------------------------------------------------------------
# Je Uebergang zwei Varianten (A/B) als Kacheln + Vergleichskachel. Ein
# Algorithmus waehlt vorab automatisch die bessere Variante (CUT/FLICKER/
# PARTICLES-Level + Ruckel-Mass); der Nutzer kann pro Uebergang ueberschreiben.
# Die gewaehlten Pfade ersetzen segments in der shots-Pipe (variants bleibt
# erhalten), sodass der nachgeschaltete Assemble die gewaehlten Segmente bekommt.


def _jerk_metric(path: str) -> float:
    """Ruckel-Mass (Auftrag 61): Graustufen 96x120, d[t] = mittlere
    Absolutdifferenz der Nachbarframes, jerk = max(d) / mean(d)."""
    frames = _read_gray_frames(path, every=1)
    n = frames.shape[0]
    if n < 2:
        return 0.0
    d = np.mean(np.abs(np.diff(frames, axis=0)), axis=(1, 2))  # (n-1,)
    m = float(d.mean())
    if m <= 0:
        return 0.0
    return float(d.max() / m)


def _read_frame_gray(path: str, index: int) -> np.ndarray | None:
    """Einzelnes Frame (0-basiert) als Graustufen GRAY_W x GRAY_H, shape (H, W) float32.
    Per ffmpeg select=eq(n\\,index) – nur das eine Frame, nie den ganzen Film als
    IMAGE-Batch (AGENTS-Regel 4)."""
    sel = f"select=eq(n\\,{index}),scale={GRAY_W}:{GRAY_H}"
    res = subprocess.run(
        [_ffmpeg(), "-v", "error", "-i", path, "-vf", sel,
         "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True, **_no_window())
    a = np.frombuffer(res.stdout, np.uint8)
    if a.size < GRAY_W * GRAY_H:
        return None
    return a[: GRAY_W * GRAY_H].reshape(GRAY_H, GRAY_W).astype(np.float32)


def _seam_metric(path_a: str, path_b: str) -> float:
    """Naht-Mass (78): letztes Frame von path_a gegen erstes Frame von path_b.
    Gleiche Bildverkleinerung (Graustufen 96x120) und Differenz (mittlere
    Absolutdifferenz) wie _jerk_metric. Returns den Wert in Grauwerten (0-255)."""
    if not os.path.exists(path_a) or not os.path.exists(path_b):
        return 0.0
    n_a = _count_frames(path_a)
    n_b = _count_frames(path_b)
    if n_a < 1 or n_b < 1:
        return 0.0
    last_a = _read_frame_gray(path_a, n_a - 1)
    first_b = _read_frame_gray(path_b, 0)
    if last_a is None or first_b is None:
        return 0.0
    return float(np.mean(np.abs(last_a - first_b)))


def _make_still(path: str, out_still: str) -> None:
    """Standbild (erster Frame, 160 px) als WebP – fuer die Live-Vorschau
    (nur die aktive Spalte ist animiert, die anderen zeigen das Standbild)."""
    ff = _ffmpeg()
    cmd = [ff, "-y", "-i", path,
           "-vf", "scale=160:-2",
           "-frames:v", "1", "-c:v", "libwebp", "-quality", "60", out_still]
    _run_ffmpeg_to(cmd, out_still)


SHEET_GRID = 3          # 2026-11-08 (Nutzer: „sheet muss schon in chooser … 3x3 als standard“)
SHEET_TILE = (240, 300)  # je Kachel 4:5 -> Sheet 720×900 (großes Feld unten im Chooser, bis 640 px breit)


def sheet_picks(n: int, grid: int = SHEET_GRID) -> list[int]:
    """grid×grid gleichmäßig verteilte Frame-Indizes (erstes + letztes Frame immer dabei, keine Doppelten)."""
    want = min(grid * grid, max(n, 0))
    if want <= 0:
        return []
    if want == 1:
        return [0]
    out = []
    for i in range(want):
        k = round(i * (n - 1) / (want - 1))
        if k not in out:
            out.append(k)
    return out


def _make_sheet(path: str, out_sheet: str, grid: int = SHEET_GRID) -> None:
    """Kontaktabzug grid×grid (Standard 3×3) über den ganzen Shot als WebP – zeigt im Chooser den Verlauf des
    Übergangs auf einen Blick, ohne abzuspielen."""
    n = _count_frames(path)
    picks = sheet_picks(n, grid)
    if not picks:
        raise RuntimeError(f"no frames in {path}")
    w, h = SHEET_TILE
    sel = "+".join(f"eq(n\\,{k})" for k in picks)
    vf = (f"select={sel},scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},"
          f"tile={grid}x{grid}:padding=2:color=0x121212")
    cmd = [_ffmpeg(), "-y", "-i", path, "-vf", vf, "-fps_mode", "passthrough",
           "-frames:v", "1", "-c:v", "libwebp", "-quality", "75", out_sheet]
    _run_ffmpeg_to(cmd, out_sheet)


def _make_last(path: str, out_last: str) -> None:
    """Letztes Frame (160 px) als WebP – für die Naht-Ansicht im Chooser (letztes Bild Shot k | erstes Bild
    Shot k+1). Gegenstück zu _make_still (erstes Frame)."""
    n = _count_frames(path)
    if n < 1:
        raise RuntimeError(f"no frames in {path}")
    cmd = [_ffmpeg(), "-y", "-i", path, "-vf", f"select=eq(n\\,{n - 1}),scale=160:-2", "-fps_mode", "passthrough",
           "-frames:v", "1", "-c:v", "libwebp", "-quality", "60", out_last]
    _run_ffmpeg_to(cmd, out_last)


# Zusatzbilder je Variante: Cache-Schlüssel -> (Erzeuger, Dateiendung, Eintrag im ui)
_EXTRAS = {"sheet_file": (_make_sheet, "_sheet.webp", "sheet"), "last_file": (_make_last, "_last.webp", "last")}


def _variant_entry(path: str, choose_dir: str, subfolder: str, variant_key: str,
                   cache: dict, cache_key: str) -> tuple[dict, bool]:
    """Vorschau (animierte WebP) + Standbild + Pruefungen + jerk fuer eine
    Variante. Gecacht nach Groesse/mtime (wie der Review-Node). Returns (entry, changed)."""
    if not os.path.exists(path):
        return {"preview": None, "still": None, "flags": [], "level": 0,
                "info": f"segment file not found: {os.path.basename(path)}",
                "jerk": 0.0, "score": 0.0}, False
    size, mtime = _segment_sig(path)
    sig = f"{size}:{mtime:.6f}"
    cached = cache.get(cache_key)
    if cached and cached.get("sig") == sig and cached.get("preview_file") and \
            os.path.exists(os.path.join(choose_dir, cached["preview_file"])) and \
            cached.get("still_file") and os.path.exists(os.path.join(choose_dir, cached["still_file"])):
        made = False
        for key, (fn, suffix, _ui) in _EXTRAS.items():
            if cached.get(key) and os.path.exists(os.path.join(choose_dir, cached[key])):
                continue
            try:   # ältere Cache-Einträge: fehlende Zusatzbilder nachziehen
                f = cached["still_file"].replace("_still.webp", suffix)
                fn(path, os.path.join(choose_dir, f))
                cached[key] = f
                made = True
            except Exception:  # noqa: BLE001
                cached[key] = None
        return {
            "preview": {"filename": cached["preview_file"], "subfolder": subfolder, "type": "temp"},
            "still": {"filename": cached["still_file"], "subfolder": subfolder, "type": "temp"},
            **{ui: ({"filename": cached[key], "subfolder": subfolder, "type": "temp"} if cached.get(key) else None)
               for key, (_fn, _sfx, ui) in _EXTRAS.items()},
            "flags": cached.get("flags", []),
            "level": cached.get("level", 0),
            "info": cached.get("info", ""),
            "jerk": cached.get("jerk", 0.0),
            "score": cached.get("score", 0.0),
        }, made
    h = hashlib.md5(sig.encode("utf-8")).hexdigest()[:8]
    preview_file = f"{variant_key}_{h}.webp"
    still_file = f"{variant_key}_{h}_still.webp"
    out_webp = os.path.join(choose_dir, preview_file)
    out_still = os.path.join(choose_dir, still_file)
    extra_files = {key: f"{variant_key}_{h}{sfx}" for key, (_fn, sfx, _ui) in _EXTRAS.items()}
    try:
        res = _review_segment(path, out_webp)
        _make_still(path, out_still)
        for key, (fn, _sfx, _ui) in _EXTRAS.items():
            try:
                fn(path, os.path.join(choose_dir, extra_files[key]))
            except Exception:  # noqa: BLE001  (Zugabe – Vorschau/Prüfung laufen weiter)
                extra_files[key] = None
        jerk = _jerk_metric(path)
    except Exception as e:  # noqa: BLE001
        res = {"flags": [], "level": 0, "info": f"choose failed: {e}"}
        jerk = 0.0
    level = res["level"]
    score = level * 10 + jerk
    cache[cache_key] = {"sig": sig, "preview_file": preview_file, "still_file": still_file, **extra_files,
                        "flags": res["flags"], "level": level, "info": res["info"],
                        "jerk": jerk, "score": score}
    return {
        "preview": {"filename": preview_file, "subfolder": subfolder, "type": "temp"},
        "still": {"filename": still_file, "subfolder": subfolder, "type": "temp"},
        **{ui: ({"filename": extra_files[key], "subfolder": subfolder, "type": "temp"} if extra_files[key] else None)
           for key, (_fn, _sfx, ui) in _EXTRAS.items()},
        "flags": res["flags"],
        "level": level,
        "info": res["info"],
        "jerk": jerk,
        "score": score,
    }, True


def _auto_choose(a_entry: dict, b_entry: dict) -> tuple[str, float, float, str]:
    """Auto-Wahl (Auftrag 61): score = level*10 + jerk, niedriger ist besser,
    Gleichstand gewinnt A. Returns (winner, a_score, b_score, reason)."""
    a_score = a_entry["score"]
    b_score = b_entry["score"]
    winner = "a" if a_score <= b_score else "b"
    reason = (f"A: level {a_entry['level']}, jerk {a_entry['jerk']:.2f} (score {a_score:.2f}); "
              f"B: level {b_entry['level']}, jerk {b_entry['jerk']:.2f} (score {b_score:.2f})")
    return winner, a_score, b_score, reason


# 75 (Nutzer 2026-11-03: „Empfehlung nur wenn starke Indikation (schlechte harte Übergänge)“)
JERK_HARD = 7.0        # ab hier harter Sprung; echte ruhige LTX-Shots 1.8-4.8 (2026-11-03), synth. Schnitt-Clip im Test nur >= 2.5
LEVEL_STRONG = 2       # Review-Stufe ab der ein Fehler deutlich ist (0-3)


def _is_bad(e: dict) -> bool:
    return int(e.get("level", 0)) >= LEVEL_STRONG or float(e.get("jerk", 0.0)) >= JERK_HARD


def _auto_strong(a_entry: dict, b_entry: dict) -> bool:
    """True nur, wenn eine Variante klar schlecht ist und die andere klar besser."""
    for bad, good in ((a_entry, b_entry), (b_entry, a_entry)):
        if not _is_bad(bad) or _is_bad(good):
            continue
        return True
    if _is_bad(a_entry) and _is_bad(b_entry):
        # beide schlecht: nur bei deutlichem Abstand empfehlen (eine Stufe oder 40 % weniger Ruck)
        la, lb = int(a_entry.get("level", 0)), int(b_entry.get("level", 0))
        ja, jb = float(a_entry.get("jerk", 0.0)), float(b_entry.get("jerk", 0.0))
        return abs(la - lb) >= 1 or min(ja, jb) < 0.6 * max(ja, jb)
    return False


def _parse_choices(choices: str, n: int) -> list[str]:
    """Parse the choices string ('auto,b,auto') into a list of 'a'/'b'/'auto'
    per segment. Missing / invalid entries become 'auto'."""
    parts = [p.strip().lower() for p in str(choices or "").split(",")]
    result = []
    for i in range(n):
        if i < len(parts) and parts[i] in ("a", "b"):
            result.append(parts[i])
        else:
            result.append("auto")
    return result


class InfiniteMovieChooser(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieChooser",
            display_name="Infinite Movie · Choose",
            search_aliases=["infinite movie", "infinite_movie", "choose", "chooser", "variant", "variants"],
            category="Infinite Movie/2 Render",
            description="Variants builder (Auftrag 61): for each transition, shows variant A and B side by side "
                        "with a comparison tile. An algorithm pre-selects the better variant (CUT/FLICKER/"
                        "PARTICLES level + jerk metric); the user can override per transition. The chosen "
                        "segments replace 'segments' in the shots pipe (variants is preserved), so the "
                        "downstream Assemble gets the chosen segments.",
            is_output_node=True,
            inputs=[
                SHOTS.Input("shots", display_name="shots",
                            tooltip="Pipe with all shots (segment paths, folder, name, fps, loop, variants) "
                                    "from Infinite Movie · Director."),
                io.String.Input("choices", default="",
                                tooltip="Hidden (written by the frontend): per-transition choice, e.g. 'auto,b,auto' "
                                        "('a'/'b' overrides the automatic choice)."),
            ],
            outputs=[
                # 73: nur noch shots (segments-Ausgang gestrichen; die gewählten
                # Segmente stecken in der shots-Pipe unter "segments").
                SHOTS.Output("shots", display_name="shots",
                             tooltip="Pipe with the chosen segment paths (segments replaced, variants preserved)."),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, shots, choices=""):
        if shots is None:
            raise ValueError("InfiniteMovieChooser: shots pipe required")
        segments = list(shots.get("segments", []))
        variants = shots.get("variants", None)
        has_variants = variants is not None and len(variants) == len(segments)
        n = len(segments)
        if n == 0:
            raise ValueError("InfiniteMovieChooser: no segment paths provided")
        choice_list = _parse_choices(choices, n)
        unique_id = None
        try:
            unique_id = str(cls.hidden.unique_id)
        except AttributeError:
            unique_id = "choose"
        import folder_paths
        temp_root = folder_paths.get_temp_directory()
        subfolder = os.path.join("infinite_movie_choose", unique_id)
        choose_dir = os.path.join(temp_root, subfolder)
        os.makedirs(choose_dir, exist_ok=True)
        cache_file = os.path.join(choose_dir, "cache.json")
        try:
            cache = json.loads(open(cache_file, encoding="utf-8").read()) if os.path.exists(cache_file) else {}
        except Exception:  # noqa: BLE001
            cache = {}
        entries: list[dict] = []
        chosen_segments: list[str] = []
        changed = False
        for i in range(n):
            number = i + 1
            a_path = str(segments[i])
            b_path = str(variants[i][1]) if has_variants else None
            a_entry, ch_a = _variant_entry(a_path, choose_dir, subfolder, "a", cache, f"{i}_a")
            changed = changed or ch_a
            if b_path is not None:
                b_entry, ch_b = _variant_entry(b_path, choose_dir, subfolder, "b", cache, f"{i}_b")
                changed = changed or ch_b
                auto_winner, a_score, b_score, reason = _auto_choose(a_entry, b_entry)
                strong = _auto_strong(a_entry, b_entry)
                if not strong:
                    auto_winner, reason = "a", "no clear difference – your choice. " + reason
                chosen = choice_list[i] if choice_list[i] in ("a", "b") else auto_winner
                chosen_path = a_path if chosen == "a" else b_path
            else:
                b_entry = None
                strong = False
                auto_winner = "a"
                a_score = a_entry["score"]
                b_score = None
                reason = ""
                chosen = "a"
                chosen_path = a_path
            chosen_segments.append(chosen_path)
            print(f"[InfiniteMovieChooser] shot {number}: chosen={chosen} auto={auto_winner} "
                  f"score_a={a_score} score_b={b_score} {reason}".rstrip())
            entries.append({
                "index": i,
                "number": number,
                "has_variants": b_entry is not None,
                "a": a_entry,
                "b": b_entry,
                "auto": auto_winner,
                "auto_reason": reason,
                "auto_strong": strong,
                "score_a": a_score,
                "score_b": b_score,
                "chosen": chosen,
            })
        # 78: Naht (seam) je Shot: letztes Frame von Shot i gegen erstes Frame von
        # Shot i+1 (mit Loop: letzter -> erster). Gleiche Verkleinerung/Differenz
        # wie _jerk_metric; Schwelle JERK_HARD. Auf den gewaehlten Segmenten gemessen.
        loop = bool(shots.get("loop", False))
        for i in range(n):
            if i + 1 < n:
                nxt = i + 1
            elif loop:
                nxt = 0
            else:
                entries[i]["seam"] = 0.0
                entries[i]["seam_bad"] = False
                entries[i]["seam_next"] = None
                continue
            seam = _seam_metric(chosen_segments[i], chosen_segments[nxt])
            entries[i]["seam"] = seam
            entries[i]["seam_bad"] = seam >= JERK_HARD
            entries[i]["seam_next"] = nxt + 1   # Shot-Nummer des Nachbarn (Loop: 1)
        if changed:
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump(cache, f)
        out_shots = dict(shots)
        out_shots["segments"] = chosen_segments
        ui = {"infinite_movie_choose": entries}
        # 73: nur noch shots (segments-Ausgang gestrichen).
        return io.NodeOutput(out_shots, ui=ui)


REVIEW_NODE_LIST = [InfiniteMovieChooser]
