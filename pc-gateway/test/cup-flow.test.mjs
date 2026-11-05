import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Memory,labelFor} from '../src/memory.mjs';
import {Session} from '../src/session.mjs';
import {Providers} from '../src/providers.mjs';
import {parseIntent} from '../src/intent.mjs';
import {rankCandidates} from '../src/candidates.mjs';
import {diagnosticLog} from '../src/diagnostics.mjs';
import {memory,frame,picture,directory} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
const vector=i=>{const b=Buffer.alloc(192);b.writeFloatLE(1,i*4);return b.toString('base64');};
const candidate=(score,box,embedding=vector(0))=>({label:'cup',score,box,embedding,cropJpeg:picture.toString('base64')});
const left=candidate(.99,[.1,.1,.35,.8],vector(1)),right=candidate(.8,[.6,.1,.9,.8]);
function saved(m,name='蓝色水杯'){
 const r=m.capture(name,frame());m.finish(r,{appearance:{jpeg:picture,embedding:vector(0)},description:'蓝色杯子',location:{location:'笔记本电脑右侧',anchor:'笔记本电脑'}});return m.get(r.objectId);
}
const settle=()=>new Promise(r=>setImmediate(r));
test('the exact screenshot follow-ups work without online interpretation',()=>{
 for(const q of ['可以。哦，你看一下。','现在这个桌面上有没有？','你看一下这个桌面上有没有之前说过的蓝色水杯。'])assert.deepEqual(parseIntent(q,'蓝色水杯'),{action:'find',target:'蓝色水杯'});
 assert.deepEqual(parseIntent('在哪里呀？告诉我。','蓝色水杯'),{action:'history',target:'蓝色水杯'});
 assert.equal(parseIntent('我的水杯在哪').action,'history');
 assert.equal(parseIntent('我的水杯现在在哪').action,'find');
 assert.equal(parseIntent('现在帮我找','蓝色水杯').target,'蓝色水杯');
 assert.deepEqual(parseIntent('你有没有记住蓝色水杯'),{action:'check',target:'蓝色水杯'});
});
test('coloured object names map to the detector category and aliases survive reopening',t=>{
 const root=directory();let m=new Memory(root);const o=saved(m);m.close();m=new Memory(root);t.after(()=>m.close());
 for(const q of ['杯子','我的水杯','蓝色杯子','水杯'])assert.equal(m.matching(q)[0].id,o.id);
 assert.equal(labelFor('蓝色水杯'),'cup');assert.equal(labelFor('白色手机'),'cell phone');
 assert.equal(m.matching('红色杯子').length,0);
});
test('a generic cup query includes the old generic record and the blue cup; no automatic merge',t=>{
 const m=memory(t);saved(m,'水杯');saved(m);saved(m,'红色杯子');
 assert.equal(m.matching('杯子').length,3);assert.equal(m.matching('水杯').length,3);
 assert.equal(m.matching('蓝色水杯').length,1);
});
test('fresh conversation asks which cup while an existing focus is preserved across aliases',async t=>{
 const m=memory(t);saved(m,'水杯');const blue=saved(m),events=[];
 const s=new Session({memory:m,providers:{intent:async()=>{throw Error();}},emit:e=>events.push(e)});
 await s.command({commandId:uuid(),text:'我的杯子在哪'});assert.equal(events.filter(e=>e.type==='choices').length,1);
 assert.equal(s.focus,null);await s.command({commandId:uuid(),action:'select',index:1});assert.equal(s.focus.id,blue.id);
 await s.command({commandId:uuid(),text:'水杯上次在哪'});assert.equal(s.focus.id,blue.id);assert.equal(m.all().length,2);
});
test('saved position then screenshot follow-up runs YOLO and compares the same-frame crop against saved photos',async t=>{
 const m=memory(t);const blue=saved(m);let category,compared;const events=[];
 const s=new Session({memory:m,emit:e=>events.push(e),detector:{ready:true,busy:false,run:async(f,o)=>{category=o.target;return {frameId:f.frameId,detections:[left,right],candidates:[left,right]};}},providers:{intent:async()=>{throw Error('must_not_call_online_intent');},review:async(f,o)=>{compared={f,o};return {decision:'CONFIRM'};}}});
 s.start();s.frame(picture,s.source.generation,1,Date.now());
 await s.command({commandId:uuid(),text:'蓝色水杯上次在哪里'});
 assert.match(events.filter(e=>e.type==='reply').at(-1).message,/笔记本电脑右侧/);
 await s.command({commandId:uuid(),text:'你看一下这个桌面上有没有之前说过的蓝色水杯。'});
 await s.tick();await settle();assert.equal(category,'cup');assert.equal(s.task.objectId,blue.id);
 assert.deepEqual(compared.o.crop,Buffer.from(right.cropJpeg,'base64'));assert.deepEqual(compared.o.references,[picture]);
 assert.equal(compared.f.frameId,1);assert.equal(s.state,'GUIDING');assert.deepEqual(s.lastConfirmed.box,right.box);
 assert.equal(m.get(blue.id).locations.length,1); // Finding must not rewrite the stored position.
});
test('appearance ranking is a coarse shortlist score and never substitutes for Jev identity confirmation',()=>{
 const ranked=rankCandidates([left,right],[{embedding:vector(0)}]);assert.equal(ranked[0].score,.8);assert.equal(ranked[0].appearanceSimilarity,1);
 assert.equal(rankCandidates([right,left],[])[0].score,.99);
});
test('an absent YOLO box falls back to the current full scene and saved reference without claiming absence',async t=>{
 const m=memory(t);saved(m);let calls=0;const events=[];
 const s=new Session({memory:m,emit:e=>events.push(e),detector:{ready:true,busy:false,run:async()=>({detections:[],candidates:[]})},providers:{review:async(f,o)=>{calls++;assert.equal(o.crop,null);assert.equal(o.references.length,1);return {decision:'UNCERTAIN'};}}});
 s.start();s.frame(picture,s.source.generation,1,Date.now());await s.command({commandId:uuid(),action:'find',target:'蓝色水杯'});await s.tick();await settle();
 assert.equal(calls,1);assert.ok(events.filter(e=>e.type==='reply').some(e=>e.message.includes('本地检测暂未圈出')));assert.equal(s.task.label,'cup');
});
test('slow Jev results report the past observation and keep searching instead of silently disappearing',async t=>{
 const m=memory(t);saved(m);let now=Date.now();const events=[];
 const s=new Session({memory:m,now:()=>now,emit:e=>events.push(e),detector:{ready:true,busy:false,run:async()=>({detections:[right],candidates:[right]})},providers:{review:async()=>{now+=5000;return {decision:'CONFIRM'};}}});
 s.start();s.frame(picture,s.source.generation,1,now);await s.command({commandId:uuid(),action:'find',target:'蓝色水杯'});await s.tick();await settle();
 assert.equal(s.state,'SEARCHING');assert.equal(s.lastConfirmed,null);assert.match(events.filter(e=>e.type==='reply').at(-1).message,/刚才.*画面已过期/);
 assert.ok(events.some(e=>e.code==='review_frame_expired'));
});
test('failed comparison retains target and ordinary follow-up can retry without online intent',async t=>{
 const m=memory(t);const blue=saved(m),events=[];
 const s=new Session({memory:m,emit:e=>events.push(e),detector:{ready:true,busy:false,run:async()=>({detections:[right],candidates:[right]})},providers:{review:async()=>{throw Error('jev_http_503');}}});
 s.start();s.frame(picture,s.source.generation,1,Date.now());await s.command({commandId:uuid(),action:'find',target:'蓝色水杯'});await s.tick();await settle();
 assert.match(events.filter(e=>e.type==='reply').at(-1).message,/物品对比未完成/);
 await s.command({commandId:uuid(),text:'可以。哦，你看一下。'});assert.equal(s.task.objectId,blue.id);
 assert.ok(events.some(e=>e.code==='jev_http_503'));
});
test('provisional memory feedback says location is still pending and agrees with persisted state',t=>{
 const m=memory(t),r=m.capture('杯子',frame());const receipt=m.finish(r,{description:'蓝色杯子',suggestedLocation:'电脑右侧',failureKind:'REVIEW_PENDING'});
 assert.match(receipt.message,/已记录.*位置尚待核对/);assert.equal(m.get(r.objectId).locations.length,0);
});
test('image HTTP and malformed response failures remain distinguishable',async()=>{
 const f=frame();const p=new Providers({fetcher:async()=>new Response('unavailable',{status:503})});
 await assert.rejects(p.describe(f,null,'桌面有什么'),/qwen_http_503/);
 const timeout=new Providers({fetcher:async()=>Response.json({code:'provider_timeout'},{status:502})});
 await assert.rejects(timeout.describe(f,null,'桌面有什么'),/qwen_image_timeout/);
 const bad=new Providers({fetcher:async()=>Response.json({choices:[{message:{content:'{broken'}}]})});
 await assert.rejects(bad.describe(f,null,'桌面有什么'),/qwen_json_invalid/);
});
test('diagnostic records contain stage and timing without text, images or tokens',()=>{
 const root=directory(),log=diagnosticLog(root);log({type:'diagnostic',operation:'find_review',code:'jev_http_503',frameId:5,durationMs:8000,text:'private',jpeg:'private',token:'private'});
 const output=readFileSync(join(root,'diagnostics.jsonl'),'utf8');assert.doesNotMatch(output,/private|token|jpeg/);assert.equal(JSON.parse(output).code,'jev_http_503');
});

test('a capped water cup detected as bottle reaches Jev and remains guided on subsequent frames',async t=>{
 const m=memory(t);saved(m);const bottle={...right,label:'bottle'};let calls=0;
 const s=new Session({memory:m,detector:{ready:true,busy:false,run:async(f,o)=>{assert.deepEqual(o.targets,['cup','bottle']);return {detections:[bottle],candidates:[bottle]};}},providers:{review:async(f,o)=>{calls++;assert.equal(o.references.length,1);return {decision:'CONFIRM'};}}});
 s.start();s.frame(picture,s.source.generation,1,Date.now());await s.command({commandId:uuid(),action:'find',target:'蓝色水杯'});await s.tick();await settle();
 assert.equal(calls,1);assert.equal(s.state,'GUIDING');assert.equal(s.lastConfirmed.label,'bottle');
 s.frame(picture,s.source.generation,2,Date.now());await s.tick();assert.equal(s.state,'GUIDING');
});

test('an unverified target crop is supplemented by its original scene instead of hiding the fuller reference',t=>{
 const m=memory(t),r=m.capture('蓝色水杯',frame());m.finish(r,{appearance:{jpeg:picture,embedding:vector(0)},description:'蓝色瓶状水杯',suggestedLocation:'桌面',failureKind:'REVIEW_UNCERTAIN'});
 const o=m.get(r.objectId);assert.deepEqual(m.references(o),[o.appearances[0].image,o.captures[0].image]);assert.equal(o.locations.length,0);
});
