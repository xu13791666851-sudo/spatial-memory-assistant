import {freshSdp} from '../lib/fresh-sdp.mjs';
const MODEL = 'qwen3.8-omni-flash-realtime';
const json = (message, status, extra={}) => Response.json({detail: message,...extra}, {status, headers:{'Cache-Control':'no-store'}});
const codes=new Set(['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID']);
export function connectionFailure(error){
  const found=[];
  const visit=(e,depth=0)=>{if(!e||depth>3)return;if(codes.has(e.code))found.push(e.code);visit(e.cause,depth+1);if(Array.isArray(e.errors))e.errors.slice(0,5).forEach(x=>visit(x,depth+1));};
  visit(error);
  if(found.some(x=>['ENOTFOUND','EAI_AGAIN'].includes(x)))return 'UPSTREAM_DNS';
  if(found.some(x=>['CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID'].includes(x)))return 'UPSTREAM_TLS';
  if(found.some(x=>['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','ETIMEDOUT'].includes(x))||['TimeoutError','AbortError'].includes(error?.name))return 'UPSTREAM_TIMEOUT';
  if(found.length||error?.name==='TypeError')return 'UPSTREAM_NETWORK';
  return 'UPSTREAM_UNKNOWN';
}

export async function exchange(request, fetcher=freshSdp, env=process.env) {
  if(request.method!=='POST')return json('请求方式不支持。',405);
  if(request.headers.get('origin')!==new URL(request.url).origin)return json('请从本网站发起连接。',403);
  if(!serverReady(env))return json('管理员还没有完成后台连接配置，请稍后再试。',503);
  let body;
  try{
    const raw=await request.text();
    if(raw.length>180000)return json('连接数据过大。',413);
    body=JSON.parse(raw);
  }catch{return json('连接配置格式不正确。',400);}
  const {sdp}=body||{};
  const key=env.DASHSCOPE_API_KEY,workspace=env.DASHSCOPE_WORKSPACE_ID,region=env.DASHSCOPE_REGION||'beijing';
  if(typeof key!=='string'||!/^sk-[\x21-\x7e]{17,509}$/.test(key)||typeof workspace!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(workspace)||!['beijing','singapore'].includes(region))return json('请检查密钥、业务空间 ID 和地域。',400);
  if(typeof sdp!=='string'||sdp.length>160000||!sdp.startsWith('v=0')||!sdp.includes('m=audio '))return json('浏览器未准备好语音连接。',400);
  const host=region==='beijing'?'cn-beijing':'ap-southeast-1';
  try{
    let response,attempts=0;
    for(let attempt=1;attempt<=2;attempt++){
      attempts=attempt;
      if(request.signal.aborted)return json('本次连接已取消。',499,{error_code:'CLIENT_CANCELLED'});
      try{
        response=await fetcher(`https://${workspace}.${host}.maas.aliyuncs.com/api/v1/webrtc/realtime?model=${MODEL}`,{
          method:'POST',headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/sdp'},body:sdp,
          redirect:'error',signal:AbortSignal.any([request.signal,AbortSignal.timeout(12000)])
        });break;
      }catch(error){
        if(request.signal.aborted)return json('本次连接已取消。',499,{error_code:'CLIENT_CANCELLED'});
        const code=connectionFailure(error);
        const phase=['dns','tcp','tls','response','body'].includes(error?.connectionPhase)?error.connectionPhase:'unknown';
        const transportCode=codes.has(error?.cause?.code)?error.cause.code:codes.has(error?.code)?error.code:'UNSPECIFIED';
        console.error('realtime_connection_failure',JSON.stringify({code,phase,transportCode,attempt}));
        if(attempt===1&&['UPSTREAM_TIMEOUT','UPSTREAM_NETWORK','UPSTREAM_DNS'].includes(code))continue;
        const detail=code==='UPSTREAM_DNS'?'网站后台暂时无法解析千问服务地址，重试后仍未连上。':code==='UPSTREAM_TLS'?'网站后台与千问的安全连接失败，请联系管理员排查。':code==='UPSTREAM_TIMEOUT'?'网站后台连接千问超时，自动重试后仍未连上，请稍后再试。':'网站后台到千问的连接中断，请稍后再试。';
        return json(detail,502,{error_code:code,phase,attempts:attempt});
      }
    }
    if(!response.ok){
      let code='';try{code=(await response.json()).code;}catch{}
      if(code==='BadRequest.IllegalEndpoint')return json('业务空间地址无效，请核对业务空间 ID 和地域。',400);
      if(response.status===401)return json('千问认证未通过，请检查密钥、业务空间和地域。',401);
      if(response.status===403)return json('千问拒绝连接，请检查模型权限或密钥访问限制。',403);
      if(response.status===429)return json('千问当前请求较多，请稍后再试。',429,{error_code:'UPSTREAM_BUSY'});
      return json(`千问暂未完成连接（HTTP ${response.status}）。请稍后重试。`,502);
    }
    const answer=await response.text();
    if(answer.length>160000||!answer.trimStart().startsWith('v=0'))return json('千问返回的连接数据无效。',502);
    return new Response(answer,{headers:{'Content-Type':'application/sdp','Cache-Control':'no-store','X-Realtime-Transport':'fresh-ipv4','X-Realtime-Attempts':String(attempts)}});
  }catch{console.error('realtime_answer_unreadable');return json('千问已响应，但连接信息未能完整读取，请重新开始。',502,{error_code:'UPSTREAM_RESPONSE'});}
}
export default request=>exchange(request);
export const config={path:'/api/realtime/sdp',method:'POST',rateLimit:{windowLimit:12,windowSize:60,aggregateBy:['ip','domain']}};
import {serverReady} from '../lib/access.mjs';
