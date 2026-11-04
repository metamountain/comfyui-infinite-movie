r"""Patch für VideoHelperSuite: stumme Filme liefern Stille statt Abbruch (Claude 2026-11-02, Nutzer: „vhs fixed“).

Problem: VHS Load Video gibt `audio` als LazyAudioMap aus (videohelpersuite/utils.py). ComfyUI geht nach jedem Node
alle Ausgaben durch (execution.py cache_update -> comfy/model_patcher.py:67) und berührt dabei den Ton -> bei Filmen
OHNE Tonspur wirft get_audio „VHS failed to extract audio“ und der Workflow bricht ab, sobald audio verbunden ist.
Kein nachgeschalteter Node kann das abfangen.

Fix: in get_audio bei „keine Tonspur“ Stille in Filmlänge zurückgeben (44,1 kHz Stereo). Echte ffmpeg-Fehler werfen
weiter. Idempotent (Marker), Sicherung utils.py.orig-im daneben. Nach jedem VHS-Update erneut ausführen:

    python tools/patch_vhs_silent_audio.py          # anwenden
    python tools/patch_vhs_silent_audio.py --check  # nur prüfen (Exit 1 = nicht gepatcht)
"""
import os
import shutil
import sys

UTILS = r"D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\comfyui-videohelpersuite\videohelpersuite\utils.py"
MARKER = "# INFINITE-MOVIE PATCH silent audio"
OLD = """    except subprocess.CalledProcessError as e:
        raise Exception(f"VHS failed to extract audio from {file}:\\n" \\
                + e.stderr.decode(*ENCODE_ARGS))"""
NEW = """    except subprocess.CalledProcessError as e:
        """ + MARKER + """ (comfyui-infinite-movie tools/patch_vhs_silent_audio.py):
        # Film ohne Tonspur -> Stille in Filmlänge statt Abbruch (ComfyUI cache_update berührt den Ton immer).
        err = e.stderr.decode(*ENCODE_ARGS)
        if "Audio:" not in err:   # ffmpeg listet keine Tonspur (Meldung je nach Version verschieden)
            secs = duration
            if not secs:
                m = re.search(r"Duration: (\\d+):(\\d+):(\\d+(?:\\.\\d+)?)", err)
                secs = (int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) - start_time) if m else 1.0
            return {'waveform': torch.zeros((1, 2, max(1, int(round(max(secs, 0) * 44100))))), 'sample_rate': 44100}
        raise Exception(f"VHS failed to extract audio from {file}:\\n" \\
                + err)"""


def main():
    src = open(UTILS, encoding="utf-8").read()
    if MARKER in src:
        print("VHS-Patch: schon angewendet")
        return 0
    if "--check" in sys.argv:
        print("VHS-Patch: FEHLT")
        return 1
    if src.count(OLD) != 1:
        print("VHS-Patch: Stelle nicht gefunden (VHS-Version geändert?) – nichts geändert")
        return 2
    shutil.copy2(UTILS, UTILS + ".orig-im")
    open(UTILS, "w", encoding="utf-8").write(src.replace(OLD, NEW))
    print(f"VHS-Patch: angewendet (Sicherung {os.path.basename(UTILS)}.orig-im)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
