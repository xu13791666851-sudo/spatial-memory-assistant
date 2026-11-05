import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';
import {memory,picture} from './helpers.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function setup(t,providers,detector){const events=[];const s=new Session({memory:memory(t),providers,detector,emit:e=>events.push(e)});s.start();s.frame(picture,s.source.generation,1,Date.now());t.after(()=>s.stop());return {s,events};}
test('scene inference starts before acknowledgement; fast answers suppress it',async t=>{
 let started=false;const work=deferred();const {s,events}=setup(t,{describe:()=>{started=true;return work.promise;}});
 const run=s.command({commandId:'fast',text:'画面里面有什么'});assert.ok(started);assert.equal(events.filter(e=>e.type==='reply').length,0);
 work.resolve({answer:'桌上有杯子'});await run;await pause(150);
 assert.deepEqual(events.filter(e=>e.type==='reply').map(e=>e.kind),['result']);
 assert.equal(events.find(e=>e.type==='reply').commandId,'fast');
});
test('slow vision acknowledges without claiming success; a later failure is still spoken',async t=>{
 const work=deferred();const {s,events}=setup(t,{describe:()=>work.promise});const run=s.command({commandId:'slow',text:'画面里面有什么'});
 await pause(150);assert.equal(events.filter(e=>e.type==='reply')[0].kind,'ack');
 work.reject(Error('omni_timeout'));await run;
 const replies=events.filter(e=>e.type==='reply');assert.deepEqual(replies.map(e=>e.kind),['ack','result']);assert.match(replies[1].message,/超时/);
 assert.ok(events.some(e=>e.operation==='ack_ready'));assert.ok(events.some(e=>e.operation==='result_ready'));
});
test('new visual request aborts old work and suppresses its late result and acknowledgement',async t=>{
 const old=deferred();let signal,calls=0;const {s,events}=setup(t,{describe:(_,__,___,sig)=>{if(++calls===1){signal=sig;return old.promise;}return Promise.resolve({answer:'新画面'});}});
 const a=s.command({commandId:'old',text:'画面里面有什么'});await s.command({commandId:'new',text:'画面里面有什么'});assert.ok(signal.aborted);
 old.resolve({answer:'旧画面'});await a;await pause(150);
 assert.deepEqual(events.filter(e=>e.type==='reply').map(e=>e.message),['新画面']);
});
test('stop during slow vision clears the acknowledgement and all late speech',async t=>{
 const work=deferred();const {s,events}=setup(t,{describe:()=>work.promise});const run=s.command({commandId:'stop',text:'画面里面有什么'});
 s.stop();work.resolve({answer:'旧画面'});await run;await pause(150);assert.equal(events.filter(e=>e.type==='reply').length,0);
});
test('warm detections are reused immediately for a new find without another detector call',async t=>{
 let detections=0,reviews=0;const candidate={label:'cup',score:.9,box:[.1,.1,.5,.8],cropJpeg:picture.toString('base64')};
 const review=deferred();const {s}=setup(t,{review:()=>{reviews++;return review.promise;}},{ready:true,busy:false,run:async f=>{detections++;return {frameId:f.frameId,detections:[candidate],candidates:[candidate]};}});
 await s.tick();assert.equal(reviews,0);await s.command({commandId:'find',text:'帮我找杯子'});
 assert.equal(detections,1);assert.equal(reviews,1);review.resolve({decision:'UNCERTAIN'});await pause(0);
});
test('history reads memory without scheduling visual work or acknowledgement',async t=>{
 let calls=0;const {s,events}=setup(t,{describe:()=>{calls++;},review:()=>{calls++;}});
 await s.command({commandId:'history',text:'杯子上次在哪'});await pause(150);
 assert.equal(calls,0);assert.deepEqual(events.filter(e=>e.type==='reply').map(e=>e.kind),['result']);
});
test('changing target during a pending review aborts the old comparison',async t=>{
 const old=deferred();let signal;const candidate={label:'cup',score:.9,box:[.1,.1,.5,.8],cropJpeg:picture.toString('base64')};
 const {s,events}=setup(t,{review:(_,options,sig)=>{if(options.target==='杯子'){signal=sig;return old.promise;}return Promise.resolve({decision:'UNCERTAIN'});}},{ready:true,busy:false,run:async f=>({frameId:f.frameId,detections:[candidate],candidates:[candidate]})});
 await s.command({commandId:'cup',text:'帮我找杯子'});await pause(0);
 await s.command({commandId:'key',text:'帮我找钥匙'});assert.ok(signal.aborted);
 old.resolve({decision:'CONFIRM'});await pause(0);
 assert.equal(s.task.target,'钥匙');assert.ok(!events.some(e=>e.type==='reply'&&/发现.*杯子/.test(e.message)));
});
