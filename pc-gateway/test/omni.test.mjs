import test from 'node:test';
import assert from 'node:assert/strict';
import {OmniProviders,parseOmniReview} from '../src/omni.mjs';
import {Session} from '../src/session.mjs';
import {CandidateContinuity} from '../src/tracking.mjs';
import {memory,frame,picture} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
const answer=(f,extra={})=>JSON.stringify({f,visible:true,clear:true,distinctive:true,same:'MATCH',evidence:'杯身相同缺口和图案',...extra});
const response=content=>Response.json({choices:[{message:{content}}]});
const tick=()=>new Promise(r=>setImmediate(r));
const candidate={label:'cup',score:.95,box:[.3,.2,.6,.8],trackId:7,cropJpeg:picture.toString('base64')};

test('Omni review binds current and reference images to one Realtime request, never Jev',async()=>{
 const f=frame(),calls=[];const p=new OmniProviders({prepare:async(current,reference)=>{assert.deepEqual(current,picture);assert.deepEqual(reference,picture);return picture;},client:{request:async(prompt,image)=>{calls.push({prompt,image});return answer(f.frameId);}}});
 assert.equal((await p.review(f,{target:'杯子',crop:picture,references:[picture]})).decision,'CONFIRM');
 assert.equal(calls.length,1);assert.match(calls[0].prompt,/CURRENT.*HISTORICAL REFERENCE/);
 assert.doesNotMatch(calls[0].prompt,/openrouter|typesafe|jev-1/);
});
test('wrong frames, absent evidence and ambiguous identity cannot confirm',()=>{
 assert.throws(()=>parseOmniReview(answer(2),1,true),/frame_invalid/);
 assert.equal(parseOmniReview(answer(1,{same:'UNCERTAIN'}),1,true).decision,'UNCERTAIN');
 assert.equal(parseOmniReview(answer(1,{evidence:''}),1,true).decision,'UNCERTAIN');
 assert.equal(parseOmniReview(answer(1,{clear:false}),1,true).decision,'UNCERTAIN');
 assert.equal(parseOmniReview(answer(1,{distinctive:false}),1,true).decision,'UNCERTAIN');
 assert.throws(()=>parseOmniReview(answer(1,{evidence:'已保存成功'}),1,true),/output_invalid/);
 assert.equal(parseOmniReview(answer(1,{same:'DIFFERENT'}),1,true).decision,'REJECT');
});
test('three network failures pause review requests; explicit cancellation is not an outage',async()=>{
 let now=0,calls=0;const p=new OmniProviders({now:()=>now,prepare:async()=>picture,client:{request:async()=>{calls++;throw Error('omni_connection_failed');}}});
 for(let i=0;i<3;i++)await assert.rejects(p.review(frame(),{target:'杯子'}),/connection_failed/);
 await assert.rejects(p.review(frame(),{target:'杯子'}),/cooldown/);assert.equal(calls,3);
 now=15001;await assert.rejects(p.review(frame(),{target:'杯子'}),/connection_failed/);assert.equal(calls,4);
 const c=new AbortController();c.abort();await assert.rejects(new OmniProviders().review(frame(),{target:'杯子'},c.signal),/cancelled/);
});
test('one Omni observation saves real records and never calls an independent reviewer',async t=>{
 const m=memory(t),events=[];let calls=0;
 const s=new Session({memory:m,providers:{singlePassMemory:true,describe:async()=>{calls++;return {v:true,d:'蓝色杯子',l:'键盘右侧',b:[.3,.2,.6,.8]};},review:()=>{throw Error('must_not_wait');}},emit:e=>events.push(e)});
 s.start();s.frame(picture,s.source.generation,1,Date.now());await s.command({commandId:uuid(),text:'记住这个杯子'});
 const o=m.all()[0];assert.equal(calls,1);assert.equal(o.appearances.length,1);assert.equal(o.locations.length,0);
 assert.equal(m.locationHistory(o.id)[0].source,'CAMERA_OBSERVED');assert.equal(events.filter(e=>e.type==='reply'&&e.kind!=='ack').length,1);
 assert.match(events.filter(e=>e.type==='reply'&&e.kind!=='ack')[0].message,/已记录.*位置尚待核对/);
 await s.command({commandId:uuid(),text:'杯子上次在哪'});assert.equal(calls,1);assert.match(events.filter(e=>e.type==='reply').at(-1).message,/键盘右侧/);
});
test('cancelled Omni memory keeps the captured scene but cannot append a late observation',async t=>{
 const m=memory(t);let done;const d=new Promise(r=>done=r);const s=new Session({memory:m,providers:{singlePassMemory:true,describe:()=>d}});
 s.start();s.frame(picture,s.source.generation,1,Date.now());const pending=s.command({commandId:uuid(),text:'记住杯子'});
 s.stop();done({v:true,d:'蓝杯',l:'桌面'});await pending;assert.equal(m.all()[0].captures.length,1);assert.equal(m.all()[0].description,null);
});
test('failed Omni analysis does not claim a save of appearance or location',async t=>{
 const m=memory(t),events=[];const s=new Session({memory:m,providers:{singlePassMemory:true,describe:async()=>{throw Error('qwen_image_timeout');}},emit:e=>events.push(e)});
 s.start();s.frame(picture,s.source.generation,1,Date.now());await s.command({commandId:uuid(),text:'记住杯子'});
 assert.equal(m.all()[0].captures[0].status,'SCENE_ONLY');assert.equal(s.state,'IDLE');assert.match(events.filter(e=>e.type==='reply').at(-1).message,/还未确认/);
});
test('tracking bridge requires repeated, fresh, unambiguous observations and has a hard age bound',()=>{
 const f={...frame(),receivedAtMs:0},track=new CandidateContinuity(candidate,f,0);
 for(let n=1;n<=4;n++)track.update({...f,frameId:n+1,receivedAtMs:n*1000},{detections:[candidate]},n*1000);
 assert.deepEqual(track.current(4000),candidate.box);assert.equal(track.current(8100),null);
 track.update({...f,frameId:6,receivedAtMs:4100},{detections:[]},4100);assert.equal(track.current(4100),null);
});
test('slow Omni confirmation uses the latest continuously tracked position, not the old box',async t=>{
 const m=memory(t);let now=Date.now(),finish;const review=new Promise(r=>finish=r),events=[];let current=candidate;
 const s=new Session({memory:m,now:()=>now,providers:{trackCandidates:true,review:()=>review},detector:{ready:true,busy:false,run:async()=>({detections:[current],candidates:[current]})},emit:e=>events.push(e)});
 s.start();s.frame(picture,s.source.generation,1,now);await s.command({commandId:uuid(),text:'帮我找杯子'});await s.tick();
 for(let n=1;n<=4;n++){now+=1000;current={...candidate,box:[.3+n*.02,.2,.6+n*.02,.8]};s.frame(picture,s.source.generation,n+1,now);await s.tick();}
 finish({decision:'CONFIRM'});await tick();assert.equal(s.state,'GUIDING');assert.deepEqual(s.lastConfirmed.box,current.box);
});
test('a replacement or disappeared track invalidates a delayed confirmation',async t=>{
 const m=memory(t);let now=Date.now(),finish;const review=new Promise(r=>finish=r);let current=candidate;
 const s=new Session({memory:m,now:()=>now,providers:{trackCandidates:true,review:()=>review},detector:{ready:true,busy:false,run:async()=>({detections:[current],candidates:[current]})}});
 s.start();s.frame(picture,s.source.generation,1,now);await s.command({commandId:uuid(),text:'帮我找杯子'});await s.tick();
 now+=500;current={...candidate,trackId:8};s.frame(picture,s.source.generation,2,now);await s.tick();finish({decision:'CONFIRM'});await tick();assert.equal(s.state,'SEARCHING');assert.equal(s.lastConfirmed,null);
});

test('intent requests cannot inherit camera history or speak a non-chat answer',async()=>{
 const p=new OmniProviders({client:{request:()=>{throw Error('vision_context_must_not_be_used');}},intentClient:{request:async()=>JSON.stringify({action:'describe',answer:'旧画面有公交车'})}});
 const result=await p.interpret('瞧瞧眼前',null,[]);assert.equal(result.action,'describe');assert.equal(result.answer,undefined);
});
