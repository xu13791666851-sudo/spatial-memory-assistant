"""Bound visual uploads independently of the browser's timers."""
import base64
import binascii
import re
import time


def validate_frame(encoded):
    if not isinstance(encoded, str) or not encoded or len(encoded) > 250000:
        raise ValueError("图片太大或没有准备好，请重试。")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("图片格式无效，请重新打开摄像头。") from None
    if not raw.startswith(b"\xff\xd8") or not raw.endswith(b"\xff\xd9"):
        raise ValueError("仅支持摄像头生成的 JPEG 图片。")
    pos = 2
    while pos + 4 <= len(raw):
        if raw[pos] != 255:
            break
        while pos < len(raw) and raw[pos] == 255:
            pos += 1
        marker = raw[pos]
        pos += 1
        if marker in (0xD9, 0xDA):
            break
        length = int.from_bytes(raw[pos:pos + 2], "big")
        if length < 2 or pos + length > len(raw):
            break
        if marker in {0xC0, 0xC1, 0xC2} and length >= 8:
            height = int.from_bytes(raw[pos + 3:pos + 5], "big")
            width = int.from_bytes(raw[pos + 5:pos + 7], "big")
            if 0 < width <= 640 and 0 < height <= 640:
                return width, height
            raise ValueError("画面尺寸过大，请使用本页面摄像头。")
        pos += length
    raise ValueError("无法读取图片尺寸，请重试。")


class VideoWindow:
    def __init__(self, clock=None):
        self.clock = clock or time.monotonic
        self.id = None
        self.deadline = 0
        self.frames = 0
        self.duration = 0
        self.last_frame = float("-inf")

    def start(self, stream_id, duration):
        if self.id:
            raise ValueError("视频观察已经开启，请先停止。")
        if not isinstance(stream_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", stream_id):
            raise ValueError("视频会话无效，请重新开启。")
        if type(duration) is not int or duration not in (10, 30, 60):
            raise ValueError("请选择 10、30 或 60 秒。")
        self.id, self.duration = stream_id, duration
        self.frames = 0
        self.last_frame = float("-inf")
        self.deadline = self.clock() + duration

    @property
    def expired(self):
        return bool(self.id and self.clock() >= self.deadline)

    def accept(self, stream_id, encoded):
        if not self.id or self.id != stream_id or self.expired:
            return False
        instant = self.clock()
        if self.frames >= self.duration or instant - self.last_frame < 0.95:
            return False
        validate_frame(encoded)
        self.frames += 1
        self.last_frame = instant
        return True

    def stop(self):
        old_id = self.id
        self.id = None
        return old_id
