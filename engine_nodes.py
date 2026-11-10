"""Engine Start / Engine Result - pack nodes for the engine split (Auftrag 37, 57e).

Engine Start (from Director): pack node WITHOUT inputs. Outputs: start_image,
end_image, prompt, negative, seed, width, height, length. The Director reads the
values per segment from the dynprompt and replaces them in the segment graph.

Engine Result (to Director): pack node. Inputs: images (IMAGE) or video
(VIDEO, video takes priority), optional audio. Widgets: fps, length_grid. Output:
engine (INFINITE_ENGINE).

Important (57e): the chain between Start and Result is NOT executed
directly. The Director input 'engine' is lazy=True (graph.py add_node does not
create lazy inputs as Strong-Links), so no Strong-Link to the
chain is created and there is no double run. The Director reads the wiring from
the dynprompt (link [engine_out_id, 0]) and builds the template from it. The execute
methods only return placeholders (None/""/0 or an engine dict as a string),
so the nodes work in the UI without the chain running.
"""

from __future__ import annotations

from comfy_api.latest import io


class InfiniteMovieEngineIn(io.ComfyNode):
    """Engine Start (from Director): pack node without inputs.

    Provides the engine parameters (start_image, end_image, prompt,
    seed, width, height, length). In a normal run execute() returns
    placeholders (None/""/0) - the chain is NOT executed directly, because the
    Director input 'engine' is lazy (no Strong-Link). The Director reads
    the values per segment from the dynprompt.
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
                # 73: negative output removed - the negative encoder stays empty
                # (the expansion no longer sets negative text).
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
        # Placeholders: the chain is NOT executed directly (engine is lazy,
        # no Strong-Link). The real values are provided by the Director per segment
        # from the dynprompt.
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
    """Engine Result (to Director): pack node.

    Takes images or video, provides engine (INFINITE_ENGINE).
    Priority: video > images. Optional: audio. Widgets: fps, length_grid.
    execute() returns an engine dict as a string placeholder; the chain is
    NOT executed directly (engine is lazy).
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
        # Priority: video > images
        # Placeholders: the chain is NOT executed directly (engine is lazy).
        engine_dict = {
            "fps": float(fps),
            "length_grid": int(length_grid),
            "has_images": images is not None,
            "has_video": video is not None,
        }
        return io.NodeOutput(
            str(engine_dict),  # engine (placeholder)
        )


ENGINE_NODE_LIST = [InfiniteMovieEngineIn, InfiniteMovieEngineOut]
