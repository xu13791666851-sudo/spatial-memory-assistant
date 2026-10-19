import {access} from '../netlify/functions/access.mjs';
import {exchange} from '../netlify/functions/realtime-sdp.mjs';
import {understand} from '../netlify/functions/vision.mjs';

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
  const response=await fetcher(url,{...init,redirect:'manual'});
  if(response.status>=300&&response.status<400){await response.body?.cancel();throw new TypeError('Provider redirect rejected');}
  return response;
 };
 return async(request,env)=>{
 const path=new URL(request.url).pathname;
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
