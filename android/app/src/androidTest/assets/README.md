The public `bus.jpg` fixture is from Ultralytics' repository:
https://github.com/ultralytics/ultralytics/blob/main/ultralytics/assets/bus.jpg

SHA-256: c02019c4979c191eb739ddd944445ef408dad5679acab6fd520ef9d434bfbc63

It is packaged only in the instrumentation test APK, never the user application.
The native detector must detect a bus and people in this photograph; the test
does not replace the model's output with prewritten labels or boxes.

`find-cup.wav` is a synthesized Chinese test utterance, “帮我找水杯。”,
generated locally with Windows Speech (Microsoft Huihui), mono PCM16 at 16 kHz.
It contains no microphone recording. It is published through the real AOQ audio
pipeline to test cloud ASR and the search command, never passed to sendText.
It is packaged only in the instrumentation test APK, not the user application.
