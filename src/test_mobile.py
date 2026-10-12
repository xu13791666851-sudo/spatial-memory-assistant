import asyncio
import ipaddress
import json
import plistlib
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python-deps"))
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from mobile_access import MobileGate
from run_mobile import make_certificate


class MobileAccessTests(unittest.TestCase):
    def setUp(self):
        upstream = FastAPI()

        @upstream.get("/api/status")
        def status():
            return {"token": "private-local-token"}

        @upstream.get("/video")
        def video():
            return {"page": "video"}

        @upstream.websocket("/ws/realtime")
        async def socket(ws: WebSocket):
            await ws.accept()
            await ws.send_json({"ready": True})
            await ws.close()

        self.origin = "https://172.24.84.96:8767"
        self.gate = MobileGate(upstream, self.origin, "123456")
        self.client = TestClient(self.gate, base_url=self.origin, follow_redirects=False)

    def tearDown(self):
        self.client.close()

    def pair(self):
        return self.client.post("/pair", data={"code": "123456"}, headers={"Origin": self.origin})

    def test_unpaired_cannot_read_token_or_records(self):
        self.assertEqual(self.client.get("/api/status").status_code, 401)
        self.assertEqual(self.client.get("/api/memories").status_code, 401)
        response = self.client.get("/video")
        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers["location"], "/pair")
        self.assertNotIn("123456", self.client.get("/pair").text)

    def test_pairing_sets_secure_cookie_and_permits_page(self):
        response = self.pair()
        self.assertEqual(response.status_code, 303)
        cookie = response.headers["set-cookie"]
        self.assertIn("Secure", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=strict", cookie)
        self.assertEqual(self.client.get("/video").status_code, 200)
        self.assertEqual(self.client.get("/api/status").status_code, 200)

    def test_bad_code_is_limited_and_cannot_unlock(self):
        for _ in range(5):
            self.assertEqual(self.client.post("/pair", data={"code": "000000"}).status_code, 401)
        self.assertEqual(self.pair().status_code, 429)
        self.assertEqual(self.client.get("/api/status").status_code, 401)

    def test_cross_origin_pairing_and_http_are_blocked(self):
        self.assertEqual(self.client.post("/pair", data={"code": "123456"}, headers={"Origin": "https://evil.example"}).status_code, 403)
        self.assertEqual(self.client.get("/pair", headers={"Host": "evil.example"}).status_code, 400)
        with TestClient(self.gate, base_url="http://172.24.84.96:8767") as insecure:
            self.assertEqual(insecure.get("/pair").status_code, 400)

    def test_paired_websocket_works_and_other_origin_is_rejected(self):
        self.pair()
        with self.client.websocket_connect("wss://172.24.84.96:8767/ws/realtime", headers={"Origin": self.origin}) as ws:
            self.assertTrue(ws.receive_json()["ready"])
        from starlette.websockets import WebSocketDisconnect
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect("wss://172.24.84.96:8767/ws/realtime", headers={"Origin": "https://evil.example"}):
                pass

    def test_expired_pairing_does_not_expose_data(self):
        self.pair()
        self.gate.expires = time.monotonic() - 1
        self.assertEqual(self.client.get("/api/status").status_code, 401)


class CertificateTests(unittest.TestCase):
    def test_profile_contains_only_root_certificate_and_private_ca_is_not_saved(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            metadata = make_certificate("172.24.84.96", folder)
            profile = plistlib.loads((folder / "local-test.mobileconfig").read_bytes())
            self.assertEqual(len(profile["PayloadContent"]), 1)
            self.assertEqual(profile["PayloadContent"][0]["PayloadType"], "com.apple.security.root")
            root = x509.load_der_x509_certificate(profile["PayloadContent"][0]["PayloadContent"])
            leaf = x509.load_pem_x509_certificate((folder / "server.pem").read_bytes())
            self.assertEqual(leaf.issuer, root.subject)
            names = leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            self.assertEqual(names.get_values_for_type(x509.IPAddress), [ipaddress.ip_address("172.24.84.96")])
            saved_key = serialization.load_pem_private_key((folder / "server.key").read_bytes(), None)
            self.assertNotEqual(saved_key.public_key().public_numbers(), root.public_key().public_numbers())
            self.assertEqual(make_certificate("172.24.84.96", folder)["fingerprint"], metadata["fingerprint"])


if __name__ == "__main__":
    unittest.main()
