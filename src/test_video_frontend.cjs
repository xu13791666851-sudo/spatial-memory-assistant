const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
// The app is an ES module package, so load this browser script in a CommonJS-shaped VM context.
const streamSource=fs.readFileSync(path.join(__dirname,'static/video-stream.js'),'utf8');
const streamContext={module:{exports:{}}};
vm.runInNewContext(streamSource,streamContext);
const {FrameStream}=streamContext.module.exports;

class Clock {
 constructor(){this.time=0;this.serial=0;this.timers=new Map();}
 set(fn,delay,interval=0){const id=++this.serial;this.timers.set(id,{fn,at:this.time+delay,interval});return id;}
 clear(id){this.timers.delete(id);}
 advance(ms){const target=this.time+ms;for(;;){const next=[...this.timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;const [id,t]=next;this.time=t.at;if(t.interval)t.at+=t.interval;else this.timers.delete(id);t.fn();}this.time=target;}
 options(){return {now:()=>this.time,interval:(f,d)=>this.set(f,d,d),clearIntervalFn:id=>this.clear(id),timeout:(f,d)=>this.set(f,d),clearTimeoutFn:id=>this.clear(id)};}
}

function timerTests(){
 const browserTimers={performance:{now:()=>0}};
 for(const name of ['setInterval','clearInterval','setTimeout','clearTimeout'])browserTimers[name]=function(){assert.notEqual(this?.constructor?.name,'FrameStream','native timers must not receive FrameStream as receiver');return 1;};
 vm.createContext(browserTimers);vm.runInContext(fs.readFileSync(path.join(__dirname,'static/video-stream.js'),'utf8'),browserTimers);
 vm.runInContext('const nativeStream=new FrameStream();nativeStream.start(10,()=>true,()=>{});nativeStream.stop();',browserTimers);
 const clock=new Clock();const stream=new FrameStream(clock.options());let count=0,stops=0;
 stream.start(10,()=>{count++;return true;},()=>stops++);clock.advance(9500);
 assert.equal(count,10);clock.advance(1000);assert.equal(stops,1);assert.equal(stream.running,false);
 clock.advance(60000);assert.equal(count,10);assert.equal(clock.timers.size,0);
 stream.start(30,()=>{count++;return true;},()=>stops++);stream.stop();const before=count;clock.advance(60000);assert.equal(count,before);
 stream.start(10,()=>false,()=>stops++);clock.advance(10000);assert.equal(stops,2);assert.equal(clock.timers.size,0);
 stream.start(30,()=>true,()=>stops++);clock.time+=40000;clock.advance(1000);assert.equal(stream.running,false);
 stream.start(600,()=>true,()=>stops++);clock.advance(600000);assert.equal(stream.running,false);assert.equal(clock.timers.size,0);
 assert.throws(()=>stream.start(900,()=>true,()=>{}));
 const errorClock=new Clock();const errors=new FrameStream(errorClock.options());let failure='';
 errors.start(30,()=>{throw Error('capture failed');},reason=>failure=reason);
 assert.match(failure,/未完成/);assert.equal(errorClock.timers.size,0);
 console.log('PASS: frame pacing, deadline, manual stop, empty camera, delayed timers, invalid duration, capture failure');
}

function fixture(page='video'){
 const clock=new Clock();const elements=new Map();const listeners={};const tracks=[];const packets=[];let uuid=0;
 const make=()=>({textContent:'',value:'',hidden:false,disabled:false,style:{},classList:{toggle(){}},children:[],readyState:2,videoWidth:640,videoHeight:480,
  append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},addEventListener(){},focus(){},
  getContext(){return {drawImage(){}};},toDataURL(){return 'data:image/jpeg;base64,aW1hZ2U=';}});
 const get=id=>{if(!elements.has(id))elements.set(id,make());return elements.get(id);};get('video-duration').value='30';
 const document={hidden:false,getElementById:get,createElement:make,querySelectorAll:()=>[],body:{dataset:{page},classList:{toggle(){}}},addEventListener:(name,fn)=>listeners[name]=fn};
 const permissions=[];
 const navigator={mediaDevices:{getUserMedia:()=>new Promise((resolve,reject)=>permissions.push({resolve,reject}))}};
 const context={document,navigator,console,crypto:{randomUUID:()=>`offline-video-${++uuid}`},sessionStorage:{getItem:()=>null,setItem(){}},
  performance:{now:()=>clock.time},setTimeout:(f,d)=>clock.set(f,d),clearTimeout:id=>clock.clear(id),setInterval:(f,d)=>clock.set(f,d,d),clearInterval:id=>clock.clear(id),
  fetch:async url=>({ok:true,json:async()=>url==='/api/status'?{token:'offline-only',configured:true,workspace:'7662864',region:'beijing'}:{items:[]}}),
  WebSocket:{OPEN:1},location:{host:'127.0.0.1:8765',assign(url){context.destination=url;}},fixtureSocket:{readyState:1,bufferedAmount:0,send:raw=>packets.push(JSON.parse(raw)),close(){this.readyState=3;}},
  addEventListener:(name,fn)=>listeners[name]=fn};
 context.window=context;vm.createContext(context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'static/video-stream.js'),'utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'static/app.js'),'utf8'),context);
 vm.runInContext("ready=true;socket=fixtureSocket;stateUI('正在监听');",context);
 const evaluate=code=>vm.runInContext(code,context);
 const grant=()=>{const track={stops:0,stop(){this.stops++;}};tracks.push(track);permissions.shift().resolve({getTracks:()=>[track]});return track;};
 return {clock,elements,listeners,permissions,tracks,packets,document,evaluate,grant,context};
}

async function begin(f){
 const pending=f.evaluate('startVideo()');f.grant();await pending;
 const start=f.packets.find(p=>p.type==='video_start');assert.ok(start);
 await f.evaluate(`handleCloud(${JSON.stringify({type:'app.video_started',id:start.id,duration:start.duration})})`);
 return start;
}

async function frontendTests(){
 {
  const f=fixture();const pending=f.evaluate('startVideo()');await f.evaluate('stopCamera()');const track=f.grant();await pending;
  assert.equal(track.stops,1);assert.equal(f.packets.length,1);assert.equal(f.packets[0].type,'video_stop');assert.equal(f.elements.get('preview').srcObject,null);
  console.log('PASS: stopping while camera permission is pending prevents a late camera start');
 }
 {
  const f=fixture();const start=await begin(f);assert.equal(f.packets.filter(p=>p.type==='video_frame').length,1);
  f.clock.advance(2000);assert.equal(f.packets.filter(p=>p.type==='video_frame').length,3);
  await f.evaluate('stopCamera()');const count=f.packets.length;f.clock.advance(60000);assert.equal(f.packets.length,count);assert.equal(f.tracks[0].stops,1);
  await f.evaluate(`handleCloud(${JSON.stringify({type:'app.video_started',id:start.id,duration:30})})`);assert.equal(f.packets.length,count);
  assert.equal(f.elements.get('main-toggle').textContent,'结束对话');assert.equal(f.elements.get('video-stop').disabled,true);
  console.log('PASS: continuous frames, manual stop, timer cleanup, stale cloud acknowledgement');
 }
 {
  const f=fixture();await begin(f);f.clock.advance(30000);assert.equal(f.tracks[0].stops,1);
  assert.equal(f.packets.filter(p=>p.type==='video_frame').length,30);assert.match(f.elements.get('camera-state').textContent,/已到观察时长/);
  assert.equal(f.evaluate('ready'),true);assert.equal(f.clock.timers.size,0);
  console.log('PASS: thirty-second automatic cutoff closes camera and retains voice connection');
 }
 {
  const f=fixture();await begin(f);await f.evaluate("handleCloud({type:'conversation.item.input_audio_transcription.completed',transcript:'停止视频。'})");
  assert.equal(f.tracks[0].stops,1);assert.equal(f.evaluate('videoId'),null);
  console.log('PASS: spoken stop command closes the camera');
 }
 {
  const f=fixture();await begin(f);f.document.hidden=true;await f.listeners.visibilitychange();
  assert.equal(f.tracks[0].stops,1);assert.equal(f.evaluate('frameStream.running'),false);
  console.log('PASS: background page stops image capture');
 }
 {
  const f=fixture();await begin(f);await f.elements.get('pause').onclick();
  assert.equal(f.tracks[0].stops,1);assert.equal(f.evaluate('paused'),true);assert.equal(f.evaluate('videoId'),null);
  console.log('PASS: pause closes camera and cancels frame timer');
 }
 {
  const f=fixture();const pending=f.evaluate('startVideo()');f.permissions.shift().reject(Error('permission denied'));await pending;
  assert.equal(f.packets.filter(p=>p.type==='video_start').length,0);assert.equal(f.elements.get('main-toggle').disabled,false);
  console.log('PASS: permission denial restores controls without uploads');
 }
 {
  const f=fixture();const pending=f.evaluate('startVideo()');f.grant();await pending;f.clock.advance(8000);
  assert.equal(f.tracks[0].stops,1);assert.match(f.elements.get('camera-state').textContent,/没有准备好/);
  console.log('PASS: missing cloud acknowledgement closes the camera');
 }
 {
  const f=fixture();await begin(f);f.context.fixtureMic={stops:0,stop(){this.stops++;}};
  f.evaluate('micStream={getTracks:()=>[fixtureMic]}');await f.evaluate("navigateToPage('/memory')");
  assert.equal(f.context.fixtureMic.stops,1);assert.equal(f.tracks[0].stops,1);assert.equal(f.context.destination,'/memory');
  const count=f.packets.length;f.clock.advance(60000);assert.equal(f.packets.length,count);
  console.log('PASS: page navigation stops camera, microphone, connection and all frame timers');
 }
 for(const page of ['video','memory']){
  const f=fixture(page);await new Promise(resolve=>setImmediate(resolve));
  f.context.AudioContext=class{constructor(){this.audioWorklet={addModule:async()=>{}};}async resume(){}async close(){}createMediaStreamSource(){return {connect(){},disconnect(){}};}};
  f.context.AudioWorkletNode=class{constructor(){this.port={};}connect(){}disconnect(){}};
  f.context.WebSocket=class{static OPEN=1;constructor(url){this.readyState=1;this.bufferedAmount=0;f.context.newSocket=this;this.url=url;}send(raw){f.packets.push(JSON.parse(raw));}close(){this.readyState=3;}};
  f.evaluate('ready=false;socket=null;');const pending=f.elements.get('main-toggle').onclick();
  await new Promise(resolve=>setImmediate(resolve));const ws=f.context.newSocket;assert.ok(ws);ws.onopen();
  assert.equal(f.packets[0].mode,page);const connected=ws.onmessage({data:JSON.stringify({type:'app.ready'})});
  assert.equal(f.permissions.length,1);const mic=f.grant();await connected;
  await new Promise(resolve=>setImmediate(resolve));
  let camera;
  if(page==='video'){assert.equal(f.permissions.length,1);camera=f.grant();}
  else assert.equal(f.permissions.length,0);
  await pending;assert.equal(!!f.packets.find(p=>p.type==='video_start'),page==='video');
  assert.equal(f.elements.get('main-toggle').textContent,'结束对话');
  await f.elements.get('main-toggle').onclick();assert.equal(mic.stops,1);if(camera)assert.equal(camera.stops,1);
  assert.equal(f.evaluate('ready'),false);assert.equal(f.clock.timers.size,0);
  assert.equal(f.elements.get('main-toggle').textContent,page==='video'?'开始观察':'开始对话');
  console.log(`PASS: ${page} primary button starts the right devices, then ends the session and stops all devices`);
 }
 {
  const f=fixture();const opening=f.evaluate('startVideo()');
  assert.equal(f.elements.get('main-toggle').disabled,false);
  await f.elements.get('main-toggle').onclick();const track=f.grant();await opening;
  assert.equal(track.stops,1);assert.equal(f.evaluate('ready'),false);assert.equal(f.evaluate('videoId'),null);
  assert.equal(f.elements.get('main-toggle').textContent,'开始观察');
  console.log('PASS: primary button cancels delayed camera permission without starting a late session');
 }
 {
  const f=fixture();await f.evaluate("handleCloud({type:'response.text.delta',item_id:'reply-1',delta:'逐字'})");
  assert.equal(f.elements.has('answer-live'),false);
  f.evaluate("$('screen-reader-mode').checked=true");
  await f.evaluate("handleCloud({type:'response.text.done',item_id:'reply-1',text:'完整回答'})");
  assert.equal(f.elements.get('latest-answer').textContent,'完整回答');assert.equal(f.elements.get('answer-live').textContent,'完整回答');
  console.log('PASS: final answer is announced once instead of announcing streamed fragments');
 }
}

(async()=>{timerTests();await frontendTests();console.log('All offline frontend checks passed.');})().catch(error=>{console.error(error);process.exitCode=1;});
