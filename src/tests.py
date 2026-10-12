import json
import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
import app
from memory import Store, Dialogue


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "memory.db"
        self.store = Store(self.path)
        self.d = Dialogue(self.store)

    def tearDown(self):
        self.tmp.cleanup()

    def test_record_query_and_followup(self):
        self.d.command("记住，钥匙刚放在玄关桌上。")
        self.assertIsNotNone(self.store.get("钥匙"))
        self.assertIsNone(self.store.get("钥匙刚"))
        self.assertIn("还没有确认现在的位置", self.d.command("钥匙在哪？"))
        self.assertIn("不是摄像头观察", self.d.command("什么时候看到的？"))

    def test_event_time_does_not_become_record_time(self):
        self.d.command("记住，我昨天把钥匙放在书桌上")
        r = self.store.get("钥匙")
        self.assertEqual(r["event_time"], "昨天")
        self.assertEqual(r["state"], "HISTORICAL")
        self.assertEqual(r["source"], "MANUAL")

    def test_persistence(self):
        self.store.record("背包", "椅子上", "昨天")
        self.assertEqual(Store(self.path).get("背包")["location"], "椅子上")

    def test_unknown(self):
        self.assertIn("没有找到", self.d.command("杯子在哪"))

    def test_ambiguous_correction_cannot_confirm(self):
        self.d.command("记住，钥匙刚放在玄关桌上")
        self.d.command("改成书桌上")
        with self.assertRaises(ValueError):
            self.d.command("确认")
        self.assertEqual(self.store.get("钥匙")["location"], "玄关桌上")

    def test_correction_keeps_event_time(self):
        self.d.command("记住，我昨天把钥匙放在玄关桌上")
        first = self.store.get("钥匙")
        self.d.command("改成书桌上")
        self.d.command("刚才记错了")
        self.d.command("确认")
        latest = self.store.get("钥匙")
        self.assertEqual(latest["location"], "书桌上")
        self.assertEqual(latest["event_time"], "昨天")
        self.assertEqual(latest["correction_of"], first["id"])

    def test_delete_requires_confirmation(self):
        self.store.record("钥匙", "桌上")
        self.d.command("删除钥匙的全部记录")
        self.assertIsNotNone(self.store.get("钥匙"))
        self.d.command("取消")
        self.assertIsNotNone(self.store.get("钥匙"))
        self.d.command("删除钥匙的记录")
        self.d.command("确认")
        self.assertIsNone(Store(self.path).get("钥匙"))

    def test_expired_and_reused_confirmation_rejected(self):
        self.d.prepare("record", "杯子", "桌上")
        token = self.d.pending["token"]
        self.d.pending["expires"] = time.monotonic() - 1
        with self.assertRaises(ValueError):
            self.d.confirm(token)
        self.d.prepare("record", "杯子", "桌上")
        token = self.d.pending["token"]
        self.d.confirm(token)
        with self.assertRaises(ValueError):
            self.d.confirm(token)

    def test_records_deduplicated_but_history_kept(self):
        self.store.record("钥匙", "玄关")
        self.store.record("钥匙", "书桌")
        self.assertEqual(len(self.store.all()), 1)
        with self.store.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 2)


class APITests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.previous_store = app.STORE
        app.STORE = Store(Path(self.tmp.name) / "memory.db")
        app.DIALOGUES.clear()
        app.CONFIG.update(key="", workspace="7662864", region="beijing")
        self.client = TestClient(app.app)
        self.headers = {"X-Local-Token": app.TOKEN}

    def tearDown(self):
        self.client.close()
        app.STORE = self.previous_store
        app.DIALOGUES.clear()
        app.CONFIG.update(key="", workspace="7662864", region="beijing")
        self.tmp.cleanup()

    def test_ui_and_assets(self):
        for path in ["/", "/memory", "/video", "/static/app.js", "/static/style.css", "/static/recorder.js", "/static/video-stream.js"]:
            self.assertEqual(self.client.get(path).status_code, 200)

    def test_protected_endpoints(self):
        self.assertEqual(self.client.get("/api/memories").status_code, 403)
        self.assertEqual(self.client.get("/api/status", headers={"Host": "evil.example"}).status_code, 400)
        h = {**self.headers, "Origin": "https://evil.example"}
        self.assertEqual(self.client.post("/api/command", json={"sid":"test-session", "text":"钥匙在哪"}, headers=h).status_code, 403)

    def test_local_memory_flow(self):
        def command(text):
            res = self.client.post("/api/command", headers=self.headers, json={"sid":"test-session", "text":text})
            self.assertEqual(res.status_code, 200)
            return res.json()
        command("记住，钥匙刚放在玄关桌上")
        self.assertIn("玄关桌上", command("钥匙在哪")["answer"])
        pending = command("删除钥匙的记录")["pending"]
        res = self.client.post("/api/confirm", headers=self.headers, json={"sid":"test-session", "token":pending["token"]})
        self.assertEqual(res.json()["items"], [])

    def test_key_is_not_returned_and_can_be_cleared(self):
        fake_key = "sk-test-" + "x" * 40
        result = self.client.post("/api/config", headers=self.headers, json={"key":fake_key, "workspace":"7662864", "region":"beijing"})
        self.assertEqual(result.status_code, 200)
        self.assertNotIn(fake_key, result.text)
        self.assertNotIn(fake_key, self.client.get("/api/status").text)
        self.client.delete("/api/config", headers=self.headers)
        self.assertFalse(self.client.get("/api/status").json()["configured"])

    def test_validation_never_echoes_secret(self):
        fake_key = "sensitive-fixture-for-validation"
        res = self.client.post("/api/config", headers=self.headers, json={"key":fake_key})
        self.assertEqual(res.status_code, 422)
        self.assertNotIn(fake_key, res.text)

    def test_cloud_write_is_pending_not_saved(self):
        d = Dialogue(app.STORE)
        result = app.execute_tool(d, "prepare_memory", {"action":"record", "name":"背包", "location":"椅子上"})
        self.assertFalse(result["saved"])
        self.assertIsNone(app.STORE.get("背包"))
        d.confirm(result["pending"]["token"])
        self.assertEqual(app.STORE.get("背包")["source"], "MANUAL")

    def test_visual_cannot_write_memory(self):
        result = app.execute_tool(Dialogue(app.STORE), "prepare_memory", {"action":"record", "name":"背包", "location":"椅子上"}, image_active=True)
        self.assertIn("error", result)
        self.assertEqual(app.STORE.all(), [])

    def test_model_configuration(self):
        session = app.session_config()["session"]
        self.assertEqual(session["audio"]["input"]["format"]["sample_rate"], 16000)
        self.assertFalse(session["enable_search"])
        self.assertEqual(len(session["tools"]), 3)
        self.assertEqual(session["video"]["input"]["representation_compact"], "none")

    def test_pages_have_distinct_titles_and_modes(self):
        for path, mode, title in [("/memory", "memory", "语音记忆"), ("/video", "video", "视频理解")]:
            html = self.client.get(path).text
            self.assertIn('data-page="' + mode + '"', html)
            self.assertIn('<h1>' + title + '</h1>', html)
            self.assertNotIn("{{", html)
            self.assertNotIn('name="viewport" content="width=device-width,initial-scale=1,user-scalable=no', html)
        video_tools = [t["function"]["name"] for t in app.session_config("video")["session"]["tools"]]
        self.assertNotIn("prepare_memory", video_tools)


if __name__ == "__main__":
    unittest.main(verbosity=2)
