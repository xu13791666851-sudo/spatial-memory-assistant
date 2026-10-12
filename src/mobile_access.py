"""LAN authentication wrapper. No keys, memories or media are served before pairing."""
import secrets
import time
from http.cookies import SimpleCookie
from urllib.parse import parse_qs

from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse, Response


class MobileGate:
    def __init__(self, upstream, origin, passcode):
        self.upstream = upstream
        self.origin = origin
        self.host = origin.split("://", 1)[1]
        self.passcode = passcode
        self.session = secrets.token_urlsafe(32)
        self.failures = {}
        self.expires = time.monotonic() + 12 * 3600

    def paired(self, scope):
        cookie = SimpleCookie()
        try:
            cookie.load(dict(scope.get("headers", [])).get(b"cookie", b"").decode("ascii"))
            value = cookie.get("spatial_mobile")
            return bool(value and time.monotonic() < self.expires and secrets.compare_digest(value.value, self.session))
        except (ValueError, UnicodeError):
            return False

    def page(self, message="输入电脑上显示的六位访问码。", status=200):
        return HTMLResponse("""<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>连接空间记忆助手</title>
<style>body{margin:0;background:#fafbf9;color:#172b25;font:18px/1.6 system-ui,sans-serif}main{max-width:440px;margin:40px auto;padding:24px}h1{font-size:28px}input,button{box-sizing:border-box;width:100%;min-height:64px;font:inherit;padding:16px;border-radius:12px;border:1px solid #9aafa3}button{margin-top:20px;background:#165b46;color:white}input:focus-visible,button:focus-visible{outline:3px solid #005fcc;outline-offset:4px}</style>
<main><h1>连接空间记忆助手</h1><p>""" + message + """</p>
<form method="post" action="/pair"><label for="code">访问码</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required><button>进入网页</button></form></main></html>""", status_code=status, headers={
            "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"})

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            return await self.upstream(scope, receive, send)
        headers = dict(scope.get("headers", []))
        valid_host = headers.get(b"host", b"").decode("ascii", "replace") == self.host
        if scope["type"] == "websocket":
            if not valid_host or headers.get(b"origin", b"").decode("ascii", "replace") != self.origin or not self.paired(scope):
                return await send({"type": "websocket.close", "code": 1008})
            return await self.upstream(scope, receive, send)
        if not valid_host or scope.get("scheme") != "https":
            return await Response("Invalid host or transport", status_code=400)(scope, receive, send)
        if scope["path"] == "/pair":
            if scope["method"] == "POST":
                request = Request(scope, receive)
                if request.headers.get("origin", self.origin) != self.origin:
                    return await Response(status_code=403)(scope, receive, send)
                address = (scope.get("client") or ("unknown", 0))[0]
                stamp, count = self.failures.get(address, (time.monotonic(), 0))
                if time.monotonic() - stamp > 60:
                    stamp, count = time.monotonic(), 0
                if count >= 5:
                    return await self.page("尝试次数过多，请一分钟后重试。", 429)(scope, receive, send)
                body = await request.body()
                if len(body) > 1024:
                    return await Response(status_code=413)(scope, receive, send)
                code = parse_qs(body.decode("utf-8", "replace")).get("code", [""])[0]
                if time.monotonic() < self.expires and secrets.compare_digest(code.encode(), self.passcode.encode()):
                    self.failures.pop(address, None)
                    response = RedirectResponse("/video", status_code=303)
                    response.set_cookie("spatial_mobile", self.session, secure=True, httponly=True, samesite="strict", max_age=43200)
                    return await response(scope, receive, send)
                self.failures[address] = (stamp, count + 1)
                return await self.page("访问码不正确，请核对电脑上显示的六位数字。", 401)(scope, receive, send)
            return await self.page()(scope, receive, send)
        if not self.paired(scope):
            response = RedirectResponse("/pair", status_code=303) if scope["path"] in {"/", "/video", "/memory"} else Response("Pairing required", status_code=401)
            return await response(scope, receive, send)
        return await self.upstream(scope, receive, send)
