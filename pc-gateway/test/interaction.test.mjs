import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';
import {Providers,parseJev,jevPayload} from '../src/providers.mjs';
import {parseIntent,validateSemantic} from '../src/intent.mjs';
import {memory,picture,frame} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
const noul=noul=>({type:'noul',noul});
const reviewed=answers=>({model:'typesafe/jev-1.14',answers:{target_visible:noul(.99),detail_clear:noul(.95),...answers}});
test('the object name excludes command words in ordinary remember phrases',()=>{
 assert.equal(parseIntent('帮我把这个毛绒玩具记住').target,'毛绒玩具');
 assert.equal(validateSemantic({action:'remember',target:'帮我把这个毛绒玩具'},'帮我把这个毛绒玩具记住',null).target,'毛绒玩具');
});
test('clear general questions get a direct answer without changing object memory',async t=>{
 const m=memory(t),events=[];const s=new Session({memory:m,emit:e=>events.push(e),providers:{intent:async()=>({action:'chat',answer:'联网分析会消耗配置账号的API额度，具体费用以服务商账单为准。'})}});
 await s.command({commandId:uuid(),text:'这个是要收费还是咋的'});
 assert.equal(m.all().length,0);assert.match(events.filter(e=>e.type==='reply')[0].message,/API额度/);assert.equal(events.filter(e=>e.type==='reply').length,1);
 assert.equal(validateSemantic({action:'chat',answer:'已经保存成功了'},'你是谁',null),null);
 assert.equal(validateSemantic({action:'remember',target:'杯子'},'你是谁',null),null);
});
test('frozen-frame proposed crop can be confirmed without beta box output; rejected location stays unconfirmed',()=>{
 const proposal={memory:true,proposalBox:[.1,.2,.5,.8],proposalLocation:'书桌左边',proposalAnchor:'书桌'};
 const p=jevPayload(frame(),{...proposal,target:'杯子',crop:picture});
 assert.ok(p.questions.candidate_matches);assert.ok(p.questions.location_matches);assert.equal(p.questions.target_box,undefined);
 const r=parseJev(reviewed({candidate_matches:noul(.97),location_matches:noul(.05)}),proposal);
 assert.deepEqual(r.box,proposal.proposalBox);assert.equal(r.location,null);
 const noBox=parseJev(reviewed({candidate_matches:noul(.05),location_matches:noul(.99)}),proposal);
 assert.equal(noBox.box,null);assert.equal(noBox.location.location,'书桌左边');
});
test('untrusted proposals never turn into memory through confidence alone',()=>{
 const r=parseJev(reviewed({candidate_matches:noul(.2),location_matches:noul(.3)}),{memory:true,proposalBox:[.1,.1,.8,.8],proposalLocation:'桌面上'});
 assert.equal(r.box,null);assert.equal(r.location,null);
});
test('scene request accepts more than three objects and answers the actual question in natural prose',async()=>{
 const f=frame(),items=['杯子','键盘','鼠标','屏幕','书','台灯'];let request;
 const p=new Providers({fetcher:async(_,options)=>{request=JSON.parse(options.body);return Response.json({choices:[{message:{content:JSON.stringify({f:f.frameId,v:true,d:'',l:'',a:'',i:items,answer:'桌上有电脑和键盘，右侧摆着杯子、台灯和几本书，鼠标在键盘旁。'})}}]});}});
 const result=await p.describe(f,null,'桌面上都有什么');
 assert.equal(result.i.length,6);assert.match(result.answer,/右侧/);assert.equal(request.task,'scene');
});
test('a late failed semantic request cannot append an error after a newer scene answer',async t=>{
 let fail;const pending=new Promise((_,reject)=>{fail=reject;});const events=[];
 const s=new Session({memory:memory(t),emit:e=>events.push(e),providers:{intent:()=>pending,describe:async()=>({i:['杯子'],answer:'杯子在键盘旁边。'})}});
 s.start();s.frame(picture,s.source.generation,1,Date.now());
 const old=s.command({commandId:uuid(),text:'模糊表达'});
 await s.command({commandId:uuid(),text:'画面里面有什么'});
 fail(Error('client_operation_failed'));await old;
 assert.deepEqual(events.filter(e=>e.type==='reply').map(e=>e.message),['杯子在键盘旁边。']);
});
test('clear scene phrases and filler never need a cloud intent round-trip',async t=>{
 for(const words of ['画面里面有什么','我的前面有什么','帮我看看桌面上有哪些东西','这个是什么颜色'])assert.equal(parseIntent(words).action,'describe');
 let calls=0;const s=new Session({memory:memory(t),providers:{intent:async()=>{calls++;throw Error();}}});
 await s.command({commandId:uuid(),text:'我操。'});assert.equal(calls,0);
});
test('memory stores a validated proposed crop, description and location and replies only once',async t=>{
 const m=memory(t),events=[];let cropCount=0;
 const s=new Session({memory:m,emit:e=>events.push(e),crop:async()=>{cropCount++;return {jpeg:picture,embedding:Buffer.alloc(48*4).toString('base64')};},providers:{describe:async()=>({v:true,d:'白色带把杯',l:'键盘右侧',a:'键盘',b:[.2,.1,.6,.8]}),review:async(_,options)=>{assert.ok(options.crop);assert.equal(options.proposalLocation,'键盘右侧');return {box:options.proposalBox,location:{location:'键盘右侧',anchor:'键盘'}};}}});
 s.start();s.frame(picture,s.source.generation,1,Date.now());await s.command({commandId:uuid(),text:'记住这个杯子'});
 const object=m.all()[0];assert.equal(object.description,'白色带把杯');assert.equal(object.appearances.length,1);assert.equal(object.locations[0].location,'键盘右侧');assert.equal(object.captures[0].status,'COMPLETE');assert.equal(cropCount,1);
 assert.equal(events.filter(e=>e.type==='reply').length,1);
});
test('a unique frozen-frame local candidate is reviewed before the slower description finishes',async t=>{
 let describeDone,reviewStarted;const description=new Promise(r=>describeDone=r),started=new Promise(r=>reviewStarted=r);
 const m=memory(t);const box=[.2,.1,.6,.8];
 const s=new Session({memory:m,crop:async()=>({jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}),detector:{ready:true,busy:false,run:async f=>({frameId:f.frameId,detections:[{label:'cup',score:.9,box}]})},providers:{describe:()=>description,review:async()=>{reviewStarted();return {visible:.99,clear:.99,candidateMatch:.99,box,location:{location:'桌面上',anchor:'桌面'}};}}});
 s.start();s.frame(picture,s.source.generation,1,Date.now());const work=s.command({commandId:uuid(),text:'记住杯子'});
 await started;assert.equal(m.all()[0].captures[0].status,'CAPTURED');describeDone({v:true,d:'白色杯子'});await work;
 assert.equal(m.all()[0].captures[0].status,'COMPLETE');
});
test('an independently rejected local crop is not re-asked until it becomes a yes',async t=>{
 let calls=0;const m=memory(t);const box=[.2,.1,.6,.8];
 const s=new Session({memory:m,crop:async()=>({jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}),detector:{ready:true,busy:false,run:async f=>({frameId:f.frameId,detections:[{label:'cup',score:.9,box}]})},providers:{describe:async()=>({v:true,d:'杯子',l:'桌面上',b:box}),review:async()=>{calls++;return {visible:.99,clear:.99,candidateMatch:.02,box:null,location:null};}}});
 s.start();s.frame(picture,s.source.generation,1,Date.now());await s.command({commandId:uuid(),text:'记住杯子'});
 assert.equal(calls,1);assert.equal(m.all()[0].captures[0].status,'SCENE_ONLY');
});
