"""Engine Start / Engine Result – Pack-Nodes für den Engine-Split (Auftrag 37, 57e).

Engine Start (from Director): Pack-Node OHNE Eingänge. Ausgänge: start_image,
end_image, prompt, negative, seed, width, height, length. Der Director liest die
Werte pro Segment aus dem dynprompt und ersetzt sie im Segment-Graph.

Engine Result (to Director): Pack-Node. Eingänge: images (IMAGE) oder video
(VIDEO, Vorrang video), optional audio. Widgets: fps, length_grid. Ausgang:
engine (INFINITE_ENGINE).

Wichtig (57e): Die Kette zwischen Start und Result wird NICHT direkt
ausgeführt. Der Director-Eingang 'engine' ist lazy=True (graph.py add_node legt
lazy Inputs nicht als Strong-Links an), daher entsteht kein Strong-Link zur
Kette und es gibt keinen Double-Run. Der Director liest die Verkabelung aus dem
dynprompt (Link [engine_out_id, 0]) und baut daraus das Template. Die execute-
Methoden liefern nur Platzhalter (None/""/0 bzw. ein engine-Dict als String),
damit die Nodes im UI funktionieren, ohne dass die Kette läuft.
"""

from __future__ import annotations

from comfy_api.latest import io


class InfiniteMovieEngineIn(io.ComfyNode):
    """Engine Start (from Director): Pack-Node ohne Eingänge.

    Liefert die Engine-Parameter (start_image, end_image, prompt,
    seed, width, height, length). Im normalen Lauf liefert execute()
    Platzhalter (None/""/0) – die Kette wird NICHT direkt ausgeführt, weil der
    Director-Eingang 'engine' lazy ist (kein Strong-Link). Der Director liest
    die Werte pro Segment aus dem dynprompt.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieEngineIn",
            display_name="Infinite Movie · Engine Start (from Director)",
            search_aliases=["infinite movie", "engine", "pack", "start"],
            category="Infinite Movie/0 Setup",
            description="Build your video model between Engine Start and Engine Result (any loaders/samplers), "
                        "e.g. in a group. Several engine groups: mute all but one, or connect one to Director · engine.",
            inputs=[],
            outputs=[
                io.Image.Output(display_name="start_image",
                                tooltip="Start image (IMAGE) – per segment from the Director."),
                io.Image.Output(display_name="end_image",
                                tooltip="End image (IMAGE) – per segment from the Director."),
                io.String.Output(display_name="prompt",
                                 tooltip="Prompt (STRING) – per segment from the Director."),
                # 73: negative-Ausgang gestrichen – der Negativ-Encoder bleibt leer
                # (Expansion setzt keinen Negativ-Text mehr).
                io.Int.Output(display_name="seed",
                              tooltip="Seed (INT) – per segment from the Director."),
                io.Int.Output(display_name="width",
                              tooltip="Width (INT) – from the Director / settings."),
                io.Int.Output(display_name="height",
                              tooltip="Height (INT) – from the Director / settings."),
                io.Int.Output(display_name="length",
                              tooltip="Length in frames (INT) – from the Director."),
            ],
        )

    @classmethod
    def execute(cls) -> io.NodeOutput:
        # Platzhalter: die Kette wird NICHT direkt ausgeführt (engine ist lazy,
        # kein Strong-Link). Die echten Werte liefert der Director pro Segment
        # aus dem dynprompt.
        return io.NodeOutput(
            None,  # start_image
            None,  # end_image
            "",    # prompt
            0,     # seed
            0,     # width
            0,     # height
            0,     # length
        )


class InfiniteMovieEngineOut(io.ComfyNode):
    """Engine Result (to Director): Pack-Node.

    Nimmt images oder video entgegen, liefert engine (INFINITE_ENGINE).
    Vorrang: video > images. Optional: audio. Widgets: fps, length_grid.
    execute() liefert ein engine-Dict als String-Platzhalter; die Kette wird
    NICHT direkt ausgeführt (engine ist lazy).
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="InfiniteMovieEngineOut",
            display_name="Infinite Movie · Engine Result (to Director)",
            search_aliases=["infinite movie", "engine", "pack", "result"],
            category="Infinite Movie/0 Setup",
            description="Build your video model between Engine Start and Engine Result (any loaders/samplers), "
                        "e.g. in a group. Several engine groups: mute all but one, or connect one to Director · engine.",
            inputs=[
                io.Image.Input("images", optional=True,
                               tooltip="Frames (IMAGE), e.g. from the VAE decode."),
                io.Video.Input("video", optional=True,
                               tooltip="Video (VIDEO), takes priority over images."),
                io.Audio.Input("audio", optional=True,
                               tooltip="Optional audio."),
                io.Float.Input("fps", default=24.0,
                               tooltip="Frame rate (FLOAT) – 24 for LTX, 16 for Wan."),
                io.Int.Input("length_grid", default=1,
                             tooltip="Length grid (INT) – 8 for LTX, 4 for Wan."),
            ],
            outputs=[
                io.String.Output(display_name="engine",
                                 tooltip="Engine (INFINITE_ENGINE) – connect to Director · engine (optional)."),
            ],
        )

    @classmethod
    def execute(cls, images=None, video=None, audio=None, fps=24.0, length_grid=1) -> io.NodeOutput:
        # Vorrang: video > images
        # Platzhalter: die Kette wird NICHT direkt ausgeführt (engine ist lazy).
        engine_dict = {
            "fps": float(fps),
            "length_grid": int(length_grid),
            "has_images": images is not None,
            "has_video": video is not None,
        }
        return io.NodeOutput(
            str(engine_dict),  # engine (Platzhalter)
        )


ENGINE_NODE_LIST = [InfiniteMovieEngineIn, InfiniteMovieEngineOut]
