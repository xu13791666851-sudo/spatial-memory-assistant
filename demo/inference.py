"""Portable equivalents of the handoff's YoloDetector and HistogramObjectEmbedder."""
import base64
import hashlib
import io
import json
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
LABELS = json.loads((ROOT / 'models/yolo/labels.json').read_text(encoding='utf8'))
ALIASES = json.loads((ROOT / 'models/yolo/aliases.json').read_text(encoding='utf8'))


def image(data):
    if not isinstance(data, str) or len(data) > 1_050_000:
        raise ValueError('画面过大，请降低分辨率后重试。')
    try:
        raw = base64.b64decode(data, validate=True)
        if not raw.startswith(b'\xff\xd8\xff'):
            raise ValueError()
        with Image.open(io.BytesIO(raw)) as source:
            if source.width * source.height > 4_000_000 or min(source.size) < 32:
                raise ValueError()
            return ImageOps.exif_transpose(source).convert('RGB'), raw
    except Exception:
        raise ValueError('没有收到有效的当前 JPEG 画面。') from None


def jpeg(picture):
    out = io.BytesIO()
    picture.save(out, 'JPEG', quality=88)
    return out.getvalue()


def crop(picture, box):
    w, h = picture.size
    l, t, r, b = box
    l, t = max(0, min(w-1, int(l*w))), max(0, min(h-1, int(t*h)))
    r, b = max(l+1, min(w, int(r*w))), max(t+1, min(h, int(b*h)))
    return picture.crop((l, t, r, b))


def embedding(picture):
    values = np.asarray(picture.resize((64, 64), Image.Resampling.BILINEAR))
    bins = np.concatenate([np.bincount((values[:, :, c] // 16).ravel(), minlength=16) for c in range(3)]).astype(np.float32)
    return (bins / max(float(np.linalg.norm(bins)), 1.0)).tolist()


def similarity(left, right):
    a, b = np.asarray(left), np.asarray(right)
    return float(np.dot(a, b) / max(float(np.linalg.norm(a)*np.linalg.norm(b)), 1e-12))


def iou(a, b):
    intersection = max(0, min(a[2], b[2])-max(a[0], b[0])) * max(0, min(a[3], b[3])-max(a[1], b[1]))
    return intersection / max((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection, 1e-12)


def classes(target):
    matches = {label for label in LABELS if label in target.lower()}
    for alias, labels in ALIASES.items():
        if alias in target:
            matches.update(labels)
    return matches


class Detector:
    def __init__(self):
        self.lock = threading.Lock()
        self.interpreter = None

    def load(self):
        with self.lock:
            if self.interpreter is not None:
                return
            from ai_edge_litert.interpreter import Interpreter
            manifest = json.loads((ROOT/'models/yolo/manifest.json').read_text())
            data = b''.join((ROOT/'models/yolo'/p['file']).read_bytes() for p in manifest['parts'])
            if hashlib.sha256(data).hexdigest() != manifest['sha256']:
                raise RuntimeError('YOLO 模型校验失败')
            candidate = Interpreter(model_content=data, num_threads=4)
            candidate.allocate_tensors()
            assert list(candidate.get_input_details()[0]['shape']) == [1, 3, 640, 640]
            assert list(candidate.get_output_details()[0]['shape']) == [1, 84, 8400]
            self.interpreter = candidate

    def detect(self, picture):
        self.load()
        start = time.monotonic()
        w, h = picture.size
        scale = min(640/w, 640/h)
        sw, sh = int(w*scale+.5), int(h*scale+.5)
        px, py = (640-sw)/2, (640-sh)/2
        canvas = Image.new('RGB', (640, 640), (114, 114, 114))
        canvas.paste(picture.resize((sw, sh), Image.Resampling.BILINEAR), (int(px), int(py)))
        tensor = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
        with self.lock:
            self.interpreter.set_tensor(self.interpreter.get_input_details()[0]['index'], tensor)
            self.interpreter.invoke()
            output = self.interpreter.get_tensor(self.interpreter.get_output_details()[0]['index'])[0].T
        labels = output[:, 4:].argmax(axis=1)
        scores = output[np.arange(len(output)), labels+4]
        normalized = bool(np.max(np.abs(output[:, :4])) <= 2)
        candidates = []
        for index in np.flatnonzero(scores >= .25):
            cx, cy, bw, bh = output[index, :4] * (640 if normalized else 1)
            box = [float(np.clip((cx-bw/2-px)/scale/w, 0, 1)), float(np.clip((cy-bh/2-py)/scale/h, 0, 1)), float(np.clip((cx+bw/2-px)/scale/w, 0, 1)), float(np.clip((cy+bh/2-py)/scale/h, 0, 1))]
            if (box[2]-box[0])*w > 1 and (box[3]-box[1])*h > 1:
                candidates.append(dict(label=LABELS[int(labels[index])], confidence=float(scores[index]), box=box))
        kept = []
        for d in sorted(candidates, key=lambda d: -d['confidence']):
            if not any(d['label'] == p['label'] and iou(d['box'], p['box']) > .45 for p in kept):
                kept.append(d)
        return kept[:100], round((time.monotonic()-start)*1000)
