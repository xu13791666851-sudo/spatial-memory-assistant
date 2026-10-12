const MODEL = 'qwen3.8-omni-flash-realtime';
const json = (message, status) => Response.json({detail: message}, {status, headers:{'Cache-Control':'no-store'}});

export async function exchange(request, fetcher=fetch) {
  if(request.method!=='POST')return json('请求方式不支持。',405);
  if(request.headers.get('origin')!==new URL(request.url).origin)return json('请从本网站发起连接。',403);
  let body;
  try{
    const raw=await request.text();
    if(raw.length>180000)return json('连接数据过大。',413);
    body=JSON.parse(raw);
  }catch{return json('连接配置格式不正确。',400);}
  const {key,workspace,region,sdp}=body||{};
  if(typeof key!=='string'||!/^sk-[\x21-\x7e]{17,509}$/.test(key)||typeof workspace!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(workspace)||!['beijing','singapore'].includes(region))return json('请检查密钥、业务空间 ID 和地域。',400);
  if(typeof sdp!=='string'||sdp.length>160000||!sdp.startsWith('v=0')||!sdp.includes('m=audio '))return json('浏览器未准备好语音连接。',400);
  const host=region==='beijing'?'cn-beijing':'ap-southeast-1';
  try{
    const response=await fetcher(`https://${workspace}.${host}.maas.aliyuncs.com/api/v1/webrtc/realtime?model=${MODEL}`,{
      method:'POST',headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/sdp'},body:sdp,
      redirect:'error',signal:AbortSignal.timeout(22000)
    });
    if(!response.ok){
      let code='';try{code=(await response.json()).code;}catch{}
      if(code==='BadRequest.IllegalEndpoint')return json('业务空间地址无效，请核对业务空间 ID 和地域。',400);
      if(response.status===401)return json('千问认证未通过，请检查密钥、业务空间和地域。',401);
      if(response.status===403)return json('千问拒绝连接，请检查模型权限或密钥访问限制。',403);
      return json(`千问暂未完成连接（HTTP ${response.status}）。请稍后重试。`,502);
    }
    const answer=await response.text();
    if(answer.length>160000||!answer.trimStart().startsWith('v=0'))return json('千问返回的连接数据无效。',502);
    return new Response(answer,{headers:{'Content-Type':'application/sdp','Cache-Control':'no-store'}});
  }catch{return json('连接千问超时或网络未通，请稍后重试。',502);}
}
export default request=>exchange(request);
export const config={path:'/api/realtime/sdp',method:'POST'};
