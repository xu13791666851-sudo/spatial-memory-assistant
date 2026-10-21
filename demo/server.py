import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, JSONResponse

from .cloud import Cloud
from .engine import Session
from .inference import Detector, ROOT, image
from .store import Store
from .voice import serve


def create_app(data_path=None, detector=None, cloud=None):
    data = Path(data_path or os.environ.get('DEMO_DATA_DIR', ROOT/'.demo-data'))
    data.mkdir(parents=True,exist_ok=True)
    secret_file=data/'session-secret'
    if not secret_file.exists(): secret_file.write_bytes(secrets.token_bytes(32))
    secret=secret_file.read_bytes()
    store=Store(str(data/'memories.sqlite3'))
    detector=detector or Detector()
    cloud=cloud or Cloud(os.environ.get('QWEN_API_KEY',''))
    sessions={}
    rates=defaultdict(deque)
    site=Path(os.environ.get('DEMO_SITE_DIR',ROOT/'.demo-site')).resolve()
    inference_slots=asyncio.Semaphore(2)

    @asynccontextmanager
    async def lifespan(app):
        async def watchdog():
            while True:
                await asyncio.sleep(3)
                for owner, session in list(sessions.items()):
                    if session.state['running'] and time.monotonic()-session.last_frame>20:
                        await session.command('stop',{})
                    if time.monotonic()-session.seen>1800:
                        await session.command('stop',{})
                        sessions.pop(owner,None)
                for key, stamps in list(rates.items()):
                    if not stamps or time.monotonic()-stamps[-1]>60: rates.pop(key,None)
        task=asyncio.create_task(watchdog())
        warm=asyncio.create_task(asyncio.to_thread(detector.load))
        try: yield
        finally:
            task.cancel();warm.cancel()
            for session in list(sessions.values()): await session.command('stop',{})
            await asyncio.gather(task,warm,return_exceptions=True)

    app=FastAPI(title='I SEE YOU 手机完整流程演示',lifespan=lifespan,docs_url=None,redoc_url=None,openapi_url=None)
    app.state.sessions=sessions
    app.state.store=store

    def signed(owner): return owner+'.'+hmac.new(secret,owner.encode(),'sha256').hexdigest()
    def cookie_owner(cookie):
        if not cookie or len(cookie)!=97: return None
        owner,_,sig=cookie.partition('.')
        return owner if all(c in '0123456789abcdef' for c in owner) and hmac.compare_digest(signed(owner),cookie) else None
    def csrf(owner): return hmac.new(secret,(owner+':csrf').encode(),'sha256').hexdigest()
    def get_session(request):
        owner=cookie_owner(request.cookies.get('iseeyou-demo'))
        if not owner: raise HTTPException(401,'请刷新页面后重试。')
        if owner not in sessions:
            if len(sessions)>=128: raise HTTPException(503,'演示人数较多，请稍后再试。')
            sessions[owner]=Session(owner,store,detector,cloud)
        sessions[owner].seen=time.monotonic()
        return sessions[owner]
    def same_origin(request):
        origin=request.headers.get('origin')
        if origin and origin.split('://',1)[-1]!=request.headers.get('host'):
            raise HTTPException(403,'请从当前应用页面操作。')
    def authorize(request):
        same_origin(request)
        session=get_session(request)
        if not hmac.compare_digest(request.headers.get('x-demo-csrf',''),csrf(session.owner)):
            raise HTTPException(403,'请刷新页面后重试。')
        return session

    @app.middleware('http')
    async def headers(request,call_next):
        if request.url.path.startswith('/api/demo/'):
            key=(request.client.host if request.client else 'unknown',request.url.path)
            stamps=rates[key];current=time.monotonic()
            while stamps and current-stamps[0]>60: stamps.popleft()
            limit=180 if request.url.path.endswith(('/frame','/state')) else 90
            if len(stamps)>=limit: return JSONResponse({'detail':'操作较频繁，请稍候。'},429)
            stamps.append(current)
            length=request.headers.get('content-length','0')
            if not length.isdigit(): return JSONResponse({'detail':'请求长度不正确。'},400)
            if int(length)>1_100_000:
                return JSONResponse({'detail':'画面过大。'},413)
        response=await call_next(request)
        response.headers.update({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(self), microphone=(self)','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self' https://modelscope.cn https://www.modelscope.cn"})
        return response

    @app.get('/health')
    async def health(): return dict(app='I SEE YOU web demo',configured=bool(cloud.key),model_ready=detector.interpreter is not None,labels=80)

    @app.get('/api/demo/bootstrap')
    async def bootstrap(request:Request):
        same_origin(request)
        owner=cookie_owner(request.cookies.get('iseeyou-demo')) or secrets.token_hex(16)
        if owner not in sessions:
            if len(sessions)>=128: raise HTTPException(503,'演示人数较多，请稍后再试。')
            sessions[owner]=Session(owner,store,detector,cloud)
        response=JSONResponse({**sessions[owner].snapshot(),'csrf':csrf(owner),'configured':bool(cloud.key)})
        response.set_cookie('iseeyou-demo',signed(owner),max_age=90*86400,httponly=True,samesite='lax',secure=request.url.scheme=='https' or request.headers.get('x-forwarded-proto')=='https')
        return response

    @app.get('/api/demo/state')
    async def state(request:Request,since:int=0):
        return get_session(request).snapshot(since)

    async def body(request):
        raw=await request.body()
        if len(raw)>1_100_000: raise HTTPException(413,'画面过大。')
        try:
            value=json.loads(raw)
            if not isinstance(value,dict): raise ValueError()
            return value
        except (ValueError,TypeError): raise HTTPException(400,'请求格式不正确。') from None

    @app.post('/api/demo/command')
    async def command(request:Request):
        session=authorize(request);supplied=await body(request)
        method=supplied.get('method');params=supplied.get('params',{})
        if not isinstance(method,str) or not isinstance(params,dict): raise HTTPException(400,'请求格式不正确。')
        try:
            result=await session.command(method,params)
            return {**session.snapshot(int(supplied.get('since',0))),'result':result}
        except ValueError as error: raise HTTPException(400,str(error)) from None

    @app.post('/api/demo/frame')
    async def frame(request:Request):
        session=authorize(request);supplied=await body(request)
        if session.frame_busy: raise HTTPException(409,'上一帧仍在处理中。')
        session.frame_busy=True
        try:
            captured=int(supplied['capturedAt']);frame_id=int(supplied['id']);epoch=int(supplied['epoch'])
            if abs(int(time.time()*1000)-captured)>15_000: raise ValueError('画面已经过期，请检查设备时间。')
            picture,raw=image(supplied.get('image'))
            async with inference_slots:
                output=await session.frame(picture,raw,frame_id,captured,epoch)
            return {**session.snapshot(int(supplied.get('since',0))),'frame':output}
        except (KeyError,TypeError,ValueError) as error:
            raise HTTPException(400,str(error) if isinstance(error,ValueError) else '画面信息不完整。') from None
        finally: session.frame_busy=False

    @app.websocket('/api/demo/voice')
    async def voice(browser:WebSocket):
        if browser.headers.get('origin','').split('://',1)[-1]!=browser.headers.get('host'):
            await browser.close(code=1008);return
        try: session=get_session(browser)
        except HTTPException:
            await browser.close(code=1008);return
        if getattr(session,'voice_connected',False):
            await browser.close(code=1013);return
        session.voice_connected=True
        try: await serve(browser,session,csrf(session.owner))
        finally: session.voice_connected=False

    @app.get('/{path:path}')
    async def files(path:str):
        if path in ['', 'video','video/','index.html']: path='index.html'
        file=(site/path).resolve()
        if not file.is_relative_to(site) or not file.is_file(): raise HTTPException(404,'文件不存在。')
        mime='text/javascript' if file.suffix in ['.mjs','.js'] else None
        return FileResponse(file,media_type=mime)
    return app


app=create_app()
