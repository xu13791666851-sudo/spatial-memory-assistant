import {access} from '../netlify/functions/access.mjs';
import {exchange} from '../netlify/functions/realtime-sdp.mjs';
import {understand} from '../netlify/functions/vision.mjs';
import {readEvents} from '../web/stream.mjs';

const security={
 'Cache-Control':'no-store',
 'X-Content-Type-Options':'nosniff',
 'Referrer-Policy':'no-referrer',
 'X-Frame-Options':'DENY',
 'Permissions-Policy':'camera=(self), microphone=(self), geolocation=()',
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; form-action 'self'"
};
const reply=(detail,status)=>Response.json({detail},{status});
const secure=response=>{
 const headers=new Headers(response.headers);
 for(const [name,value] of Object.entries(security))headers.set(name,value);
 return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
};

// The handlers receive explicit bindings; provider keys never enter the asset bundle.
export function createHandler(fetcher=fetch){
 // Workers supports manual/follow redirects, but not the Fetch "error" mode.
 // Preserve the existing no-redirect rule without forwarding provider keys.
 const upstream=async(url,init)=>{
  // Receive structured vision output incrementally as well: the upstream's
  // buffered response can fail at the edge before it sends any response bytes.
  const structured=String(url).endsWith('/compatible-mode/v1/chat/completions')&&typeof init.body==='string'&&!JSON.parse(init.body).stream;
  const body=structured?JSON.stringify({...JSON.parse(init.body),stream:true}):init.body;
  const response=await fetcher(url,{...init,body,redirect:'manual'});
  if(response.status>=300&&response.status<400){await response.body?.cancel();throw new TypeError('Provider redirect rejected');}
  if(structured&&response.ok&&response.headers.get('Content-Type')?.includes('text/event-stream')){
   let content='';
   for await(const event of readEvents(response.body)){
    if(event?.error)throw new TypeError('Provider stream failed');
    const delta=event?.choices?.[0]?.delta?.content;
    if(typeof delta==='string')content+=delta;
    if(content.length>10000){await response.body.cancel().catch(()=>{});throw new TypeError('Provider result too large');}
   }
   if(!content.trim())throw new TypeError('Empty provider result');
   return Response.json({choices:[{message:{content}}]});
  }
  return response;
 };
 return async(request,env)=>{
 const path=new URL(request.url).pathname;
 // Service-bound entry points also need the current deployment's assets.
 if(!path.startsWith('/api/')&&env.ASSETS)return secure(await env.ASSETS.fetch(request));
 const route={
  '/api/access':{methods:['GET','POST','DELETE'],limit:'ACCESS_LIMITER',run:()=>access(request,env)},
  '/api/realtime/sdp':{methods:['POST'],limit:'VOICE_LIMITER',run:()=>exchange(request,upstream,env)},
  '/api/vision':{methods:['POST'],limit:'VISION_LIMITER',run:()=>understand(request,upstream,env)}
 }[path];
 if(!route)return secure(reply('没有找到这个接口。',404));
 if(!route.methods.includes(request.method))return secure(reply('请求方式不支持。',405));
 if(request.method!=='GET'&&request.headers.get('origin')!==new URL(request.url).origin)return secure(reply('请从本网站操作。',403));
 try{
  const limiter=env[route.limit];
  if(!limiter)return secure(reply('后台请求保护尚未配置。',503));
  const actor=request.headers.get('CF-Connecting-IP')||'unknown';
  const {success}=await limiter.limit({key:path+':'+actor});
  if(!success){const result=secure(reply('操作有些频繁，请稍后再试。',429));result.headers.set('Retry-After','60');return result;}
  return secure(await route.run());
 }catch{return secure(reply('服务暂时没有完成请求，请稍后再试。',502));}
};}

const handle=createHandler();
export default {fetch:handle};
