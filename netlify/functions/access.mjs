import {authenticated,issueSession,safeEqual,serverReady,sessionCookie,COOKIE} from '../lib/access.mjs';
const reply=(body,status=200,headers={})=>Response.json(body,{status,headers:{'Cache-Control':'no-store',...headers}});
export async function access(request,env=process.env){
  if(request.method==='GET')return reply({configured:serverReady(env),authenticated:authenticated(request,env),fixedKey:true});
  if(request.headers.get('origin')!==new URL(request.url).origin)return reply({detail:'请从本网站操作。'},403);
  if(request.method==='DELETE')return reply({configured:serverReady(env),authenticated:false,fixedKey:true},200,{'Set-Cookie':`${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`});
  if(request.method!=='POST')return reply({detail:'请求方式不支持。'},405);
  if(!serverReady(env))return reply({detail:'管理员还没有完成后台连接配置，请稍后再试。'},503);
  let body;try{const raw=await request.text();if(raw.length>512)return reply({detail:'访问码格式不正确。'},400);body=JSON.parse(raw);}catch{return reply({detail:'访问码格式不正确。'},400);}
  if(!safeEqual(body?.accessCode,env.APP_ACCESS_CODE))return reply({detail:'访问码不正确，请核对后重试。'},401);
  return reply({configured:true,authenticated:true,fixedKey:true},200,{'Set-Cookie':sessionCookie(issueSession(env))});
}
export default request=>access(request);
export const config={path:'/api/access',rateLimit:{windowLimit:10,windowSize:60,aggregateBy:['ip','domain']}};
