"""Serve the existing app over authenticated LAN HTTPS plus a public certificate guide."""
import argparse
import hashlib
import ipaddress
import json
import os
import plistlib
import secrets
import sys
import threading
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "python-deps"))
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)


def make_certificate(host, folder):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    folder.mkdir(parents=True, exist_ok=True)
    metadata = folder / "certificate.json"
    if metadata.exists():
        saved = json.loads(metadata.read_text())
        if saved.get("host") == host and datetime.fromisoformat(saved["expires"]) > datetime.now(timezone.utc) + timedelta(days=1):
            return saved
    now = datetime.now(timezone.utc)
    expiry = now + timedelta(days=30)
    root_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    root_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Spatial Agent Local Test")])
    root_cert = (x509.CertificateBuilder().subject_name(root_name).issuer_name(root_name)
                 .public_key(root_key.public_key()).serial_number(x509.random_serial_number())
                 .not_valid_before(now - timedelta(minutes=5)).not_valid_after(expiry)
                 .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
                 .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
                 .sign(root_key, hashes.SHA256()))
    server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    server_cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)]))
                   .issuer_name(root_name).public_key(server_key.public_key()).serial_number(x509.random_serial_number())
                   .not_valid_before(now - timedelta(minutes=5)).not_valid_after(expiry)
                   .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                   .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(host))]), critical=False)
                   .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
                   .add_extension(x509.KeyUsage(True, False, True, False, False, False, False, False, False), critical=True)
                   .sign(root_key, hashes.SHA256()))
    pem = serialization.Encoding.PEM
    (folder / "server.pem").write_bytes(server_cert.public_bytes(pem) + root_cert.public_bytes(pem))
    (folder / "server.key").write_bytes(server_key.private_bytes(pem, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    (folder / "root.pem").write_bytes(root_cert.public_bytes(pem))
    profile = {"PayloadContent": [{"PayloadType": "com.apple.security.root", "PayloadVersion": 1,
               "PayloadIdentifier": "local.spatial-agent.certificate", "PayloadUUID": str(uuid.uuid4()),
               "PayloadDisplayName": "Spatial Agent Local Test", "PayloadContent": root_cert.public_bytes(serialization.Encoding.DER)}],
               "PayloadType": "Configuration", "PayloadVersion": 1, "PayloadIdentifier": "local.spatial-agent.testing",
               "PayloadUUID": str(uuid.uuid4()), "PayloadDisplayName": "空间记忆助手：本地测试证书",
               "PayloadDescription": "仅用于这台电脑上的空间记忆助手 HTTPS 测试；测试完成后可移除。"}
    (folder / "local-test.mobileconfig").write_bytes(plistlib.dumps(profile))
    saved = {"host": host, "expires": expiry.isoformat(), "fingerprint": root_cert.fingerprint(hashes.SHA256()).hex().upper()}
    metadata.write_text(json.dumps(saved), encoding="utf-8")
    # The CA private key is deliberately not stored; it cannot issue other certificates after startup.
    return saved


def setup_page(host, fingerprint):
    return f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>手机连接空间记忆助手</title>
<style>body{{margin:0;background:#fafbf9;color:#172b25;font:18px/1.7 system-ui,sans-serif}}main{{max-width:520px;margin:auto;padding:24px}}h1{{font-size:28px}}li{{margin:16px 0}}a{{color:#165b46}}.button{{display:block;padding:18px;text-align:center;border-radius:14px;background:#165b46;color:white;text-decoration:none}}.small{{font-size:14px;overflow-wrap:anywhere;color:#52645d}}</style>
<main><h1>在 iPhone 上使用</h1><p>手机和电脑连接同一个 Wi-Fi。请用 Safari 打开此页面。</p>
<ol><li>下载下方的本地测试证书。</li><li>在 iPhone“设置”中打开“已下载描述文件”，安装“空间记忆助手：本地测试证书”。安装时需你亲自确认。</li><li>前往“设置 → 通用 → 关于本机 → 证书信任设置”，信任“Spatial Agent Local Test”。</li><li>回到此页面，打开测试网页，输入电脑上显示的六位访问码。</li><li>在“更多 → 连接与声音设置”填写千问密钥；业务空间和北京地域已预填。点击“开始观察”，允许摄像头和麦克风。</li></ol>
<p><a class="button" href="http://{host}:8766/local-test.mobileconfig">下载本地测试证书</a></p><p><a class="button" href="https://{host}:8767/video">打开测试网页</a></p>
<p>这份描述文件只包含本地证书，没有设备管理、VPN 或代理设置。根证书签发私钥没有保存。测试后可在“设置 → 通用 → VPN 与设备管理”移除此描述文件。</p>
<p class="small">证书 SHA-256 指纹：{fingerprint}</p><p class="small">如果仍出现证书警告，请检查安装及信任步骤，不要跳过浏览器警告。如果页面打不开，检查同一 Wi-Fi、防火墙或网络是否隔离设备。</p>
<p><a href="https://support.apple.com/zh-cn/102390">Apple 官方证书信任说明</a></p></main></html>"""


def bootstrap_handler(host, folder, metadata):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path in {"/", "/index.html"}:
                content = setup_page(host, metadata["fingerprint"]).encode()
                kind = "text/html; charset=utf-8"
            elif self.path == "/local-test.mobileconfig":
                content = (folder / "local-test.mobileconfig").read_bytes()
                kind = "application/x-apple-aspen-config"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(content)
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    args = parser.parse_args()
    address = ipaddress.ip_address(args.host)
    if address.version != 4 or not address.is_private or address.is_loopback or address.is_unspecified:
        raise SystemExit("Choose the computer's private Wi-Fi IPv4 address")
    host = str(address)
    os.environ["SPATIAL_LAN_HOST"] = host
    folder = ROOT / "data" / "mobile-tls"
    metadata = make_certificate(host, folder)
    import uvicorn
    from app import app
    from mobile_access import MobileGate
    passcode = f"{secrets.randbelow(1000000):06d}"
    origin = f"https://{host}:8767"
    server = ThreadingHTTPServer((host, 8766), bootstrap_handler(host, folder, metadata))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    output = ROOT.parent / "outputs" / "手机访问"
    output.mkdir(parents=True, exist_ok=True)
    try:
        import qrcode
        qrcode.make(f"http://{host}:8766/").save(output / "手机扫码入口.png")
    except ImportError:
        pass
    (output / "手机连接步骤.html").write_text(setup_page(host, metadata["fingerprint"]), encoding="utf-8")
    print(f"PHONE_SETUP=http://{host}:8766/", flush=True)
    print(f"PHONE_APP={origin}/video", flush=True)
    print(f"ACCESS_CODE={passcode}", flush=True)
    print(f"CERT_SHA256={metadata['fingerprint']}", flush=True)
    try:
        uvicorn.run(MobileGate(app, origin, passcode), host=host, port=8767,
                    ssl_certfile=str(folder / "server.pem"), ssl_keyfile=str(folder / "server.key"),
                    access_log=False, log_level="warning", ws="websockets", proxy_headers=False)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
