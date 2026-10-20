import test from 'node:test';
import assert from 'node:assert/strict';
import {PersistentVision} from '../netlify/lib/persistent-vision.mjs';
import {parseFrame,attachVisionSocket,createStreamHandler} from '../cloudflare/vision-stream.mjs';
import {VisionStream} from '../web/vision-stream.mjs';
const env={DASHSCOPE_API_KEY:'sk-test-fixture',DASHSCOPE_REGION:'beijing'};
const frame={type:'observe',request_id:'frame-12345',image:'/9j/AAAA',goal:'找水杯',task:{target:'水杯',remember:false,reference_appearance:'绿色带把手'}};
const evidence={frame_status:'clear',answer:'绿色水杯在木桌左侧。',objects:[{name:'木桌',position:'下方'}],target_visible:true,appearance_match:{status:'match',unique:true,reason:'绿色杯身和把手一致'}};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function provider({holdDelete=false,holdResponse=false,wrongId=false,noImage=false}={}){
  let hooks,id,n=0,connections=0,closed=0,finish;const sent=[],deleted=[];
  const emit=event=>queueMicrotask(()=>hooks.onMessage(JSON.stringify(event)));
  const connect=(url,options)=>{connections++;hooks=options;setTimeout(()=>emit({type:'session.created'}),0);return {close(){closed++;},send(raw){const event=JSON.parse(raw);sent.push(event);
    if(event.type==='session.update'){id=JSON.parse(event.session.instructions.split('请求数据：')[1]).observation_id;n++;emit({type:'session.updated'});}
    if(event.type==='input_audio_buffer.clear')emit({type:'input_audio_buffer.cleared'});
    if(event.type==='input_audio_buffer.commit')emit({type:'input_audio_buffer.committed',item_id:'input-'+n});
    if(event.type==='response.create'){emit({type:'response.created',response:{id:'response-'+n}});finish=()=>emit({type:'response.done',response:{id:'response-'+n,status:'completed',usage:{input_tokens_details:noImage?{}:{video_tokens:500}},output:[{id:'output-'+n,type:'function_call',name:'report_observation',arguments:JSON.stringify({...evidence,observation_id:wrongId?'old':id})}]}});if(!holdResponse)finish();}
    if(event.type==='conversation.item.delete'){deleted.push(event.item_id);if(!holdDelete)emit({type:'conversation.item.deleted',item_id:event.item_id});}
  }};};
  return {connect,sent,deleted,emit,finish:()=>finish(),connections:()=>connections,closed:()=>closed};
}
test('persistent provider reuses one socket and deletes all input/output items before delivering each result',async()=>{
  const fake=provider(),session=new PersistentVision({connect:fake.connect,env});
  try{for(let n=1;n<=3;n++){const result=await session.observe({...frame,image:'/9j/AAAA'+n});assert.equal(result.target_visible,true);assert.equal(session.current,null);assert.deepEqual(fake.deleted.slice(-2),['input-'+n,'output-'+n]);}assert.equal(fake.connections(),1);assert.equal(fake.closed(),0);assert.equal(fake.sent.filter(e=>e.type==='input_image_buffer.append').length,3);}finally{session.close();}assert.equal(fake.closed(),1);
});
test('cleanup acknowledgement is a required barrier, and concurrent frames are rejected',async()=>{
  const fake=provider({holdDelete:true}),session=new PersistentVision({connect:fake.connect,env});let resolved=false;
  try{const pending=session.observe(frame).then(r=>{resolved=true;return r;});await session.ready;await settle();assert.equal(resolved,false);await assert.rejects(session.observe(frame),/busy/);
    fake.emit({type:'conversation.item.deleted',item_id:'wrong-item'});await settle();assert.equal(resolved,false);
    for(const item_id of fake.deleted)fake.emit({type:'conversation.item.deleted',item_id});await pending;assert.equal(resolved,true);
  }finally{session.close();}
});
test('missing cleanup, wrong frame identity and missing image usage close the provider without publishing',async()=>{
  for(const options of [{holdDelete:true},{wrongId:true},{noImage:true}]){const fake=provider(options),session=new PersistentVision({connect:fake.connect,env,timeoutMs:30});await assert.rejects(session.observe(frame),/observation_/);assert.equal(fake.closed(),1);assert.equal(session.closed,true);}
});
test('abort closes the provider; a late response never resolves the old request',async()=>{
  const fake=provider({holdResponse:true}),session=new PersistentVision({connect:fake.connect,env}),controller=new AbortController();
  const pending=session.observe({...frame,signal:controller.signal});const check=assert.rejects(pending,/cancelled/);await session.ready;await settle();controller.abort();await check;fake.finish();await settle();assert.equal(session.current,null);assert.equal(fake.closed(),1);
});
test('stream boundary strips extra data, rejects writes and malformed images',()=>{
  const parsed=parseFrame(JSON.stringify({...frame,key:'not-forwarded',task:{...frame.task,location:'private home'}}));assert.equal(parsed.key,undefined);assert.equal(parsed.task.location,undefined);
  for(const bad of [{...frame,task:{...frame.task,remember:true}},{...frame,image:'x'},{...frame,request_id:'short'},{...frame,task:{...frame.task,reference_appearance:'x'.repeat(151)}},{type:'session.update'}])assert.throws(()=>parseFrame(JSON.stringify(bad)));
});
class Socket{
  constructor(){this.listeners={};this.sent=[];this.closed=false;}
  addEventListener(type,fn){this.listeners[type]=fn;}
  send(raw){this.sent.push(JSON.parse(raw));}
  close(){this.closed=true;}
  message(value){return this.listeners.message({data:JSON.stringify(value)});}
}
test('gateway enforces origin, upgrade and unavailable configuration before connecting to model',async()=>{
  const handler=createStreamHandler(()=>assert.fail('must not connect'));
  for(const [headers,status]of [[{},426],[{Upgrade:'websocket',Origin:'https://evil.test'},403],[{Upgrade:'websocket',Origin:'https://allowed.test'},503]])assert.equal((await handler(new Request('https://gateway.test/api/vision-stream',{headers}),{ALLOWED_ORIGIN:'https://allowed.test'})).status,status);
});
test('gateway binds the target, limits requests and closes upstream on disconnect',async()=>{
  let count=0,closed=0,now=0;const socket=new Socket(),session={ready:Promise.resolve(),observe:async()=>{count++;return evidence;},close:()=>closed++};
  attachVisionSocket(socket,session,{clock:()=>now,limit:async()=>true});await settle();assert.equal(socket.sent[0].type,'ready');await socket.message(frame);assert.equal(count,1);
  now=2000;await socket.message({...frame,request_id:'frame-23456',task:{...frame.task,target:'钥匙'}});assert.equal(count,1);assert.equal(socket.closed,true);assert.equal(closed,1);
});
test('gateway drops in-flight late results after disconnect and never queues a second request',async()=>{
  let resolve,closed=0;const socket=new Socket(),session={ready:Promise.resolve(),observe:()=>new Promise(r=>resolve=r),close:()=>closed++};
  attachVisionSocket(socket,session,{limit:async()=>true});const first=socket.message(frame);await settle();await socket.message({...frame,request_id:'frame-23456'});resolve(evidence);await first;assert.equal(closed,1);assert.ok(!socket.sent.some(e=>e.type==='observation'));
});
test('gateway rate limit, duplicate identifiers and session deadline stop requests',async()=>{
  for(const denied of [true,false]){const socket=new Socket(),session={ready:Promise.resolve(),observe:async()=>evidence,close(){}};attachVisionSocket(socket,session,{limit:async()=>!denied,clock:()=>5000});await socket.message(frame);if(!denied)await socket.message(frame);assert.equal(socket.closed,true);}
  const socket=new Socket();attachVisionSocket(socket,{ready:Promise.resolve(),close(){}},{limit:async()=>true,ttlMs:5});await new Promise(r=>setTimeout(r,10));assert.equal(socket.closed,true);
});
test('browser stream keeps one connection, correlates results and closes on abort',async()=>{
  let created=0,socket;
  class BrowserSocket{constructor(){created++;socket=this;queueMicrotask(()=>this.onmessage({data:JSON.stringify({type:'ready',protocol:1})}));}send(raw){this.last=JSON.parse(raw);}close(){this.closed=true;}result(id){this.onmessage({data:JSON.stringify({type:'observation',request_id:id,...evidence})});}}
  const stream=new VisionStream({url:'wss://gateway.test/api/vision-stream',WebSocket:BrowserSocket});
  await stream.open();const a=stream.observe(frame);await settle();socket.result(frame.request_id);await a;const controller=new AbortController(),b=stream.observe({...frame,request_id:'frame-23456'},controller.signal),check=assert.rejects(b,/cancelled/);await settle();controller.abort();await check;assert.equal(created,1);assert.equal(socket.closed,true);
});
test('browser stream rejects an old result instead of pairing it with a new frame',async()=>{
  let socket;class BrowserSocket{constructor(){socket=this;queueMicrotask(()=>this.onmessage({data:JSON.stringify({type:'ready',protocol:1})}));}send(){}close(){this.closed=true;}}
  const stream=new VisionStream({url:'wss://gateway.test',WebSocket:BrowserSocket}),pending=stream.observe(frame),check=assert.rejects(pending,/中断/);await stream.open();await settle();socket.onmessage({data:JSON.stringify({type:'observation',request_id:'old-frame'})});await check;assert.equal(socket.closed,true);
});

test('browser distinguishes connection readiness timeout from frame timeout and closes permanently',async()=>{
  let socket;class BrowserSocket{constructor(){socket=this;}send(){}close(){this.closed=true;}}
  const cold=new VisionStream({url:'wss://gateway.test',WebSocket:BrowserSocket,openTimeoutMs:10});
  await assert.rejects(cold.open(),e=>e.code==='gateway_connect_timeout'&&e.retryable);assert.equal(socket.closed,true);
  await assert.rejects(cold.open(),e=>e.code==='gateway_connect_timeout'&&e.retryable);
  const model=new VisionStream({url:'wss://gateway.test',WebSocket:BrowserSocket,openTimeoutMs:10});const waiting=model.open();socket.onopen();
  await assert.rejects(waiting,e=>e.code==='model_ready_timeout'&&e.retryable);
  const ready=new VisionStream({url:'wss://gateway.test',WebSocket:BrowserSocket,timeoutMs:10});const opening=ready.open();socket.onmessage({data:JSON.stringify({type:'ready',protocol:1})});await opening;
  await assert.rejects(ready.observe(frame),e=>e.code==='frame_timeout'&&e.retryable);
});
test('gateway rate-limit code reaches browser as a non-retryable error',async()=>{
  const server=new Socket();attachVisionSocket(server,{ready:Promise.resolve(),close(){}},{limit:async()=>false});await server.message(frame);assert.equal(server.sent.at(-1).code,'rate_limited');
  let socket;class BrowserSocket{constructor(){socket=this;}close(){}}
  const stream=new VisionStream({url:'wss://gateway.test',WebSocket:BrowserSocket});const opening=stream.open();socket.onmessage({data:JSON.stringify(server.sent.at(-1))});await assert.rejects(opening,e=>e.code==='rate_limited'&&!e.retryable);
});
test('disconnect between frames remains retryable on the next observation',async()=>{
  let socket;class BrowserSocket{constructor(){socket=this;}send(){}close(){}}
  const stream=new VisionStream({url:'wss://gateway.test',WebSocket:BrowserSocket});const opening=stream.open();
  socket.onmessage({data:JSON.stringify({type:'ready',protocol:1})});await opening;socket.onclose();
  await assert.rejects(stream.observe(frame),e=>e.code==='network_error'&&e.retryable);
});
