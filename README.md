# StemSplit

A phone-installable web app (PWA) that splits songs into stems (vocals, drums, bass, guitar, piano, other) using a Hugging Face Space, and keeps every result in a library on your phone with a mute/solo/volume mixer.

- **Separate:** pick a song from your phone, and the app sends it to a Hugging Face Space running Demucs and downloads the stems.
- **Library:** every split song is stored on the device (IndexedDB) and still plays when you're offline.
- **Mixer:** play all stems in sync with mute, solo and volume per stem, slow down to 0.5× (pitch preserved), and loop.
- **Export:** render the mix as you've set it to a WAV file (for example the song without guitar for practice), or save or share any single stem.

## 1. Put it on GitHub Pages (5 minutes)

1. Create a new public repository on GitHub, e.g. `stemsplit`.
2. Upload everything in this folder **except** `hf-space/` (it does no harm, but it isn't needed): `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, the `icons/` folder.
3. In the repo go to **Settings → Pages**, set *Source* to **Deploy from a branch**, branch `main`, folder `/ (root)`, then Save.
4. After a minute your app is live at `https://YOUR-USERNAME.github.io/stemsplit/`.

## 2. Install it on your phone

- **iPhone:** open the link in **Safari** → Share button → **Add to Home Screen**.
- **Android:** open in **Chrome** → ⋮ → **Install app** (or *Add to Home screen*).

## 3. Choose the separation engine

The app works with any Gradio Space that takes an audio file and returns audio. It finds the right endpoint and shows that Space's options (model and so on) automatically.

**Quick start:** the default `teamup-tech/demucs-source-separation` (4 stems, runs on free ZeroGPU). Anonymous users get a small daily GPU quota, so add a free Hugging Face token in Settings for more (huggingface.co → Settings → Access Tokens → *Read*).

**Recommended: your own Space (6 stems including guitar, always available).** Public Spaces get paused or broken without warning, so it's worth having your own:

1. Go to huggingface.co → **New Space** and name it e.g. `stemsplit`. Pick SDK **Gradio** and hardware **CPU basic (free)**.
2. Upload the three files from `hf-space/`: `app.py`, `requirements.txt`, `packages.txt`.
3. Wait for it to build (about 5 minutes the first time) until it says *Running*.
4. In the app's **Settings**, enter `YOUR-HF-NAME/stemsplit` and tap **Save & test connection**.

Free CPU takes roughly 3–8 minutes for a 4-minute song. For speed you can switch the Space's hardware to a paid GPU, or (with HF PRO) to ZeroGPU after adding `import spaces` and an `@spaces.GPU` decorator on `separate()`.

## Notes & limits

- Keep the app open while a song is processing, because phones suspend web apps in the background. The app holds the screen awake where the browser supports it.
- Your library stays on that phone in that browser. Deleting the home-screen app or clearing Safari website data deletes it too. On iPhone, the home-screen app and Safari have **separate** storage.
- Stems from the included Space are 256 kbps MP3, about 8 MB per stem for a 4-minute song. Choose WAV in the options for lossless.
- Your HF token is saved only in the browser on your phone (localStorage) and is sent only to Hugging Face.
- Only separate music you have the rights to use.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | the app |
| `sw.js` | offline cache of the app shell |
| `manifest.webmanifest`, `icons/` | home-screen install |
| `hf-space/` | optional: your own Demucs Space for Hugging Face |
