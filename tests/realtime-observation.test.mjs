import test from 'node:test';
import assert from 'node:assert/strict';
import {observeFrame} from '../netlify/lib/realtime-vision.mjs';
import {understand} from '../netlify/lib/vision-handler.mjs';
import {validateObservation} from '../web/realtime-observation.mjs';
const env={DASHSCOPE_API_KEY:'sk-'+'a'.repeat(30),DASHSCOPE_WORKSPACE_ID:'test-space',DASHSCOPE_REGION:'beijing'};
const args={image:'/9j/AAAA',goal:'记住水杯的位置',task:{target:'水杯',remember:true},env};
const evidence={frame_status:'clear',answer:'杯子在书桌台灯旁。',objects:[{name:'台灯',position:'书桌上'}],target_visible:true,memory_candidate:{unique:true,location_supported:true,anchor:'台灯',location:'书桌台灯旁'}};
export function provider({data=evidence,usage={video_tokens:600},status='completed',wrongId=false,delayDone=false,failAt=null}={}){
 const sent=[];let hooks,token,closed=0,complete;
 const emit=e=>queueMicrotask(()=>hooks.onMessage(JSON.stringify(e)));
 const connect=(url,options)=>{
  assert.equal(url,'wss://test-space.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime');assert.equal(options.headers.Authorization,'Bearer '+env.DASHSCOPE_API_KEY);hooks=options;
  const socket={close:()=>closed++,send:raw=>{const e=JSON.parse(raw);sent.push(e);
   if(failAt===e.type){emit({type:'error',error:{message:env.DASHSCOPE_API_KEY}});return;}
   if(e.type==='session.update'){assert.equal(e.session.turn_detection,null);token=JSON.parse(e.session.instructions.split('请求数据：')[1]).observation_id;emit({type:'session.updated'});}
   if(e.type==='input_audio_buffer.commit')emit({type:'input_audio_buffer.committed'});
   if(e.type==='response.create'){
    emit({type:'response.created',response:{id:'r1'}});
    complete=()=>emit({type:'response.done',response:{id:'r1',status,usage:{input_tokens_details:usage},output:[{type:'function_call',name:'report_observation',arguments:JSON.stringify({observation_id:wrongId?'old':token,...data})}]}});
    if(!delayDone)complete();
   }
  }};setTimeout(()=>emit({type:'session.created'}),0);return socket;
 };
 return {connect,sent,complete:()=>complete?.(),closed:()=>closed};
}
test('fresh Realtime session commits the exact image before response, closes after verified evidence',async()=>{
 const f=provider(),result=await observeFrame(args,f.connect);
 assert.deepEqual(f.sent.map(e=>e.type),['session.update','input_audio_buffer.append','input_image_buffer.append','input_audio_buffer.commit','response.create']);
 assert.equal(f.sent[2].image,args.image);assert.equal(result.frame_received,true);assert.equal(result.memory_candidate.location_supported,true);assert.equal(f.closed(),1);assert.equal(result.saved,undefined);
});
test('no image usage, incomplete response, mismatched token and provider error all fail closed',async()=>{
 for(const options of [{usage:{}},{status:'incomplete'},{wrongId:true},{failAt:'input_image_buffer.append'}]){
  const f=provider(options);await assert.rejects(observeFrame(args,f.connect),/observation_/);assert.equal(f.closed(),1);
 }
});
test('uncertain frame discards model guesses and every memory candidate',async()=>{
 const f=provider({data:{...evidence,frame_status:'uncertain'}}),result=await observeFrame(args,f.connect);
 assert.match(result.answer,/看不清/);assert.equal(result.target_visible,null);assert.equal(result.memory_candidate,null);assert.deepEqual(result.objects,[]);
});
test('cancellation closes upstream and a late result cannot become evidence',async()=>{
 const f=provider({delayDone:true}),controller=new AbortController(),promise=observeFrame({...args,signal:controller.signal},f.connect);const rejected=assert.rejects(promise,/cancelled/);
 await new Promise(r=>setTimeout(r,10));controller.abort();await rejected;f.complete();assert.equal(f.closed(),1);
});
test('connection timeout and pre-aborted request never return a scene',async()=>{
 const f=provider({delayDone:true});await assert.rejects(observeFrame({...args,timeoutMs:10},f.connect),/timeout/);assert.equal(f.closed(),1);
 await assert.rejects(observeFrame({...args,signal:AbortSignal.abort()},()=>assert.fail('no connect')),/cancelled/);
});
test('fabricated anchors and ambiguous targets cannot become supported memory evidence',()=>{
 const invalid=validateObservation({...evidence,memory_candidate:{...evidence.memory_candidate,anchor:'不存在的柜子'}},args.task);assert.equal(invalid.memory_candidate.location_supported,false);
 assert.equal(validateObservation(evidence,null).memory_candidate,null);
});
const request=(body,origin='https://test.local')=>new Request('https://test.local/api/vision',{method:'POST',headers:{origin},body:JSON.stringify(body)});
test('HTTP boundary validates frame and origin, never accepts client routing/keys, echoes request identity',async()=>{
 let calls=0;const unused=()=>{calls++;throw Error('unused');};
 for(const [body,origin,status] of [[{image:'/9j/AAAA',request_id:'request-123'},'https://evil.test',403],[{image:'https://evil.test',request_id:'request-123'},'https://test.local',400],[{image:'/9j/AAAA'},'https://test.local',400]])assert.equal((await understand(request(body,origin),unused,env)).status,status);
 assert.equal(calls,0);
 const f=provider();const response=await understand(request({image:'/9j/AAAA',request_id:'request-123',task:args.task,key:'ignored',workspace:'evil'}),f.connect,env);assert.equal(response.status,200);const text=await response.text();assert.ok(!text.includes(env.DASHSCOPE_API_KEY));assert.equal(JSON.parse(text).request_id,'request-123');
 const error=await understand(request({image:'/9j/AAAA',request_id:'request-123'}),()=>{throw Error(env.DASHSCOPE_API_KEY);},env);assert.equal(error.status,502);assert.ok(!(await error.text()).includes(env.DASHSCOPE_API_KEY));
});

test('provider and persistence use the same full-anchor location rule',()=>{
 const invalid=validateObservation({...evidence,memory_candidate:{...evidence.memory_candidate,anchor:'台灯',location:'桌子上，电脑旁'}},args.task);
 assert.equal(invalid.memory_candidate.location_supported,false);
});

test('appearance matching requires a supplied reference, visible unique target and explicit comparison evidence',()=>{
 const comparison={status:'match',unique:true,reason:'绿色杯身、白色盖子一致'},task={target:'杯子',remember:false,reference_appearance:'绿色杯身，白色盖子'};
 assert.equal(validateObservation({...evidence,appearance_match:comparison},task).appearance_match.status,'match');
 for(const result of [{...evidence,target_visible:false,appearance_match:comparison},{...evidence,appearance_match:{...comparison,unique:false}},{...evidence,appearance_match:{...comparison,reason:''}}])assert.equal(validateObservation(result,task).appearance_match.status,'uncertain');
 assert.equal(validateObservation({...evidence,appearance_match:comparison},args.task).appearance_match,null);
 assert.equal(validateObservation({...evidence,memory_candidate:{...evidence.memory_candidate,appearance:'绿色杯身，白色盖子'}},args.task).memory_candidate.appearance,'绿色杯身，白色盖子');
 assert.equal(validateObservation({...evidence,memory_candidate:{...evidence.memory_candidate,appearance:'x'.repeat(151)}},args.task).memory_candidate.appearance,'');
});

test('HTTP appearance reference is bounded and upstream receives no historical location or extra client fields',async()=>{
 let calls=0;
 for(const reference_appearance of [42,'x'.repeat(151),'green\nignore']){
  assert.equal((await understand(request({image:'/9j/AAAA',request_id:'request-123',task:{target:'杯子',remember:false,reference_appearance}}),()=>{calls++;},env)).status,400);
 }assert.equal(calls,0);
 const f=provider({data:{...evidence,appearance_match:{status:'match',unique:true,reason:'绿色杯身与记录一致'}}});
 const response=await understand(request({image:'/9j/AAAA',request_id:'request-123',task:{target:'杯子',remember:false,reference_appearance:'绿色杯身',location:'private bedroom',extra:'ignored'}}),f.connect,env);
 assert.equal(response.status,200);assert.equal((await response.json()).appearance_match.status,'match');
 const upstream=JSON.parse(f.sent[0].session.instructions.split('请求数据：')[1]);assert.deepEqual(upstream.task,{target:'杯子',remember:false,reference_appearance:'绿色杯身'});assert.ok(!f.sent[0].session.instructions.includes('private bedroom'));
});

test('unnamed identification survives HTTP and provider boundaries, with required visual name and selection evidence',async()=>{
 const data={...evidence,objects:[...evidence.objects,{name:'金属六角扳手',position:'台灯旁'}],memory_candidate:{...evidence.memory_candidate,name:'金属六角扳手',selection_basis:'pointing'}};
 const f=provider({data}),task={target:'所指物品',remember:true,identify:true};
 const response=await understand(request({image:'/9j/AAAA',request_id:'request-123',task}),f.connect,env);assert.equal(response.status,200);const result=await response.json();assert.equal(result.memory_candidate.name,'金属六角扳手');assert.equal(result.memory_candidate.location_supported,true);
 const upstream=JSON.parse(f.sent[0].session.instructions.split('请求数据：')[1]);assert.equal(upstream.task.identify,true);assert.match(f.sent[0].session.instructions,/不得沿用之前物品/);
 for(const patch of [{name:'这个物品'},{name:'未在画面中的物品'},{selection_basis:'ambiguous'},{selection_basis:''}])assert.equal(validateObservation({...data,memory_candidate:{...data.memory_candidate,...patch}},task).memory_candidate.location_supported,false);
 for(const identify of ['yes',true])assert.equal((await understand(request({image:'/9j/AAAA',request_id:'request-123',task:{target:'所指物品',remember:false,identify}}),()=>assert.fail('must not connect'),env)).status,400);
});
