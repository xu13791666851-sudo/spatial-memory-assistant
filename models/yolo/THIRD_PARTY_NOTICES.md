# Recognition assets

The TFLite model, labels and Chinese aliases were supplied by the project owner in the “YOLO + 千问快速识别” handoff. The model is imported unchanged; its SHA-256 is `9db0427fb26b590b6293b28da6071f3f62bdaa188a2c08cfe9e09af5032ee6b4`. Splitting it only accommodates hosting file-size limits and does not retrain or quantize it. The original handoff does not specify model training or licensing provenance; preserve that provenance information when distributing model assets.

TensorFlow.js core 4.9.0, CPU backend 4.9.0, and TFLite 0.0.1-alpha.10 are copyright Google LLC and contributors, distributed under Apache License 2.0. Their original copyright headers remain in the published JavaScript.

- Source: https://github.com/tensorflow/tfjs
- License: https://github.com/tensorflow/tfjs/blob/master/LICENSE
- License text: https://www.apache.org/licenses/LICENSE-2.0

The pinned npm distributions provide the browser runtime and WebAssembly files. These are copied during builds, rather than requested from a third-party CDN while a user is using the product.
