"""Server-authenticated Qwen microphone transcription and receipt speech.

The model cannot save a memory: only the application handles user transcripts.
Unrequested model audio is discarded; only explicit application receipts play.
"""
import asyncio
import base64
import json
import time

from fastapi import WebSocketDisconnect
from websockets.asyncio.client import connect


async def serve(browser, session, csrf):
    await browser.accept()
    cloud = None
    try:
        first = await asyncio.wait_for(browser.receive_json(), 8)
        if first.get('csrf') != csrf or not session.state['running']:
            await browser.close(code=1008)
            return
        if not session.cloud.key:
            await browser.send_json(dict(type='error', message='千问语音尚未配置；文字输入和画面识别仍可操作。'))
            await browser.close(code=1013)
            return
        async with connect('wss://maas.qianwenaiapi.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime', additional_headers={'Authorization':'Bearer '+session.cloud.key}, user_agent_header='okhttp/4.12.0', open_timeout=18, close_timeout=2, max_size=2_000_000, proxy=None) as cloud:
            await cloud.send(json.dumps(dict(type='session.update', session=dict(modalities=['text','audio'], voice='Tina', input_audio_format='pcm', output_audio_format='pcm', input_audio_transcription={'model':'qwen3-asr-flash-realtime'}, turn_detection={'type':'server_vad','threshold':.5,'silence_duration_ms':700,'create_response':False}, instructions='你是空间记忆助手的语音通道。默认只接收和转录用户说话。只有应用明确要求朗读时才逐字朗读给定文字。不能自行判断物品已保存或已找到，不能修改记忆。', max_tokens=400, tools=[])), ensure_ascii=False))
            ready = asyncio.Event()
            speaking = False
            requested = False
            fallback_used = False
            last_say = 0

            async def upstream():
                nonlocal speaking, requested, fallback_used
                async for raw in cloud:
                    event = json.loads(raw)
                    kind = event.get('type')
                    if kind=='session.updated':
                        ready.set()
                        await browser.send_json(dict(type='ready'))
                    elif kind=='error':
                        code = event.get('error',{}).get('code','')
                        if not ready.is_set() and not fallback_used:
                            # Some model revisions do not accept create_response.
                            fallback_used = True
                            await cloud.send(json.dumps(dict(type='session.update', session={'turn_detection':{'type':'server_vad','threshold':.5,'silence_duration_ms':700}})))
                        elif code not in ['response_cancel_not_active','response_already_in_progress','response_not_active']:
                            requested = speaking = False
                            await browser.send_json(dict(type='error',message='这次千问语音未完成，可以继续使用文字输入。'))
                    elif kind=='input_audio_buffer.speech_started':
                        speaking = requested = False
                        await cloud.send(json.dumps(dict(type='response.cancel')))
                        await browser.send_json(dict(type='interrupt'))
                    elif kind=='conversation.item.input_audio_transcription.completed':
                        text = str(event.get('transcript','')).strip()
                        if not 0<len(text)<=400:
                            continue
                        await cloud.send(json.dumps(dict(type='response.cancel')))
                        speaking = requested = False
                        await browser.send_json(dict(type='transcript',text=text))
                        # The page routes every spoken transcript through the
                        # exact same command function as typed messages. Never
                        # execute here as well, or remembering would run twice.
                    elif kind=='response.created':
                        speaking = requested
                        requested = False
                        if not speaking:
                            await cloud.send(json.dumps(dict(type='response.cancel')))
                    elif kind=='response.audio.delta' and speaking:
                        await browser.send_json(dict(type='audio',audio=event.get('delta','')))
                    elif kind=='response.audio.done' and speaking:
                        await browser.send_json(dict(type='audio_end'))
                    elif kind=='response.done':
                        speaking = False

            async def downstream():
                nonlocal speaking, requested, last_say
                await asyncio.wait_for(ready.wait(), 20)
                while session.state['running']:
                    packet = await browser.receive()
                    if packet['type']=='websocket.disconnect':
                        return
                    if packet.get('bytes') is not None:
                        audio = packet['bytes']
                        if 0<len(audio)<=32000 and len(audio)%2==0:
                            await cloud.send(json.dumps(dict(type='input_audio_buffer.append', audio=base64.b64encode(audio).decode())))
                    elif packet.get('text'):
                        message = json.loads(packet['text'])
                        if message.get('type')=='speak' and 0<len(str(message.get('text','')))<=700 and time.monotonic()-last_say>.5:
                            last_say = time.monotonic()
                            await cloud.send(json.dumps(dict(type='response.cancel')))
                            requested = True
                            await cloud.send(json.dumps(dict(type='response.create',response={'modalities':['text','audio'],'instructions':'只逐字朗读下列应用已经核验的回执，不加解释、不执行操作：'+message['text']}),ensure_ascii=False))
                        elif message.get('type')=='stop':
                            return
            tasks = [asyncio.create_task(upstream()),asyncio.create_task(downstream())]
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks: task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception:
        try:
            await browser.send_json(dict(type='error',message='千问语音连接暂未完成，可以使用文字输入重试。'))
        except Exception:
            pass
    finally:
        try: await browser.close()
        except Exception: pass
