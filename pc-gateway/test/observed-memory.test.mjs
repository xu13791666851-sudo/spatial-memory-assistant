import test from 'node:test';import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';import {parseIntent} from '../src/intent.mjs';
import {Memory} from '../src/memory.mjs';import {exportArchive,readArchive} from '../src/archive.mjs';
import {memory,picture,frame,account,directory} from './helpers.mjs';import {uuid} from '../src/util.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function start(t,providers){const m=memory(t),events=[];const s=new Session({memory:m,providers,emit:e=>events.push(e)});s.start();s.frame(picture,s.source.generation,1,Date.now());return {m,s,events,command:text=>s.command({commandId:uuid(),text})};}
test('a filler utterance does not suppress the pending memory answer',async t=>{
 const words=deferred();const x=start(t,{describe:()=>words.promise,review:async()=>({box:null,location:null})});
 const pending=x.command('记住小风扇');await x.command('嗯');words.resolve({v:true,d:'白色风扇',l:'键盘右边'});await pending;
 assert.equal(x.events.filter(e=>e.type==='reply').length,1);assert.match(x.events.filter(e=>e.type==='reply')[0].message,/已记录/);
});
test('asking about a running memory task reports progress and does not leave an endless learning state',async t=>{
 const words=deferred();const x=start(t,{describe:()=>words.promise,review:async()=>({box:null,location:null})});
 const pending=x.command('记住小风扇');await x.command('记住他了吗');
 const reply=x.events.filter(e=>e.type==='reply').at(-1).message;assert.match(reply,/正在分析/);assert.doesNotMatch(reply,/单独|拉远|靠近/);
 words.resolve({v:true,d:'白色风扇',l:'键盘右边'});await pending;assert.equal(x.s.state,'IDLE');assert.ok(x.m.receipt(x.m.all()[0].id).complete);
});
test('a slow vision connection is not reported as a request to reframe a clearly visible object',async t=>{
 const x=start(t,{describe:async()=>{throw new DOMException('slow','TimeoutError');}});
 await x.command('眼前有什么');const reply=x.events.filter(e=>e.type==='reply');assert.equal(reply.length,1);assert.match(reply[0].message,/连接.*慢/);assert.doesNotMatch(reply[0].message,/镜头|没看清/);
});
test('describe then remember selects the newer command frame rather than saving the earlier scene description',async t=>{
 const x=start(t,{describe:async(f,target)=>target?{v:true,d:'蓝色小风扇',l:f.frameId===2?'显示器左边':'键盘右边'}:{i:['键盘','小风扇'],answer:'桌上有键盘，小风扇在键盘右边。'},review:async()=>({visible:.5,clear:.6,box:null,location:null})});
 await x.command('眼前有什么');assert.equal(x.m.all().length,0);
 x.s.frame(picture,x.s.source.generation,2,Date.now());await x.command('记住这个小风扇');
 const o=x.m.all()[0];assert.equal(o.captures[0].frameId,2);assert.equal(o.captures[0].suggestedLocation,'显示器左边');assert.match(x.m.history(o.id),/显示器左边/);
});

test('fan appearance and location are durable before independent review finishes, with only one spoken answer',async t=>{
 const review=deferred();const x=start(t,{describe:async()=>({v:true,d:'蓝色圆形小风扇',l:'键盘右侧',a:'键盘'}),review:()=>review.promise});
 const pending=x.command('记住这个小风扇的位置');
 for(let i=0;i<20&&!x.events.some(e=>e.type==='reply');i++)await new Promise(r=>setImmediate(r));
 const saved=x.m.all()[0];assert.equal(saved.description,'蓝色圆形小风扇');assert.ok(x.m.receipt(saved.id).complete);assert.equal(saved.appearances.length,0);
 assert.match(x.m.history(saved.id),/画面里看到小风扇在键盘右侧/);assert.ok(x.m.references(saved).length);
 await x.command('他上次在哪');assert.equal(x.m.all().length,1);assert.match(x.events.filter(e=>e.type==='reply').at(-1).message,/键盘右侧/);
 review.resolve({visible:.6,clear:.7,box:null,location:null,failureKind:'BOX_UNCERTAIN'});await pending;
 assert.equal(x.m.receipt(saved.id).complete,true);assert.match(x.m.records()[0].capture_status_label,/已记录/);
 assert.equal(x.events.filter(e=>e.type==='reply').length,2); // memory answer and explicit history query
});
test('a later explicit rejection marks the observation disputed without erasing its original scene or speaking again',async t=>{
 const review=deferred();const x=start(t,{describe:async()=>({v:true,d:'蓝色小风扇',l:'书桌右边'}),review:()=>review.promise});
 const pending=x.command('记住小风扇');
 for(let i=0;i<20&&!x.events.some(e=>e.type==='reply');i++)await new Promise(r=>setImmediate(r));
 review.resolve({visible:.02,clear:.99,box:null,location:null,failureKind:'TARGET_UNCERTAIN'});await pending;
 const o=x.m.all()[0];assert.equal(o.captures.length,1);assert.equal(o.captures[0].failureKind,'REVIEW_REJECTED');
 assert.equal(x.m.locationHistory(o.id).length,0);assert.equal(x.m.references(o).length,0);assert.equal(x.m.receipt(o.id).complete,false);
 assert.equal(x.events.filter(e=>e.type==='reply').length,1);assert.match(x.m.records()[0].capture_status_label,/分歧/);
});
test('verified appearance from one angle and position from another are reported together without claiming a fresh position',t=>{
 const m=memory(t);const first=m.capture('小风扇',frame());m.finish(first,{location:{location:'桌面上',anchor:'桌面'}});
 const next=m.capture('小风扇',{...frame(),capturedAtMs:Date.now()+1},{objectId:first.objectId});
 m.finish(next,{appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')},description:'白色小风扇'});
 const receipt=m.receipt(first.objectId);assert.equal(receipt.complete,true);assert.match(receipt.message,/样子已经记住.*上次记录在桌面上/);
 assert.match(m.records()[0].capture_status_label,/外观和位置已保存/);
});
test('repeating the same named fan and ASR pronouns reuses its identity; explicitly another fan creates a separate one',async t=>{
 const x=start(t,{describe:async()=>({v:true,d:'白色小风扇',l:'桌面上'}),review:async()=>({visible:.6,clear:.7,box:null,location:null})});
 await x.command('记住这个小风扇');const id=x.m.all()[0].id;
 x.s.focus=null;await x.command('记住风扇的位置');assert.equal(x.m.all().length,1);assert.equal(x.s.focus.id,id);
 await x.command('记住他的位置');assert.equal(x.m.all().length,1);assert.equal(x.s.focus.id,id);
 await x.command('记住另一个小风扇');assert.equal(x.m.all().length,2);
 assert.equal(parseIntent('记住她的位置',null).target,null);
});
test('same-name ambiguity asks which item rather than merging two physical objects',async t=>{
 const x=start(t,{describe:async()=>({v:true,d:'小风扇',l:'桌面上'}),review:async()=>({box:null,location:null})});
 x.m.capture('小风扇',frame());x.m.capture('小风扇',frame());
 await x.command('记住小风扇');assert.equal(x.m.all().length,2);assert.ok(x.events.some(e=>e.type==='choices'));
});
test('unverified observations and their scene survive backup and a fresh memory instance',async t=>{
 const a=memory(t),b=memory(t);a.bindAccount(account);b.bindAccount(account);
 const r=a.capture('小风扇',frame());a.finish(r,{description:'蓝色小风扇',suggestedLocation:'键盘右侧',failureKind:'REVIEW_UNCERTAIN'});
 const zipped=await exportArchive(a,account),parsed=await readArchive(zipped.bytes,account);b.importObjects(parsed.objects,parsed.files);
 assert.match(b.history(r.objectId),/画面里看到小风扇在键盘右侧/);assert.equal(b.get(r.objectId).locations.length,0);
 assert.ok(b.receipt(r.objectId).complete);assert.equal(b.references(b.get(r.objectId)).length,1);
});
