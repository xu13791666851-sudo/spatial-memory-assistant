import test from 'node:test';
import assert from 'node:assert/strict';
import {Memory,rememberCommand} from '../web/memory.mjs';
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
import {interfaceCommand} from '../web/interface-commands.mjs';

const storage=()=>{const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),map};};

test('interface commands are narrow and leave ordinary object and cancellation requests alone',()=>{
  assert.deepEqual(interfaceCommand('小忆，请打开记录。'),{type:'records',tab:'chat'});
  assert.deepEqual(interfaceCommand('我记过什么'),{type:'records',tab:'memory',read:true});
  assert.deepEqual(interfaceCommand('放大画面'),{type:'camera',view:'video'});
  assert.equal(interfaceCommand('水杯在记录本旁边'),null);
  assert.equal(interfaceCommand('不要记住'),null);
  assert.deepEqual(interfaceCommand('取消'),{type:'cancel-confirmation'});
});

test('record browsing commands preserve a pending observation and current find target',()=>{
  const {runtime}=runtimeFixture(),bridge=new runtime.Bridge();bridge.mode='assistant';
  bridge.requestCurrentView=()=>{};bridge.send(JSON.stringify({type:'text',text:'找蓝色水杯'}));
  assert.equal(runtime.taskState().target,'蓝色水杯');
  let aborted=false;const scene={controller:{abort(){aborted=true;}}};bridge.sceneCommit=scene;
  const events=[];bridge.onmessage=e=>events.push(JSON.parse(e.data));
  bridge.send(JSON.stringify({type:'text',text:'打开记录'}));
  assert.equal(aborted,false);assert.equal(bridge.sceneCommit,scene);assert.equal(runtime.taskState().target,'蓝色水杯');
  bridge.event({type:'conversation.item.input_audio_transcription.completed',transcript:'放大画面'});
  assert.equal(events.filter(e=>e.type==='app.interface_command').length,2);
  assert.equal(aborted,false);assert.equal(runtime.taskState().target,'蓝色水杯');bridge.close();
});

test('direct memory edits persist renames, preserve placement time and reject stale or colliding records',()=>{
  const data=storage(),m=new Memory(data);m.remember('记住，水杯放在电脑左侧');m.remember('记住，耳机盒放在书本前面');
  const original=m.get('水杯');const result=m.edit({id:original.id,recorded_at:original.recorded_at,name:'蓝色水杯',location:'电脑左侧，台灯旁边，书本前面',appearance:'蓝色带把手'});
  assert.equal(result.saved,true);assert.equal(new Memory(data).all().length,2);assert.equal(m.get('蓝色水杯').appearance,'蓝色带把手');
  assert.equal(m.get('蓝色水杯').event_time,original.event_time);assert.equal(m.get('水杯').name,'蓝色水杯');
  assert.throws(()=>m.edit({...original,recorded_at:original.recorded_at,name:'水杯',location:'旧位置'}),/已经变化/);
  const current=m.get('蓝色水杯');assert.throws(()=>m.edit({...current,name:'耳机盒',location:'别处'}),/同名/);
});

test('failed memory edit leaves the original record and never acknowledges persistence',()=>{
  const data=storage(),m=new Memory(data);m.remember('记住，钥匙放在桌上');const original=m.get('钥匙');
  data.setItem=()=>{throw Error('quota');};assert.throws(()=>m.edit({...original,location:'抽屉'}));assert.equal(m.get('钥匙').location,'桌上');
});

test('editing legacy memories without ids uses the original name instead of another same-time record',()=>{
  const data=storage(),records=['钥匙','眼镜'].map(name=>({name,location:'桌上',event_time:'昨天',recorded_at:'2026-10-13T08:00:00.000Z',source:'MANUAL',state:'HISTORICAL'}));
  data.setItem('spatial-memory.records.v1',JSON.stringify(records));const m=new Memory(data);
  m.edit({recorded_at:records[0].recorded_at,original_name:'钥匙',name:'蓝色钥匙',location:'玄关抽屉'});
  assert.equal(m.get('眼镜').location,'桌上');assert.equal(m.get('蓝色钥匙').location,'玄关抽屉');assert.equal(m.all().length,2);
});
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
test('scene commands accept natural speech without misreading object questions',()=>{
  for(const text of ['请切换到家中场景','我回家了','小忆，我现在在家','帮我切换到家里'])assert.equal(placeIntent(text),'home');
  for(const text of ['切换到普通场景','我现在出门了','进入户外模式','请切到外出场景'])assert.equal(placeIntent(text),'explore');
  for(const text of ['我在家里的水杯在哪','普通场景有什么物品','记住家里的钥匙','到家后帮我找杯子'])assert.equal(placeIntent(text),null);
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
  const fixtureFetch=async(url,init)=>{
    const response=await (options.fetch||fetcher)(url,init);
    if(url!=='/api/vision'||!response.ok||options.rawVision)return response;
    return Response.json({...await response.json(),request_id:JSON.parse(init.body).request_id,frame_received:true,frame_status:'clear'});
  };
  const runtime=createRuntime({storage:data,document,RTCPeerConnection:class{},...options,fetch:fixtureFetch});
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
test('ordinary scenes deny writes but explicit history questions can recall home records',()=>{
  const {runtime}=runtimeFixture();const bridge=new runtime.Bridge();bridge.mode='assistant';
  const events=[];bridge.onmessage=e=>events.push(JSON.parse(e.data));
  const sent=[];bridge.channel={readyState:'open',send:e=>sent.push(JSON.parse(e))};
  bridge.event({type:'response.done',response:{output:[{type:'function_call',call_id:'write',name:'prepare_memory',arguments:JSON.stringify({action:'record',name:'钥匙',location:'玄关'})}]}},bridge.channel);
  assert.equal(runtime.memory.pending,null);
  assert.match(JSON.parse(sent.find(e=>e.item?.call_id==='write').item.output).error,/切换到家/);
  runtime.setPlace('home');runtime.memory.prepare({action:'record',name:'钥匙',location:'玄关'});runtime.memory.confirm(runtime.memory.pending.token);
  runtime.setPlace('explore');bridge.send(JSON.stringify({type:'text',text:'之前记录的钥匙在哪里'}));
  bridge.event({type:'response.done',response:{output:[{type:'function_call',call_id:'read',name:'query_memory',arguments:'{"name":"钥匙"}'}]}},bridge.channel);
  assert.match(events.findLast(e=>e.type==='app.memory_result').answer,/钥匙在玄关/);
  assert.match(events.findLast(e=>e.type==='app.memory_result').answer,/还没有确认现在/);
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
  assert.equal(sent.some(e=>e.type==='response.cancel'),false);
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

test('quiet camera startup waits for a spoken observation request',async()=>{
  const {bridge,events}=visualFixture();
  bridge.send(JSON.stringify({type:'video_start',id:'quiet-view',duration:120,describe:false}));await settle();
  assert.ok(!bridge.scene.config);
  assert.equal(events.find(e=>e.type==='app.video_started').describe,false);
  bridge.event({type:'conversation.item.input_audio_transcription.completed',transcript:'眼前有什么'},bridge.channel);
  assert.ok(bridge.scene.config);bridge.scene.config.onReady();await settle();
  assert.equal(events.filter(e=>e.type==='app.scene_fallback').length,1);bridge.close();
});

test('two, five and ten minute observations are accepted and preserve manual stop',async()=>{
  for(const duration of [120,300,600]){
    const {bridge}=visualFixture();bridge.send(JSON.stringify({type:'video_start',id:'long-view',duration}));await settle();
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

test('automatic scene description answers locally as soon as the frame is understood',async()=>{
  const {bridge,sent,events}=visualFixture();
  bridge.send(JSON.stringify({type:'video_start',id:'scene-one',duration:30}));await settle();
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

test('spoken input suppresses automatic description instead of overlapping the user reply',async()=>{
  const {bridge,sent}=visualFixture();bridge.send(JSON.stringify({type:'video_start',id:'scene-two',duration:30}));await settle();
  const stale=bridge.scene.config;bridge.event({type:'input_audio_buffer.speech_started'},bridge.channel);stale.onReady();
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

test('fresh observation tool waits for frames, then answers directly from the current frame',async()=>{
  const {bridge,sent,events}=visualFixture();toolCall(bridge,'request_observation',{goal:'找水杯'},'look');
  assert.ok(events.some(e=>e.type==='app.observe'&&e.goal==='找水杯'));
  assert.equal(sent.filter(e=>e.item?.call_id==='look').length,0);
  bridge.send(JSON.stringify({type:'video_start',id:'find-cup',duration:30}));await settle();bridge.scene.config.onReady();
  await settle();bridge.event({type:'session.updated'},bridge.channel);
  const result=JSON.parse(sent.find(e=>e.item?.call_id==='look').item.output);
  assert.equal(result.camera_active,true);assert.equal(result.reference,'镜头画面');
  assert.equal(sent.filter(e=>e.type==='response.create').length,0);
  assert.match(events.find(e=>e.type==='app.scene_fallback').answer,/水杯/);bridge.close();
});

test('failed observation never announces a successful description',async()=>{
  const {bridge,sent}=visualFixture();toolCall(bridge,'request_observation',{goal:'找水杯'},'failed-look');
  bridge.send(JSON.stringify({type:'video_start',id:'failed-frame',duration:30}));await settle();bridge.scene.config.onError('无画面');
  const result=JSON.parse(sent.find(e=>e.item?.call_id==='failed-look').item.output);
  assert.equal(result.camera_active,false);assert.equal(result.error,'无画面');assert.equal(bridge.lastObservedAt,null);bridge.close();
});

test('current visual location never exposes historical records, explicit history still works',()=>{
  const {runtime,bridge,sent}=visualFixture({place:'home'});runtime.memory.prepare({action:'record',name:'水杯',location:'以前的柜子'});runtime.memory.confirm(runtime.memory.pending.token);
  bridge.videoId='live-view';bridge.lastUserText='水杯现在在哪里';toolCall(bridge,'query_memory',{name:'水杯'},'current');
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
  bridge.send(JSON.stringify({type:'text',text:'我现在需要找钥匙'}));
  bridge.send(JSON.stringify({type:'video_start',id:'home-key',duration:30,goal:'找钥匙'}));await settle();bridge.scene.config.onReady();await settle();
  const answer=events.find(e=>e.type==='app.scene_fallback')?.answer||'';
  assert.match(answer,/当前画面没有看到钥匙/);assert.match(answer,/上次记录钥匙在玄关桌上/);assert.match(answer,/不能确认/);
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
  bridge.send(JSON.stringify({type:'video_start',id:'fast-home-key',duration:30,goal:'找钥匙'}));await settle();bridge.scene.config.onReady();await settle();
  assert.equal(requestedStream,undefined);
  const spoken=events.find(e=>e.type==='app.scene_answer');assert.match(spoken.answer,/上次记录钥匙在玄关桌上/);
  assert.match(spoken.answer,/不能确认/);bridge.close();
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
  assert.ok(events.some(e=>e.type==='app.observe'&&/寻找水杯/.test(e.goal)));
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
const visionRequest=(body,origin='https://example.netlify.app')=>new Request('https://example.netlify.app/api/vision',{method:'POST',headers:{Origin:origin},body:JSON.stringify(body)});



const sse=value=>'data: '+JSON.stringify(value)+'\n\n';
test('stream parser handles split Chinese bytes and CRLF safely',async()=>{
  const bytes=new TextEncoder().encode((sse({type:'delta',text:'电脑与水杯。'})+'data: [DONE]\n\n').replaceAll('\n','\r\n'));
  const body=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=3)c.enqueue(bytes.slice(i,i+3));c.close();}});
  const events=[];for await(const event of readEvents(body))events.push(event);
  assert.deepEqual(events,[{type:'delta',text:'电脑与水杯。'}]);
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

// User-authorized visual memory and multi-turn finding regression suite.
const candidate={unique:true,location_supported:true,anchor:'木桌',location:'木桌上，纸巾盒旁边'};
const seenCup={answer:'蓝色杯子在木桌上，纸巾盒旁边。',objects:[{name:'木桌',position:'画面中间'},{name:'纸巾盒',position:'桌面上'}],target_visible:true,memory_candidate:candidate};
const missingCup={answer:'当前画面没有看到蓝色杯子。',objects:[{name:'木桌',position:'画面中间'}],target_visible:false};
const say=(bridge,text)=>bridge.event({type:'conversation.item.input_audio_transcription.completed',transcript:text},bridge.channel);
async function finishPicture(bridge,id='dialogue-view'){
  if(!bridge.videoId){bridge.send(JSON.stringify({type:'video_start',id,duration:120}));await settle();}
  bridge.scene.config.onReady();await settle();
}
const lastAnswer=events=>events.findLast(e=>['app.scene_fallback','app.scene_answer','app.memory_result'].includes(e.type))?.answer||'';

test('spoken visual remember commits before acknowledgement, survives new runtime and recalls a shorter name',async t=>{
  const bodies=[];
  const {runtime,bridge,events,data}=visualFixture({fetch:async(url,opts)=>{
    if(url==='/api/vision'){bodies.push(JSON.parse(opts.body));return Response.json(seenCup);}
    return Response.json({configured:true,authenticated:true});
  }});t.after(()=>bridge.close());runtime.setPlace('home');
  say(bridge,'帮我记住这个蓝色玻璃杯的位置');assert.equal(runtime.memory.all().length,0);
  await finishPicture(bridge);
  assert.equal(bodies[0].task.remember,true);assert.equal(bodies[0].task.target,'蓝色玻璃杯');assert.equal(bodies[0].stream,undefined);
  assert.match(lastAnswer(events),/^已记住/);assert.equal(runtime.memory.pending,null);
  const record=new Memory(data).get('玻璃杯');assert.equal(record.location,candidate.location);assert.equal(record.source,'USER_REQUESTED_VISUAL');assert.ok(record.object_id);
  say(bridge,'玻璃杯在哪');assert.match(lastAnswer(events),/木桌上，纸巾盒旁边/);assert.match(lastAnswer(events),/还没有确认现在的位置/);
  const reloaded=runtimeFixture({storage:data}).runtime;reloaded.setPlace('home');
  const result=await reloaded.api('/api/command',{text:'刚才让你记住的杯子在哪'});assert.match(result.answer,/木桌上/);
});

test('find dialogue retains target and uses fresh pictures across follow-ups without rewriting memory',async t=>{
  let result=missingCup;const targets=[];
  const {runtime,bridge,events}=visualFixture({fetch:async(url,opts)=>{
    if(url==='/api/vision'){targets.push(JSON.parse(opts.body).task.target);return Response.json(result);}
    return Response.json({configured:true,authenticated:true});
  }});t.after(()=>bridge.close());runtime.setPlace('home');runtime.memory.remember('记住，蓝色玻璃杯放在木桌上，纸巾盒旁边');
  const before=JSON.stringify(runtime.memory.rows());say(bridge,'我现在需要找玻璃杯');await finishPicture(bridge);
  assert.match(lastAnswer(events),/上次记录蓝色玻璃杯/);assert.match(lastAnswer(events),/可以把镜头对准/);
  result={...missingCup,next_step:{kind:'reframe',anchor:'木桌',question:'木桌右边没有拍全，可以把镜头稍微向右转吗？'}};
  say(bridge,'已经对准了');await finishPicture(bridge);assert.match(lastAnswer(events),/右边没有拍全/);assert.doesNotMatch(lastAnswer(events),/上次记录/);
  result=missingCup;say(bridge,'这里没有');await finishPicture(bridge);assert.match(lastAnswer(events),/后来有没有/);
  say(bridge,'可能拿到厨房了');assert.match(lastAnswer(events),/作为这次寻找的线索/);
  result=seenCup;say(bridge,'这样呢');await finishPicture(bridge);assert.match(lastAnswer(events),/符合.*玻璃杯/);assert.doesNotMatch(lastAnswer(events),/不能确认是同一件/);
  assert.deepEqual(targets,['蓝色玻璃杯','蓝色玻璃杯','蓝色玻璃杯','蓝色玻璃杯']);assert.equal(JSON.stringify(runtime.memory.rows()),before);
});

test('ambiguous or unclear visual memories ask for missing information and save only after a fresh disambiguated frame',async t=>{
  let result={...seenCup,memory_candidate:{unique:false,location_supported:false}};const bodies=[];
  const {runtime,bridge,events}=visualFixture({fetch:async(url,opts)=>{
    if(url==='/api/vision'){bodies.push(JSON.parse(opts.body));return Response.json(result);}
    return Response.json({configured:true,authenticated:true});
  }});t.after(()=>bridge.close());runtime.setPlace('home');say(bridge,'记住这个蓝色玻璃杯的位置');await finishPicture(bridge);
  assert.equal(runtime.memory.all().length,0);assert.match(lastAnswer(events),/还没有保存/);assert.match(lastAnswer(events),/哪一个/);
  result=seenCup;say(bridge,'左边那个');await finishPicture(bridge);
  assert.match(bodies[1].goal,/左边那个/);assert.match(lastAnswer(events),/^已记住/);assert.equal(runtime.memory.all().length,1);
});

test('missing target, weak anchor and storage failure cannot say saved',async t=>{
  for(const result of [missingCup,{...seenCup,memory_candidate:{...candidate,location_supported:false}},{...seenCup,memory_candidate:{...candidate,anchor:'左边',location:'左边'}}]){
    const {runtime,bridge,events}=visualFixture({fetch:async url=>Response.json(url==='/api/vision'?result:{configured:true,authenticated:true})});t.after(()=>bridge.close());
    runtime.setPlace('home');say(bridge,'记住这个杯子的位置');await finishPicture(bridge);
    assert.equal(runtime.memory.all().length,0);assert.doesNotMatch(lastAnswer(events),/^已记住/);
  }
  const {runtime,bridge,events}=visualFixture({storage:{getItem:()=>null,setItem:()=>{throw Error('quota');}},fetch:async url=>Response.json(url==='/api/vision'?seenCup:{configured:true,authenticated:true})});t.after(()=>bridge.close());
  runtime.setPlace('home');say(bridge,'记住这个杯子的位置');await finishPicture(bridge);assert.match(lastAnswer(events),/没有保存成功/);assert.equal(runtime.memory.all().length,0);
});

test('cancellation, scene switch, pause, disconnect and new topic discard late visual save results',async t=>{
  for(const action of [b=>say(b,'取消'),(b,r)=>r.setPlace('explore'),b=>b.send(JSON.stringify({type:'pause'})),b=>b.close(),b=>say(b,'今天天气怎么样')]){
    let finish;const {runtime,bridge,events}=visualFixture({fetch:async url=>url==='/api/vision'?new Promise(resolve=>finish=resolve):Response.json({configured:true,authenticated:true})});t.after(()=>bridge.close());
    runtime.setPlace('home');say(bridge,'记住这个杯子的位置');await finishPicture(bridge);
    action(bridge,runtime);finish(Response.json(seenCup));await settle();
    assert.equal(runtime.memory.all().length,0);assert.ok(!events.some(e=>e.answer?.startsWith('已记住')));
  }
});

test('ordinary fresh scenes do not leak home history, while explicit recall works after switching modes',async t=>{
  const {runtime,bridge,events}=visualFixture({fetch:async url=>Response.json(url==='/api/vision'?missingCup:{configured:true,authenticated:true})});t.after(()=>bridge.close());
  runtime.setPlace('home');runtime.memory.remember('记住，蓝色玻璃杯放在私人卧室柜子上');runtime.setPlace('explore');
  say(bridge,'找玻璃杯');await finishPicture(bridge);assert.doesNotMatch(lastAnswer(events),/私人卧室/);
  say(bridge,'之前记住的玻璃杯在哪');assert.match(lastAnswer(events),/私人卧室柜子上/);
  say(bridge,'记住这个杯子的位置');assert.match(lastAnswer(events),/切换到家/);assert.equal(runtime.memory.all().length,1);
});

test('matching ignores deictic words and cup aliases, but never picks one of multiple candidates',()=>{
  const memory=new Memory(storage());memory.remember('记住，这个蓝色玻璃杯放在木桌上');
  assert.equal(memory.get('水杯').name,'蓝色玻璃杯');
  memory.remember('记住，红色杯子放在柜子上');assert.equal(memory.get('杯子'),null);assert.match(memory.answer('杯子'),/你要找哪一个/);
  assert.throws(()=>memory.prepare({action:'delete',name:'杯子'}));
  memory.prepare({action:'delete',name:'蓝色水杯'});memory.confirm(memory.pending.token);
  assert.equal(memory.all().length,1);assert.equal(memory.get('红色杯子').location,'柜子上');
});

test('visual memory intent handles updates without misparsing 现在 as a spoken location',async()=>{
  const {FindDialogue,visualRememberIntent}=await import('../web/find-dialogue.mjs');
  assert.equal(rememberCommand('记住它现在的位置'),null);
  assert.equal(visualRememberIntent('记住它现在的位置','杯子').name,'杯子');
  const memory=new Memory(storage()),d=new FindDialogue(memory,()=>0);
  d.intent('帮我找蓝色杯子','home');const first=d.intent('更新到这里','home');assert.ok(first.task.saveToken);
  const saved=d.complete(first.task,seenCup);assert.equal(saved.saved,true);
  const next=d.intent('记住它现在的位置','home');d.complete(next.task,{...seenCup,memory_candidate:{...candidate,location:'木桌另一端'}});
  assert.equal(memory.all().length,1);assert.equal(memory.get('杯子').object_id,saved.record.object_id);assert.equal(memory.get('杯子').location,'木桌另一端');
});

test('visual save authorization expires without writing a record',async()=>{
  const {FindDialogue}=await import('../web/find-dialogue.mjs');let now=0;
  const memory=new Memory(storage()),d=new FindDialogue(memory,()=>now);const plan=d.intent('记住这个杯子的位置','home');now=300001;
  assert.match(d.complete(plan.task,seenCup).answer,/过期/);assert.equal(memory.all().length,0);
});



test('a selected historical object retains identity when its new visual location is explicitly recorded',async t=>{
  const {runtime,bridge,events}=visualFixture({fetch:async url=>Response.json(url==='/api/vision'?seenCup:{configured:true,authenticated:true})});t.after(()=>bridge.close());
  runtime.setPlace('home');runtime.memory.saveVisual('蓝色玻璃杯',candidate);
  const objectId=runtime.memory.get('杯子').object_id;
  say(bridge,'帮我找杯子');await finishPicture(bridge);
  say(bridge,'记住它现在的位置');await finishPicture(bridge);
  assert.match(lastAnswer(events),/^已记住/);assert.equal(runtime.memory.all().length,1);
  assert.equal(runtime.memory.get('杯子').name,'蓝色玻璃杯');assert.equal(runtime.memory.get('杯子').object_id,objectId);
});

test('ambiguous historical names require selection and do not guess on a follow-up',async t=>{
  const {runtime,bridge,events}=visualFixture();t.after(()=>bridge.close());runtime.setPlace('home');
  runtime.memory.remember('记住，蓝色杯子放在木桌上');runtime.memory.remember('记住，红色杯子放在柜子上');
  say(bridge,'杯子在哪');assert.match(lastAnswer(events),/你要找哪一个/);
  say(bridge,'红色那个');assert.match(lastAnswer(events),/红色杯子在柜子上/);
  say(bridge,'这样呢');assert.equal(bridge.sceneTask.target,'红色杯子');
});

test('an identical reframe question is not repeated indefinitely',async()=>{
  const {FindDialogue}=await import('../web/find-dialogue.mjs');
  const d=new FindDialogue(new Memory(storage()));const plan=d.intent('帮我找杯子','home');
  const result={...missingCup,next_step:{kind:'reframe',anchor:'木桌',question:'可以把木桌拍全吗？'}};
  d.complete(plan.task,result);const second=d.complete(plan.task,result);
  assert.match(second.answer,/最后一次使用/);assert.doesNotMatch(second.answer,/可以把木桌拍全/);
});

test('default cloud reading of a complete memory receipt does not wait for scene context acknowledgement',()=>{
  const {bridge,sent}=visualFixture();bridge.pendingInstructions=true;
  bridge.replayAnswer('已记住：杯子在木桌上。');assert.ok(sent.some(e=>e.type==='response.create'));bridge.close();
});

test('short name matching does not confuse an object with its accessory',()=>{
  const m=new Memory(storage());m.remember('记住，钥匙扣放在桌上');m.remember('记住，蓝色杯子套放在柜子里');
  assert.equal(m.get('钥匙'),null);assert.equal(m.get('杯子'),null);
  m.remember('记住，蓝色玻璃杯放在桌上');assert.equal(m.get('蓝色杯').name,'蓝色玻璃杯');
});

test('replayed transcripts remain marked after speech interrupts the replay',()=>{
 const {bridge,events}=visualFixture();bridge.replayAnswer('已保存的回答');
 bridge.event({type:'response.created',response:{id:'replay-response'}},bridge.channel);
 bridge.event({type:'response.text.delta',response_id:'replay-response',item_id:'replayed-item',delta:'已保存'},bridge.channel);
 assert.equal(events.findLast(e=>e.type==='response.text.delta').replay,true);
 bridge.event({type:'input_audio_buffer.speech_started'},bridge.channel);
 bridge.event({type:'response.text.done',response_id:'replay-response',item_id:'replayed-item',text:'已保存的回答'},bridge.channel);
 bridge.event({type:'conversation.item.input_audio_transcription.completed',transcript:'谢谢'},bridge.channel);
 assert.equal(events.findLast(e=>e.type==='response.text.done').replay,true);
 bridge.event({type:'response.created',response:{id:'new-response'}},bridge.channel);
 bridge.event({type:'response.text.done',response_id:'new-response',item_id:'new-item',text:'不客气'},bridge.channel);
 assert.equal(events.findLast(e=>e.type==='response.text.done').replay,undefined);bridge.close();
});

test('unmatched or unverified image results cannot enter chat or memory',async t=>{
 for(const payload of [{answer:'猜测',request_id:'old',frame_received:true,frame_status:'clear'},{answer:'猜测',frame_received:false}]){
  const {bridge,events}=visualFixture({rawVision:true,fetch:async url=>Response.json(url==='/api/vision'?payload:{configured:true,authenticated:true})});t.after(()=>bridge.close());
  bridge.send(JSON.stringify({type:'video_start',id:'unverified',duration:30}));await settle();bridge.scene.config.onReady();await settle();
  assert.ok(events.some(e=>e.type==='app.video_error'));assert.equal(events.some(e=>e.type==='app.scene_fallback'||e.saved===true),false);assert.ok(!bridge.currentScene);
 }
});

test('failed observation releases visual suppression so ordinary conversation can continue',async t=>{
 const {bridge,events}=visualFixture({fetch:async url=>url==='/api/vision'?Response.json({detail:'这次没有获取到画面'},{status:502}):Response.json({configured:true,authenticated:true})});t.after(()=>bridge.close());
 bridge.send(JSON.stringify({type:'video_start',id:'failed-continue',duration:30}));await settle();bridge.scene.config.onReady();await settle();
 assert.ok(events.some(e=>e.type==='app.video_error'));assert.equal(bridge.visualPending,false);
 bridge.send(JSON.stringify({type:'text',text:'你好'}));assert.equal(bridge.suppressResponse,false);assert.equal(bridge.closed,false);
});

test('visual remember accepts arbitrary item names and persists the requested identity without a second confirmation',async t=>{
 for(const name of ['绿色水杯','黑色耳机','钥匙','一本红色笔记本','充电宝','白色药盒','遥控器','小熊玩偶','我的工具袋']){
  const {runtime,bridge,events,data}=visualFixture({fetch:async url=>Response.json(url==='/api/vision'?seenCup:{configured:true,authenticated:true})});t.after(()=>bridge.close());runtime.setPlace('home');
  say(bridge,`帮我记住${name}的位置`);await finishPicture(bridge);
  assert.equal(new Memory(data).get(name)?.name,name);assert.match(lastAnswer(events),/^已记住/);assert.ok(lastAnswer(events).includes(name));assert.equal(runtime.memory.pending,null);
 }
});

test('phone transcript saves, finds and rechecks fresh frames for spoken and typed follow-ups',async t=>{
 for(const input of ['spoken','typed']){
  let frame=0,result=seenCup;const bodies=[];
  const {runtime,bridge,events,sent}=visualFixture({captureFrame:()=>`/9j/frame-${++frame}`,fetch:async(url,opts)=>{
   if(url==='/api/vision'){bodies.push(JSON.parse(opts.body));return Response.json(result);}
   return Response.json({configured:true,authenticated:true});
  }});t.after(()=>bridge.close());runtime.setPlace('home');
  const speak=text=>input==='spoken'?say(bridge,text):bridge.send(JSON.stringify({type:'text',text}));
  speak('请帮我记住这个杯子的具体位置。');await finishPicture(bridge);
  assert.match(lastAnswer(events),/^已记住/);assert.equal(runtime.memory.all().length,1);
  speak('你帮我记住它的位置。');await finishPicture(bridge);
  assert.match(lastAnswer(events),/^已记住/);assert.equal(runtime.memory.all().length,1);
  const saved=JSON.stringify(runtime.memory.rows());
  result={...missingCup,answer:'本次画面暂未看到白色纸杯。'};
  speak('我现在需要找到他这个白色纸杯的位置，你帮我看一下这个画面里有没有。');await finishPicture(bridge);
  assert.equal(bodies.at(-1).task.target,'白色纸杯');assert.match(lastAnswer(events),/上次记录/);
  const seen={...seenCup,answer:'白色纸杯在木桌上，纸巾盒旁边。'};
  for(const phrase of ['现在没也没有这个杯子吗？','现在也没有吗？','现在看到它了吗？','你帮我看一下这个画面里有没有。']){
   result=seen;speak(phrase);assert.equal(bridge.visualPending,true);await finishPicture(bridge);
   assert.match(lastAnswer(events),/当前画面中看到了符合“白色纸杯”/);
   assert.equal(bodies.at(-1).task.target,'白色纸杯');assert.equal(bodies.at(-1).task.remember,false);
  }
  assert.equal(bodies.length,7);assert.equal(new Set(bodies.map(b=>b.image)).size,7);
  assert.equal(new Set(bodies.map(b=>b.request_id)).size,7);
  assert.ok(bodies.slice(0,2).every(b=>b.task.remember));
  assert.equal(JSON.stringify(runtime.memory.rows()),saved);
  assert.equal(sent.filter(e=>e.type==='response.create').length,0);
 }
});

test('natural requests keep negation, unrelated questions and missing targets out of visual writes',async()=>{
 const {FindDialogue,visualRememberIntent,searchTarget}=await import('../web/find-dialogue.mjs');
 const memory=new Memory(storage()),d=new FindDialogue(memory);
 for(const phrase of ['不要记住这个杯子的位置','我说记住这个杯子的位置','你为什么记住这个杯子的位置']){
  assert.equal(visualRememberIntent(phrase,'杯子'),null);assert.equal(rememberCommand(phrase),null);
 }
 assert.match(d.intent('现在也没有吗？','home').answer,/哪件物品/);
 assert.match(d.intent('你帮我记住它的位置。','home').answer,/物品名称/);
 assert.equal(d.saving,null);assert.equal(memory.all().length,0);
 assert.equal(d.intent('今天的天气怎么样','home'),null);
 assert.equal(rememberCommand('请帮我记住钥匙放在玄关桌上。').name,'钥匙');
 assert.ok(currentViewIntent('你帮我看一下这个画面里有没有白色纸杯'));
 assert.equal(d.intent('再看一下','home'),null);
 assert.deepEqual(observationCommand('小忆'),{goal:''});
 assert.equal(searchTarget('画面里有没有白色纸杯？'),'白色纸杯');
});
test('inconsistent anchor wording requests clarification and retains consent for a fresh corrected frame',async t=>{
 let result={...seenCup,memory_candidate:{...candidate,anchor:'木桌',location:'桌面上，纸巾盒旁边'}};
 const {runtime,bridge,events}=visualFixture({fetch:async url=>Response.json(url==='/api/vision'?result:{configured:true,authenticated:true})});t.after(()=>bridge.close());runtime.setPlace('home');
 say(bridge,'帮我记住绿色水杯的位置');await finishPicture(bridge);
 assert.equal(runtime.memory.all().length,0);assert.match(lastAnswer(events),/拍进来/);assert.doesNotMatch(lastAnswer(events),/保存成功|重新说/);
 result=seenCup;say(bridge,'这样呢');await finishPicture(bridge);
 assert.equal(runtime.memory.get('绿色水杯').location,candidate.location);assert.match(lastAnswer(events),/^已记住：绿色水杯/);
});
test('storage write failures name the actual item and never blame the remember command',async t=>{
 for(const local of [{getItem:()=>null,setItem:()=>{throw Error('QuotaExceededError');}},{getItem:()=>null,setItem:()=>{}}]){
  const {runtime,bridge,events}=visualFixture({storage:local,fetch:async url=>Response.json(url==='/api/vision'?seenCup:{configured:true,authenticated:true})});t.after(()=>bridge.close());runtime.setPlace('home');
  say(bridge,'帮我记住绿色水杯的位置');await finishPicture(bridge);
  assert.match(lastAnswer(events),/浏览器未能读写/);assert.match(lastAnswer(events),/绿色水杯/);assert.doesNotMatch(lastAnswer(events),/重新说“记住这个物品/);assert.equal(runtime.memory.all().length,0);
 }
});
test('generic this item asks for identity when there is no active target',async()=>{
 const {FindDialogue}=await import('../web/find-dialogue.mjs');const memory=new Memory(storage()),dialogue=new FindDialogue(memory);
 assert.match(dialogue.intent('帮我记住这个物品的位置','home').answer,/物品名称/);assert.equal(dialogue.saving,null);
});

test('saved paper cup is recalled from natural typed and spoken questions without a camera or provider call',async t=>{
 for(const input of ['typed','spoken']){
  let visionCalls=0;
  const f=visualFixture({fetch:async url=>{if(url==='/api/vision'){visionCalls++;return Response.json({...seenCup,answer:'白色纸杯在木桌上，纸巾盒旁边。'});}return Response.json({configured:true,authenticated:true});}});
  const {runtime,bridge,events,sent,data}=f;t.after(()=>bridge.close());runtime.setPlace('home');
  const speak=text=>input==='spoken'?say(bridge,text):bridge.send(JSON.stringify({type:'text',text}));
  speak('请帮我记住纸杯的位置');await finishPicture(bridge);assert.equal(runtime.memory.get('纸杯').location,candidate.location);
  bridge.endVideo('摄像头关闭');const saved=data.getItem('spatial-memory.records.v1');
  for(const phrase of ['我不记得放哪里了，你帮我看看之前我放在哪里了','你帮我看看之前我把纸杯放在哪里了','白色纸杯上次放在哪里','我想知道纸杯的位置','帮我找纸杯','它在哪里','我忘了把纸杯放哪了']){
   speak(phrase);assert.match(lastAnswer(events),/纸杯在木桌上，纸巾盒旁边/,phrase);
   assert.match(lastAnswer(events),/还没有确认现在的位置/);assert.equal(events.at(-1).source,'history');
  }
  assert.equal(visionCalls,1);assert.equal(sent.filter(e=>e.type==='response.create').length,0);assert.equal(data.getItem('spatial-memory.records.v1'),saved);
  const reloaded=runtimeFixture({storage:data}).runtime;
  const result=await reloaded.api('/api/command',{text:'你帮我看看之前我把纸杯放在哪里了'});
  assert.match(result.answer,/纸杯在木桌上，纸巾盒旁边/);assert.equal(result.source,'history');
 }
});

test('implicit recall after reload uses a sole record, asks among multiple records and never substitutes an unknown named item',async()=>{
 const {FindDialogue}=await import('../web/find-dialogue.mjs');const data=storage(),memory=new Memory(data);
 memory.remember('记住，纸杯放在书桌旁边');let dialogue=new FindDialogue(new Memory(data));
 assert.match(dialogue.intent('我不记得放哪里了，你帮我看看之前我放在哪里了','home').answer,/纸杯在书桌旁边/);
 memory.remember('记住，钥匙放在抽屉');dialogue=new FindDialogue(new Memory(data));
 const ambiguous=dialogue.intent('我忘了放哪里了','home');assert.match(ambiguous.answer,/哪件物品/);assert.match(ambiguous.answer,/纸杯、钥匙|钥匙、纸杯/);
 dialogue.focus('纸杯');assert.match(dialogue.intent('我的耳机之前放在哪里','home').answer,/没有找到耳机/);
 assert.equal(dialogue.intent('今天的天气怎么样','home'),null);
});

test('history survives current-view misses and uncertainty, and current confirmation always requests new evidence',async t=>{
 let result=missingCup,calls=0;const {runtime,bridge,events}=visualFixture({fetch:async url=>{if(url==='/api/vision'){calls++;return Response.json(result);}return Response.json({configured:true,authenticated:true});}});t.after(()=>bridge.close());
 runtime.setPlace('home');runtime.memory.remember('记住，纸杯放在电脑左边');
 say(bridge,'纸杯现在在哪里');await finishPicture(bridge);assert.match(lastAnswer(events),/上次记录纸杯在电脑左边/);
 say(bridge,'我不记得放哪里了，你帮我看看之前我放在哪里了');assert.match(lastAnswer(events),/纸杯在电脑左边/);assert.equal(calls,1);
 result={answer:'看见白色杯状物，材质无法确认。',objects:[],target_visible:null};say(bridge,'这样呢');await finishPicture(bridge);
 say(bridge,'你还记得纸杯放在哪里吗');assert.match(lastAnswer(events),/纸杯在电脑左边/);assert.equal(calls,2);assert.equal(runtime.memory.get('纸杯').location,'电脑左边');
});

test('memory tool fallback resolves the current object and reads home memory independently of camera state',t=>{
 const {runtime,bridge,sent}=visualFixture({place:'home'});t.after(()=>bridge.close());runtime.memory.remember('记住，纸杯放在电脑左侧');
 for(const [index,phrase]of ['纸杯在哪里','我不记得放哪里了，你帮我看看之前我放在哪里了'].entries()){
  bridge.lastUserText=phrase;toolCall(bridge,'query_memory',{name:'它'},'recall-'+index);
  const result=JSON.parse(sent.find(e=>e.item?.call_id==='recall-'+index).item.output);assert.equal(result.record.name,'纸杯');assert.equal(result.is_current,false);
 }
});

test('camera snapshots preserve detail and adapt size without exceeding the existing request budget',t=>{
 const {runtime,preview,document}=runtimeFixture();const bridge=new runtime.Bridge();t.after(()=>bridge.close());
 Object.assign(preview,{videoWidth:1920,videoHeight:1080,readyState:2,paused:false,srcObject:{getVideoTracks:()=>[{readyState:'live',muted:false}]}});
 const draws=[],encodes=[];let large=false;
 const canvas={getContext:()=>({drawImage(...args){draws.push(args);}}),toDataURL(type,quality){encodes.push({width:canvas.width,height:canvas.height,quality});return 'data:image/jpeg;base64,/9j/'+(large&&canvas.width>640?'A'.repeat(250000):'AAAA');}};
 document.createElement=()=>canvas;
 assert.equal(bridge.captureScene(),'/9j/AAAA');assert.deepEqual(encodes[0],{width:1280,height:720,quality:0.85});
 large=true;assert.equal(bridge.captureScene(),'/9j/AAAA');assert.deepEqual(draws.slice(1).map(a=>a.slice(3)),[[1280,720],[960,540],[640,360]]);
 preview.srcObject=null;assert.throws(()=>bridge.captureScene(),/实时画面/);
});

test('visual save persists appearance, reload sends only selected appearance, and a verified match reports found',async t=>{
 const appearance='浅绿色圆柱杯身，白色杯盖，侧面有一个弧形把手';
 const f=visualFixture({fetch:async url=>Response.json(url==='/api/vision'?{...seenCup,memory_candidate:{...candidate,appearance}}:{configured:true,authenticated:true})});t.after(()=>f.bridge.close());f.runtime.setPlace('home');
 say(f.bridge,'记住绿色水杯的位置');await finishPicture(f.bridge);assert.match(lastAnswer(f.events),/外观也已保存/);
 assert.equal(new Memory(f.data).get('绿色水杯').appearance,appearance);
 const requests=[],comparison={status:'match',unique:true,reason:'浅绿色杯身、白色杯盖和弧形把手均与记录相符'};
 const next=visualFixture({storage:f.data,fetch:async(url,opts)=>{if(url==='/api/vision'){requests.push(JSON.parse(opts.body));return Response.json({...seenCup,answer:'浅绿色杯子在显示器左侧。',appearance_match:comparison});}return Response.json({configured:true,authenticated:true});}});t.after(()=>next.bridge.close());next.runtime.setPlace('home');
 const before=f.data.getItem('spatial-memory.records.v1');say(next.bridge,'绿色水杯现在在哪里');await finishPicture(next.bridge);
 assert.equal(requests[0].task.reference_appearance,appearance);assert.deepEqual(Object.keys(requests[0].task).sort(),['reference_appearance','remember','target']);
 assert.ok(!JSON.stringify(requests[0]).includes(candidate.location));assert.match(lastAnswer(next.events),/找到了绿色水杯，外观与记录相符/);assert.match(lastAnswer(next.events),/显示器左侧/);assert.doesNotMatch(lastAnswer(next.events),/不能确认是同一件/);
 assert.equal(f.data.getItem('spatial-memory.records.v1'),before);
});

test('appearance conflicts, occlusion and multiple candidates produce specific feedback without changing saved identity',async t=>{
 for(const [status,reason,expected]of [['different','记录是白色杯盖，眼前是黑色杯盖',/外观不一致/],['uncertain','把手被遮挡，无法核对把手形状',/把手被遮挡/],['multiple','两个杯子的颜色和杯盖相同',/多件相近/]]){
  const f=visualFixture({fetch:async url=>Response.json(url==='/api/vision'?{...seenCup,appearance_match:{status,unique:false,reason}}:{configured:true,authenticated:true})});t.after(()=>f.bridge.close());f.runtime.setPlace('home');
  f.runtime.memory.saveVisual('绿色水杯',{...candidate,appearance:'绿色杯身，白色杯盖，弧形把手'});const before=f.data.getItem('spatial-memory.records.v1');
  say(f.bridge,'绿色水杯现在在哪里');await finishPicture(f.bridge);assert.match(lastAnswer(f.events),expected);assert.ok(lastAnswer(f.events).includes(reason));assert.doesNotMatch(lastAnswer(f.events),/找到了|外观与记录相符/);assert.equal(f.data.getItem('spatial-memory.records.v1'),before);
 }
});

test('legacy memory remains readable and fresh observation neither fabricates appearance nor repeats identity boilerplate',async t=>{
 const requests=[],f=visualFixture({fetch:async(url,opts)=>{if(url==='/api/vision'){requests.push(JSON.parse(opts.body));return Response.json({...seenCup,appearance_match:{status:'match',unique:true,reason:'模型无依据的比对'}});}return Response.json({configured:true,authenticated:true});}});t.after(()=>f.bridge.close());f.runtime.setPlace('home');
 f.runtime.memory.remember('记住，绿色水杯放在电脑左侧');say(f.bridge,'绿色水杯现在在哪里');await finishPicture(f.bridge);
 assert.equal(requests[0].task.reference_appearance,'');assert.match(lastAnswer(f.events),/当前画面中看到了/);assert.doesNotMatch(lastAnswer(f.events),/不能确认是同一件|外观与记录相符/);assert.equal(f.runtime.memory.get('绿色水杯').appearance,'');
 say(f.bridge,'上次放在哪里');assert.match(lastAnswer(f.events),/电脑左侧/);assert.equal(requests.length,1);
});

test('ambiguous names and fresh ordinary scenes never send an arbitrary saved appearance',async()=>{
 const {FindDialogue}=await import('../web/find-dialogue.mjs');const memory=new Memory(storage());
 memory.saveVisual('红色水杯',{...candidate,appearance:'红色杯身，白色把手'});memory.saveVisual('绿色水杯',{...candidate,appearance:'绿色杯身，黑色杯盖'});
 const d=new FindDialogue(memory);
 assert.equal(d.intent('杯子现在在哪里','home').task.reference_appearance,'');
 d.reset();assert.equal(d.intent('绿色水杯现在在哪里','explore').task.reference_appearance,'');
 d.intent('之前记住的绿色水杯在哪里','explore');assert.equal(d.intent('现在在哪里','explore').task.reference_appearance,'绿色杯身，黑色杯盖');
});

test('explicit placement changes preserve recorded appearance; a new authorized visual save can update it',()=>{
 const data=storage(),m=new Memory(data),appearance='浅绿色，有白色杯盖';m.saveVisual('水杯',{...candidate,appearance});const id=m.get('水杯').object_id;
 m.remember('记住，水杯放在厨房桌上');assert.equal(m.get('水杯').appearance,appearance);assert.equal(m.get('水杯').object_id,id);
 m.prepare({action:'move',name:'水杯',location:'客厅茶几'});m.confirm(m.pending.token);assert.equal(m.get('水杯').appearance,appearance);
 m.saveVisual('水杯',{...candidate,appearance:''});assert.equal(m.get('水杯').appearance,appearance);
 m.saveVisual('水杯',{...candidate,appearance:'浅绿色杯身，杯盖已取下'});assert.equal(new Memory(data).get('水杯').appearance,'浅绿色杯身，杯盖已取下');assert.equal(m.get('水杯').object_id,id);
});

test('a newly named manual record does not inherit a loosely matched objects appearance',()=>{
 const m=new Memory(storage());m.saveVisual('绿色水杯',{...candidate,appearance:'浅绿色杯身，有把手'});
 m.prepare({action:'record',name:'水杯',location:'厨房桌上'});m.confirm(m.pending.token);
 const created=m.all().find(r=>r.name==='水杯');assert.equal(created.appearance,'');assert.equal(created.object_id,undefined);
});
