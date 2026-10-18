import test from 'node:test';
import assert from 'node:assert/strict';
import {Memory,rememberCommand} from '../web/memory.mjs';
import {MemoryCompanion} from '../web/companion.mjs';
import {SessionContext,placeIntent} from '../web/context.mjs';
import {createRuntime,sessionConfig} from '../web/runtime.mjs';
import {exchange} from '../netlify/functions/realtime-sdp.mjs';
import {access} from '../netlify/functions/access.mjs';
import {serverReady} from '../netlify/lib/access.mjs';
import {ObservationGate,observationCommand,asksHistory,currentViewIntent} from '../web/interaction.mjs';
import {ForegroundWake,wakeText} from '../web/wake.mjs';
import {understand} from '../netlify/functions/vision.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {readEvents} from '../web/stream.mjs';
import {SceneSpeech} from '../web/scene-speech.mjs';

const storage=()=>{const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),map};};
const key='sk-offline-test-only-xxxxxxxxxxxxxxxx';
const request=(body,origin='https://example.netlify.app')=>new Request('https://example.netlify.app/api/realtime/sdp',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
const config={key,workspace:'ws-test-fixture',region:'beijing',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'};
const serverEnv={DASHSCOPE_API_KEY:key,DASHSCOPE_WORKSPACE_ID:config.workspace,APP_ACCESS_CODE:'fixture-access-code'};

test('memory is pending until confirmation and survives a new instance',()=>{
  const data=storage(),m=new Memory(data,()=>1000000,()=>String(Math.random()));
  m.prepare({action:'record',name:'钥匙',location:'玄关桌上',event_time:'昨天'});
  assert.equal(m.get('钥匙'),null);
  m.confirm(m.pending.token);
  const next=new Memory(data);
  assert.equal(next.get('钥匙').location,'玄关桌上');
  assert.equal(next.get('钥匙').place,'home');
  assert.match(next.answer('钥匙'),/还没有确认现在的位置/);
});
test('explicit remember command saves immediately, replaces the latest location and survives reload',()=>{
  const data=storage(),m=new Memory(data);
  assert.equal(rememberCommand('钥匙放在玄关桌上'),null);
  assert.equal(rememberCommand('我说记住，钥匙放在玄关桌上'),null);
  const first=m.command('记住，钥匙放在玄关桌上。');
  assert.equal(first.saved,true);assert.equal(first.pending,null);
  assert.equal(new Memory(data).get('钥匙').location,'玄关桌上');
  m.command('小忆，记住，钥匙放在抽屉里');
  assert.equal(new Memory(data).get('钥匙').location,'抽屉里');
  assert.equal(new Memory(data).all().length,1);
});
test('failed direct save never reports success',()=>{
  const m=new Memory({getItem:()=>null,setItem:()=>{throw Error('quota');}});
  assert.throws(()=>m.command('记住，钥匙放在玄关桌上'));
  assert.equal(m.get('钥匙'),null);
});
test('failed storage is not reported as saved and retains confirmation',()=>{
  const m=new Memory({getItem:()=>null,setItem:()=>{throw Error('quota');}});
  m.prepare({action:'record',name:'钥匙',location:'桌上'});
  assert.throws(()=>m.confirm(m.pending.token));assert.ok(m.pending);assert.equal(m.get('钥匙'),null);
});
test('correction preserves placement time and deletion requires confirmation',()=>{
  const m=new Memory(storage());m.prepare({action:'record',name:'钥匙',location:'桌上',event_time:'昨天'});m.confirm(m.pending.token);
  m.prepare({action:'correct',name:'钥匙',location:'抽屉',event_time:'今天'});m.confirm(m.pending.token);
  assert.equal(m.get('钥匙').event_time,'昨天');
  m.prepare({action:'delete',name:'钥匙'});assert.ok(m.get('钥匙'));m.confirm(m.pending.token);assert.equal(m.get('钥匙'),null);
});
test('expired confirmation and invalid actions cannot mutate records',()=>{
  let now=0;const m=new Memory(storage(),()=>now);
  m.prepare({action:'record',name:'钥匙',location:'桌上'});const token=m.pending.token;now=300001;
  assert.throws(()=>m.confirm(token));assert.equal(m.get('钥匙'),null);assert.throws(()=>m.prepare({action:'invent',name:'钥匙',location:'桌上'}));
});
test('legacy browser records remain available as home memories',()=>{
  const data=storage();data.setItem('spatial-memory.records.v1',JSON.stringify([{name:'钥匙',location:'玄关桌上',event_time:'昨天',recorded_at:'2026-10-13T08:00:00.000Z',source:'MANUAL',state:'HISTORICAL'}]));
  assert.equal(new Memory(data).get('钥匙').location,'玄关桌上');
});
test('session context resolves a follow-up target and clears it when the place changes',()=>{
  const context=new SessionContext();context.note('帮我找水杯');
  assert.equal(context.resolve('它旁边有什么？'),'水杯旁边有什么？');
  context.setPlace('home');assert.equal(context.focus,'');assert.equal(context.resolve('它旁边有什么？'),'它旁边有什么？');
  assert.equal(placeIntent('小忆，我在家了'),'home');
  assert.equal(placeIntent('小忆，我到家了'),'home');
  assert.equal(placeIntent('我出门了'),'explore');
});
test('SDP exchange permits only same-origin and validated Alibaba workspace targets',async()=>{
  let calls=0;const noFetch=async()=>{calls++;throw Error('unexpected network');};
  assert.equal((await exchange(request(config,'https://evil.example'),noFetch,serverEnv)).status,403);
  assert.equal((await exchange(request({...config,sdp:'not an offer'}),noFetch,serverEnv)).status,400);
  assert.equal(calls,0);
});
test('SDP success forwards credentials only to fixed endpoint and returns no key',async()=>{
  const response=await exchange(request({...config,key:'ignored',workspace:'evil.example/attack'}),async(url,options)=>{
    assert.equal(url,'https://ws-test-fixture.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.8-omni-flash-realtime');
    assert.equal(options.headers.Authorization,'Bearer '+key);assert.equal(options.redirect,'error');
    return new Response('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n');
  },serverEnv);
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(!(await response.text()).includes(key));
});
test('upstream auth errors and exceptions never echo secrets',async()=>{
  for(const factory of [async()=>Response.json({code:'InvalidApiKey',message:key},{status:401}),async()=>{throw Error(key);}]){
    const response=await exchange(request(config),factory,serverEnv);assert.ok(response.status>=400);assert.ok(!(await response.text()).includes(key));
  }
});
function runtimeFixture(options={}){
  const data=storage(),audio={muted:false,pause(){},hidden:true},preview={srcObject:null};
  const document={getElementById:id=>id==='remote-audio'?audio:id==='preview'?preview:{checked:false}};
  const fetcher=async(url,options={})=>{
    if(url==='/api/vision')return Response.json({answer:'测试桌面有电脑、水杯和眼镜。水杯在电脑左侧。',objects:[{name:'水杯',position:'电脑左侧'}],source:'current_camera_frame'});
    assert.equal(url,'/api/access');
    assert.equal(options.body,undefined);
    return Response.json({configured:true,authenticated:true,fixedKey:true,publicAccess:true});
  };
  const runtime=createRuntime({storage:data,document,fetch:fetcher,RTCPeerConnection:class{},...options});
  return {runtime,data,preview,audio,document};
}
test('a fresh browser is ready without a login or persisted credentials',async()=>{
  const {runtime,data}=runtimeFixture();await runtime.loaded;
  assert.equal(runtime.status().configured,true);
  assert.equal((await runtime.api('/api/config')).configured,true);
  const saved=JSON.stringify([...data.map]);assert.ok(!saved.includes(key));assert.ok(!saved.includes(serverEnv.APP_ACCESS_CODE));
});

test('Qwen replay cancels an active response and queues only the supplied text',()=>{
  const {runtime}=runtimeFixture();const bridge=new runtime.Bridge();bridge.mode='assistant';bridge.active=true;
  const sent=[];bridge.channel={readyState:'open',send:e=>sent.push(JSON.parse(e))};
  let aborted=false;bridge.sceneCommit={controller:{abort(){aborted=true;}}};
  assert.equal(bridge.replayAnswer('水杯在电脑左侧。'),true);
  assert.equal(aborted,true);assert.equal(bridge.sceneCommit,null);
  assert.ok(sent.some(e=>e.type==='response.cancel'));
  assert.ok(!sent.some(e=>e.type==='response.create'));
  bridge.event({type:'response.done',response:{status:'cancelled'}},bridge.channel);
  const message=sent.find(e=>e.type==='conversation.item.create').item.content[0].text;
  assert.match(message,/水杯在电脑左侧/);assert.match(message,/不调用工具/);
  assert.ok(sent.some(e=>e.type==='response.create'));
  bridge.paused=true;assert.equal(bridge.replayAnswer('不应播报'),false);bridge.close();
});
test('public status never exposes backend key, workspace or access code',async()=>{
  const response=await access(new Request('https://example.netlify.app/api/access'),serverEnv);
  const text=await response.text();assert.ok(!text.includes(key));assert.ok(!text.includes(serverEnv.APP_ACCESS_CODE));assert.ok(!text.includes(config.workspace));
});
test('public access works without a code or cookie and ignores a legacy code',async()=>{
  for(const env of [serverEnv,{DASHSCOPE_API_KEY:key,DASHSCOPE_WORKSPACE_ID:config.workspace}]){
    assert.equal(serverReady(env),true);
    const response=await access(new Request('https://example.netlify.app/api/access'),env);
    assert.deepEqual(await response.json(),{configured:true,authenticated:true,fixedKey:true,publicAccess:true});
    assert.equal(response.headers.get('set-cookie'),null);
    const legacy=await access(new Request('https://example.netlify.app/api/access',{method:'POST',headers:{Origin:'https://example.netlify.app'},body:JSON.stringify({accessCode:'wrong-old-code'})}),env);
    assert.equal(legacy.status,200);assert.equal((await legacy.json()).authenticated,true);
  }
});
test('missing provider configuration never calls the model even with a client key',async()=>{
  for(const env of [{},{DASHSCOPE_API_KEY:key},{DASHSCOPE_WORKSPACE_ID:config.workspace}]){
    let network=0;const unused=async()=>{network++;};
    assert.equal((await exchange(request(config),unused,env)).status,503);
    assert.equal((await understand(visionRequest({image:jpeg}),unused,env)).status,503);
    const status=await (await access(new Request('https://example.netlify.app/api/access'),env)).json();
    assert.equal(status.configured,false);assert.equal(status.authenticated,false);assert.equal(network,0);
  }
});

test('access status retains origin checks and can remove obsolete cookies',async()=>{
  const url='https://example.netlify.app/api/access';
  assert.equal((await access(new Request(url,{method:'POST',headers:{Origin:'https://evil.example'}}),serverEnv)).status,403);
  const result=await access(new Request(url,{method:'DELETE',headers:{Origin:'https://example.netlify.app'}}),serverEnv);
  assert.match(result.headers.get('set-cookie'),/Max-Age=0/);assert.equal((await result.json()).authenticated,true);
});
test('tool writes are denied in video sessions and never auto-save in memory sessions',()=>{
  for(const mode of ['video','memory']){
    const {runtime}=runtimeFixture();const bridge=new runtime.Bridge();bridge.mode=mode;
    const sent=[];bridge.channel={readyState:'open',send:e=>sent.push(JSON.parse(e))};
    const event={type:'response.done',response:{output:[{type:'function_call',call_id:'one',name:'prepare_memory',arguments:JSON.stringify({action:'record',name:'钥匙',location:'桌上'})}]}};
    bridge.event(event,bridge.channel);bridge.event(event,bridge.channel);
    assert.equal(runtime.memory.get('钥匙'),null);
    assert.equal(!!runtime.memory.pending,mode==='memory');
    assert.equal(sent.filter(e=>e.type==='conversation.item.create').length,1);bridge.close();
  }
});
test('late microphone attachment is stopped after cancellation',async()=>{
  const {runtime}=runtimeFixture();const bridge=new runtime.Bridge();bridge.close();
  let stopped=false;await assert.rejects(()=>bridge.attachAudio({getTracks:()=>[{stop(){stopped=true;}}]}));assert.equal(stopped,true);
});

test('microphone attachment verifies outgoing audio',async()=>{
  const {runtime}=runtimeFixture();const bridge=new runtime.Bridge();bridge.configured=true;
  const track={readyState:'live'};let attached=false,reads=0;
  bridge.audioSender={replaceTrack:async()=>{attached=true;},getStats:async()=>{reads++;return new Map([['audio',{type:'outbound-rtp',kind:'audio',bytesSent:attached?100:0}]]);}};
  await bridge.attachAudio({getAudioTracks:()=>[track],getTracks:()=>[track]});
  assert.equal(attached,true);assert.ok(reads>=2);bridge.close();
});
test('observation uses local preview without cloning or transmitting a video track',async()=>{
  const {runtime,preview}=runtimeFixture();const bridge=new runtime.Bridge();bridge.mode='video';bridge.configured=true;
  let sourceStopped=false;
  const source={readyState:'live',stop(){sourceStopped=true;},clone:()=>assert.fail('must not encode a duplicate video stream')};
  preview.srcObject={getVideoTracks:()=>[source]};
  bridge.videoSender={replaceTrack:async()=>assert.fail('must not upload continuous video')};
  await bridge.attachVideo();assert.equal(bridge.previewTrack,source);
  bridge.clearVideoTrack();assert.equal(bridge.previewTrack,null);assert.equal(sourceStopped,false);bridge.close();
});
test('session tools keep visual and memory permissions separate',()=>{
  assert.deepEqual(sessionConfig('video').session.tools.map(t=>t.function.name),['stop_video','request_observation']);
  assert.ok(!sessionConfig('memory').session.tools.some(t=>t.function.name==='stop_video'));
});

test('combined session can observe and remember, with explicit confirmation before saving',()=>{
  assert.deepEqual(sessionConfig('assistant').session.tools.map(t=>t.function.name),['stop_video','query_memory','list_memories','prepare_memory','request_observation']);
  const {runtime}=runtimeFixture();runtime.setPlace('home');const bridge=new runtime.Bridge();bridge.mode='assistant';
  const sent=[];bridge.channel={readyState:'open',send:e=>sent.push(JSON.parse(e))};
  const call=(name,args,id)=>bridge.event({type:'response.done',response:{output:[{type:'function_call',call_id:id,name,arguments:JSON.stringify(args)}]}},bridge.channel);
  call('prepare_memory',{action:'record',name:'钥匙',location:'抽屉里'},'record');
  assert.equal(runtime.memory.get('钥匙'),null);assert.ok(runtime.memory.pending);
  const result=JSON.parse(sent.find(e=>e.item?.call_id==='record').item.output);assert.equal(result.saved,false);
  runtime.memory.confirm(runtime.memory.pending.token);
  call('stop_video',{},'close-camera');assert.equal(bridge.closed,false);
  bridge.lastUserText='之前记录的钥匙在哪里';
  call('query_memory',{name:'钥匙'},'find');
  const found=JSON.parse(sent.find(e=>e.item?.call_id==='find').item.output);
  assert.equal(found.record.location,'抽屉里');assert.equal(found.is_current,false);
  bridge.close();
});
test('ordinary scenes cannot expose or change home records',()=>{
  const {runtime}=runtimeFixture();const bridge=new runtime.Bridge();bridge.mode='assistant';
  const sent=[];bridge.channel={readyState:'open',send:e=>sent.push(JSON.parse(e))};
  bridge.event({type:'response.done',response:{output:[{type:'function_call',call_id:'write',name:'prepare_memory',arguments:JSON.stringify({action:'record',name:'钥匙',location:'玄关'})}]}},bridge.channel);
  assert.equal(runtime.memory.pending,null);
  assert.match(JSON.parse(sent.find(e=>e.item?.call_id==='write').item.output).error,/切换到家/);
  runtime.setPlace('home');runtime.memory.prepare({action:'record',name:'钥匙',location:'玄关'});runtime.memory.confirm(runtime.memory.pending.token);
  runtime.setPlace('explore');bridge.send(JSON.stringify({type:'text',text:'之前记录的钥匙在哪里'}));
  bridge.event({type:'response.done',response:{output:[{type:'function_call',call_id:'read',name:'query_memory',arguments:'{"name":"钥匙"}'}]}},bridge.channel);
  assert.equal(JSON.parse(sent.find(e=>e.item?.call_id==='read').item.output).record,undefined);
  bridge.close();
});
test('remember command works for typed and spoken input only in home scene',()=>{
  const {runtime}=runtimeFixture();const bridge=new runtime.Bridge();bridge.mode='assistant';
  const events=[],sent=[];bridge.onmessage=e=>events.push(JSON.parse(e.data));
  bridge.channel={readyState:'open',send:e=>sent.push(JSON.parse(e))};
  bridge.send(JSON.stringify({type:'text',text:'记住，钥匙放在玄关桌上'}));
  assert.equal(runtime.memory.get('钥匙'),null);
  assert.equal(events.at(-1).saved,false);
  runtime.setPlace('home');
  bridge.send(JSON.stringify({type:'text',text:'记住，钥匙放在玄关桌上'}));
  assert.equal(runtime.memory.get('钥匙').location,'玄关桌上');
  assert.equal(runtime.memory.pending,null);
  assert.equal(events.at(-1).saved,true);
  bridge.event({type:'conversation.item.input_audio_transcription.completed',transcript:'记住，钥匙放在抽屉里'},bridge.channel);
  assert.equal(runtime.memory.get('钥匙').location,'抽屉里');
  assert.equal(events.at(-1).saved,true);
  assert.ok(sent.some(e=>e.type==='response.cancel'));
  bridge.close();
});
test('offline text command saves in home without a pending confirmation',async()=>{
  const {runtime}=runtimeFixture();
  const outside=await runtime.api('/api/command',{text:'记住，眼镜放在床头柜上'});
  assert.equal(outside.items.length,0);assert.equal(runtime.memory.get('眼镜'),null);
  runtime.setPlace('home');
  const saved=await runtime.api('/api/command',{text:'记住，眼镜放在床头柜上'});
  assert.equal(saved.saved,true);assert.equal(saved.pending,null);
  assert.equal(runtime.memory.get('眼镜').location,'床头柜上');
});

test('stopping observation leaves preview cleanup to the UI and keeps voice connected',async()=>{
  const {runtime,preview}=runtimeFixture();const bridge=new runtime.Bridge();bridge.mode='assistant';bridge.configured=true;
  let stopped=false;preview.srcObject={getVideoTracks:()=>[{readyState:'live',stop(){stopped=true;},clone:()=>assert.fail('no duplicate video track')}]};
  await bridge.attachVideo();bridge.endVideo('观察结束，语音继续');
  assert.equal(stopped,false);assert.equal(bridge.previewTrack,null);assert.equal(bridge.closed,false);bridge.close();
});

class TestGate{
  constructor(){this.config=null;}
  start(config){this.config=config;}
  stop(){this.config=null;}
}
const visualFixture=(options={})=>{
  const {place,...runtimeOptions}=options;
  const fixture=runtimeFixture({ObservationGate:TestGate,captureFrame:()=>'/9j/test-jpeg',...runtimeOptions});
  if(place)fixture.runtime.setPlace(place);
  const bridge=new fixture.runtime.Bridge();bridge.mode='assistant';bridge.configured=true;
  const sent=[],events=[];bridge.channel={readyState:'open',send:e=>sent.push(JSON.parse(e))};bridge.onmessage=e=>events.push(JSON.parse(e.data));
  fixture.preview.srcObject={getVideoTracks:()=>[{readyState:'live',clone:()=>({stop(){}})}]};
  bridge.videoSender={replaceTrack:async()=>{},getParameters:()=>({encodings:[]})};
  return {...fixture,bridge,sent,events};
};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const toolCall=(bridge,name,args,id)=>bridge.event({type:'response.done',response:{output:[{type:'function_call',call_id:id,name,arguments:JSON.stringify(args)}]}},bridge.channel);

test('realtime connection negotiates audio only while visual questions use snapshots',async()=>{
  const kinds=[];
  class Peer{
    constructor(){this.iceGatheringState='complete';}
    addTransceiver(kind){kinds.push(kind);return {sender:{}};}
    createDataChannel(){return {};}
    async createOffer(){return {type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'};}
    async setLocalDescription(value){this.localDescription=value;}
    async setRemoteDescription(value){this.remoteDescription=value;}
    close(){}
  }
  const {runtime}=runtimeFixture({RTCPeerConnection:Peer,fetch:async(url,options)=>{
    if(url==='/api/access')return Response.json({configured:true,authenticated:true});
    assert.equal(url,'/api/realtime/sdp');assert.ok(!JSON.parse(options.body).sdp.includes('m=video'));
    return new Response('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n');
  }});
  const bridge=new runtime.Bridge();bridge.mode='assistant';await bridge.connect();
  assert.deepEqual(kinds,['audio']);assert.equal(bridge.pc.remoteDescription.type,'answer');bridge.close();
});

test('snapshot request starts before voice cancellation finishes and is sent only once',async()=>{
  let finish,calls=0,tick=100;
  const {bridge,events}=visualFixture({now:()=>tick,fetch:async url=>{
    if(url==='/api/access')return Response.json({configured:true,authenticated:true});
    assert.equal(url,'/api/vision');calls++;return await new Promise(resolve=>finish=resolve);
  }});
  bridge.active=true;bridge.replyPending=true;
  bridge.send(JSON.stringify({type:'video_start',observe:true,id:'parallel-view',duration:30}));await settle();bridge.scene.config.onReady();await settle();
  assert.equal(calls,1);assert.ok(events.some(e=>e.type==='app.scene_loading'));
  bridge.event({type:'response.done',response:{status:'cancelled'}},bridge.channel);await settle();assert.equal(calls,1);
  tick=850;finish(Response.json({answer:'画面中有一只杯子。',objects:[]}));await settle();
  assert.equal(events.find(e=>e.type==='app.scene_ready').durationMs,750);
  assert.equal(events.filter(e=>e.type==='app.scene_fallback').length,1);bridge.close();
});

test('common overview and hand questions route directly to a fresh image request',()=>{
  const {bridge,events,sent}=visualFixture();
  for(const text of ['眼前有什么','我面前有什么？','我手里拿着什么？']){
    bridge.send(JSON.stringify({type:'text',text}));
    assert.equal(events.at(-1).type,'app.observe');
  }
  assert.equal(events[0].goal,'');assert.equal(events[1].goal,'');
  assert.equal(events[2].goal,'我手里拿着什么？');
  assert.equal(sent.filter(e=>e.type==='response.create').length,0);
  assert.equal(currentViewIntent('之前记录的杯子在哪里'),null);bridge.close();
});

test('startup greets once without capturing an image and waits for a user question',async()=>{
  let captures=0;
  const {bridge,events}=visualFixture({captureFrame:()=>{captures++;return '/9j/latest-frame';}});
  bridge.send(JSON.stringify({type:'video_start',id:'greeting-first',duration:120}));await settle();
  assert.equal(bridge.scene.config,null);assert.equal(captures,0);
  const intro=events.filter(e=>e.type==='app.introduction');assert.equal(intro.length,1);assert.match(intro[0].answer,/先调整手机方向/);
  assert.ok(!events.some(e=>e.type==='app.scene_loading'||e.type==='app.scene_ready'));
  bridge.send(JSON.stringify({type:'text',text:'你好'}));assert.equal(bridge.scene.config,null);assert.equal(captures,0);
  bridge.send(JSON.stringify({type:'text',text:'眼前有什么？'}));assert.ok(bridge.scene.config);
  bridge.scene.config.onReady();await settle();assert.equal(captures,1);assert.ok(events.some(e=>e.type==='app.scene_fallback'));
  bridge.endVideo('停止观察');bridge.send(JSON.stringify({type:'video_start',id:'same-session',duration:120}));await settle();
  assert.equal(events.filter(e=>e.type==='app.introduction').length,1);assert.equal(captures,1);bridge.close();
});

test('a visual question asked during camera startup is retained and skips the introduction',async()=>{
  let question='';
  const {bridge,events}=visualFixture({fetch:async(url,options)=>{
    if(url==='/api/access')return Response.json({configured:true,authenticated:true});
    question=JSON.parse(options.body).goal;return Response.json({answer:'水杯在电脑左侧。',objects:[]});
  }});
  bridge.send(JSON.stringify({type:'text',text:'水杯在哪里？'}));assert.equal(bridge.pendingObservation,true);
  bridge.send(JSON.stringify({type:'video_start',id:'early-question',duration:120}));await settle();
  assert.equal(bridge.pendingObservation,false);assert.ok(bridge.scene.config);assert.ok(!events.some(e=>e.type==='app.introduction'));
  bridge.scene.config.onReady();await settle();assert.equal(question,'水杯在哪里？');assert.ok(events.some(e=>e.type==='app.scene_fallback'));bridge.close();
});

test('explicit observe and wake-with-goal requests still capture without an extra greeting',async()=>{
  for(const options of [{observe:true},{goal:'找水杯'}]){
    const {bridge,events}=visualFixture();
    bridge.send(JSON.stringify({type:'video_start',id:'explicit-view',duration:120,...options}));await settle();
    assert.ok(bridge.scene.config);assert.ok(!events.some(e=>e.type==='app.introduction'));
    bridge.scene.config.onReady();await settle();assert.ok(events.some(e=>e.type==='app.scene_fallback'));bridge.close();
  }
});

test('greeting never interrupts a user already speaking and a bare wake word does not capture',async()=>{
  const {bridge,events}=visualFixture();bridge.event({type:'input_audio_buffer.speech_started'},bridge.channel);
  bridge.send(JSON.stringify({type:'video_start',id:'speaking-first',duration:120}));await settle();
  assert.ok(!events.some(e=>e.type==='app.introduction'));assert.equal(bridge.scene.config,null);
  assert.equal(currentViewIntent('小忆'),null);assert.equal(observationCommand('小忆你好'),null);bridge.close();
});

test('cancelled startup cannot play a late introduction',async()=>{
  const {bridge,events}=visualFixture();let finish;
  bridge.attachVideo=()=>new Promise(resolve=>finish=resolve);
  bridge.send(JSON.stringify({type:'video_start',id:'cancel-greeting',duration:120}));bridge.close();finish();await settle();
  assert.ok(!events.some(e=>e.type==='app.introduction'));
});

test('reading a complete visual answer does not wait for a scene-context acknowledgement',async()=>{
  const {bridge,events,sent}=visualFixture();
  bridge.send(JSON.stringify({type:'video_start',observe:true,id:'read-now',duration:30}));await settle();bridge.scene.config.onReady();await settle();
  assert.equal(bridge.pendingInstructions,true);
  const answer=events.find(e=>e.type==='app.scene_fallback').answer;
  bridge.replayAnswer(answer);
  assert.equal(sent.filter(e=>e.type==='response.create').length,1);
  assert.ok(sent.some(e=>e.item?.content?.[0]?.text.includes(answer)));
  bridge.event({type:'session.updated'},bridge.channel);
  assert.equal(sent.filter(e=>e.type==='response.create').length,1);bridge.close();
});

test('delayed context acknowledgement does not silently discard a queued user reply',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {bridge,sent}=visualFixture();
  bridge.send(JSON.stringify({type:'video_start',observe:true,id:'context-delay',duration:30}));await settle();bridge.scene.config.onReady();await settle();
  bridge.requestReply('请根据这次画面继续回答。');
  assert.equal(sent.filter(e=>e.type==='response.create').length,0);
  t.mock.timers.tick(6000);
  assert.equal(sent.filter(e=>e.type==='response.create').length,1);
  bridge.event({type:'session.updated'},bridge.channel);
  assert.equal(sent.filter(e=>e.type==='response.create').length,1);bridge.close();
});

test('two and five minute observations are accepted and preserve manual stop',async()=>{
  for(const duration of [120,300,600]){
    const {bridge}=visualFixture();bridge.send(JSON.stringify({type:'video_start',observe:true,id:'long-view',duration}));await settle();
    assert.equal(bridge.videoId,'long-view');bridge.send(JSON.stringify({type:'video_stop',id:'long-view'}));
    assert.equal(bridge.videoId,null);assert.equal(bridge.closed,false);bridge.close();
  }
});

test('long frame timers continue past 30 seconds and stop exactly at their configured deadline',()=>{
  for(const duration of [120,300,600]){
    let now=0,nextId=0,stops=0,frames=0;const tasks=new Map();
    const add=(fn,delay,interval=0)=>{const id=++nextId;tasks.set(id,{fn,at:now+delay,interval});return id;};
    const context={module:{exports:{}},performance:{now:()=>now},setTimeout:(fn,ms)=>add(fn,ms),clearTimeout:id=>tasks.delete(id),setInterval:(fn,ms)=>add(fn,ms,ms),clearInterval:id=>tasks.delete(id)};
    vm.runInNewContext(readFileSync(new URL('../src/static/video-stream.js',import.meta.url),'utf8'),context);
    const stream=new context.module.exports.FrameStream();stream.start(duration,()=>{frames++;return true;},()=>stops++);
    const advance=target=>{while(true){const due=[...tasks].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;const [id,t]=due;now=t.at;if(t.interval)t.at+=t.interval;else tasks.delete(id);t.fn();}now=target;};
    advance(30001);assert.equal(stream.running,true);assert.equal(stops,0);
    advance(duration*1000-1);assert.equal(stream.running,true);assert.equal(stops,0);
    advance(duration*1000);assert.equal(stream.running,false);assert.equal(stops,1);assert.equal(frames,duration);assert.equal(tasks.size,0);
  }
});

test('requested scene description answers as soon as the fresh frame is understood',async()=>{
  const {bridge,sent,events}=visualFixture();
  bridge.send(JSON.stringify({type:'video_start',observe:true,id:'scene-one',duration:30}));await settle();
  assert.equal(sent.filter(e=>e.type==='response.create').length,0);
  bridge.scene.config.onReady();
  await settle();
  assert.equal(sent.filter(e=>e.type==='response.create').length,0);
  assert.ok(sent.some(e=>e.type==='session.update'&&e.session.instructions.includes('测试桌面')));
  bridge.event({type:'session.updated'},bridge.channel);
  assert.equal(sent.filter(e=>e.type==='response.create').length,0);
  assert.equal(events.filter(e=>e.type==='app.scene_fallback').length,1);
  assert.match(events.find(e=>e.type==='app.scene_fallback').answer,/水杯在电脑左侧/);bridge.close();
});

test('spoken input suppresses a pending description instead of overlapping the user reply',async()=>{
  const {bridge,sent}=visualFixture();bridge.send(JSON.stringify({type:'video_start',observe:true,id:'scene-two',duration:30}));await settle();
  bridge.event({type:'input_audio_buffer.speech_started'},bridge.channel);bridge.scene.config.onReady();
  assert.equal(sent.filter(e=>e.type==='response.create').length,0);bridge.close();
});

const fastFixture=(options={})=>{
  const fixture=visualFixture({supportsSpeech:true,...options});const original=fixture.document.getElementById;
  fixture.document.getElementById=id=>id==='fast-describe'?{checked:true}:original(id);return fixture;
};
test('fast visual speech starts at the vision result without a second model response or context acknowledgement',async()=>{
  const {bridge,sent,events}=fastFixture();bridge.send(JSON.stringify({type:'video_start',observe:true,id:'fast-view',duration:120}));await settle();bridge.scene.config.onReady();await settle();
  const answer=events.find(e=>e.type==='app.scene_answer');assert.ok(answer);assert.match(answer.answer,/水杯/);
  assert.equal(bridge.pendingInstructions,true);assert.equal(sent.filter(e=>e.type==='response.create').length,0);
  bridge.finishLocalSpeech(answer.token);bridge.event({type:'session.updated'},bridge.channel);
  assert.equal(bridge.visualPending,false);assert.equal(sent.filter(e=>e.type==='response.create').length,0);
  bridge.send(JSON.stringify({type:'text',text:'你好'}));assert.equal(sent.filter(e=>e.type==='response.create').length,1);bridge.close();
});
test('late device speech callbacks cannot clear a newer visual request',async()=>{
  const {bridge,events}=fastFixture();bridge.send(JSON.stringify({type:'video_start',observe:true,id:'speech-view',duration:120}));await settle();bridge.scene.config.onReady();await settle();
  const answer=events.find(e=>e.type==='app.scene_answer');bridge.requestCurrentView('找眼镜');bridge.finishLocalSpeech(answer.token);
  assert.equal(bridge.visualPending,true);bridge.close();
});
test('failed device speech reports a retry option without switching back to cloud speech',async()=>{
  const {bridge,sent,events}=fastFixture();bridge.send(JSON.stringify({type:'video_start',observe:true,id:'fallback-view',duration:120}));await settle();bridge.scene.config.onReady();await settle();
  const answer=events.find(e=>e.type==='app.scene_answer');bridge.finishLocalSpeech(answer.token,true);bridge.event({type:'session.updated'},bridge.channel);
  assert.equal(sent.filter(e=>e.type==='response.create').length,0);bridge.finishLocalSpeech(answer.token,true);
  assert.equal(events.filter(e=>e.type==='app.device_voice_error').length,1);assert.equal(bridge.visualPending,false);bridge.close();
});

test('device voice requests text-only model output and keeps cloud audio muted',()=>{
  for(const supportsSpeech of [true,false]){
    const {runtime,document,audio}=runtimeFixture({supportsSpeech});
    const get=document.getElementById;document.getElementById=id=>id==='fast-describe'?{checked:true}:get(id);
    const bridge=new runtime.Bridge();bridge.mode='assistant';bridge.created=true;bridge.pc={connectionState:'connected',close(){}};
    const sent=[];bridge.channel={readyState:'open',send:raw=>sent.push(JSON.parse(raw))};bridge.initialize();
    assert.deepEqual(sent[0].session.modalities,supportsSpeech?['text']:['text','audio']);
    bridge.updatePlayback();assert.equal(audio.muted,supportsSpeech);bridge.close();
  }
});

test('device replay cancels pending cloud work without making a new model response',()=>{
  const {bridge,sent}=fastFixture();bridge.active=true;let aborted=false;
  bridge.sceneCommit={controller:{abort(){aborted=true;}}};bridge.queuedReply={text:'old answer'};
  bridge.prepareDeviceReplay();assert.equal(aborted,true);assert.equal(bridge.queuedReply,null);
  assert.ok(sent.some(e=>e.type==='response.cancel'));assert.ok(!sent.some(e=>e.type==='response.create'));
  bridge.event({type:'response.text.done',item_id:'old',text:'旧回答'},bridge.channel);assert.equal(bridge.suppressResponse,true);bridge.close();
});

test('readable local preview does not wait for remote video statistics',async()=>{
  let now=0,task,ready=0;const gate=new ObservationGate({requireTransmission:false,settleMs:100,now:()=>now,schedule:fn=>(task=fn,1),cancel:()=>{}});
  const preview={videoWidth:640,videoHeight:480,readyState:2,paused:false,srcObject:{getVideoTracks:()=>[{readyState:'live',muted:false}]}};
  gate.start({preview,sender:{getStats:()=>assert.fail('preview snapshot must not depend on RTP')},baseline:{bytes:100},stillCurrent:()=>true,onReady:()=>ready++,onError:()=>assert.fail('unexpected timeout')});
  now=100;await task();assert.equal(ready,1);gate.stop();
});

test('fresh observation tool waits for frames, then answers directly from the current frame',async()=>{
  const {bridge,sent,events}=visualFixture();toolCall(bridge,'request_observation',{goal:'找水杯'},'look');
  assert.ok(events.some(e=>e.type==='app.observe'&&e.goal==='找水杯'));
  assert.equal(sent.filter(e=>e.item?.call_id==='look').length,0);
  bridge.send(JSON.stringify({type:'video_start',observe:true,id:'find-cup',duration:30}));await settle();bridge.scene.config.onReady();
  await settle();bridge.event({type:'session.updated'},bridge.channel);
  const result=JSON.parse(sent.find(e=>e.item?.call_id==='look').item.output);
  assert.equal(result.camera_active,true);assert.equal(result.reference,'镜头画面');
  assert.equal(sent.filter(e=>e.type==='response.create').length,0);
  assert.match(events.find(e=>e.type==='app.scene_fallback').answer,/水杯/);bridge.close();
});

test('failed observation never announces a successful description',async()=>{
  const {bridge,sent}=visualFixture();toolCall(bridge,'request_observation',{goal:'找水杯'},'failed-look');
  bridge.send(JSON.stringify({type:'video_start',observe:true,id:'failed-frame',duration:30}));await settle();bridge.scene.config.onError('无画面');
  const result=JSON.parse(sent.find(e=>e.item?.call_id==='failed-look').item.output);
  assert.equal(result.camera_active,false);assert.equal(result.error,'无画面');assert.equal(bridge.lastObservedAt,null);bridge.close();
});

test('current visual location never exposes historical records, explicit history still works',()=>{
  const {runtime,bridge,sent}=visualFixture({place:'home'});runtime.memory.prepare({action:'record',name:'水杯',location:'以前的柜子'});runtime.memory.confirm(runtime.memory.pending.token);
  bridge.videoId='live-view';bridge.lastUserText='水杯在哪里';toolCall(bridge,'query_memory',{name:'水杯'},'current');
  const current=JSON.parse(sent.find(e=>e.item?.call_id==='current').item.output);assert.equal(current.use_current_view,true);assert.equal(current.record,undefined);
  bridge.videoId=null;bridge.lastUserText='水杯现在在哪里';toolCall(bridge,'query_memory',{name:'水杯'},'closed-view');
  assert.equal(JSON.parse(sent.find(e=>e.item?.call_id==='closed-view').item.output).requires_observation,true);
  bridge.lastUserText='之前记录的水杯在哪里';toolCall(bridge,'query_memory',{name:'水杯'},'history');
  const history=JSON.parse(sent.find(e=>e.item?.call_id==='history').item.output);assert.equal(history.record.location,'以前的柜子');assert.equal(history.is_current,false);bridge.close();
});
test('home search adds a labeled historical hint only when the target is clearly absent',async()=>{
  const fetcher=async url=>url==='/api/vision'?Response.json({answer:'当前画面没有看到钥匙。',objects:[],target_visible:false}):Response.json({configured:true,authenticated:true});
  const {runtime,bridge,events}=visualFixture({fetch:fetcher});runtime.setPlace('home');
  runtime.memory.prepare({action:'record',name:'钥匙',location:'玄关桌上'});runtime.memory.confirm(runtime.memory.pending.token);
  bridge.send(JSON.stringify({type:'text',text:'找钥匙'}));
  bridge.send(JSON.stringify({type:'video_start',observe:true,id:'home-key',duration:30,goal:'找钥匙'}));await settle();bridge.scene.config.onReady();await settle();
  const answer=events.find(e=>e.type==='app.scene_fallback')?.answer||'';
  assert.match(answer,/当前画面没有看到钥匙/);assert.match(answer,/要听一下吗/);assert.ok(!answer.includes('玄关桌上'));
  bridge.send(JSON.stringify({type:'text',text:'好'}));
  const history=events.findLast(e=>e.type==='app.memory_result').answer;assert.match(history,/上次记录钥匙在玄关桌上/);assert.match(history,/不能确认/);
  bridge.close();
});
test('fast speech still verifies a home target before mentioning its saved location',async()=>{
  let requestedStream;
  const fetcher=async(url,options)=>{
    if(url==='/api/vision'){
      requestedStream=JSON.parse(options.body).stream;
      return Response.json({answer:'当前画面没有看到钥匙。',objects:[],target_visible:false});
    }
    return Response.json({configured:true,authenticated:true});
  };
  const {runtime,bridge,events}=fastFixture({fetch:fetcher});runtime.setPlace('home');
  runtime.memory.prepare({action:'record',name:'钥匙',location:'玄关桌上'});runtime.memory.confirm(runtime.memory.pending.token);
  bridge.send(JSON.stringify({type:'video_start',observe:true,id:'fast-home-key',duration:30,goal:'找钥匙'}));await settle();bridge.scene.config.onReady();await settle();
  assert.equal(requestedStream,false);
  const spoken=events.find(e=>e.type==='app.scene_answer');assert.match(spoken.answer,/要听一下吗/);assert.ok(!spoken.answer.includes('玄关桌上'));
  bridge.send(JSON.stringify({type:'text',text:'需要'}));assert.match(events.findLast(e=>e.type==='app.memory_result').answer,/玄关桌上/);bridge.close();
});

test('stopping observation informs the model that previous frames are historical',()=>{
  const {bridge,sent}=visualFixture();bridge.videoId='closed-scene';bridge.lastObservedAt='2026-10-13T08:00:00Z';bridge.endVideo('停止');
  assert.ok(sent.some(e=>e.session?.instructions.includes('不能把旧画面说成当前位置')));bridge.close();
});

test('observation gate rejects blank, stale, muted and cancelled camera tracks',async()=>{
  let now=0,task,ready=0,fail=0;const gate=new ObservationGate({now:()=>now,schedule:fn=>(task=fn,1),cancel:()=>{task=null;},settleMs:1000,timeoutMs:2000});
  const track={readyState:'live',muted:false};let bytes=10;
  const preview={srcObject:{getVideoTracks:()=>[track]},videoWidth:0,videoHeight:0,readyState:0,paused:true};
  const sender={getStats:async()=>new Map([['video',{type:'outbound-rtp',kind:'video',bytesSent:bytes}]])};
  const config={preview,sender,baseline:{bytes:10},stillCurrent:()=>true,onReady:()=>ready++,onError:()=>fail++};
  gate.start(config);now=1000;await task();assert.equal(ready,0);
  Object.assign(preview,{videoWidth:640,videoHeight:480,readyState:2,paused:false});now=1500;await task();assert.equal(ready,0);
  bytes=20;track.muted=true;await task();assert.equal(ready,0);track.muted=false;await task();assert.equal(ready,1);
  gate.start(config);const stale=task;gate.stop();await stale();assert.equal(ready,1);
  preview.videoWidth=0;gate.start(config);now+=2100;await task();assert.equal(fail,1);gate.stop();
});

test('foreground wake consumes one phrase and suspends recognition before the cloud session',()=>{
  class Recognition{start(){this.onstart?.();}abort(){this.aborted=true;}}
  const states=[],wakes=[];const wake=new ForegroundWake({Recognition,onState:s=>states.push(s),onWake:s=>wakes.push(s)});
  assert.equal(wake.enable(),true);const recognition=wake.recognition;
  const result=Object.assign([{transcript:'小忆，找水杯'}],{isFinal:true});recognition.onresult({resultIndex:0,results:[result]});
  assert.equal(wakes.length,1);assert.equal(wakes[0].goal,'找水杯');assert.equal(recognition.aborted,true);assert.equal(wake.listening,false);
  wake.resume();assert.ok(wake.recognition);wake.disable();assert.equal(wake.enabled,false);assert.equal(wake.recognition,null);
});

test('unsupported or denied wake never starts a cloud session and gives a button fallback',()=>{
  let message='';const unavailable=new ForegroundWake({onState:s=>message=s});assert.equal(unavailable.enable(),false);assert.match(message,/开始对话/);
  class Recognition{start(){}abort(){}}
  const wake=new ForegroundWake({Recognition,onState:s=>message=s,onWake:()=>assert.fail('must not wake')});wake.enable();wake.recognition.onerror({error:'not-allowed'});
  assert.equal(wake.enabled,false);assert.match(message,/授权/);
});

test('wake and observation phrases do not confuse unrelated speech or explicit history',()=>{
  assert.deepEqual(wakeText('小忆，看看周围'),{goal:'看看周围'});assert.equal(wakeText('我的回忆很多'),null);
  assert.deepEqual(observationCommand('再看一下。'),{goal:''});assert.ok(observationCommand('帮我找水杯'));
  assert.equal(observationCommand('之前记录的水杯在哪'),null);assert.equal(asksHistory('水杯在哪里'),false);assert.equal(asksHistory('以前的水杯记录'),true);
});

test('current location text deterministically requests a new view instead of answering cached positions',()=>{
  const {bridge,sent,events}=visualFixture();bridge.send(JSON.stringify({type:'text',text:'水杯现在具体在哪里？'}));
  assert.ok(events.some(e=>e.type==='app.observe'&&e.goal==='水杯现在具体在哪里？'));
  assert.equal(sent.filter(e=>e.type==='response.create').length,0);assert.equal(bridge.visualPending,true);bridge.close();
  assert.equal(currentViewIntent('之前记录的水杯在哪里'),null);
});
test('follow-up pronouns use the active target for a fresh observation',()=>{
  const {bridge,events}=visualFixture();
  bridge.send(JSON.stringify({type:'text',text:'帮我找水杯'}));
  bridge.send(JSON.stringify({type:'text',text:'它旁边是什么？'}));
  assert.ok(events.some(e=>e.type==='app.observe'&&e.goal==='水杯旁边是什么？'));
  bridge.close();
});

test('spoken location suppresses the old response until the new visual result is available',async()=>{
  const {bridge,sent,events,audio}=visualFixture();
  bridge.event({type:'input_audio_buffer.speech_started'},bridge.channel);
  bridge.event({type:'input_audio_buffer.speech_stopped'},bridge.channel);
  bridge.event({type:'response.created'},bridge.channel);
  bridge.event({type:'response.text.done',text:'旧位置'},bridge.channel);
  assert.equal(audio.muted,true);assert.ok(!events.some(e=>e.text==='旧位置'));
  bridge.event({type:'conversation.item.input_audio_transcription.completed',transcript:'水杯在哪？'},bridge.channel);
  assert.ok(sent.some(e=>e.type==='response.cancel'));assert.ok(events.some(e=>e.type==='app.observe'));
  bridge.event({type:'response.done',response:{status:'cancelled'}},bridge.channel);
  bridge.send(JSON.stringify({type:'video_start',observe:true,id:'new-view',duration:30}));await settle();bridge.scene.config.onReady();await settle();
  bridge.event({type:'session.updated'},bridge.channel);bridge.event({type:'response.created'},bridge.channel);
  assert.equal(audio.muted,false);bridge.event({type:'response.text.done',text:'当前画面中的水杯在电脑左侧'},bridge.channel);
  assert.ok(events.some(e=>e.text==='当前画面中的水杯在电脑左侧'));assert.ok(!events.some(e=>e.text==='旧位置'));bridge.close();
});

test('a late vision result after closing the camera cannot become a current observation',async()=>{
  let finish;
  const {bridge,events}=visualFixture({fetch:async(url)=>url==='/api/vision'?await new Promise(resolve=>finish=resolve):Response.json({configured:true,authenticated:true})});
  bridge.send(JSON.stringify({type:'video_start',observe:true,id:'cancelled-view',duration:30}));await settle();bridge.scene.config.onReady();await settle();
  bridge.endVideo('已停止');finish(Response.json({answer:'水杯在电脑左侧',objects:[]}));await settle();
  assert.equal(bridge.lastObservedAt,null);assert.ok(!events.some(e=>e.type==='app.scene_ready'));bridge.close();
});

const jpeg='/9j/2Q==';
const visionRequest=(body,origin='https://example.netlify.app')=>new Request('https://example.netlify.app/api/vision',{method:'POST',headers:{Origin:origin},body:JSON.stringify(body)});
test('public vision retains origin checks, rejects remote images and keeps the endpoint fixed',async()=>{
  let calls=0;const unused=async()=>{calls++;throw Error('must not fetch');};
  assert.equal((await understand(visionRequest({image:jpeg},'https://evil.example'),unused,serverEnv)).status,403);
  assert.equal((await understand(visionRequest({image:'https://evil.example/private'}),unused,serverEnv)).status,400);
  assert.equal(calls,0);
  const result=await understand(visionRequest({image:jpeg,workspace:'evil',key:'ignored'}),async(url,options)=>{
    assert.equal(url,'https://ws-test-fixture.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
    assert.equal(options.headers.Authorization,'Bearer '+key);assert.equal(options.redirect,'error');
    const payload=JSON.parse(options.body);assert.equal(payload.model,'qwen3.6-flash');assert.equal(payload.enable_thinking,false);
    assert.equal(payload.messages[1].content[0].image_url.url,'data:image/jpeg;base64,'+jpeg);
    return Response.json({choices:[{message:{content:JSON.stringify({answer:'当前画面没有看到水杯。',objects:[],target_visible:false})}}]});
  },serverEnv);
  assert.equal(result.status,200);const text=await result.text();assert.ok(!text.includes(key));assert.ok(!text.includes(serverEnv.APP_ACCESS_CODE));assert.match(text,/current_camera_frame/);assert.equal(JSON.parse(text).target_visible,false);
});
test('vision errors do not expose provider credentials or fabricate a result',async()=>{
  for(const fetcher of [async()=>Response.json({message:key},{status:403}),async()=>{throw Error(key);},async()=>Response.json({choices:[{message:{content:'not valid JSON'}}]})]){
    const result=await understand(visionRequest({image:jpeg}),fetcher,serverEnv);
    assert.equal(result.status,502);assert.ok(!(await result.text()).includes(key));
  }
});

const sse=value=>'data: '+JSON.stringify(value)+'\n\n';
test('stream parser handles split Chinese bytes and CRLF safely',async()=>{
  const bytes=new TextEncoder().encode((sse({type:'delta',text:'电脑与水杯。'})+'data: [DONE]\n\n').replaceAll('\n','\r\n'));
  const body=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=3)c.enqueue(bytes.slice(i,i+3));c.close();}});
  const events=[];for await(const event of readEvents(body))events.push(event);
  assert.deepEqual(events,[{type:'delta',text:'电脑与水杯。'}]);
});

test('vision sends its first text before the upstream response completes',async()=>{
  let upstream;
  const body=new ReadableStream({start(c){upstream=c;}});
  const response=await understand(visionRequest({image:jpeg,stream:true}),async(url,options)=>{
    const payload=JSON.parse(options.body);assert.equal(payload.stream,true);assert.equal(payload.response_format,undefined);
    return new Response(body,{headers:{'Content-Type':'text/event-stream'}});
  },serverEnv);
  const iterator=readEvents(response.body);upstream.enqueue(new TextEncoder().encode(sse({choices:[{delta:{content:'桌面上有电脑。'}}]})));
  const first=await iterator.next();assert.equal(first.value.type,'delta');assert.equal(first.value.text,'桌面上有电脑。');
  upstream.enqueue(new TextEncoder().encode(sse({choices:[{delta:{content:'水杯在左侧。'}}]})+'data: [DONE]\n\n'));upstream.close();
  assert.equal((await iterator.next()).value.type,'delta');const done=(await iterator.next()).value;
  assert.equal(done.type,'done');assert.equal(done.result.answer,'桌面上有电脑。水杯在左侧。');await iterator.return();
});

test('frontend forwards partial sentences before final vision metadata and stopping releases speech suppression',async()=>{
  let upstream;
  const body=new ReadableStream({start(c){upstream=c;}});
  const {bridge,events}=fastFixture({fetch:async url=>url==='/api/vision'?new Response(body,{headers:{'Content-Type':'text/event-stream'}}):Response.json({configured:true,authenticated:true})});
  bridge.send(JSON.stringify({type:'video_start',observe:true,id:'stream-view',duration:120}));await settle();bridge.scene.config.onReady();await settle();
  upstream.enqueue(new TextEncoder().encode(sse({type:'delta',text:'水杯在电脑左侧。'})));await settle();
  assert.ok(events.some(e=>e.type==='app.scene_delta'));assert.equal(bridge.currentScene,undefined);
  bridge.endVideo('停止');assert.ok(events.some(e=>e.type==='app.scene_cancel'));assert.equal(bridge.visualPending,false);assert.equal(bridge.localSpeechToken,null);
  upstream.close();bridge.close();
});

test('sentence speech starts on a complete sentence and does not repeat it at final completion',()=>{
  class Utterance{constructor(text){this.text=text;}}
  const spoken=[],done=[];const synth={cancel(){},speak(u){spoken.push(u);u.onstart?.();}};
  const player=new SceneSpeech({synth,Utterance,onDone:(...args)=>done.push(args),schedule:()=>1,cancelTimer:()=>{}});
  player.begin('one');player.append('电脑在');assert.equal(spoken.length,0);
  player.append('中央。水杯在');assert.equal(spoken[0].text,'电脑在中央。');spoken[0].onend();assert.equal(done.length,0);
  player.append('左侧。');assert.equal(spoken.length,2);player.finish('电脑在中央。水杯在左侧。');spoken[1].onend();
  assert.equal(spoken.length,2);assert.deepEqual(done,[['one',false]]);
});

test('interrupting sentence speech drops its queued continuation and ignores late callbacks',()=>{
  class Utterance{constructor(text){this.text=text;}}
  const spoken=[],done=[];const player=new SceneSpeech({synth:{cancel(){},speak:u=>spoken.push(u)},Utterance,onDone:(...args)=>done.push(args),schedule:()=>1,cancelTimer:()=>{}});
  player.begin('old');player.append('第一句。第二句。');const old=spoken[0];player.cancel();player.begin('new');player.append('新画面。');old.onend();
  assert.equal(spoken.length,2);assert.deepEqual(done,[['old',false]]);player.finish('新画面。');spoken[1].onend();
  assert.deepEqual(done,[['old',false],['new',false]]);
});

test('ordinary conversation reads complete text sentences before the final response and never repeats them',()=>{
  class Utterance{constructor(text){this.text=text;}}
  const spoken=[];const voice={lang:'zh-CN',localService:true};
  const player=new SceneSpeech({synth:{cancel(){},getVoices:()=>[{lang:'en-US'},voice],speak:u=>{spoken.push(u);u.onstart();}},Utterance,schedule:()=>1,cancelTimer:()=>{}});
  player.reply({type:'response.text.delta',item_id:'one',delta:'你好'});assert.equal(spoken.length,0);
  player.reply({type:'response.text.delta',item_id:'one',delta:'。有什么可以帮你？'});
  assert.equal(spoken[0].text,'你好。有什么可以帮你？');assert.equal(spoken[0].voice,voice);
  spoken[0].onend();player.reply({type:'response.text.done',item_id:'one',text:'你好。有什么可以帮你？'});
  player.reply({type:'response.text.done',item_id:'one',text:'你好。有什么可以帮你？'});
  assert.equal(spoken.length,1);assert.equal(player.finished,true);
});

test('interrupting a spoken conversation ignores late text while a new reply can be read',()=>{
  class Utterance{constructor(text){this.text=text;}}
  const spoken=[];const player=new SceneSpeech({synth:{cancel(){},speak:u=>spoken.push(u)},Utterance,schedule:()=>1,cancelTimer:()=>{}});
  player.reply({type:'response.text.delta',item_id:'old',delta:'旧回答。'});player.cancel();
  player.reply({type:'response.text.done',item_id:'old',text:'旧回答。还有一句。'});
  player.reply({type:'response.text.done',item_id:'new',text:'新回答'});
  assert.deepEqual(spoken.map(u=>u.text),['旧回答。','新回答']);player.cancel();
});



test('memory search accepts descriptions and synonyms, returns candidates without changing names',()=>{
  const memory=new Memory(storage());memory.remember('记住，蓝色水杯放在书桌上');memory.remember('记住，白色耳机盒放在抽屉里');memory.remember('记住，红色水杯放在柜子上');
  assert.equal(memory.search('装耳机的盒子')[0].name,'白色耳机盒');
  assert.equal(memory.search('杯子').length,2);assert.equal(memory.search('蓝色')[0].name,'蓝色水杯');
  const companion=new MemoryCompanion(memory);const answer=companion.handle('我忘记之前记住的什么物品了').answer;
  assert.match(answer,/蓝色水杯/);assert.match(answer,/哪一件/);
  assert.match(companion.handle('是的').answer,/有几件/);
  assert.match(companion.handle('第二个').answer,/历史位置/);
  assert.equal(memory.all().length,3);
});

test('browsing memory can continue beyond the first five records',()=>{
  const memory=new Memory(storage());for(let i=0;i<8;i++)memory.remember(`记住，物品${i}放在抽屉里`);
  const companion=new MemoryCompanion(memory);assert.match(companion.handle('我记过什么').answer,/下一批/);
  const next=companion.handle('下一批').answer;assert.match(next,/物品0/);assert.ok(!next.includes('物品7'));
});

test('a vague new record never saves under the name this or overwrites an arbitrary item',()=>{
  const memory=new Memory(storage());memory.remember('记住，水杯放在桌上');
  assert.equal(memory.remember('记住，这个放在床上').saved,false);assert.equal(memory.get('这个'),null);
  const companion=new MemoryCompanion(memory);assert.match(companion.handle('记住，这个放在床上').answer,/哪一件/);
  const selected=companion.handle('第一个');assert.ok(selected.pending);assert.equal(memory.get('水杯').location,'桌上');
  assert.equal(selected.items.length,1);
  companion.handle('确认');assert.equal(memory.get('水杯').location,'床上');assert.equal(memory.get('这个'),null);
});

test('visible location change checks identity, asks permission, then saves only after consent',()=>{
  const memory=new Memory(storage());memory.remember('记住，蓝色水杯放在书桌上');
  let now=Date.now();const companion=new MemoryCompanion(memory,()=>now);
  const scene={answer:'桌上有一个蓝色杯子。',objects:[{name:'蓝色杯子',position:'床头柜上'}],observedAt:new Date(now).toISOString()};
  const options={scene,cameraActive:true};
  assert.match(companion.observe(scene,'',''),/是你之前记住/);assert.equal(memory.pending,null);
  assert.match(companion.handle('是的',options).answer,/要把.*更新/);assert.equal(memory.get('蓝色水杯').location,'书桌上');
  const done=companion.handle('确认',options);assert.match(done.answer,/已保存/);assert.equal(memory.get('蓝色水杯').location,'床头柜上');
  assert.equal(companion.observe(scene,'',''),scene.answer);
});

test('denial, multiple lookalikes, stale or switched frames never update memory',()=>{
  for(const reason of ['deny','stale','switched','closed']){
    const memory=new Memory(storage());memory.remember('记住，水杯放在书桌上');let now=Date.now();
    const companion=new MemoryCompanion(memory,()=>now),scene={answer:'有一个杯子。',objects:[{name:'杯子',position:'床头柜上'}],observedAt:new Date(now).toISOString()};
    companion.observe(scene,'','');
    if(reason==='deny')companion.handle('不是');
    else{companion.handle('对');if(reason==='stale')now+=120001;companion.handle('确认',{cameraActive:reason!=='closed',scene:reason==='switched'?{...scene,observedAt:'2000-01-01T00:00:00Z'}:scene});}
    assert.equal(memory.get('水杯').location,'书桌上');
  }
  const memory=new Memory(storage());memory.remember('记住，水杯放在桌上');const companion=new MemoryCompanion(memory);
  const scene={answer:'有两个杯子。',objects:[{name:'蓝色杯子',position:'床头柜上'},{name:'白色杯子',position:'书桌上'}],observedAt:new Date().toISOString()};
  assert.equal(companion.observe(scene,'',''),scene.answer);assert.equal(companion.pending,null);
});

test('runtime handles a spoken memory clarification, consent to history and a fresh-view follow-up',async()=>{
  const {runtime,bridge,events}=visualFixture();runtime.setPlace('home');runtime.memory.remember('记住，白色耳机盒放在抽屉里');
  const speak=transcript=>bridge.event({type:'conversation.item.input_audio_transcription.completed',transcript},bridge.channel);
  speak('我忘记之前记住的什么物品了');assert.match(events.findLast(e=>e.type==='app.memory_result').answer,/耳机盒/);
  speak('第一个');assert.match(events.findLast(e=>e.type==='app.memory_result').answer,/历史位置/);
  speak('好');assert.ok(events.some(e=>e.type==='app.observe'&&e.goal==='找白色耳机盒'));bridge.close();
});

test('home overview keeps structured visible objects to allow one useful follow-up',async()=>{
  let stream;
  const {runtime,bridge,events}=fastFixture({fetch:async(url,options)=>{
    if(url!=='/api/vision')return Response.json({configured:true,authenticated:true});
    stream=JSON.parse(options.body).stream;return Response.json({answer:'床头柜上有一个蓝色杯子。',objects:[{name:'蓝色杯子',position:'床头柜上'}],target_visible:null});
  }});runtime.setPlace('home');runtime.memory.remember('记住，蓝色水杯放在书桌上');
  bridge.send(JSON.stringify({type:'video_start',observe:true,id:'proactive',duration:600}));await settle();bridge.scene.config.onReady();await settle();
  assert.equal(stream,false);assert.match(events.findLast(e=>e.type==='app.scene_answer').answer,/是你之前记住/);
  bridge.send(JSON.stringify({type:'text',text:'是的'}));assert.match(events.findLast(e=>e.type==='app.memory_result').answer,/要把/);
  bridge.send(JSON.stringify({type:'text',text:'确认'}));assert.equal(runtime.memory.get('蓝色水杯').location,'床头柜上');bridge.close();
});

test('higher resolution vision supports more than five objects and rejects oversized uploads',async()=>{
  let payload;
  const objects=Array.from({length:12},(_,i)=>({name:'物品'+i,position:'桌面'}));
  const response=await understand(visionRequest({image:'/9j/'+ 'A'.repeat(300000),goal:'桌子上有什么'}),async(url,options)=>{payload=JSON.parse(options.body);return Response.json({choices:[{message:{content:JSON.stringify({answer:'桌上有十二件物品。',objects})}}]});},serverEnv);
  assert.equal(response.status,200);assert.equal((await response.json()).objects.length,12);assert.equal(payload.model,'qwen3.6-flash');assert.ok(payload.max_tokens>=1000);assert.match(payload.messages[0].content,/不.*凑数/);
  assert.equal((await understand(visionRequest({image:'/9j/'+'A'.repeat(1200001)}),()=>assert.fail('oversize must not be sent'),serverEnv)).status,413);
});

test('published controls default to five minutes and provide ten minutes',()=>{
  const html=readFileSync(new URL('../dist/video/index.html',import.meta.url),'utf8');
  assert.match(html,/<option value="300" selected>5 分钟/);assert.match(html,/<option value="600">10 分钟/);
  assert.ok(!html.includes('摄像头默认 2 分钟'));
});
