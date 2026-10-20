import test from 'node:test';
import assert from 'node:assert/strict';
import {observeFocusedFrame,validCandidate,candidateRegion,perceptionNotice} from '../web/yolo-focus.mjs';
import {searchTarget,searchFollowup} from '../web/find-dialogue.mjs';
import {continuousTarget} from '../web/continuous-search.mjs';

const candidate={label:'cup',confidence:0.9,hits:2,box:[0.1,0.2,0.4,0.8]};
const frame={image:'/9j/whole',goal:'寻找绿色水杯',request_id:'request-whole',task:{target:'绿色水杯',remember:false,reference_appearance:'绿色杯身，有把手'}};
const result=(input,visible=true,appearance='match')=>({request_id:input.request_id,frame_received:true,frame_status:'clear',answer:visible?'水杯在桌面上。':'没看到水杯。',objects:[{name:'木桌',position:'画面中间'}],target_visible:visible,appearance_match:{status:appearance,unique:true,reason:'对照绿色杯身和把手'},memory_candidate:null});

test('repeat find and named close-up phrases retain the saved cup target without accepting negation',()=>{
 for(const phrase of ['重新帮我找绿色水杯','重新帮我找它','再帮我找这个绿色水杯','你再重新帮我找一下绿色水杯']){assert.equal(searchTarget(phrase,'绿色水杯'),'绿色水杯',phrase);assert.equal(continuousTarget(phrase,'绿色水杯'),'绿色水杯',phrase);}
 for(const phrase of ['不要重新帮我找绿色水杯','他说重新帮我找绿色水杯','如果再帮我找绿色水杯'])assert.equal(continuousTarget(phrase,'绿色水杯'),'',phrase);
 for(const phrase of ['我已经把镜头对准绿色水杯了','我都怼到水杯前面了','我靠近它了'])assert.equal(searchFollowup(phrase),true,phrase);
});

test('stable local proposal is not evidence, invalid boxes cannot be cropped',()=>{
 assert.equal(validCandidate(candidate),true);assert.equal(candidateRegion(candidate.box),'左侧');
 for(const patch of [{hits:1},{confidence:0.49},{box:[0,0,1.2,1]},{box:[0.5,0.5,0.1,0.9]},{box:[NaN,0,1,1]}])assert.equal(validCandidate({...candidate,...patch}),false);
 assert.match(perceptionNotice('loading'),/正在加载.*先用千问/);assert.match(perceptionNotice('unsupported_target'),/不在 YOLO 类别/);assert.match(perceptionNotice('confirmed'),/新画面确认/);
});

test('full-frame miss can be corrected by verified crop, using original frame position and no save candidate',async()=>{
 const calls=[];let active=0,max=0;
 const payload=await observeFocusedFrame({frame,candidate,crop:'/9j/crop',observe:async input=>{calls.push(input);max=Math.max(max,++active);await new Promise(resolve=>setImmediate(resolve));active--;return input.image===frame.image?result(input,false,'uncertain'):result(input);}});
 assert.equal(calls.length,2);assert.equal(max,2);assert.notEqual(calls[0].request_id,calls[1].request_id);assert.ok(calls.every(call=>call.task.remember===false&&call.task.reference_appearance===frame.task.reference_appearance));
 assert.equal(payload.request_id,frame.request_id);assert.equal(payload.target_visible,true);assert.equal(payload.focus.status,'confirmed');assert.equal(payload.memory_candidate,null);assert.match(payload.answer,/画面左侧/);assert.doesNotMatch(payload.answer,/上次|已保存/);
});

test('full-frame false positive cannot survive crop rejection, appearance conflict or uncertainty',async()=>{
 for(const kind of ['absent','different','multiple','uncertain']){
  const payload=await observeFocusedFrame({frame,candidate,crop:'/9j/crop',observe:async input=>{
   if(input.image===frame.image)return result(input);
   const value=result(input,kind!=='absent',kind==='absent'?'uncertain':kind);
   if(kind==='uncertain')value.frame_status='uncertain';return value;
  }});
  assert.equal(payload.target_visible,null,kind);assert.equal(payload.frame_status,'uncertain',kind);assert.equal(payload.memory_candidate,null,kind);
 }
});

test('clear object close-up does not need a visible placement anchor and never invents background from an unclear full frame',async()=>{
 const payload=await observeFocusedFrame({frame,candidate,crop:'/9j/crop',observe:async input=>input.image===frame.image?{...result(input,false,'uncertain'),frame_status:'uncertain',objects:[],appearance_match:null}:result(input)});
 assert.equal(payload.target_visible,true);assert.equal(payload.frame_status,'clear');assert.equal(payload.objects.length,1);assert.equal(payload.objects[0].name,'绿色水杯');assert.equal(payload.memory_candidate,null);assert.doesNotMatch(payload.answer,/桌面|台灯/);
});

test('focused checks reject stale identity; a crop network failure preserves only independently verified full-frame evidence',async()=>{
 await assert.rejects(observeFocusedFrame({frame,candidate,crop:'/9j/crop',observe:async input=>({...result(input),request_id:'stale'})}),/对应/);
 await assert.rejects(observeFocusedFrame({frame:{...frame,task:{...frame.task,remember:true}},candidate,crop:'/9j/crop',observe:async input=>result(input)}),/only for finding/);
 const payload=await observeFocusedFrame({frame,candidate,crop:'/9j/crop',observe:async input=>{if(input.image!==frame.image)throw Error('network');return result(input);}});
 assert.equal(payload.target_visible,true);assert.equal(payload.focus.status,'unavailable');assert.equal(payload.focus.fallback,'whole_frame');
 const unclear=await observeFocusedFrame({frame,candidate,crop:'/9j/crop',observe:async input=>{if(input.image!==frame.image)throw Error('network');return {...result(input),frame_status:'uncertain',target_visible:null,appearance_match:null};}});
 assert.equal(unclear.target_visible,null);assert.equal(unclear.frame_status,'uncertain');
});

test('whole-frame timeout preserves a verified matching crop without inventing background or claiming the whole frame was received',async()=>{
 for(const matches of [true,false]){
  const payload=await observeFocusedFrame({frame,candidate,crop:'/9j/crop',observe:async input=>{if(input.image===frame.image)throw Error('timeout');return result(input,matches,matches?'match':'different');}});
  assert.equal(payload.request_id,frame.request_id);assert.notEqual(payload.detail_request_id,frame.request_id);assert.equal(payload.whole_frame_received,false);assert.equal(payload.source,'current_camera_crop');assert.equal(payload.memory_candidate,null);
  assert.equal(payload.target_visible,matches?true:null);assert.equal(payload.objects.length,matches?1:0);assert.doesNotMatch(payload.answer,/木桌|台灯/);
 }
 await assert.rejects(observeFocusedFrame({frame,candidate,crop:'/9j/crop',observe:async()=>{throw Error('network');}}),/network/);
});
