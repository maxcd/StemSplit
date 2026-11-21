# StemSplit engine: a minimal Hugging Face Space running Meta's Demucs.
# Create a new Gradio Space, upload this file + requirements.txt + packages.txt,
# then put "your-name/your-space" into the StemSplit app's Settings.
import glob
import os
import tempfile

import gradio as gr
import demucs.separate

MODELS = {
    "6 stems: vocals, drums, bass, guitar, piano, other": "htdemucs_6s",
    "4 stems: vocals, drums, bass, other (cleaner)": "htdemucs",
}
STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"]


def separate(audio_path, model_choice, fmt):
    if not audio_path:
        raise gr.Error("Please upload a song.")
    model = MODELS.get(model_choice, "htdemucs_6s")
    out_dir = tempfile.mkdtemp()
    args = ["-n", model, "-o", out_dir]
    if fmt == "mp3 (small)":
        args += ["--mp3", "--mp3-bitrate", "256"]
    demucs.separate.main(args + [audio_path])
    ext = "mp3" if fmt == "mp3 (small)" else "wav"
    found = {os.path.splitext(os.path.basename(p))[0]: p
             for p in glob.glob(os.path.join(out_dir, model, "*", f"*.{ext}"))}
    return [found.get(s) for s in STEMS]


with gr.Blocks(title="StemSplit engine") as demo:
    gr.Markdown("## StemSplit engine (Demucs)\nUpload a song to split it into stems.")
    with gr.Row():
        with gr.Column():
            inp = gr.Audio(type="filepath", label="Song")
            model = gr.Dropdown(list(MODELS), value=list(MODELS)[0], label="Model")
            fmt = gr.Radio(["mp3 (small)", "wav (lossless)"], value="mp3 (small)", label="Output format")
            btn = gr.Button("Separate", variant="primary")
        with gr.Column():
            outs = [gr.Audio(type="filepath", label=s.capitalize()) for s in STEMS]
    btn.click(separate, [inp, model, fmt], outs, api_name="separate")

demo.queue(max_size=8).launch()
