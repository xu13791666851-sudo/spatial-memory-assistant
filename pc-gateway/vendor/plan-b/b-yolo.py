"""One persistent PC YOLO process, one JSON line in/out. No cloud credentials."""
import base64
import io
import json
import os
import sys
import time
from contextlib import redirect_stdout
from pathlib import Path

from PIL import Image, ImageStat, ImageFilter

Image.MAX_IMAGE_PIXELS = 2_000_000

def inspect_image(image):
    grey = image.convert('L').resize((64, 64))
    stat = ImageStat.Stat(grey)
    return {'dark': stat.mean[0] < 15, 'lowDetail': stat.stddev[0] < 5,
            'edgeEnergy': ImageStat.Stat(grey.filter(ImageFilter.FIND_EDGES)).mean[0]}

def dhash(image):
    pixels = list(image.convert('L').resize((9, 8)).getdata())
    return ''.join('1' if pixels[y * 9 + x] > pixels[y * 9 + x + 1] else '0' for y in range(8) for x in range(8))

def infer(model, data, device):
    raw = base64.b64decode(data['fullJpeg'], validate=True)
    if len(raw) > 190 * 1024:
        raise ValueError('image_too_large')
    image = Image.open(io.BytesIO(raw)).convert('RGB')
    if image.width * image.height > 2_000_000:
        raise ValueError('image_too_large')
    started = time.perf_counter()
    with redirect_stdout(sys.stderr):
        result = model.predict(image, device=device, imgsz=640, conf=0.5, verbose=False)[0]
    detections = []
    for box in result.boxes:
        score = float(box.conf[0])
        if score <= 0.5:
            continue
        xy = box.xyxyn[0].tolist()
        detections.append({'label': result.names[int(box.cls[0])], 'score': score, 'box': [max(0, min(1, n)) for n in xy]})
    detections.sort(key=lambda item: item['score'], reverse=True)
    candidate = next((item for item in detections if item['label'] == data['target']), None)
    reply = {**data, 'label': None, 'detections': detections[:10], 'size': list(image.size),
             'inferenceMs': (time.perf_counter() - started) * 1000, 'rotationDegrees': 0, 'quality': inspect_image(image)}
    if candidate:
        import math
        coords = candidate['box']
        rect = [math.floor(coords[0] * image.width), math.floor(coords[1] * image.height),
                math.ceil(coords[2] * image.width), math.ceil(coords[3] * image.height)]
        crop = image.crop(rect)
        buffer = io.BytesIO()
        crop.save(buffer, format='JPEG', quality=95)
        reply.update(candidate, cropRect=rect, cropJpeg=base64.b64encode(buffer.getvalue()).decode(), appearance=dhash(crop))
    return reply

if __name__ == '__main__':
    from ultralytics import YOLO
    import torch
    model_path = Path(os.environ.get('B_YOLO_MODEL', '../models/yolo11s.pt'))
    device = os.environ.get('B_YOLO_DEVICE', 'cpu')
    if not model_path.is_file():
        raise RuntimeError('Explicit local B_YOLO_MODEL required')
    if device != 'cpu' and not torch.cuda.is_available():
        raise RuntimeError('CUDA requested but unavailable')
    with redirect_stdout(sys.stderr):
        model = YOLO(str(model_path))
        model.predict(Image.new('RGB', (640, 640)), device=device, imgsz=640, verbose=False)
    print(json.dumps({'ready': True, 'device': device}), flush=True)
    for line in sys.stdin:
        try:
            data = json.loads(line)
            print(json.dumps(infer(model, data, device)), flush=True)
        except Exception:
            print(json.dumps({'error': 'yolo_inference_failed'}), flush=True)
