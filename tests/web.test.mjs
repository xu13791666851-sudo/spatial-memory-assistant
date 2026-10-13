import test from 'node:test';
import assert from 'node:assert/strict';
import {Memory} from '../web/memory.mjs';
import {createRuntime,sessionConfig} from '../web/runtime.mjs';
import {exchange} from '../netlify/functions/realtime-sdp.mjs';
import {access} from '../netlify/functions/access.mjs';
import {issueSession,authenticated,sessionCookie} from '../netlify/lib/access.mjs';
import {ObservationGate,observationCommand,asksHistory,currentViewIntent} from '../web/interaction.mjs';
import {ForegroundWake,wakeText} from '../web/wake.mjs';
import {understand} from '../netlify/functions/vision.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {readEvents} from '../web/stream.mjs';
import {SceneSpeech} from '../web/scene-speech.mjs';

const storage=()=>{const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),map};};
const key='sk-offline-test-only-xxxxxxxxxxxxxxxx';
const request=(body,origin='https://example.netlify.app',cookie=sessionCookie(issueSession(serverEnv)))=>new Request('https://example.netlify.app/api/realtime/sdp',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
const config={key,workspace:'ws-test-fixture',region:'beijing',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'};
const serverEnv={DASHSCOPE_API_KEY:key,DASHSCOPE_WORKSPACE_ID:config.workspace,APP_ACCESS_CODE:'fixture-access-code'};

test('memory is pending until confirmation and survives a new instance',()=>{
  const data=storage(),m=new Memory(data,()=>1000000,()=>String(Math.random()));
  m.prepare({action:'record',name:'钥匙',location:'玄关桌上',event_time:'昨天'});
  assert.equal(m.get('钥匙'),null);
  m.confirm(m.pending.token);
  const next=new Memory(data);
  assert.equal(next.get('钥匙').location,'玄关桌上');
  assert.match(next.answer('钥匙'),/还没有确认现在的位置/);
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
test('SDP exchange permits only same-origin and validated Alibaba workspace targets',async()=>{
  let calls=0;const noFetch=async()=>{calls++;throw Error('unexpected network');};
  assert.equal((await exchange(request(config,'https://evil.example'),noFetch,serverEnv)).status,403);
  assert.equal((await exchange(request(config,'https://example.netlify.app',''),noFetch,serverEnv)).status,401);
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
  let loggedIn=false;
  const fetcher=async(url,options={})=>{
    if(url==='/api/vision')return Response.json({answer:'测试桌面有电脑、水杯和眼镜。水杯在电脑左侧。',objects:[{name:'水杯',position:'电脑左侧'}],source:'current_camera_frame'});
    assert.equal(url,'/api/access');
    if(options.method==='POST'){assert.deepEqual(JSON.parse(options.body),{accessCode:'fixture-access-code'});loggedIn=true;}
    if(options.method==='DELETE')loggedIn=false;
    return Response.json({configured:true,authenticated:loggedIn,fixedKey:true});
  };
  const runtime=createRuntime({storage:data,document,fetch:fetcher,RTCPeerConnection:class{},...options});
  return {runtime,data,preview,audio,document};
}
test('fixed key is never entered or persisted by browser and device logout clears access',async()=>{
  const {runtime,data}=runtimeFixture();await runtime.loaded;await runtime.api('/api/config',{accessCode:'fixture-access-code'});
  assert.equal(runtime.status().configured,true);assert.ok(!JSON.stringify([...data.map]).includes(key));
  await runtime.api('/api/config',null,'DELETE');assert.equal(runtime.status().configured,false);
});
test('public status never exposes backend key, workspace or access code',async()=>{
  const response=await access(new Request('https://example.netlify.app/api/access'),serverEnv);
  const text=await response.text();assert.ok(!text.includes(key));assert.ok(!text.includes(serverEnv.APP_ACCESS_CODE));assert.ok(!text.includes(config.workspace));
});
test('access creates HttpOnly secure session that survives requests, rejects forgery and expires',async()=>{
  const req=new Request('https://example.netlify.app/api/access',{method:'POST',headers:{Origin:'https://example.netlify.app'},body:JSON.stringify({accessCode:serverEnv.APP_ACCESS_CODE})});
  const response=await access(req,serverEnv);assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);
  const page=new Request('https://example.netlify.app/api/access',{headers:{Cookie:cookie}});
  assert.equal(authenticated(page,serverEnv),true);
  assert.equal(authenticated(page,serverEnv,Date.now()+31*86400000),false);
  const forged=new Request(page.url,{headers:{Cookie:cookie.replace('spatial_access=','spatial_access=9')}});assert.equal(authenticated(forged,serverEnv),false);
});
test('missing backend protection fails closed even with client-provided key',async()=>{
  let network=0;const result=await exchange(request(config),async()=>{network++;},{DASHSCOPE_API_KEY:key,DASHSCOPE_WORKSPACE_ID:config.workspace});
  assert.equal(result.status,503);assert.equal(network,0);
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

test('microphone attachment waits for outgoing audio before permitting video startup',async()=>{
  const {runtime}=runtimeFixture();const bridge=new runtime.Bridge();bridge.configured=true;
  const track={readyState:'live'};let attached=false,reads=0;
  bridge.audioSender={replaceTrack:async()=>{attached=true;},getStats:async()=>{reads++;return new Map([['audio',{type:'outbound-rtp',kind:'audio',bytesSent:attached?100:0}]]);}};
  await bridge.attachAudio({getAudioTracks:()=>[track],getTracks:()=>[track]});
  assert.equal(attached,true);assert.ok(reads>=2);bridge.close();
});
test('native video uses a clone and stopping it leaves local preview capture owned by UI',async()=>{
  const {runtime,preview}=runtimeFixture();const bridge=new runtime.Bridge();bridge.mode='video';bridge.configured=true;
  let cloneStopped=false,sourceStopped=false;
  preview.srcObject={getVideoTracks:()=>[{readyState:'live',stop(){sourceStopped=true;},clone:()=>({stop(){cloneStopped=true;}})}]};
  bridge.videoSender={replaceTrack:async()=>{},getParameters:()=>({encodings:[]})};
  await bridge.attachVideo();bridge.clearVideoTrack();assert.equal(cloneStopped,true);assert.equal(sourceStopped,false);bridge.close();
});
test('session tools keep visual and memory permissions separate',()=>{
  assert.deepEqual(sessionConfig('video').session.tools.map(t=>t.function.name),['stop_video','request_observation']);
  assert.ok(!sessionConfig('memory').session.tools.some(t=>t.function.name==='stop_video'));
});

test('combined session can observe and remember, with explicit confirmation before saving',()=>{
  assert.deepEqual(sessionConfig('assistant').session.tools.map(t=>t.function.name),['stop_video','query_memory','list_memories','prepare_memory','request_observation']);
  const {runtime}=runtimeFixture();const bridge=new runtime.Bridge();bridge.mode='assistant';
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

test('combined session supports native video without stopping the original preview track',async()=>{
  const {runtime,preview}=runtimeFixture();const bridge=new runtime.Bridge();bridge.mode='assistant';bridge.configured=true;
  let stopped=false;preview.srcObject={getVideoTracks:()=>[{readyState:'live',clone:()=>({stop(){stopped=true;}})}]};
  bridge.videoSender={replaceTrack:async()=>{},getParameters:()=>({encodings:[]})};
  await bridge.attachVideo();bridge.endVideo('观察结束，语音继续');
  assert.equal(stopped,true);assert.equal(bridge.closed,false);bridge.close();
});

class TestGate{
  constructor(){this.config=null;}
  start(config){this.config=config;}
  stop(){this.config=null;}
}
const visualFixture=(options={})=>{
  const fixture=runtimeFixture({ObservationGate:TestGate,captureFrame:()=>'/9j/test-jpeg',...options});
  const bridge=new fixture.runtime.Bridge();bridge.mode='assistant';bridge.configured=true;
  const sent=[],events=[];bridge.channel={readyState:'open',send:e=>sent.push(JSON.parse(e))};bridge.onmessage=e=>events.push(JSON.parse(e.data));
  fixture.preview.srcObject={getVideoTracks:()=>[{readyState:'live',clone:()=>({stop(){}})}]};
  bridge.videoSender={replaceTrack:async()=>{},getParameters:()=>({encodings:[]})};
  return {...fixture,bridge,sent,events};
};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const toolCall=(bridge,name,args,id)=>bridge.event({type:'response.done',response:{output:[{type:'function_call',call_id:id,name,arguments:JSON.stringify(args)}]}},bridge.channel);

test('two and five minute observations are accepted and preserve manual stop',async()=>{
  for(const duration of [120,300]){
    const {bridge}=visualFixture();bridge.send(JSON.stringify({type:'video_start',id:'long-view',duration}));await settle();
    assert.equal(bridge.videoId,'long-view');bridge.send(JSON.stringify({type:'video_stop',id:'long-view'}));
    assert.equal(bridge.videoId,null);assert.equal(bridge.closed,false);bridge.close();
  }
});

test('long frame timers continue past 30 seconds and stop exactly at their configured deadline',()=>{
  for(const duration of [120,300]){
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

test('automatic scene description starts only after usable frames, once per observation',async()=>{
  const {bridge,sent}=visualFixture();
  bridge.send(JSON.stringify({type:'video_start',id:'scene-one',duration:30}));await settle();
  assert.equal(sent.filter(e=>e.type==='response.create').length,0);
  bridge.scene.config.onReady();
  await settle();
  assert.equal(sent.filter(e=>e.type==='response.create').length,0);
  assert.ok(sent.some(e=>e.type==='session.update'&&e.session.instructions.includes('测试桌面')));
  bridge.event({type:'session.updated'},bridge.channel);
  assert.equal(sent.filter(e=>e.type==='response.create').length,1);
  assert.match(sent.find(e=>e.item?.content?.[0]?.text)?.item.content[0].text,/直接语音播报/);
  bridge.event({type:'response.created'},bridge.channel);bridge.event({type:'response.done',response:{}},bridge.channel);
  assert.equal(sent.filter(e=>e.type==='response.create').length,1);bridge.close();
});

test('spoken input suppresses automatic description instead of overlapping the user reply',async()=>{
  const {bridge,sent}=visualFixture();bridge.send(JSON.stringify({type:'video_start',id:'scene-two',duration:30}));await settle();
  bridge.event({type:'input_audio_buffer.speech_started'},bridge.channel);bridge.scene.config.onReady();
  assert.equal(sent.filter(e=>e.type==='response.create').length,0);bridge.close();
});

const fastFixture=(options={})=>{
  const fixture=visualFixture({supportsSpeech:true,...options});const original=fixture.document.getElementById;
  fixture.document.getElementById=id=>id==='fast-describe'?{checked:true}:original(id);return fixture;
};
test('fast visual speech starts at the vision result without a second model response or context acknowledgement',async()=>{
  const {bridge,sent,events}=fastFixture();bridge.send(JSON.stringify({type:'video_start',id:'fast-view',duration:120}));await settle();bridge.scene.config.onReady();await settle();
  const answer=events.find(e=>e.type==='app.scene_answer');assert.ok(answer);assert.match(answer.answer,/水杯/);
  assert.equal(bridge.pendingInstructions,true);assert.equal(sent.filter(e=>e.type==='response.create').length,0);
  bridge.finishLocalSpeech(answer.token);bridge.event({type:'session.updated'},bridge.channel);
  assert.equal(bridge.visualPending,false);assert.equal(sent.filter(e=>e.type==='response.create').length,0);
  bridge.send(JSON.stringify({type:'text',text:'你好'}));assert.equal(sent.filter(e=>e.type==='response.create').length,1);bridge.close();
});
test('late device speech callbacks cannot clear a newer visual request',async()=>{
  const {bridge,events}=fastFixture();bridge.send(JSON.stringify({type:'video_start',id:'speech-view',duration:120}));await settle();bridge.scene.config.onReady();await settle();
  const answer=events.find(e=>e.type==='app.scene_answer');bridge.requestCurrentView('找眼镜');bridge.finishLocalSpeech(answer.token);
  assert.equal(bridge.visualPending,true);bridge.close();
});
test('failed device speech falls back to the cloud voice once',async()=>{
  const {bridge,sent,events}=fastFixture();bridge.send(JSON.stringify({type:'video_start',id:'fallback-view',duration:120}));await settle();bridge.scene.config.onReady();await settle();
  const answer=events.find(e=>e.type==='app.scene_answer');bridge.finishLocalSpeech(answer.token,true);bridge.event({type:'session.updated'},bridge.channel);
  assert.equal(sent.filter(e=>e.type==='response.create').length,1);bridge.finishLocalSpeech(answer.token,true);
  assert.equal(sent.filter(e=>e.type==='response.create').length,1);bridge.close();
});

test('readable local preview does not wait for remote video statistics',async()=>{
  let now=0,task,ready=0;const gate=new ObservationGate({requireTransmission:false,settleMs:100,now:()=>now,schedule:fn=>(task=fn,1),cancel:()=>{}});
  const preview={videoWidth:640,videoHeight:480,readyState:2,paused:false,srcObject:{getVideoTracks:()=>[{readyState:'live',muted:false}]}};
  gate.start({preview,sender:{getStats:()=>assert.fail('preview snapshot must not depend on RTP')},baseline:{bytes:100},stillCurrent:()=>true,onReady:()=>ready++,onError:()=>assert.fail('unexpected timeout')});
  now=100;await task();assert.equal(ready,1);gate.stop();
});

test('fresh observation tool waits for frames, then resumes the original question',async()=>{
  const {bridge,sent,events}=visualFixture();toolCall(bridge,'request_observation',{goal:'找水杯'},'look');
  assert.ok(events.some(e=>e.type==='app.observe'&&e.goal==='找水杯'));
  assert.equal(sent.filter(e=>e.item?.call_id==='look').length,0);
  bridge.send(JSON.stringify({type:'video_start',id:'find-cup',duration:30}));await settle();bridge.scene.config.onReady();
  await settle();bridge.event({type:'session.updated'},bridge.channel);
  const result=JSON.parse(sent.find(e=>e.item?.call_id==='look').item.output);
  assert.equal(result.camera_active,true);assert.equal(result.reference,'镜头画面');
  assert.equal(sent.filter(e=>e.type==='response.create').length,1);bridge.close();
});

test('failed observation never announces a successful description',async()=>{
  const {bridge,sent}=visualFixture();toolCall(bridge,'request_observation',{goal:'找水杯'},'failed-look');
  bridge.send(JSON.stringify({type:'video_start',id:'failed-frame',duration:30}));await settle();bridge.scene.config.onError('无画面');
  const result=JSON.parse(sent.find(e=>e.item?.call_id==='failed-look').item.output);
  assert.equal(result.camera_active,false);assert.equal(result.error,'无画面');assert.equal(bridge.lastObservedAt,null);bridge.close();
});

test('current visual location never exposes historical records, explicit history still works',()=>{
  const {runtime,bridge,sent}=visualFixture();runtime.memory.prepare({action:'record',name:'水杯',location:'以前的柜子'});runtime.memory.confirm(runtime.memory.pending.token);
  bridge.videoId='live-view';bridge.lastUserText='水杯在哪里';toolCall(bridge,'query_memory',{name:'水杯'},'current');
  const current=JSON.parse(sent.find(e=>e.item?.call_id==='current').item.output);assert.equal(current.use_current_view,true);assert.equal(current.record,undefined);
  bridge.videoId=null;bridge.lastUserText='水杯现在在哪里';toolCall(bridge,'query_memory',{name:'水杯'},'closed-view');
  assert.equal(JSON.parse(sent.find(e=>e.item?.call_id==='closed-view').item.output).requires_observation,true);
  bridge.lastUserText='之前记录的水杯在哪里';toolCall(bridge,'query_memory',{name:'水杯'},'history');
  const history=JSON.parse(sent.find(e=>e.item?.call_id==='history').item.output);assert.equal(history.record.location,'以前的柜子');assert.equal(history.is_current,false);bridge.close();
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
  bridge.send(JSON.stringify({type:'video_start',id:'new-view',duration:30}));await settle();bridge.scene.config.onReady();await settle();
  bridge.event({type:'session.updated'},bridge.channel);bridge.event({type:'response.created'},bridge.channel);
  assert.equal(audio.muted,false);bridge.event({type:'response.text.done',text:'当前画面中的水杯在电脑左侧'},bridge.channel);
  assert.ok(events.some(e=>e.text==='当前画面中的水杯在电脑左侧'));assert.ok(!events.some(e=>e.text==='旧位置'));bridge.close();
});

test('a late vision result after closing the camera cannot become a current observation',async()=>{
  let finish;
  const {bridge,events}=visualFixture({fetch:async(url)=>url==='/api/vision'?await new Promise(resolve=>finish=resolve):Response.json({configured:true,authenticated:true})});
  bridge.send(JSON.stringify({type:'video_start',id:'cancelled-view',duration:30}));await settle();bridge.scene.config.onReady();await settle();
  bridge.endVideo('已停止');finish(Response.json({answer:'水杯在电脑左侧',objects:[]}));await settle();
  assert.equal(bridge.lastObservedAt,null);assert.ok(!events.some(e=>e.type==='app.scene_ready'));bridge.close();
});

const jpeg='/9j/2Q==';
const visionRequest=(body,cookie=sessionCookie(issueSession(serverEnv)))=>new Request('https://example.netlify.app/api/vision',{method:'POST',headers:{Origin:'https://example.netlify.app',Cookie:cookie},body:JSON.stringify(body)});
test('vision requires access, rejects remote image URLs and keeps the endpoint fixed',async()=>{
  let calls=0;const unused=async()=>{calls++;throw Error('must not fetch');};
  assert.equal((await understand(visionRequest({image:jpeg},''),unused,serverEnv)).status,401);
  assert.equal((await understand(visionRequest({image:'https://evil.example/private'}),unused,serverEnv)).status,400);
  assert.equal(calls,0);
  const result=await understand(visionRequest({image:jpeg,workspace:'evil',key:'ignored'}),async(url,options)=>{
    assert.equal(url,'https://ws-test-fixture.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
    assert.equal(options.headers.Authorization,'Bearer '+key);assert.equal(options.redirect,'error');
    const payload=JSON.parse(options.body);assert.equal(payload.model,'qwen3.6-flash');assert.equal(payload.enable_thinking,false);
    assert.equal(payload.messages[1].content[0].image_url.url,'data:image/jpeg;base64,'+jpeg);
    return Response.json({choices:[{message:{content:JSON.stringify({answer:'水杯在电脑左侧。',objects:[{name:'水杯',position:'电脑左侧'}]})}}]});
  },serverEnv);
  assert.equal(result.status,200);const text=await result.text();assert.ok(!text.includes(key));assert.ok(!text.includes(serverEnv.APP_ACCESS_CODE));assert.match(text,/current_camera_frame/);
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
  bridge.send(JSON.stringify({type:'video_start',id:'stream-view',duration:120}));await settle();bridge.scene.config.onReady();await settle();
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
