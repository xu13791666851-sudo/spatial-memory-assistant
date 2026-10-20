const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const provider='https://maas.qianwenaiapi.com';
export function androidGateway(fetcher=fetch){return async(request,env)=>{
 const path=new URL(request.url).pathname;
 if(path==='/health')return json({app:'I SEE YOU Android test',configured:!!env.QWEN_API_KEY});
 if(request.method!=='POST')return json({detail:'请求方式不支持。'},405);
 if(!['/api/android/credential','/api/android/image'].includes(path))return json({detail:'未找到接口。'},404);
 if(!env.QWEN_API_KEY)return json({detail:'测试连接尚未配置。'},503);
 const limiter=path.endsWith('/credential')?env.VOICE_LIMITER:env.IMAGE_LIMITER;
 if(!limiter||!(await limiter.limit({key:request.headers.get('CF-Connecting-IP')||'unknown'})).success)return json({detail:'操作较频繁，请稍后再试。'},429);
 try{
  const raw=await request.text();if(raw.length>1400000)return json({detail:'画面过大。'},413);
  let body={},endpoint='/api/v1/webrtc/realtime?model=qwen3.8-omni-flash-realtime';
  if(path.endsWith('/image')){
   const supplied=JSON.parse(raw),content=supplied.messages?.[0]?.content;
   if(!Array.isArray(content)||content.length<2||content.length>3)return json({detail:'候选画面格式不正确。'},400);
   const texts=content.filter(c=>c.type==='text'),images=content.filter(c=>c.type==='image_url');
   if(texts.length!==1||typeof texts[0].text!=='string'||texts[0].text.length>4000||images.length<1||images.length>2||images.some(c=>!/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+=*$/.test(c.image_url?.url||'')))return json({detail:'候选画面格式不正确。'},400);
   body={model:'qwen3.8-omni-flash',messages:[{role:'user',content}],modalities:['text'],stream:false,enable_thinking:false,max_tokens:120};endpoint='/compatible-mode/v1/chat/completions';
  }
  const response=await fetcher(provider+endpoint,{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'okhttp/4.12.0',Authorization:'Bearer '+env.QWEN_API_KEY,...(path.endsWith('/credential')?{'x-dashscope-rtc-transport':'moq'}:{})},body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(path.endsWith('/image')?12000:15000)});
  if(!response.ok)return json({detail:'千问连接没有完成。',code:'upstream_http_'+response.status},502);
  const result=await response.json();
  if(path.endsWith('/credential')){
   if(typeof result.aoqTokenForClient!=='string'||!Array.isArray(result.clientRelayEndpoints))throw Error('credential');
   return json({aoqTokenForClient:result.aoqTokenForClient,sid:result.sid,clientRelayCertFingerprint:result.clientRelayCertFingerprint,clientRelayEndpoints:result.clientRelayEndpoints,extraInfo:{workspaceIdHash:result.extraInfo?.workspaceIdHash||''},sidExpiresInSecs:Math.min(7200,result.sidExpiresInSecs||7200)});
  }
  const answer=result.choices?.[0]?.message?.content;if(typeof answer!=='string'||answer.length>4000)throw Error('result');
  return json({choices:[{message:{content:answer}}]});
 }catch(error){return json({detail:'本次千问复核未完成，本地识别会继续。',code:['TimeoutError','AbortError'].includes(error?.name)?'provider_timeout':'provider_invalid_response'},502);}
};}
export default {fetch:androidGateway()};
