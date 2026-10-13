import {createHmac,timingSafeEqual} from 'node:crypto';
export const COOKIE='spatial_access';
export const DAYS=30;
export const serverReady=env=>!!(env.DASHSCOPE_API_KEY&&env.DASHSCOPE_WORKSPACE_ID&&env.APP_ACCESS_CODE&&env.APP_ACCESS_CODE.length>=8);
const signingKey=env=>`${env.DASHSCOPE_API_KEY}\n${env.APP_ACCESS_CODE}`;
const signature=(value,env)=>createHmac('sha256',signingKey(env)).update(value).digest('base64url');
export function safeEqual(a,b){
  if(typeof a!=='string'||typeof b!=='string')return false;
  const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);
}
export function issueSession(env,now=Date.now()){
  const expires=String(Math.floor(now/1000)+DAYS*86400);return `${expires}.${signature(expires,env)}`;
}
export function authenticated(request,env,now=Date.now()){
  if(!serverReady(env))return false;
  const value=(request.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';
  const match=value.match(/^([0-9]{10})\.([A-Za-z0-9_-]{43})$/);
  if(!match||Number(match[1])<=Math.floor(now/1000)||Number(match[1])>Math.floor(now/1000)+DAYS*86400)return false;
  return safeEqual(match[2],signature(match[1],env));
}
export function sessionCookie(token){return `${COOKIE}=${token}; Path=/; Max-Age=${DAYS*86400}; HttpOnly; Secure; SameSite=Strict`;}
