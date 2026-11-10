"""Infinite Movie · Normalize Time: even out the motion of FLF segments.

LTX/Wan first-last-frame segments ease in and out: they stand almost still near both key images and
do most of the change in the middle (2026-10-26, vier_jahreszeiten 2 s: ~12 still frames at each end).
This node measures the change from frame to frame, sums it up per segment and picks the output frames
so that every output frame carries about the same amount of change ('strength' mixes with plain time).
Render longer (e.g. 2 s = 49 frames) and keep fewer (1 s = 25): the middle then has enough real frames,
nothing is interpolated. Streams one segment at a time; the film is never fully in RAM.
"""

from __future__ import annotations

import io as _io
import os
import subprocess
import tempfile

import numpy as np
import torch

from comfy_api.latest import io

from . import vram
# 75: _input_videos moved from ghost_nodes.py to nodes.py
from .nodes import SHOTS, _input_videos, _probe_size
from .nodes import _ffmpeg, _no_window, _send_progress, _video_fps, _run_ffmpeg_to, _has_audio_stream
# 57d: SETTINGS pipe + get_setting (no cycle: settings_nodes -> .vram + lazy .autoprompt).
from .settings_nodes import SETTINGS, get_setting

_W, _H = 96, 120   # analysis size


def _read_rgb(path: str) -> tuple[np.ndarray, int, int]:
    """All frames of ONE segment as uint8 [N,H,W,3] (a segment is short; a whole film is not loaded)."""
    out = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path], capture_output=True, text=True,
                         **_no_window()).stderr
    import re
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", out)
    if not m:
        raise ValueError(f"Normalize Time: cannot read {path}")
    w, h = int(m.group(1)), int(m.group(2))
    raw = subprocess.run([_ffmpeg(), "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, **_no_window()).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3), w, h


def motion_curve(frames: np.ndarray) -> np.ndarray:
    """Cumulative change 0..1 per frame. The noise floor of the still ends is subtracted so that
    flicker in a still part does not count as motion."""
    step_y, step_x = max(frames.shape[1] // _H, 1), max(frames.shape[2] // _W, 1)
    small = frames[:, ::step_y, ::step_x].astype(np.float32).mean(-1)
    d = np.abs(np.diff(small, axis=0)).mean(axis=(1, 2))
    if len(d) == 0:
        return np.zeros(len(frames))
    ends = np.concatenate([d[:3], d[-3:]])
    d = np.maximum(d - np.median(ends), 0) + 1e-3
    cum = np.concatenate([[0.0], np.cumsum(d)])
    return cum / cum[-1]


def pick_frames(cum: np.ndarray, n_out: int, strength: float) -> np.ndarray:
    """Source frame per output frame: 'strength' share even change, the rest plain time.
    First and last frame are always kept (the key images / seams)."""
    n = len(cum)
    t = np.linspace(0.0, 1.0, n_out)
    pos_even = np.interp(t, cum, np.arange(n))
    pos = strength * pos_even + (1.0 - strength) * t * (n - 1)
    idx = np.clip(np.round(pos).astype(int), 0, n - 1)
    idx[0], idx[-1] = 0, n - 1
    return idx


def _encode(frames: np.ndarray, idx: np.ndarray, fps: str, out: str) -> None:
    h, w = frames.shape[1], frames.shape[2]
    enc = subprocess.Popen([_ffmpeg(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                            "-s", f"{w}x{h}", "-r", fps, "-i", "-", "-c:v", "libx264", "-crf", "12",
                            "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE, **_no_window())
    for i in idx:
        enc.stdin.write(frames[i].tobytes())
    enc.stdin.close()
    if enc.wait() != 0:
        raise RuntimeError(f"Normalize Time: encoding {out} failed")


def draw_graph(curves: list, picks: list, fps: float, strength: float = None, rendered_seconds: float = None,
               fps_in: float = None, interpolate: str = "off") -> torch.Tensor:
    """Analysis graph, three panels sharing one colour per segment:
    1. Time remap: which rendered frame is shown at which output frame. Dashed diagonal = plain
       speed-up (no normalisation); the coloured curve = what is applied; dots = the picked frames.
       Steep = the curve races through still frames, flat = it slows down where the change happens.
    2. Transition progress before (grey, as rendered) and after (colour). Straight = even motion.
    3. Change per frame before (bars) and after (line).
    Returns an IMAGE [1,H,W,3]."""
    fps_in = fps_in or fps
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    # square like the Assemble viewer (480×480, user 2026-11-09: all analyzers the same size)
    fig = plt.figure(figsize=(8, 8), dpi=100)
    gs = fig.add_gridspec(3, 1, height_ratios=[3, 3, 2])
    ax0, ax1, ax2 = fig.add_subplot(gs[0]), fig.add_subplot(gs[1]), fig.add_subplot(gs[2])
    fig.patch.set_facecolor("#1e1e1e")
    for ax in (ax0, ax1, ax2):
        ax.set_facecolor("#262626")
        ax.tick_params(colors="#cccccc", labelsize=8)
        ax.grid(color="#333333", lw=0.6)
        for sp in ax.spines.values():
            sp.set_color("#555555")
    colors = ["#4fc3f7", "#ffb74d", "#81c784", "#e57373", "#ba68c8", "#fff176"]
    t_in = t_out = 0.0
    for i, (cum, idx) in enumerate(zip(curves, picks)):
        c = colors[i % len(colors)]
        n, k = len(cum), len(idx)
        x_out = t_out + np.arange(k) / fps
        # 1. Remap: rendered time over output time
        src_t = t_in + idx / fps_in
        lin_t = t_in + np.linspace(0, n - 1, k) / fps_in
        ax0.plot(x_out, lin_t, color="#777777", lw=1, ls="--", label="plain speed-up" if i == 0 else None)
        ax0.plot(x_out, src_t, color=c, lw=2)
        ax0.scatter(x_out, src_t, color=c, s=10, zorder=3)
        dup = np.where(np.diff(idx) == 0)[0]
        if len(dup):
            ax0.scatter(x_out[dup + 1], src_t[dup + 1], color="#ff1744", s=40, marker="x", zorder=4,
                        label="duplicate frame" if i == 0 else None)
        ax0.text(t_out + 0.02, t_in + (n - 1) / fps * 0.92, f"seg {i + 1}", color=c, fontsize=9)
        # 2. Progress before / after
        x_in = t_in + np.arange(n) / fps_in
        ax1.plot(x_in, cum + i, color="#888888", lw=1.2, label="as rendered" if i == 0 else None)
        ax1.plot(x_out, cum[idx] + i, color=c, lw=2.2, label="normalized" if i == 0 else None)
        # 3. Change per frame
        ax2.bar(x_in[1:], np.diff(cum) * fps_in / fps, width=1 / fps_in, color="#777777", alpha=0.6,
                label="change / frame before" if i == 0 else None)
        ax2.plot(x_out[1:], np.diff(cum[idx]), color=c, lw=1.6, label="after" if i == 0 else None)
        t_in += (n - 1) / fps_in
        t_out += (k - 1) / fps
    head = "Normalize Time"
    if strength is not None:
        if isinstance(rendered_seconds, list):
            head += f"   strength {strength:.2f}  ->  {[f'{s:.2g}' for s in rendered_seconds]} s per scene"
        else:
            head += f"   strength {strength:.2f}  ->  {rendered_seconds:g} s per segment"
        if interpolate != "off":
            head += f"   (picked from {interpolate} frames)"
    ax0.set_title(head + "\nwhich rendered frame is shown when\n(dashed = plain speed-up, steep = skips still "
                  "frames, flat = slows down)", color="#eeeeee", fontsize=9)
    ax0.set_ylabel("rendered time (s)", color="#cccccc", fontsize=9)
    ax1.set_ylabel("transition progress", color="#cccccc", fontsize=9)
    ax2.set_ylabel("change per frame", color="#cccccc", fontsize=9)
    ax2.set_xlabel("time (s): panel 1 = output time\npanels 2+3: grey = rendered, colour = output",
                   color="#cccccc", fontsize=9)
    for ax in (ax0, ax1, ax2):
        ax.legend(loc="upper left", fontsize=8, facecolor="#333333", labelcolor="#dddddd", edgecolor="#555555")
    fig.tight_layout()
    buf = _io.BytesIO()
    fig.savefig(buf, format="png", facecolor=fig.get_facecolor())
    plt.close(fig)
    from PIL import Image
    img = np.asarray(Image.open(buf).convert("RGB")).astype(np.float32) / 255.0
    return torch.from_numpy(img).unsqueeze(0)


# Last analysis per node: the graph route redraws it for a new strength without a run.
_CACHE: dict = {}


def auto_frames(cum: np.ndarray, n_max: int, strength: float, tol: float = 0.02) -> int:
    """Largest output frame count <= n_max at which at most tol (2 %) duplicates occur (2026-11-04, user:
    "can it be calculated?"). Duplicate = two target frames on the same source frame (too much standing still)."""
    for n in range(max(n_max, 2), 1, -1):
        idx = pick_frames(cum, n, strength)
        if len(idx) - len(set(idx.tolist())) <= int(tol * n):
            return n
    return 2


def _picks_for(curves: list, fps: float, strength: float, rendered_seconds, keep: float = 1.0) -> tuple:
    """Auftrag 41A: rendered_seconds can be a float (all segments same length) or a list
    (per-scene lengths). keep (2026-11-04): share of the rendered length that stays; 0 = auto per shot
    (auto_frames: as many frames as possible without duplicates). Returns (picks, n_out_list, report)."""
    if isinstance(rendered_seconds, (int, float)):
        n_out_list = [max(int(round(rendered_seconds * fps)) + 1, 2)] * len(curves)
    else:
        # list of per-scene seconds
        n_out_list = [max(int(round(s * fps)) + 1, 2) for s in rendered_seconds]
        # pad if too short
        while len(n_out_list) < len(curves):
            n_out_list.append(n_out_list[-1] if n_out_list else 25)
        # trim if too long
        n_out_list = n_out_list[:len(curves)]
    keep = float(keep or 0.0)
    n_full = list(n_out_list)
    if keep <= 0:
        n_out_list = [auto_frames(c, n, strength) for c, n in zip(curves, n_full)]
    elif keep < 1:
        n_out_list = [max(int(round((n - 1) * keep)) + 1, 2) for n in n_full]
    picks = [pick_frames(c, n, strength) for c, n in zip(curves, n_out_list)]
    lines = []
    for i, (c, idx, n, nf) in enumerate(zip(curves, picks, n_out_list, n_full)):
        dup = len(idx) - len(set(idx.tolist()))
        still = int((np.diff(c) < 0.5 / max(len(c) - 1, 1)).sum())
        k = (n - 1) / max(nf - 1, 1)
        lines.append(f"seg {i + 1}: {len(c)} -> {n} frames (keep {k:.2f}{' auto' if keep <= 0 else ''}), "
                     f"{still} still frames before"
                     + (f", {dup} DUPLICATES (lower keep or use 0 = auto)" if dup else ""))
    return picks, n_out_list, "\n".join(lines)


class InfiniteMovieAssemble(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieAssemble",
            display_name="Infinite Movie · Assemble",
            search_aliases=["infinite movie", "infinite_movie", "film", "movie", "video", "retime", "even motion", "ease", "smooth",
                            "normalize", "speed"],
            category="Infinite Movie/3 Assemble",
            description="Joins the shots into one film and, with even_motion, evens out their motion: first-last-frame "
                        "shots stand nearly still near the key images and change mostly in the middle, so the output "
                        "frames are re-picked to carry about the same change each. Each shot keeps its rendered length "
                        "(Director › seconds / per-shot ⏱); with interpolate RIFE there are more frames to pick from "
                        "and fewer duplicates. Draws an analysis graph below the widgets (grey = as rendered, "
                        "coloured = evened out) that updates live when you change strength.",
            is_output_node=True,
            inputs=[
                # Auftrag 32: shots (SHOTS) as the FIRST input (highest priority).
                # 57b: movie -> shots (ID + display); 57b2: type -> SHOTS.
                SHOTS.Input("shots", optional=True, display_name="shots",
                         tooltip="Pipe mit allen Shots (Segment-Pfade, Ordner, Name, fps, loop …) von "
                                 "Infinite Movie · Director (highest priority). When connected, "
                                 "segments/save_folder/save_name/fps/loop come from the pipe; otherwise "
                                 "connect video/images/video_path/file directly."),
                # 73: segments/save_folder/save_name removed as socket inputs
                # ("less is more") - they now always come from the shots pipe
                # (or Settings › output_folder). shots has the highest priority.
                io.Combo.Input("file", options=_input_videos(), upload=io.UploadType.video,
                               tooltip="direct load from ComfyUI/input (used when nothing is connected); "
                                       "a single video is treated as one segment"),
                io.Image.Input("images", optional=True, tooltip="frame batch (priority 4)"),
                io.Video.Input("video", optional=True, tooltip="VIDEO (priority 3)"),
                io.String.Input("video_path", default="", optional=True, tooltip="file path (priority 5)"),
                io.Float.Input("fps", default=24.0, min=1.0, max=120.0, optional=True,
                               tooltip="only for the images input"),
                io.Float.Input("strength", default=0.8, min=0.0, max=1.0, step=0.05,
                               tooltip="1 = fully even change per frame, 0 = unchanged timing. 0.8 keeps a short "
                                       "rest on the key images. Only effective when even_motion=true."),
                io.Combo.Input("interpolate", options=["off", "RIFE x2", "RIFE x4"], default="RIFE x2", optional=True,
                               tooltip="Interpolate in-between frames first, then pick. Only effective when even_motion=true. "
                                       "'off' = pick from the original frames (fastest, no GPU); 'RIFE x2' = 2x frames; "
                                       "'RIFE x4' = 4x (smoothest, most GPU time)."),
                # 57d: free_vram/free_ram now in the Settings node
                # (settings input at the end of the schema).
                # Auftrag 32: concat options (as the LAST inputs, widgets_values!).
                io.Float.Input("keep", default=1.0, min=0.0, max=1.0, step=0.05,
                               tooltip="Share of each shot's rendered length that stays in the film (only with even_motion).\n"
                                       "1 = full length (default). Where a shot stands still, even_motion has to fill the "
                                       "time with repeated frames - visible as small stutters.\n"
                                       "0 = auto: per shot as many frames as possible WITHOUT repeats; the still parts are "
                                       "dropped and the film gets shorter (measured on a fog/rain shot: 0.3 without, 0.6 with RIFE x2 - more frames to pick from).\n"
                                       "0.05-0.95 = fixed share for all shots.\n"
                                       "Good for: morphs/time-lapses between stills, transitions with long still ends. "
                                       "Not for: real-time action, lip sync, or when the film must keep an exact length "
                                       "(music). The Assemble report shows the keep used per shot."),
                io.Boolean.Input("even_motion", default=True,
                                 tooltip="true = even out the motion of each shot (frames re-picked so each carries about the same "
                                         "change), then join; false = join the shots unchanged (keeps the engine's sound)."),
                io.Boolean.Input("loop", default=True,
                                 tooltip="true = also drop the last frame of the last segment (seamless loop); "
                                         "false = keep it (the film ends on the last image)."),
                # 73: copy_to removed (no more copy target; the film stays in the output folder).
                # 57d: settings (SETTINGS) at the END so that the slot indices of the
                # wired inputs (shots/segments/save_folder/save_name) do not shift.
                SETTINGS.Input("settings", optional=True, display_name="settings",
                               tooltip="Shared settings from Infinite Movie · Settings (cleanup after the film: "
                                       "free_vram/free_ram). When connected, the cleanup switches "
                                       "come from the pipe; otherwise the built-in defaults apply."),
            ],
            outputs=[
                # 73: outputs slim - only video_path + video left.
                # segments/graph/report/images/fps/check/settings-chain are gone;
                # graph + report remain as a ui= display (preview.as_dict()).
                io.String.Output("video_path",
                                 tooltip="Path to the final assembled film (film_path, VHS-compatible). Same as the "
                                         "film written to <save_folder>/<save_name>.mp4."),
                io.Video.Output("video",
                                tooltip="The final assembled film as VIDEO (VHS-compatible)."),
                # 2026-11-08 (user: "last frame … to get longer videos, restart or loop")
                io.Image.Output("last_frame",
                                tooltip="The last frame of the finished film as IMAGE – connect it to the Director's "
                                        "image input to continue the film from where it ends. With loop on, the "
                                        "film ends just before the start image, so this frame is close to it."),
                # 2026-11-08 (user: "add first frame too … in some cases it does")
                io.Image.Output("first_frame",
                                tooltip="The first frame of the finished film as IMAGE – e.g. to render a lead-in "
                                        "that ends where the film starts, or to loop a follow-up back to the start."),
            ],
            hidden=[io.Hidden.unique_id, io.Hidden.dynprompt, io.Hidden.prompt, io.Hidden.extra_pnginfo],
        )

    @classmethod
    def execute(cls, shots=None, file="",
                images=None, video=None, video_path="", fps=24.0,
                strength=0.8, interpolate="off",
                even_motion=True, loop=True, keep=1.0,
                settings=None) -> io.NodeOutput:
        # 57d: free_vram/free_ram
        # come from the Settings node (SETTINGS pipe); without it -> defaults.
        free_vram = get_setting(settings, "free_vram")
        free_ram = get_setting(settings, "free_ram")
        # 63: output folder for the finished film (Settings › output_folder).
        # Empty = behaviour as before (film next to the shots in save_folder).
        of = (get_setting(settings, "output_folder") or "").strip()
        import folder_paths
        uid = getattr(getattr(cls, "hidden", None), "unique_id", None)
        out_dir = tempfile.mkdtemp(prefix="normalize_", dir=_temp_dir())
        # Source: shots > video > images > video_path > file
        # 73: segments/save_folder/save_name removed as inputs - paths/sf/sn
        # now only come from the shots pipe (or Settings › output_folder).
        paths = []
        sf = ""
        sn = "film"
        scene_frames_list = []
        # Auftrag 48-P5: "movielink" -> "movie"; 57b: "movie" -> "shots"
        if shots is not None:
            # shots (SHOTS) has the highest priority
            paths = list(shots.get("segments", []))
            sf = shots.get("save_folder", sf) or sf
            sn = shots.get("save_name", sn) or sn
            if shots.get("fps"):
                fps = float(shots["fps"])
            if "loop" in shots:
                loop = bool(shots["loop"])
            # Auftrag 41A: per-scene frames from the film dict
            scene_frames_list = list(shots.get("scene_frames", []) or [])
        if not paths:
            if video is not None:
                src = video.get_stream_source()
                if isinstance(src, _io.BytesIO):
                    src = os.path.join(out_dir, "source.mp4")
                    video.save_to(src)
                paths = [src]
            elif images is not None:
                arr = (images[..., :3].clamp(0, 1) * 255).byte().cpu().numpy()
                src = os.path.join(out_dir, "source.mp4")
                _encode(arr, np.arange(len(arr)), f"{fps:g}", src)
                paths = [src]
            else:
                # Auftrag 48B: "(none)"/"" = no file (shots/segments/video connected)
                # 2026-11-04: check video_path BEFORE file - otherwise a set video_path with
                # file="(none)" (the default) was ignored ("no source connected").
                _file = (file or "").strip()
                _vp = (video_path or "").strip().strip('"')
                if not _vp and _file in ("", "(none)"):
                    raise ValueError("InfiniteMovieAssemble: no source connected (shots, video, images, video_path, or file)")
                paths = [_vp or folder_paths.get_annotated_filepath(_file)]
        for p in paths:
            if not os.path.exists(p):
                raise ValueError(f"InfiniteMovieAssemble: not found: {p}")
        rate = _video_fps(paths[0])
        from fractions import Fraction
        fps_f = float(Fraction(rate))   # "24000/1001" -> 23.976
        fps_in = fps_f
        if interpolate != "off":
            # RIFE x2 (twice for x4) per segment; picking then happens on the dense frames
            from .post_nodes import _rife_x2
            times = 2 if interpolate == "RIFE x4" else 1
            vram.wait_acquire(min_free_mb=8000, timeout_s=3600)
            try:
                dense = []
                for i, p in enumerate(paths):
                    src, f = p, fps_f
                    for t in range(times):
                        _send_progress(f"RIFE segment {i + 1}/{len(paths)} pass {t + 1}/{times}", uid)
                        dst = os.path.join(out_dir, f"rife_{i:03d}_{t}.mp4")
                        _rife_x2(src, dst, f)
                        src, f = dst, f * 2
                    dense.append(src)
            finally:
                vram.unload_comfyui_models()
            paths, fps_in = dense, fps_f * 2 ** times
        curves = []
        for i, p in enumerate(paths):
            _send_progress(f"analyse segment {i + 1}/{len(paths)}", uid)
            vram._check_interrupt()
            frames, _, _ = _read_rgb(p)
            curves.append(motion_curve(frames))
            del frames
        # Length per shot = rendered length (widget seconds_out removed, user 2026-11-04):
        # from scene_frames of the shots pipe, otherwise from the frame count of each segment.
        if scene_frames_list and len(scene_frames_list) == len(curves):
            per_scene_seconds = [f / fps_f for f in scene_frames_list]
        else:
            per_scene_seconds = [max(len(c) - 1, 1) / fps_in for c in curves]
        picks, n_out, report = _picks_for(curves, fps_f, strength, per_scene_seconds, keep)
        out_paths = []
        # 86: viewer data (timeline, heatmap, used frames) in the temp folder; errors here are never fatal.
        import time as _time
        viz_dir = os.path.join(_temp_dir(), f"viz_{uid or 'x'}_{int(_time.time())}")
        viz = {"shots": [], "timeline": None, "subfolder": "infinite_movie_normalize/" + os.path.basename(viz_dir)}
        try:
            os.makedirs(viz_dir, exist_ok=True)
        except OSError:
            viz = None
        for i, p in enumerate(paths):
            _send_progress(f"normalize segment {i + 1}/{len(paths)}", uid)
            vram._check_interrupt()
            frames, _, _ = _read_rgb(p)
            out = os.path.join(out_dir, f"seg_{i:03d}.mp4")
            _encode(frames, picks[i], rate, out)
            out_paths.append(out)
            if viz is not None:
                try:
                    viz["shots"].append(_viz_shot(frames, picks[i], i, viz_dir, fps_f))
                except Exception as _e:  # noqa: BLE001
                    print(f"[InfiniteMovieAssemble] viewer data seg {i + 1} skipped: {_e}")
            del frames
        if viz is not None:
            try:
                viz["timeline"] = _viz_timeline(curves, picks, n_out, keep, viz_dir,
                                                n_full=[max(int(round(s * fps_f)) + 1, 2) for s in per_scene_seconds])
            except Exception as _e:  # noqa: BLE001
                print(f"[InfiniteMovieAssemble] timeline skipped: {_e}")
        if uid is not None:
            _CACHE[str(uid)] = {"curves": curves, "fps": fps_f, "fps_in": fps_in, "interpolate": interpolate,
                                "seconds": per_scene_seconds, "keep": keep,
                                "viz_dir": viz_dir if viz is not None else None}
        out_seconds = [max(n - 1, 1) / fps_f for n in n_out]
        graph = draw_graph(curves, picks, fps_f, strength, out_seconds, fps_in, interpolate)
        print(f"[InfiniteMovieAssemble]\n{report}")
        from comfy_api.latest import ui, InputImpl
        preview = ui.PreviewImage(graph, cls=cls)
        # 73: images/fps/check/segments/graph/report/chain are no longer outputs;
        # graph + report only remain as a ui= display (preview.as_dict()).
        # images_out (RAM-hungry) is no longer computed.
        # Auftrag 32: concat (shared function from nodes.py)
        from .nodes import _concat_segments, _has_audio_stream
        if even_motion:
            # Retime + concat: the retimed segments are joined
            concat_paths = out_paths
        else:
            # Concat only (without retime): the original segments are joined
            concat_paths = paths
        # 76: retime changes the video timing -> audio CANNOT be re-timed
        # (no offset). Retimed segments are video-only, so the film is
        # automatically silent with even_motion=true. If the original segments
        # had audio, report that.
        if even_motion and any(_has_audio_stream(p) for p in paths):
            report += "\nSound only without even_motion: the film is silent (even_motion changes the video timing, audio is not re-timed)."
        # 63: Settings › output_folder overrides the output folder of the FINAL
        # film (after shots/save_folder have been evaluated). _unique_output_path
        # (nodes.py:672) creates the folder and resolves relative paths against
        # the ComfyUI output directory; the retimed intermediate segments stay
        # in the temp folder (out_dir), only the final film moves to `of`.
        if of:
            sf = of
        # Auftrag 70: prompt + workflow (extra_pnginfo) as FFMETADATA in the film.
        meta = {}
        _hidden_prompt = getattr(getattr(cls, "hidden", None), "prompt", None)
        if _hidden_prompt is not None:
            meta["prompt"] = _hidden_prompt
        _hidden_pnginfo = getattr(getattr(cls, "hidden", None), "extra_pnginfo", None)
        if isinstance(_hidden_pnginfo, dict):
            meta.update(_hidden_pnginfo)
        # 73: copy_to removed (parameter removed from _concat_segments).
        film_path, check, total_frames, out_fps = _concat_segments(
            concat_paths, sf, sn, loop,
            free_vram, free_ram, metadata=meta or None, audio=bool(get_setting(settings, "audio")))
        # video_path = film_path (the final film, not the first segment)
        vp = film_path
        video_out = InputImpl.VideoFromFile(film_path)
        fps_f = out_fps
        ui_out = {"images": preview.as_dict()["images"], "text": [report], "film_path": [vp]}
        if viz is not None:
            ui_out["im_viz"] = [viz]
        # 73: outputs only video_path + video left (graph/report as ui=).
        return io.NodeOutput(vp, video_out, last_frame(film_path), first_frame(film_path), ui=ui_out)


def first_frame(video_path: str) -> torch.Tensor:
    """First frame of a film as IMAGE [1, H, W, 3] (float 0..1)."""
    w, h = _probe_size(video_path)
    raw = subprocess.run([_ffmpeg(), "-v", "error", "-i", video_path, "-map", "0:v:0", "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, **_no_window()).stdout
    size = w * h * 3
    if len(raw) < size:
        raise RuntimeError(f"Assemble: could not read the first frame of {video_path}")
    frame = np.frombuffer(raw[:size], dtype=np.uint8).reshape(h, w, 3)
    return torch.from_numpy(frame.astype(np.float32) / 255.0).unsqueeze(0)


def last_frame(video_path: str) -> torch.Tensor:
    """Last frame of a film as IMAGE [1, H, W, 3] (float 0..1). Reads only the last 2 s (-sseof),
    takes the last complete frame from the rawvideo stream."""
    w, h = _probe_size(video_path)
    raw = subprocess.run([_ffmpeg(), "-v", "error", "-sseof", "-2", "-i", video_path, "-map", "0:v:0",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, **_no_window()).stdout
    size = w * h * 3
    if len(raw) < size:   # film shorter/defective: read the whole thing
        raw = subprocess.run([_ffmpeg(), "-v", "error", "-i", video_path, "-map", "0:v:0", "-f", "rawvideo",
                              "-pix_fmt", "rgb24", "-"], capture_output=True, **_no_window()).stdout
    if len(raw) < size:
        raise RuntimeError(f"Assemble: could not read the last frame of {video_path}")
    n = len(raw) // size
    frame = np.frombuffer(raw[(n - 1) * size:n * size], dtype=np.uint8).reshape(h, w, 3)
    return torch.from_numpy(frame.astype(np.float32) / 255.0).unsqueeze(0)


def _register_route():
    import asyncio
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.post("/infinite_movie/normalize_graph")
    async def normalize_graph(request):
        """Redraw the graph of the last run with a new strength (no render, no encode)."""
        try:
            b = await request.json()
            c = _CACHE.get(str(b.get("node_id")))
            if not c:
                return web.json_response({"error": "run the node once first"}, status=404)
            strength, seconds = float(b["strength"]), c["seconds"]
            keep = float(b.get("keep", c.get("keep", 1.0)))

            def work():
                from PIL import Image
                picks, n_out, report = _picks_for(c["curves"], c["fps"], strength, seconds, keep)
                out_s = [max(n - 1, 1) / c["fps"] for n in n_out]
                g = draw_graph(c["curves"], picks, c["fps"], strength, out_s, c.get("fps_in"),
                               c.get("interpolate", "off"))
                tl = None
                if c.get("viz_dir") and os.path.isdir(c["viz_dir"]):
                    try:
                        tl = _viz_timeline(c["curves"], picks, n_out, keep, c["viz_dir"],
                                           f"_{int(round(strength * 100))}_{int(round(keep * 100))}",
                                           n_full=[max(int(round(s * c["fps"])) + 1, 2) for s in seconds])
                    except Exception:  # noqa: BLE001
                        tl = None
                name = f"normalize_{b.get('node_id')}_{int(round(strength * 100))}.png"
                Image.fromarray((g[0].numpy() * 255).astype(np.uint8)).save(os.path.join(_temp_dir(), name))
                return name, report, tl
            name, report, tl = await asyncio.to_thread(work)
            return web.json_response({"filename": name, "subfolder": "infinite_movie_normalize", "type": "temp",
                                      "report": report,
                                      "timeline": tl, "viz_subfolder": ("infinite_movie_normalize/"
                                                                        + os.path.basename(c["viz_dir"])) if tl else None})
        except Exception as e:  # noqa: BLE001
            return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=500)


try:
    _register_route()
except Exception as _e:  # noqa: BLE001  (outside ComfyUI, e.g. tests)
    print(f"[InfiniteMovieAssemble] graph route not registered: {_e}")


VIZ_MAX_FRAMES = 64   # user 2026-11-04: all used frames up to 64, above that every x-th
VIZ_FRAME_W = 256


TRACK_W = 384         # particles (user 2026-11-04): tracking at 384 px width
TRACK_MAX = 300       # at most this many tracks per shot
TRACK_RESEED = 6      # every 6 source frames, new points in empty areas


def particle_tracks(frames: np.ndarray, max_tracks: int = TRACK_MAX, min_move: float = 0.01) -> list:
    """Track detected image points (goodFeaturesToTrack) with Lucas-Kanade through all source frames,
    with a forward/backward check. Returns: a list {"s": start frame, "p": [x0,y0,x1,y1,…]} in 0..1000
    (relative to width/height); only tracks of ≥ 4 frames that move a total of ≥ min_move of the width."""
    import cv2
    n, h, w = frames.shape[:3]
    tw = min(TRACK_W, w)
    th = max(2, round(h * tw / w))
    gray = [cv2.cvtColor(cv2.resize(f, (tw, th), interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY) for f in frames]
    lk = dict(winSize=(15, 15), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.03))
    done, live = [], []          # live: [start, [(x,y),…]]

    def seed(t):
        if len(live) + len(done) >= max_tracks * 3:
            return
        mask = np.full((th, tw), 255, np.uint8)
        for _, pts in live:
            cv2.circle(mask, (int(pts[-1][0]), int(pts[-1][1])), 8, 0, -1)
        want = max(0, max_tracks - len(live))
        if want < 5:
            return
        p = cv2.goodFeaturesToTrack(gray[t], maxCorners=want, qualityLevel=0.01, minDistance=8, mask=mask)
        if p is not None:
            live.extend([t, [tuple(q)]] for q in p.reshape(-1, 2))

    seed(0)
    for t in range(1, n):
        if live:
            p0 = np.float32([pts[-1] for _, pts in live]).reshape(-1, 1, 2)
            p1, st1, _ = cv2.calcOpticalFlowPyrLK(gray[t - 1], gray[t], p0, None, **lk)
            pb, st2, _ = cv2.calcOpticalFlowPyrLK(gray[t], gray[t - 1], p1, None, **lk)
            ok = (st1.ravel() == 1) & (st2.ravel() == 1) & (np.abs(p0 - pb).reshape(-1, 2).max(1) < 1.0)
            keep = []
            for tr, good, q in zip(live, ok, p1.reshape(-1, 2)):
                if good and 0 <= q[0] < tw and 0 <= q[1] < th:
                    tr[1].append(tuple(q))
                    keep.append(tr)
                else:
                    done.append(tr)
            live[:] = keep
        if t % TRACK_RESEED == 0:
            seed(t)
    done.extend(live)
    out = []
    for s, pts in done:
        if len(pts) < 4:
            continue
        a = np.asarray(pts, np.float32)
        if np.hypot(*np.diff(a, axis=0).T).sum() < min_move * tw:
            continue
        rel = np.round(a / [tw, th] * 1000).astype(int).clip(0, 1000)
        out.append({"s": int(s), "p": rel.ravel().tolist()})
    out.sort(key=lambda r: -len(r["p"]))
    return out[:max_tracks]


def _viz_shot(frames: np.ndarray, idx: np.ndarray, seg: int, viz_dir: str, fps: float) -> dict:
    """Viewer data of a shot (Auftrag 86): heatmap PNG + the used frames as small JPEGs in
    output order (at most VIZ_MAX_FRAMES, otherwise every x-th). dup = source frame used multiple times."""
    from PIL import Image
    from . import motion_viz
    rel = os.path.basename(viz_dir)
    heat = f"heat_{seg:03d}.png"
    Image.fromarray(motion_viz.motion_heatmap(frames)).save(os.path.join(viz_dir, heat))
    idx = np.asarray(idx)
    counts = np.bincount(idx, minlength=int(idx.max()) + 1)
    step = max(1, -(-len(idx) // VIZ_MAX_FRAMES))
    sel = list(range(0, len(idx), step))
    if sel[-1] != len(idx) - 1:
        sel.append(len(idx) - 1)
    h, w = frames.shape[1:3]
    size = (VIZ_FRAME_W, max(2, round(h * VIZ_FRAME_W / w)))
    out, done = [], {}
    for k in sel:
        src = int(idx[k])
        name = done.get(src)
        if name is None:
            name = f"f_{seg:03d}_{src:04d}.jpg"
            Image.fromarray(frames[src]).resize(size, Image.BILINEAR).save(os.path.join(viz_dir, name), quality=85)
            done[src] = name
        out.append({"f": name, "out": k, "src": src, "t": round(k / fps, 3), "dup": bool(counts[src] > 1)})
    tracks = None
    try:
        import json
        tracks = f"tracks_{seg:03d}.json"
        with open(os.path.join(viz_dir, tracks), "w", encoding="utf-8") as fh:
            json.dump({"n": int(len(frames)), "aspect": w / h, "tracks": particle_tracks(frames)}, fh,
                      separators=(",", ":"))
    except Exception as _e:  # noqa: BLE001 - particles are only an extra
        print(f"[InfiniteMovieAssemble] particle tracks seg {seg + 1} skipped: {_e}")
        tracks = None
    return {"seg": seg + 1, "heat": heat, "tracks": tracks, "step": step, "n_out": int(len(idx)), "frames": out,
            "subfolder": f"infinite_movie_normalize/{rel}"}


def _viz_timeline(curves: list, picks: list, n_out: list, keep: float, viz_dir: str, tag: str = "",
                  n_full: list = None) -> str:
    """Timeline PNG (motion_viz.timeline_heatmap) with the keep per shot in the label. keep = share of the RENDERED
    length (n_full), not of the source frames - with RIFE that is 2×/4× as many."""
    from PIL import Image
    from . import motion_viz
    labels = []
    for i, (c, n) in enumerate(zip(curves, n_out)):
        full = n_full[i] if n_full and i < len(n_full) else len(c)
        k = (n - 1) / max(full - 1, 1)
        labels.append(f"seg {i + 1} · {len(c)} -> {n} frames · keep {k:.2f}{' auto' if keep <= 0 else ''}")
    name = f"timeline{tag}.png"
    # square like the Assemble viewer (480×480, user 2026-11-09: all analyzers the same size)
    Image.fromarray(motion_viz.timeline_heatmap(curves, picks, labels, width=512, height=512)).save(
        os.path.join(viz_dir, name))
    return name


def _temp_dir() -> str:
    import folder_paths
    d = os.path.join(folder_paths.get_temp_directory(), "infinite_movie_normalize")
    os.makedirs(d, exist_ok=True)
    return d


RETIME_NODE_LIST = [InfiniteMovieAssemble]
