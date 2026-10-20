import {PersistentVision} from '../netlify/lib/persistent-vision.mjs';
import {appearanceText} from '../web/memory.mjs';

export function parseFrame(raw){
  if(typeof raw!=='string'||raw.length>260000)throw Error('invalid_frame');
  const value=JSON.parse(raw),{image,request_id,goal='',task}=value;
  if(value.type!=='observe'||typeof request_id!=='string'||! /^[A-Za-z0-9_-]{8,80}$/.test(request_id)||typeof image!=='string'||image.length<8||image.length>250000||!/^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(image)||typeof goal!=='string'||goal.length>400)throw Error('invalid_frame');
  if(!task||typeof task.target!=='string'||!task.target.trim()||task.target.length>60||task.remember!==false||typeof task.reference_appearance!=='string'||task.reference_appearance.length>150||/[\x00-\x1f]/.test(task.reference_appearance))throw Error('invalid_task');
  return {image,request_id,goal,task:{target:task.target,remember:false,reference_appearance:appearanceText(task.reference_appearance)}};
}

export function attachVisionSocket(socket,session,{limit,clock=()=>Date.now(),ttlMs=125000}={}){
  let closed=false,busy=false,frames=0,last=-Infinity,identity;const ids=new Set();
  const send=event=>{if(!closed)socket.send(JSON.stringify(event));};
  const close=()=>{if(closed)return;closed=true;clearTimeout(timer);session.close();try{socket.close(1000,'Search ended');}catch{}};
  const fail=code=>{send({type:'error',code,message:'持续观察连接已停止。可以说“继续找”重新开始。'});close();};
  const timer=setTimeout(()=>fail('session_expired'),ttlMs);
  socket.addEventListener('close',close);socket.addEventListener('error',close);
  socket.addEventListener('message',async event=>{
    if(closed)return;
    try{
      const frame=parseFrame(event.data),key=JSON.stringify(frame.task);
      if(busy||frames>=60||clock()-last<1000||ids.has(frame.request_id))throw Error('frame_limit');
      if(identity&&identity!==key)throw Error('target_changed');identity=key;busy=true;
      if(!await limit())throw Error('rate_limited');if(closed)return;
      last=clock();frames++;ids.add(frame.request_id);
      const result=await session.observe(frame);if(closed)return;
      busy=false;send({type:'observation',request_id:frame.request_id,...result});
    }catch(error){if(!closed){console.warn('vision_stream_failed',/^[a-z_]{1,80}$/.test(error?.message)?error.message:'unexpected_error');fail('stream_failed');}}
  });
  session.ready.then(()=>send({type:'ready',protocol:1,min_interval_ms:2000})).catch(()=>fail('stream_unavailable'));
  return close;
}

export function createStreamHandler(fetcher=fetch){
  return async(request,env)=>{
    const path=new URL(request.url).pathname;
    if(path==='/health')return Response.json({service:'spatial-memory-vision-stream',protocol:1},{headers:{'Cache-Control':'no-store'}});
    if(path!=='/api/vision-stream')return new Response('Not found',{status:404});
    if(request.method!=='GET'||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket required',{status:426});
    if(!env.ALLOWED_ORIGIN||request.headers.get('Origin')!==env.ALLOWED_ORIGIN)return new Response('Origin rejected',{status:403});
    if(!env.DASHSCOPE_API_KEY||!env.STREAM_CONNECTION_LIMITER||!env.STREAM_FRAME_LIMITER)return new Response('Stream not configured',{status:503});
    const actor=request.headers.get('CF-Connecting-IP')||'unknown';
    if(!(await env.STREAM_CONNECTION_LIMITER.limit({key:actor})).success)return new Response('Please wait before reconnecting',{status:429});
    const [client,server]=Object.values(new WebSocketPair());server.accept();
    const connect=async(url,{headers,onMessage,onError,onClose})=>{
      const response=await fetcher(url.replace(/^wss:/,'https:'),{headers:{...headers,Upgrade:'websocket'},redirect:'manual'});
      if(response.status!==101||!response.webSocket)throw Error('upgrade_failed');
      const socket=response.webSocket;socket.addEventListener('message',event=>onMessage(event.data));socket.addEventListener('error',onError);socket.addEventListener('close',onClose);socket.accept();return socket;
    };
    const session=new PersistentVision({connect,env});
    attachVisionSocket(server,session,{limit:async()=>(await env.STREAM_FRAME_LIMITER.limit({key:actor})).success});
    return new Response(null,{status:101,webSocket:client});
  };
}
export default {fetch:createStreamHandler()};
