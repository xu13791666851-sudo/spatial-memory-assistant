import {serverReady} from '../lib/access.mjs';
const reply=(body,status=200,headers={})=>Response.json(body,{status,headers:{'Cache-Control':'no-store',...headers}});
export async function access(request,env=process.env){
  const configured=serverReady(env);
  const status={configured,authenticated:configured,fixedKey:true,publicAccess:true};
  if(request.method==='GET')return reply(status);
  if(request.headers.get('origin')!==new URL(request.url).origin)return reply({detail:'请从本网站操作。'},403);
  // Accept old clients without requiring a password; clear any obsolete login cookie.
  if(request.method==='DELETE')return reply(status,200,{'Set-Cookie':'spatial_access=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict'});
  if(request.method!=='POST')return reply({detail:'请求方式不支持。'},405);
  if(!configured)return reply({detail:'管理员还没有完成后台连接配置，请稍后再试。'},503);
  return reply(status);
}
export default request=>access(request);
export const config={path:'/api/access',rateLimit:{windowLimit:10,windowSize:60,aggregateBy:['ip','domain']}};
