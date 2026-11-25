# Third-party components

| Component | Used for | License | Where |
|---|---|---|---|
| [fflate](https://github.com/101arrowz/fflate) 0.8.2 | zip export/import | MIT | `vendor/fflate.js`, license in `vendor/licenses/` |
| [lamejs](https://github.com/zhuker/lamejs) 1.2.1 | MP3 encoding on the device | LGPL-3.0 (unmodified) | `vendor/lame.min.js`, license in `vendor/licenses/` |
| [@gradio/client](https://www.npmjs.com/package/@gradio/client) 2.8.0 | talking to Hugging Face Spaces | Apache-2.0 | loaded from the jsDelivr CDN, not included here |
| [Demucs](https://github.com/facebookresearch/demucs) | stem separation (Space template and local engine) | MIT | installed by pip, not included here |

Demucs model weights are downloaded by Demucs itself on first use and are not part of this repository.
