import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../cloudflare/worker.mjs';

const origin='https://migration.test';
const env=()=>({DASHSCOPE_API_KEY:'sk-'+'a'.repeat(30),DASHSCOPE_WORKSPACE_ID:'test-space',DASHSCOPE_REGION:'beijing',...Object.fromEntries(['ACCESS_LIMITER','VOICE_LIMITER','VISION_LIMITER'].map(name=>[name,{limit:async()=>({success:true})}]))});
const request=(path,body,extra={})=>new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.10',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});

test('all API responses retain security headers and reveal no server credentials',async()=>{
 const response=await createHandler(()=>{throw Error('Unexpected upstream');})(request('/api/access'),env());
 assert.equal(response.status,200);const data=await response.json();assert.equal(data.configured,true);assert.equal(data.authenticated,true);assert.ok(!JSON.stringify(data).includes('sk-'));
 assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-Frame-Options'),'DENY');assert.ok(response.headers.get('Permissions-Policy').includes('microphone=(self)'));assert.ok(response.headers.get('Content-Security-Policy').includes("connect-src 'self'"));
 const missing=env();delete missing.DASHSCOPE_API_KEY;
 assert.equal((await (await createHandler()(request('/api/access'),missing)).json()).configured,false);
});

test('unknown endpoints, unsupported methods and cross-site requests never invoke Qwen',async()=>{
 let calls=0;const handle=createHandler(()=>{calls++;throw Error('Unexpected');});
 for(const [req,status] of [[request('/api/unknown'),404],[request('/api/vision'),405],[request('/api/vision',{}, {Origin:'https://elsewhere.test'}),403],[new Request(origin+'/api/realtime/sdp',{method:'POST',body:'{}'}),403]]){
  assert.equal((await handle(req,env())).status,status);
 }assert.equal(calls,0);
});

test('native rate limits protect each API route independently and fail closed if not configured',async()=>{
 let calls=0;const handle=createHandler(()=>{calls++;});const config=env(),keys=[];
 config.VISION_LIMITER.limit=async value=>{keys.push(value.key);return {success:false};};
 const response=await handle(request('/api/vision',{}),config);assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'60');assert.deepEqual(keys,['/api/vision:192.0.2.10']);assert.equal(calls,0);
 assert.equal((await handle(request('/api/access'),config)).status,200);
 delete config.VISION_LIMITER;assert.equal((await handle(request('/api/vision',{}),config)).status,503);
});

test('voice handshake uses server bindings and passes the SDP reply unchanged',async()=>{
 const offer='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',answer='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=answer\r\n';
 const handle=createHandler(async(url,init)=>{
  assert.equal(init.redirect,'manual');
  assert.equal(url,'https://test-space.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.8-omni-flash-realtime');assert.equal(init.headers.Authorization,'Bearer '+env().DASHSCOPE_API_KEY);assert.equal(init.body,offer);return new Response(answer);
 });
 const response=await handle(request('/api/realtime/sdp',{sdp:offer}),env());assert.equal(response.status,200);assert.equal(await response.text(),answer);assert.equal(response.headers.get('Content-Type'),'application/sdp');
});

test('visual understanding preserves location evidence and explicit-memory candidates',async()=>{
 const image='/9j/AAAA',result={answer:'蓝色水杯在台灯旁边。',objects:[{name:'台灯',position:'书桌上'}],target_visible:true,memory_candidate:{unique:true,location_supported:true,anchor:'台灯',location:'书桌上，台灯旁边'},next_step:null};
 const handle=createHandler(async(url,init)=>{
  assert.ok(url.startsWith('https://test-space.cn-beijing.maas.aliyuncs.com/'));const payload=JSON.parse(init.body);assert.equal(payload.model,'qwen3.6-flash');assert.equal(payload.messages[1].content[0].image_url.url,'data:image/jpeg;base64,'+image);return Response.json({choices:[{message:{content:JSON.stringify(result)}}]});
 });
 const response=await handle(request('/api/vision',{image,goal:'记住水杯的位置',task:{target:'水杯',remember:true}}),env());assert.equal(response.status,200);const data=await response.json();assert.equal(data.target_visible,true);assert.equal(data.memory_candidate.location_supported,true);assert.equal(data.source,'current_camera_frame');assert.ok(!('saved' in data));
});

test('visual streaming remains a stream with delta and completion events',async()=>{
 const content='data: '+JSON.stringify({choices:[{delta:{content:'桌上有一个杯子。'}}]})+'\n\ndata: [DONE]\n\n';
 const response=await createHandler(async()=>new Response(content))(request('/api/vision',{image:'/9j/AAAA',stream:true}),env());
 assert.equal(response.status,200);assert.ok(response.headers.get('Content-Type').startsWith('text/event-stream'));const text=await response.text();assert.ok(text.includes('"type":"delta"'));assert.ok(text.includes('"type":"done"'));assert.ok(text.includes('桌上有一个杯子。'));
});

test('provider errors and invalid image bodies are reported without exposing credentials',async()=>{
 let calls=0;const handle=createHandler(async()=>{calls++;return new Response('',{status:401});});
 assert.equal((await handle(request('/api/vision',{image:'invalid'}),env())).status,400);assert.equal(calls,0);
 const response=await handle(request('/api/vision',{image:'/9j/AAAA'}),env());assert.equal(response.status,502);assert.ok(!(await response.text()).includes(env().DASHSCOPE_API_KEY));
 const oversized=new Request(origin+'/api/vision',{method:'POST',headers:{Origin:origin},body:'a'.repeat(260001)});assert.equal((await handle(oversized,env())).status,413);
});

test('Cloudflare-compatible redirects never forward credentials to another host',async()=>{
 let calls=0;
 const handle=createHandler(async(url,init)=>{calls++;assert.equal(init.redirect,'manual');assert.ok(url.startsWith('https://test-space.cn-beijing.maas.aliyuncs.com/'));return new Response(null,{status:307,headers:{Location:'https://untrusted.test/collect'}});});
 const response=await handle(request('/api/vision',{image:'/9j/AAAA'}),env());assert.equal(response.status,502);assert.equal(calls,1);assert.ok(!(await response.text()).includes(env().DASHSCOPE_API_KEY));
});
