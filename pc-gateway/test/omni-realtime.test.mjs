import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {OmniRealtime,OMNI_MODEL} from '../src/omni-realtime.mjs';
const fixture=Buffer.from([255,216,255,217]);
class Socket extends EventEmitter {
 constructor({hang=false,status='completed'}={}){super();this.readyState=1;this.sent=[];this.hang=hang;this.status=status;queueMicrotask(()=>this.event({type:'session.created',session:{model:OMNI_MODEL}}));}
 event(e){this.emit('message',Buffer.from(JSON.stringify(e)));}
 send(raw){const e=JSON.parse(raw);this.sent.push(e);queueMicrotask(()=>{
  if(e.type==='session.update')this.event({type:'session.updated'});
  if(e.type==='input_audio_buffer.commit')this.event({type:'input_audio_buffer.committed'});
  if(e.type==='response.create'&&!this.hang)this.event({type:'response.done',response:{status:this.status,output:[{type:'message',content:[{type:'text',text:'{"ok":true}'}]}]}});
 });}
 terminate(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
 close(){this.terminate();}
}
function client(t,options={}){const sockets=[];const c=new OmniRealtime({key:()=> 'fake-key',socketFactory:(url,o)=>{assert.equal(new URL(url).searchParams.get('model'),OMNI_MODEL);assert.equal(o.headers.Authorization,'Bearer fake-key');const socket=new Socket(options);sockets.push(socket);return socket;},timeoutMs:100,...options});t.after(()=>c.close());return {c,sockets};}
test('Realtime preserves one connection across turns and orders audio, image, commit, response',async t=>{
 const {c,sockets}=client(t);assert.equal(await c.request('first',fixture),'{"ok":true}');await c.request('second',fixture);
 assert.equal(sockets.length,1);assert.deepEqual(sockets[0].sent.map(e=>e.type),Array(2).fill(['session.update','input_audio_buffer.append','input_image_buffer.append','input_audio_buffer.commit','response.create']).flat());
 const config=sockets[0].sent[0].session;assert.equal(config.voice,'Tina');assert.equal(config.turn_detection,null);assert.deepEqual(config.modalities,['text']);
});
test('cancellation closes the old connection; late output cannot satisfy the next request',async t=>{
 const {c,sockets}=client(t,{hang:true});const abort=new AbortController();const first=c.request('old',fixture,abort.signal);
 await new Promise(r=>setImmediate(r));abort.abort();await assert.rejects(first,/cancelled/);assert.equal(sockets[0].readyState,3);
 c.socketFactory=()=>{const s=new Socket();sockets.push(s);return s;};const second=c.request('new',fixture);sockets[0].event({type:'response.done',response:{status:'completed',output:[]}});
 assert.equal(await second,'{"ok":true}');assert.equal(sockets.length,2);
});
test('incomplete model output fails closed and a missing key never connects',async t=>{
 const {c}=client(t,{status:'incomplete'});await assert.rejects(c.request('test',fixture),/incomplete/);
 const noKey=new OmniRealtime({key:()=>null,socketFactory:()=>{throw Error('must_not_connect');}});await assert.rejects(noKey.request('test',fixture),/not_configured/);
});
test('timeout releases connection and reset cancels queued work',async t=>{
 const {c,sockets}=client(t,{hang:true,timeoutMs:20});const keepAlive=setTimeout(()=>{},100);t.after(()=>clearTimeout(keepAlive));
 await assert.rejects(c.request('slow',fixture),/timeout/);assert.equal(sockets[0].readyState,3);
 const a=c.request('a',fixture),b=c.request('b',fixture);await new Promise(r=>setImmediate(r));c.reset();
 await assert.rejects(a,/closed/);await assert.rejects(b,/cancelled/);
});
test('endpoint allowlist prevents sending credentials to arbitrary hosts',()=>{
 assert.throws(()=>new OmniRealtime({url:'wss://attacker.example/api'}),/endpoint_invalid/);
 assert.throws(()=>new OmniRealtime({url:'ws://dashscope.aliyuncs.com/api'}),/endpoint_invalid/);
});
