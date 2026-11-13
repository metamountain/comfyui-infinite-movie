"""117c: ffmpeg / video helpers extracted from nodes.py (Auftrag 117c).
117e: _to_numpy_image now lives in shot_utils.py, which imports neither .nodes
nor .media, so media.py imports it at module level (no cycle).

Shared by the *_nodes.py modules. They live here so nodes.py stays focused on
the node classes.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess

import numpy as np
import torch

from . import vram
from .shot_utils import _to_numpy_image


# 75: _input_videos moved here from ghost_nodes.py (ghost_nodes.py -> tools/ghost_check.py)
def _input_videos() -> list[str]:
    """Video files in ComfyUI/input, with '(none)' as first option (Auftrag 48B).
    '(none)' means 'no file' – used when film/segments/video is connected."""
    import os
    import folder_paths
    d = folder_paths.get_input_directory()
    files = [f for f in os.listdir(d) if os.path.isfile(os.path.join(d, f))]
    vids = sorted(folder_paths.filter_files_content_types(files, ["video"]))
    return ["(none)"] + vids


# ---------------------------------------------------------------------------
# ffmpeg (imageio_ffmpeg binary, see guide 04)
# ---------------------------------------------------------------------------

_FFMPEG_CANDIDATES = [
    "ffmpeg",   # PATH; otherwise imageio_ffmpeg (no machine-specific paths, the pack is public)
]


def _ffmpeg() -> str:
    for cand in _FFMPEG_CANDIDATES:
        if os.path.isabs(cand):
            if os.path.exists(cand):
                return cand
        else:
            if shutil.which(cand):
                return cand
    # Fallback: try to import imageio_ffmpeg.
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        raise RuntimeError("ffmpeg not found (tried imageio_ffmpeg + PATH)")


def _no_window() -> dict:
    """57e: subprocess kwargs so that ffmpeg/ffprobe under Windows opens NO
    console window (CREATE_NO_WINDOW = 0x08000000). Empty on POSIX.
    Single definition - post_nodes.py and retime_nodes.py import it
    from here (nodes.py is the base, imported by both)."""
    if os.name == "nt":
        return {"creationflags": 0x08000000}
    return {}


# ---------------------------------------------------------------------------
# ffmpeg helpers
# ---------------------------------------------------------------------------

def _write_frames_to_dir(frames: torch.Tensor, tmp_dir: str, fps: int) -> None:
    """Write a frames tensor (B, H, W, C) float [0,1] to PNG files in tmp_dir."""
    from PIL import Image
    img = _to_numpy_image(frames)
    # img is (B, H, W, C)
    for i in range(img.shape[0]):
        Image.fromarray(img[i]).save(os.path.join(tmp_dir, f"frame_{i:05d}.png"))


def _run_ffmpeg_to(cmd: list, out_path: str, timeout_s: int = 600, tries: int = 2) -> None:
    """Run an ffmpeg command whose LAST element is out_path, hang-safe (2026-10-26).

    Observed: inside ComfyUI one InfiniteMovieSegmentSave encode wrote 99 % of the file within seconds, then
    spun for 21 min without finishing (no moov atom). The same command outside ComfyUI takes 2 s.
    Defences: -nostdin + stdin=DEVNULL (ffmpeg otherwise inherits the ComfyUI console as stdin),
    write to <name>.part<ext> and rename when complete (no other process sees a half-written file),
    timeout with one retry."""
    root, ext = os.path.splitext(out_path)
    part = f"{root}.part{ext}"
    full = [cmd[0], "-nostdin"] + list(cmd[1:-1]) + [part]
    last_err = None
    for attempt in range(1, tries + 1):
        try:
            subprocess.run(full, check=True, capture_output=True, stdin=subprocess.DEVNULL,
                           timeout=timeout_s, **_no_window())
            os.replace(part, out_path)
            return
        except subprocess.TimeoutExpired as e:  # subprocess.run kills the child on timeout
            last_err = e
            print(f"[InfiniteMovie] ffmpeg timeout after {timeout_s} s (attempt {attempt}/{tries}): {out_path}")
        except Exception as e:
            # Transient errors (ffmpeg exit!=0, file lock, I/O) – retry once.
            # 2026-10-27: Assemble failed transiently (run 194805), retry succeeded (run 202653).
            last_err = e
            print(f"[InfiniteMovie] ffmpeg error (attempt {attempt}/{tries}): {out_path}: {e}")
            try:
                if os.path.exists(part):
                    os.remove(part)
            except OSError:
                pass
    raise RuntimeError(f"ffmpeg failed {tries}x writing {out_path}") from last_err


def _write_audio_to_wav(audio: dict, wav_path: str) -> None:
    """Write a ComfyUI AUDIO dict {"waveform": tensor, "sample_rate": int} to a 16-bit PCM WAV.

    Model: comfy_extras/nodes_audio.py SaveAudio (RAG). waveform shape
    (batch, channels, samples) float; stdlib `wave` + numpy (no scipy/soundfile
    needed in embedded Python).
    """
    import wave as _wave
    waveform = audio["waveform"]
    sample_rate = int(audio.get("sample_rate", 44100))
    w = waveform.detach().cpu().float()
    # ComfyUI AUDIO: waveform shape (batch, channels, samples).
    if w.dim() == 3:
        w = w[0]  # (channels, samples)
    elif w.dim() == 1:
        w = w.unsqueeze(0)  # (samples,) -> (1, samples)
    # Now w is (channels, samples).
    n_channels = w.shape[0]
    w = w.t().numpy()  # (samples, channels)
    w16 = (np.clip(w, -1.0, 1.0) * 32767.0).astype(np.int16)
    with _wave.open(wav_path, "wb") as wf:
        wf.setnchannels(n_channels)
        wf.setsampwidth(2)  # 16-bit PCM
        wf.setframerate(sample_rate)
        wf.writeframes(w16.tobytes())


def _encode_dir_to_mp4(frame_dir: str, out_path: str, fps: int, audio_wav: str | None = None) -> None:
    """Encode a directory of frame_*.png into an mp4 (crf 17, yuv420p).

    76: optional audio_wav is muxed in as AAC (192k, -shortest).
    """
    ff = _ffmpeg()
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    cmd = [
        ff, "-y",
        "-framerate", str(fps),
        "-i", os.path.join(frame_dir, "frame_%05d.png"),
    ]
    if audio_wav:
        cmd += ["-i", audio_wav]
    cmd += [
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-crf", "17",
    ]
    if audio_wav:
        cmd += ["-c:a", "aac", "-b:a", "192k", "-shortest"]
    cmd += [out_path]
    _run_ffmpeg_to(cmd, out_path)


def _video_fps(video_path: str) -> str:
    """Frame rate of the first video stream as an ffmpeg rate string ('24', '16', '24000/1001').
    Read from the ffmpeg banner (imageio_ffmpeg ships no ffprobe); '24' if it cannot be read."""
    from fractions import Fraction
    try:
        err = subprocess.run([_ffmpeg(), "-hide_banner", "-i", video_path],
                             capture_output=True, text=True, timeout=30, **_no_window()).stderr
        m = re.search(r"Video:.*?([\d.]+) fps", err)
        if m:
            fr = Fraction(m.group(1)).limit_denominator(1001)
            return str(fr.numerator) if fr.denominator == 1 else f"{fr.numerator}/{fr.denominator}"
    except Exception:  # noqa: BLE001
        pass
    return "24"


def _count_frames(video_path: str) -> int:
    """Return the number of frames in a video file, or -1 on error.

    Tries ffprobe first (fast, no decode). imageio_ffmpeg does not ship
    ffprobe, so it falls back to decoding with ffmpeg and reading the final
    frame counter from the progress output.
    """
    ff = _ffmpeg()
    # 1. Try ffprobe (fast path, no decode).
    ffprobe = ff.replace("ffmpeg", "ffprobe")
    if os.path.exists(ffprobe):
        try:
            out = subprocess.run(
                [ffprobe, "-v", "error", "-count_packets",
                 "-select_streams", "v:0", "-show_entries", "packet=pts",
                 "-of", "csv=p=0", video_path],
                capture_output=True, text=True, timeout=60, **_no_window(),
            ).stdout.strip().splitlines()
            n = len([ln for ln in out if ln.strip()])
            if n > 0:
                return n
        except Exception:
            pass
    # 2. Fall back to decoding with ffmpeg and reading the frame counter.
    try:
        res = subprocess.run(
            [ff, "-i", video_path, "-map", "0:v:0", "-f", "null", "-"],
            capture_output=True, text=True, timeout=300, **_no_window(),
        )
        out = res.stderr.replace("\r", "\n")
        matches = re.findall(r"frame=\s*(\d+)", out)
        if matches:
            return int(matches[-1])
        return -1
    except Exception:
        return -1


def _has_audio_stream(video_path: str) -> bool:
    """True if the file has an audio stream (ffmpeg -i banner contains 'Audio:')."""
    try:
        err = subprocess.run([_ffmpeg(), "-hide_banner", "-i", video_path],
                             capture_output=True, text=True, timeout=30, **_no_window()).stderr
        return "Audio:" in err
    except Exception:  # noqa: BLE001
        return False


def _segment_is_complete(mp4_path: str, expected_frames: int) -> bool:
    """A segment is complete if the file exists and has the expected frames."""
    if not os.path.exists(mp4_path):
        return False
    if expected_frames <= 0:
        return True
    count = _count_frames(mp4_path)
    if count < 0:
        # Cannot count; assume complete if file is non-empty.
        return os.path.getsize(mp4_path) > 0
    return count >= expected_frames


def _motion_check(mp4_path: str) -> tuple:
    """Frame-to-frame difference (gray, 96x120). Returns (largest step, frame of it, start->end change).
    A good FLF transition spreads the change over many frames (largest step <= ~10 % of start->end);
    LTX's failure is a still segment with one hard cut that carries almost all of it
    (2026-10-26, seg 2 of vier_jahreszeiten: step 27.8 of ~28 at 11->12). The median is no use:
    2 s segments hold still at both ends and a smooth one had median 0.18."""
    w, h = 96, 120
    raw = subprocess.run([_ffmpeg(), "-v", "error", "-i", mp4_path, "-vf", f"scale={w}:{h}",
                          "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                         capture_output=True, **_no_window()).stdout
    a = np.frombuffer(raw, np.uint8)
    n = a.size // (w * h)
    if n < 2:
        return 0.0, -1, 0.0
    a = a[: n * w * h].reshape(n, h, w).astype(np.float32)
    d = np.abs(np.diff(a, axis=0)).mean(axis=(1, 2))
    k = int(d.argmax())
    return float(d[k]), k, float(np.abs(a[-1] - a[0]).mean())


def _segment_check_report(seg_paths: list) -> list:
    """One line per segment: ok / CUT (one frame carries >= 35 % of the whole transition)."""
    lines, bad = [], []
    for i, p in enumerate(seg_paths, 1):
        try:
            jump, k, total = _motion_check(p)
        except Exception as e:  # noqa: BLE001
            lines.append(f"seg {i}: check failed ({e})")
            continue
        share = jump / max(total, 1.0)
        cut = jump > 8.0 and share >= 0.35
        if cut:
            bad.append(str(i))
        lines.append(f"seg {i}: {f'CUT @{k}->{k + 1}' if cut else 'ok'} "
                     f"(largest step {share:.0%} of the transition)")
    lines.append(f"-> reseed {','.join(bad)} in Infinite Movie · Director" if bad else "-> all segments ok")
    return lines


def _unique_output_path(folder: str, name: str, ext: str = ".mp4") -> str:
    """Return <folder>/<name><ext>, appending _001, _002, ... if it exists.

    NEVER overwrites an existing file (Auftrag 16, point 1). The folder is
    created if it does not exist.

    Relative folders are resolved against the ComfyUI output directory
    (folder_paths.get_output_directory()), so the result is always an
    absolute path independent of the process CWD (Auftrag 32, CWD-Fallstrick).
    """
    folder = (folder or "").strip()
    if not folder:
        raise ValueError("save_folder is empty")
    name = (name or "film").strip() or "film"
    # Resolve relative paths against the ComfyUI output directory (absolute).
    if not os.path.isabs(folder):
        import folder_paths
        folder = os.path.join(folder_paths.get_output_directory(), folder)
    os.makedirs(folder, exist_ok=True)
    base = os.path.join(folder, name)
    candidate = base + ext
    i = 1
    while os.path.exists(candidate):
        candidate = f"{base}_{i:03d}{ext}"
        i += 1
    return candidate


def _probe_size(video_path: str) -> tuple[int, int]:
    """Probe the video size (width, height) via ffprobe (ffmpeg -i stderr)."""
    ff = _ffmpeg()
    r = subprocess.run([ff, "-i", video_path], capture_output=True, text=True, **_no_window())
    m = re.search(r"(\d{2,5})x(\d{2,5})", r.stderr or "")
    if not m:
        raise ValueError(f"could not probe size of {video_path}")
    return int(m.group(1)), int(m.group(2))


# ---------------------------------------------------------------------------
# Shared: _concat_segments (extracted from InfiniteMovieAssemble, Auftrag 32)
# ---------------------------------------------------------------------------

def _concat_segments(seg_paths, save_folder, save_name, loop,
                     free_vram, free_ram, metadata=None, audio=True):
    """Shared concat logic (Auftrag 32): concatenate segment mp4s into one film.

    Args:
        seg_paths: list of segment mp4 paths (in order).
        save_folder: output folder for the film.
        save_name: film file name without extension.
        loop: True = drop last frame of last segment (seamless loop).
        free_vram/free_ram: cleanup switches (vram.do_cleanup).
        metadata: optional dict (e.g. {"prompt": ..., "workflow": ...}) written
            as FFMETADATA into the output mp4 (Auftrag 70).

    76: If ALL segments have an audio stream, the audio is trimmed per segment
    to match the video frames and concatenated (aac). Otherwise the film is
    silent (as before).

    Returns:
        (film_path, check, total_frames, fps)
    """
    film_path = _unique_output_path(save_folder, save_name, ".mp4")
    ff = _ffmpeg()
    counts = []
    for p in seg_paths:
        n = _count_frames(p)
        if n <= 0:
            raise ValueError(f"concat: could not count frames in {p}")
        counts.append(n)
    n_seg = len(seg_paths)
    inputs: list[str] = []
    for p in seg_paths:
        inputs += ["-i", p]
    fps = _video_fps(seg_paths[0])
    # 76: include audio only if ALL segments have an audio stream.
    # Otherwise silent (no offset, no half-silent).
    # Settings › audio off: always silent (even if older segments still have audio).
    all_have_audio = bool(audio) and all(_has_audio_stream(p) for p in seg_paths)
    filter_parts = []
    for i in range(n_seg):
        n = counts[i]
        start = 1 if i > 0 else 0
        end = (n - 1) if (loop and i == n_seg - 1) else n
        if end <= start:
            raise ValueError(f"concat: segment {i} has only {n} frames; trim [start={start}, end={end}) is empty")
        filter_parts.append(f"[{i}:v]trim=start_frame={start}:end_frame={end}[v{i}]")
        if all_have_audio:
            # Trim the audio to match the video frames (time = frames / fps),
            # reset the timestamps so that segment 0 starts at 0.
            filter_parts.append(
                f"[{i}:a]atrim=start={start / float(fps):.6f}:end={end / float(fps):.6f},"
                f"asetpts=PTS-STARTPTS[a{i}]")
    # 76: [vout] is the combined concat output (a=1 => video+audio, a=0 => video
    # only). settb/setpts are video filters and only affect the video part;
    # audio is let through. Mapping [vout] is enough, ffmpeg extracts both streams.
    if all_have_audio:
        concat_in = "".join(f"[v{i}][a{i}]" for i in range(n_seg))
        filter_complex = ";".join(filter_parts) + \
            f";{concat_in}concat=n={n_seg}:v=1:a=1,settb=1/({fps}),setpts=N[vout]"
    else:
        concat_in = "".join(f"[v{i}]" for i in range(n_seg))
        filter_complex = ";".join(filter_parts) + \
            f";{concat_in}concat=n={n_seg}:v=1:a=0,settb=1/({fps}),setpts=N[vout]"
    # Auftrag 70: write FFMETADATA (prompt, workflow) into the final MP4.
    meta_path = None
    if metadata:
        import json as _json
        meta_path = film_path + ".meta.txt"

        def _escape_ffmpeg_metadata(key, value):
            value = str(value)
            value = value.replace("\\", "\\\\")
            value = value.replace(";", "\\;")
            value = value.replace("#", "\\#")
            value = value.replace("=", "\\=")
            value = value.replace("\n", "\\n")
            return f"{key}={value}"

        with open(meta_path, "w", encoding="utf-8") as f:
            f.write(";FFMETADATA1\n")
            if "prompt" in metadata:
                f.write(_escape_ffmpeg_metadata("prompt", _json.dumps(metadata["prompt"])) + "\n")
            if "workflow" in metadata:
                f.write(_escape_ffmpeg_metadata("workflow", _json.dumps(metadata["workflow"])) + "\n")
            for k, v in metadata.items():
                if k not in ("prompt", "workflow"):
                    f.write(_escape_ffmpeg_metadata(k, _json.dumps(v)) + "\n")
        inputs = inputs + ["-f", "ffmetadata", "-i", meta_path]
    try:
        # 76: [vout] is the combined concat output; AAC codec only if all
        # segments have audio.
        codec_args = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17"]
        if all_have_audio:
            codec_args += ["-c:a", "aac", "-b:a", "192k"]
        meta_args = ["-map_metadata", str(n_seg),
                     "-movflags", "use_metadata_tags+faststart"] if metadata \
            else ["-movflags", "+faststart"]
        cmd = [ff, "-y", *inputs,
               "-filter_complex", filter_complex,
               "-map", "[vout]",
               "-r", fps,
               *codec_args,
               *meta_args,
               film_path]
        _run_ffmpeg_to(cmd, film_path)
    finally:
        if meta_path and os.path.exists(meta_path):
            os.remove(meta_path)
    total = sum(counts) - (n_seg - 1) - (1 if loop else 0)
    audio_note = " mit Ton" if all_have_audio else " stumm"
    print(f"[concat] wrote film: {film_path} ({n_seg} segments, frames={counts} -> {total}{audio_note})")
    check = "\n".join(_segment_check_report(seg_paths))
    print(f"[concat] segment check:\n{check}")
    try:
        status = vram.do_cleanup(
            free_vram=free_vram, free_ram=free_ram,
        )
    except Exception as e:  # noqa: BLE001
        status = f"cleanup failed, film is fine: {e}"
    print(f"[concat] {status}")
    return film_path, check, total, float(fps)

