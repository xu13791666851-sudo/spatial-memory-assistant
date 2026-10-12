"""Offline: real local WebSocket route, substituted cloud transport, no account use."""
import asyncio
import base64
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python-deps"))
from websockets.datastructures import Headers
from websockets.exceptions import InvalidStatus
from websockets.http11 import Response
from fastapi.testclient import TestClient
from PIL import Image
import app
from memory import Store
from vision import VideoWindow, validate_frame


def jpeg(width=640, height=480):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, "JPEG")
    return base64.b64encode(buffer.getvalue()).decode()


class FrameTests(unittest.TestCase):
    def setUp(self):
        self.clock = [0]
        self.video = VideoWindow(lambda: self.clock[0])
        self.image = jpeg()

    def test_frame_dimensions_and_invalid_data(self):
        self.assertEqual(validate_frame(self.image), (640, 480))
        for value in ["not-base64", "x" * 250001, jpeg(641, 480), base64.b64encode(b"\xff\xd8broken\xff\xd9").decode()]:
            with self.assertRaises(ValueError):
                validate_frame(value)

    def test_rate_limit_stale_id_and_deadline(self):
        self.video.start("test-video-1", 10)
        self.assertFalse(self.video.accept("stale-video", self.image))
        self.assertTrue(self.video.accept("test-video-1", self.image))
        self.assertFalse(self.video.accept("test-video-1", self.image))
        self.clock[0] = 1
        self.assertTrue(self.video.accept("test-video-1", self.image))
        self.clock[0] = 10
        self.assertFalse(self.video.accept("test-video-1", self.image))
        self.assertTrue(self.video.expired)

    def test_stop_blocks_upload_and_restart_resets_count(self):
        self.video.start("test-video-1", 30)
        self.video.accept("test-video-1", self.image)
        self.video.stop()
        self.assertFalse(self.video.accept("test-video-1", self.image))
        self.video.start("test-video-2", 60)
        self.assertEqual(self.video.frames, 0)
        self.assertTrue(self.video.accept("test-video-2", self.image))

    def test_invalid_duration_and_duplicate_start(self):
        for duration in [0, 600, "30", True]:
            with self.assertRaises(ValueError):
                self.video.start("test-video-1", duration)
        self.video.start("test-video-1", 30)
        with self.assertRaises(ValueError):
            self.video.start("test-video-2", 30)


class FakeCloud:
    def __init__(self):
        self.sent = []

    async def __aenter__(self):
        self.loop = asyncio.get_running_loop()
        self.queue = asyncio.Queue()
        return self

    async def __aexit__(self, *args):
        pass

    async def send(self, raw):
        event = json.loads(raw)
        self.sent.append(event)
        if event["type"] == "session.update":
            await self.queue.put(json.dumps({"type": "session.updated"}))
        elif event["type"] == "response.create":
            await self.queue.put(json.dumps({"type": "response.done", "response": {"output": [], "usage": {"total_tokens": 5}}}))

    def push(self, event):
        self.loop.call_soon_threadsafe(self.queue.put_nowait, json.dumps(event))

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.queue.get()


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_store = app.STORE
        self.old_config = app.CONFIG.copy()
        app.STORE = Store(Path(self.tmp.name) / "memory.db")
        app.CONFIG.update(key="sk-offline-test-only-xxxxxxxxxxxxxxxx", workspace="7662864", region="beijing")
        app.DIALOGUES.clear()
        self.cloud = FakeCloud()
        self.mock_connect = patch("websockets.asyncio.client.connect", return_value=self.cloud)
        self.cloud_connect = self.mock_connect.start()
        self.client = TestClient(app.app)
        self.image = jpeg()

    def tearDown(self):
        self.client.close()
        self.mock_connect.stop()
        app.STORE = self.old_store
        app.CONFIG.update(self.old_config)
        app.DIALOGUES.clear()
        self.tmp.cleanup()

    def connect(self):
        return self.client.websocket_connect("/ws/realtime", headers={"Origin": "http://testserver"})

    def start(self, ws):
        ws.send_json({"token": app.TOKEN, "sid": "video-test-session", "mode": "video"})
        self.assertEqual(ws.receive_json()["type"], "app.ready")
        ws.send_bytes(b"\x00\x00" * 1600)
        ws.send_json({"type": "video_start", "id": "test-video-1", "duration": 30})
        self.assertEqual(ws.receive_json()["type"], "app.video_started")

    def send_frame(self, ws):
        ws.send_json({"type": "video_frame", "id": "test-video-1", "image": self.image})

    def image_events(self):
        return [e for e in self.cloud.sent if e["type"] == "input_image_buffer.append"]

    def barrier(self, ws):
        ws.send_json({"type": "text", "text": "连接检查"})
        self.assertEqual(ws.receive_json()["type"], "app.usage")

    def test_stream_while_answering_then_stop_and_ignore_late_frame(self):
        with self.connect() as ws:
            self.start(ws)
            self.cloud.push({"type": "response.created"})
            self.cloud.push({"type": "input_audio_buffer.speech_stopped"})
            self.assertEqual(ws.receive_json()["type"], "input_audio_buffer.speech_stopped")
            self.send_frame(ws)
            self.assertEqual(ws.receive_json()["frames"], 1)
            self.assertEqual(len(self.image_events()), 1)
            ws.send_json({"type": "video_stop", "id": "test-video-1"})
            self.assertEqual(ws.receive_json()["type"], "app.video_stopped")
            self.send_frame(ws)
            self.cloud.push({"type": "response.done", "response": {"output": []}})
            self.assertEqual(ws.receive_json()["type"], "app.usage")
            self.barrier(ws)
            self.assertEqual(len(self.image_events()), 1)
            ws.send_json({"type": "stop"})

    def test_pause_stops_and_resume_does_not_restart_video(self):
        with self.connect() as ws:
            self.start(ws)
            self.send_frame(ws)
            ws.receive_json()
            ws.send_json({"type": "pause"})
            self.assertEqual(ws.receive_json()["type"], "app.video_stopped")
            self.send_frame(ws)
            ws.send_json({"type": "resume"})
            self.send_frame(ws)
            self.barrier(ws)
            self.assertEqual(len(self.image_events()), 1)
            ws.send_json({"type": "stop"})

    def test_timeout_even_if_no_more_frames_arrive(self):
        windows = []
        clock = [0]
        def window():
            value = VideoWindow(lambda: clock[0])
            windows.append(value)
            return value
        with patch.object(app, "VideoWindow", side_effect=window):
            with self.connect() as ws:
                self.start(ws)
                clock[0] = 31
                self.assertEqual(ws.receive_json()["type"], "app.video_stopped")
                self.send_frame(ws)
                self.barrier(ws)
                self.assertEqual(len(self.image_events()), 0)
                ws.send_json({"type": "stop"})

    def test_model_stop_tool_and_visual_history_write_guard(self):
        with self.connect() as ws:
            self.start(ws)
            self.send_frame(ws)
            ws.receive_json()
            self.cloud.push({"type": "response.done", "response": {"output": [{"type": "function_call", "name": "stop_video", "call_id": "stop-1", "arguments": "{}"}]}})
            self.assertEqual(ws.receive_json()["type"], "app.video_stopped")
            self.assertEqual(ws.receive_json()["type"], "app.camera_close")
            self.assertEqual(ws.receive_json()["type"], "app.memory")
            self.assertEqual(ws.receive_json()["type"], "app.usage")
            self.assertEqual(ws.receive_json()["type"], "app.usage")
            self.cloud.push({"type": "response.done", "response": {"output": [{"type": "function_call", "name": "prepare_memory", "call_id": "write-1", "arguments": json.dumps({"action": "record", "name": "背包", "location": "椅子上"})}]}})
            self.assertIsNone(ws.receive_json()["pending"])
            ws.receive_json()
            ws.receive_json()
            result = next(e for e in self.cloud.sent if e.get("item", {}).get("call_id") == "write-1")
            self.assertIn("error", json.loads(result["item"]["output"]))
            self.assertEqual(app.STORE.all(), [])
            ws.send_json({"type": "stop"})

    def test_invalid_frame_closes_video_without_forwarding(self):
        with self.connect() as ws:
            self.start(ws)
            ws.send_json({"type": "video_frame", "id": "test-video-1", "image": jpeg(800, 600)})
            self.assertEqual(ws.receive_json()["type"], "app.video_stopped")
            self.barrier(ws)
            self.assertEqual(len(self.image_events()), 0)
            ws.send_json({"type": "stop"})

    def test_memory_page_rejects_camera_requests(self):
        with self.connect() as ws:
            ws.send_json({"token": app.TOKEN, "sid": "memory-mode-test", "mode": "memory"})
            self.assertEqual(ws.receive_json()["type"], "app.ready")
            ws.send_json({"type": "video_start", "id": "test-video-1", "duration": 30})
            self.assertEqual(ws.receive_json()["type"], "app.error")
            self.assertEqual(len(self.image_events()), 0)
            ws.send_json({"type": "stop"})

    def test_https_origin_can_start_real_bridge_route(self):
        with self.client.websocket_connect("wss://testserver/ws/realtime", headers={"Origin": "https://testserver"}) as ws:
            ws.send_json({"token": app.TOKEN, "sid": "mobile-https-test", "mode": "video"})
            self.assertEqual(ws.receive_json()["type"], "app.ready")
            ws.send_json({"type": "stop"})

    def test_handshake_errors_explain_action_without_disclosing_credentials(self):
        secret = app.CONFIG["key"]
        for status, code, expected in [
            (400, "BadRequest.IllegalEndpoint", "业务空间地址无效"),
            (401, "InvalidApiKey", "认证未通过"),
            (403, "AccessDenied", "拒绝连接"),
            (503, "Unknown", "HTTP 503"),
        ]:
            with self.subTest(status=status):
                body = json.dumps({"code": code, "message": secret}).encode()
                self.cloud_connect.side_effect = InvalidStatus(Response(status, "Rejected", Headers({"Authorization": secret}), body))
                with self.connect() as ws:
                    ws.send_json({"token": app.TOKEN, "sid": "connection-error-test", "mode": "video"})
                    event = ws.receive_json()
                    self.assertEqual(event["type"], "app.error")
                    self.assertIn(expected, event["message"])
                    self.assertNotIn(secret, json.dumps(event))
                self.assertEqual(self.cloud.sent, [])

    def test_network_timeout_has_specific_guidance(self):
        self.cloud_connect.side_effect = TimeoutError(app.CONFIG["key"])
        with self.connect() as ws:
            ws.send_json({"token": app.TOKEN, "sid": "connection-timeout-test", "mode": "video"})
            event = ws.receive_json()
            self.assertIn("连接千问超时", event["message"])
            self.assertNotIn(app.CONFIG["key"], json.dumps(event))

    def test_untrusted_error_text_is_not_returned(self):
        exc = InvalidStatus(Response(400, "Rejected", Headers(), b"sk-private-server-text"))
        self.assertNotIn("sk-private-server-text", app.connection_error_message(exc))


if __name__ == "__main__":
    unittest.main(verbosity=2)
