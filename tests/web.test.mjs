import test from 'node:test';
import assert from 'node:assert/strict';
import {Memory} from '../web/memory.mjs';
import {createRuntime,sessionConfig} from '../web/runtime.mjs';
import {exchange} from '../netlify/functions/realtime-sdp.mjs';

const storage=()=>{const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),map};};
const key='sk-offline-test-only-xxxxxxxxxxxxxxxx';
const request=(body,origin='https://example.netlify.app')=>new Request('https://example.netlify.app/api/realtime/sdp',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
const config={key,workspace:'ws-test-fixture',region:'beijing',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'};

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
  assert.equal((await exchange(request(config,'https://evil.example'),noFetch)).status,403);
  assert.equal((await exchange(request({...config,workspace:'evil.example/attack'}),noFetch)).status,400);
  assert.equal((await exchange(request({...config,sdp:'not an offer'}),noFetch)).status,400);
  assert.equal(calls,0);
});
test('SDP success forwards credentials only to fixed endpoint and returns no key',async()=>{
  const response=await exchange(request(config),async(url,options)=>{
    assert.equal(url,'https://ws-test-fixture.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.8-omni-flash-realtime');
    assert.equal(options.headers.Authorization,'Bearer '+key);assert.equal(options.redirect,'error');
    return new Response('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n');
  });
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(!(await response.text()).includes(key));
});
test('upstream auth errors and exceptions never echo secrets',async()=>{
  for(const factory of [async()=>Response.json({code:'InvalidApiKey',message:key},{status:401}),async()=>{throw Error(key);}]){
    const response=await exchange(request(config),factory);assert.ok(response.status>=400);assert.ok(!(await response.text()).includes(key));
  }
});
function runtimeFixture(){
  const data=storage(),audio={muted:false,pause(){},hidden:true},preview={srcObject:null};
  const document={getElementById:id=>id==='remote-audio'?audio:id==='preview'?preview:{checked:false}};
  const runtime=createRuntime({storage:data,document,fetch:()=>{throw Error('No real network');},RTCPeerConnection:class{}});
  return {runtime,data,preview,audio};
}
test('API key never enters persistent storage and settings clear it',async()=>{
  const {runtime,data}=runtimeFixture();await runtime.api('/api/config',config);
  assert.equal(runtime.status().configured,true);assert.ok(!JSON.stringify([...data.map]).includes(key));
  await runtime.api('/api/config',null,'DELETE');assert.equal(runtime.status().configured,false);
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
test('native video uses a clone and stopping it leaves local preview capture owned by UI',async()=>{
  const {runtime,preview}=runtimeFixture();const bridge=new runtime.Bridge();bridge.mode='video';bridge.configured=true;
  let cloneStopped=false,sourceStopped=false;
  preview.srcObject={getVideoTracks:()=>[{readyState:'live',stop(){sourceStopped=true;},clone:()=>({stop(){cloneStopped=true;}})}]};
  bridge.videoSender={replaceTrack:async()=>{},getParameters:()=>({encodings:[]})};
  await bridge.attachVideo();bridge.clearVideoTrack();assert.equal(cloneStopped,true);assert.equal(sourceStopped,false);bridge.close();
});
test('session tools keep visual and memory permissions separate',()=>{
  assert.deepEqual(sessionConfig('video').session.tools.map(t=>t.function.name),['stop_video']);
  assert.ok(!sessionConfig('memory').session.tools.some(t=>t.function.name==='stop_video'));
});
