import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Execute the real bridge with fake browser devices/transport. Geometry is tested separately.
async function fixture(){
 const source=await fs.readFile(new URL('../web/demo-bridge.mjs',import.meta.url),'utf8');
 let revision=0,running=false,mediaRequests=0,stopped=0;
 const nodes=new Map(),requests=[],timers=new Map();let timerId=0;
 const preview={style:{},readyState:0,srcObject:null,play:async()=>{}};
 const tracks=[{stop(){stopped++;}},{stop(){stopped++;}}];
 const stream={getTracks:()=>tracks,getAudioTracks:()=>[tracks[1]]};
 const node=id=>{if(!nodes.has(id))nodes.set(id,{style:{},closest:()=>({hidden:false})});return nodes.get(id);};
 nodes.set('preview',preview);
 const data=()=>({rev:revision,state:{running,paused:false,epoch:1,searchState:'IDLE'},events:[],memories:[]});
 const document={getElementById:node,hidden:false,createElement:()=>({getContext:()=>({})}),
  addEventListener(){},querySelectorAll:()=>[],body:{prepend(){}}};
 const window={addEventListener(){},dispatchEvent(){}};window.self=window.top=window;
 class AudioContext{resume(){return Promise.resolve();}close(){return Promise.resolve();}}
 window.AudioContext=AudioContext;
 class WebSocket{constructor(){this.readyState=1;}send(){}close(){this.readyState=3;this.onclose?.();}}
 const context=vm.createContext({window,document,WebSocket,AbortController,CustomEvent:class{},
  fingerprint:()=>({}),motionChanged:()=>false,location:{protocol:'https:',host:'test.example',href:'https://test.example/'},
  navigator:{mediaDevices:{async getUserMedia(){mediaRequests++;return stream;}}},
  localStorage:{getItem:()=>null},setInterval:()=>0,
  setTimeout:(fn)=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
  fetch:async(path,options={})=>{
   const body=options.body?JSON.parse(options.body):null;requests.push({path,body});
   if(body?.method==='start'){running=true;revision++;}
   if(body?.method==='stop'||(body?.method==='text'&&body.params.text==='结束对话')){running=false;revision++;}
   return {ok:true,json:async()=>({...data(),csrf:'test-csrf',result:true})};
  }});
 // Supply only the imported geometry helpers; all bridge behavior is original source.
 new vm.Script(source.replace(/^import .*?;\r?\n/,''),{filename:'demo-bridge.mjs'}).runInContext(context);
 const pending=new Map();let serial=0;
 window.NativeAssistant.onmessage=({data})=>{const reply=JSON.parse(data);const request=pending.get(reply.id);if(!request)return;pending.delete(reply.id);reply.error?request.reject(Error(reply.error)):request.resolve(reply.result);};
 const call=(method,params={})=>new Promise((resolve,reject)=>{
  const id=String(++serial);pending.set(id,{resolve,reject});window.NativeAssistant.postMessage(JSON.stringify({id,method,params}));
 });
 await call('ready');
 return {call,requests,preview,mediaRequests:()=>mediaRequests,stopped:()=>stopped};
}

test('read-only text transport does not request camera or microphone',async()=>{
 const f=await fixture();await f.call('text',{text:'蓝色水杯上次放在哪里'});
 assert.equal(f.mediaRequests(),0);assert.equal(f.preview.srcObject,null);
 assert.ok(f.requests.some(r=>r.body?.method==='text'));
});

test('a server-side stop closes actual local tracks and preview',async()=>{
 const f=await fixture();await f.call('start');assert.equal(f.mediaRequests(),1);
 assert.ok(f.preview.srcObject);
 await f.call('text',{text:'结束对话'});
 assert.equal(f.stopped(),2);assert.equal(f.preview.srcObject,null);
});
