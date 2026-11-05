import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {androidGateway} from '../cloudflare/android/gateway.mjs';
import {buildJevRequest,readJevAnswer} from '../cloudflare/android/jev.mjs';
const photo=readFileSync(new URL('../android/app/src/androidTest/assets/bus.jpg',import.meta.url)).toString('base64');
const input=()=>({taskId:'task',candidateId:'candidate',frameId:12,target:'公交车',description:'有独特车牌的公交车',learning:false,requiresPersonalMatch:true,box:[.1,.2,.5,.8],scene:photo,candidate:photo,references:[photo,photo,photo]});
const env={TYPESAFE_API_KEY:'test-typesafe-secret',QWEN_API_KEY:'test-qwen-secret',IMAGE_LIMITER:{limit:async()=>({success:true})},VOICE_LIMITER:{limit:async()=>({success:true})}};
const request=(body=input())=>new Request('https://android.test/api/android/review',{method:'POST',body:JSON.stringify(body)});
const answer=(visible=.99,same=.98,clear=.97)=>({model:'jev-1.14.0',answers:{target_visible:{type:'noul',noul:visible},same_object:{type:'noul',noul:same},detail_clear:{type:'noul',noul:clear},direction:{type:'choice',choice:'center',confidence:.95}}});

test('Jev receives separately labelled current scene, crop and three historical references with a fixed model',()=>{
 const prepared=buildJevRequest({...input(),model:'other',url:'https://attacker.test',questions:{evil:{}}});
 assert.equal(prepared.payload.model,'jev-1.14.0');assert.equal(Object.keys(prepared.payload.assets).length,5);
 assert.equal(prepared.payload.state.references.length,3);assert.notEqual(prepared.payload.state.scene,prepared.payload.state.candidate);
 assert.ok(!('evil' in prepared.payload.questions));assert.ok(!('url' in prepared.payload));
 assert.match(prepared.payload.questions.same_object.instructions,/SAME individual/);
});

test('three-way decisions require current visibility, personal identity and clear details',()=>{
 const prepared=buildJevRequest(input());
 assert.equal(readJevAnswer(answer(),prepared).decision,'CONFIRMED');
 assert.equal(readJevAnswer(answer(.01),prepared).decision,'REJECTED');
 assert.equal(readJevAnswer(answer(.99,.01),prepared).decision,'REJECTED');
 for(const result of [answer(.6),answer(.99,.6),answer(.99,.99,.5),answer(.01,.01,.1)])assert.equal(readJevAnswer(result,prepared).decision,'UNCERTAIN');
 const confirmed=readJevAnswer(answer(),prepared);assert.equal(confirmed.direction,'画面左侧');assert.equal(confirmed.frameId,12);
});

test('missing, string, nonfinite, out-of-range answers and unexpected model cannot confirm',()=>{
 const prepared=buildJevRequest(input());
 for(const value of [undefined,'1',NaN,Infinity,-.1,1.1]){const body=answer();body.answers.same_object.noul=value;assert.throws(()=>readJevAnswer(body,prepared));}
 const body=answer();delete body.answers.detail_clear;assert.throws(()=>readJevAnswer(body,prepared));
 assert.throws(()=>readJevAnswer({...answer(),model:'jev-latest'},prepared));
});

test('full-scene review may only report a validated direction after visibility is established',()=>{
 const prepared=buildJevRequest({...input(),candidate:null});
 assert.equal(readJevAnswer(answer(),prepared).direction,'画面中央');
 const absent=answer(.01);assert.equal(readJevAnswer(absent,prepared).direction,null);
 const unknown=answer();unknown.answers.direction.choice='made-up';assert.equal(readJevAnswer(unknown,prepared).direction,null);
});

test('learning requires three actual target views and checks all of them as one individual',()=>{
 const prepared=buildJevRequest({...input(),learning:true,references:[photo,photo]});
 assert.match(prepared.payload.questions.same_object.instructions,/EVERY reference/);
 assert.throws(()=>buildJevRequest({...input(),learning:true,references:[photo]}));
 assert.throws(()=>buildJevRequest({...input(),learning:true,candidate:null}));
});

test('bad images, remote URLs, missing references and malformed bounds are rejected locally',()=>{
 for(const patch of [{scene:'https://private.test/a.jpg'},{scene:'/9j/AAAA'},{candidate:''},{references:[]},{references:[photo,photo,photo,photo]},{box:[0,0,2,1]},{box:[.5,0,.4,1]},{frameId:-1},{learning:'false'},{target:'x'.repeat(161)}])assert.throws(()=>buildJevRequest({...input(),...patch}));
});

test('gateway keeps Qwen voice and Jev review separate, and never returns either long-lived key',async()=>{
 const calls=[];const run=androidGateway(async(url,options)=>{calls.push({url,options});return Response.json(url.includes('typesafe')?{...answer(),secret:env.TYPESAFE_API_KEY}:{aoqTokenForClient:'ephemeral',clientRelayEndpoints:[]});});
 let result=await run(request(),env);const text=await result.text();assert.equal(result.status,200);assert.equal(JSON.parse(text).decision,'CONFIRMED');
 assert.ok(!text.includes(env.TYPESAFE_API_KEY));assert.ok(!text.includes(env.QWEN_API_KEY));
 assert.equal(calls[0].url,'https://api.typesafe.ai/v1/systemone');assert.equal(calls[0].options.headers.Authorization,'Bearer '+env.TYPESAFE_API_KEY);
 assert.equal(calls[0].options.headers['TypeSafe-Danger-Zone-Images'],'true');assert.equal(calls[0].options.redirect,'manual');
 result=await run(new Request('https://android.test/api/android/credential',{method:'POST',body:'{}'}),env);assert.equal(result.status,200);
 assert.ok(calls[1].url.startsWith('https://maas.qianwenaiapi.com/'));assert.equal(calls[1].options.headers.Authorization,'Bearer '+env.QWEN_API_KEY);
});

test('Jev review works with no Qwen credential and malformed requests never reach providers',async()=>{
 let calls=0;const run=androidGateway(async()=>{calls++;return Response.json(answer());});
 assert.equal((await run(request(),{...env,QWEN_API_KEY:''})).status,200);assert.equal(calls,1);
 assert.equal((await run(request({...input(),references:[]}),env)).status,400);
 assert.equal((await run(new Request('https://android.test/api/android/review',{method:'POST',body:'{'}),env)).status,400);assert.equal(calls,1);
});

test('missing key, limiting, upstream failure, malformed answers and timeout fail closed without fallback',async()=>{
 let calls=0;const run=androidGateway(async()=>{calls++;return Response.json({secret:env.TYPESAFE_API_KEY},{status:401});});
 assert.equal((await run(request(),{...env,TYPESAFE_API_KEY:''})).status,503);
 assert.equal((await run(request(),{...env,IMAGE_LIMITER:{limit:async()=>({success:false})}})).status,429);assert.equal(calls,0);
 const response=await run(request(),env);assert.equal(response.status,502);assert.ok(!(await response.text()).includes(env.TYPESAFE_API_KEY));assert.equal(calls,1);
 const invalid=androidGateway(async()=>Response.json({model:'jev-1.14.0',answers:{}}));assert.equal((await invalid(request(),env)).status,502);
 const timeout=androidGateway(async()=>{throw new DOMException('test','TimeoutError');});assert.equal((await (await timeout(request(),env)).json()).code,'vision_timeout');
});

test('oversized request is stopped before provider access',async()=>{
 let called=false;const run=androidGateway(async()=>{called=true;return Response.json(answer());});
 const response=await run(new Request('https://android.test/api/android/review',{method:'POST',body:' '.repeat(4000001)}),env);
 assert.equal(response.status,413);assert.equal(called,false);
});

test('provider region restriction is reported as unavailable and never falls back to a positive result',async()=>{
 let calls=0;const run=androidGateway(async()=>{calls++;return Response.json({title:'Typesafe is not available in your region.',secret:env.TYPESAFE_API_KEY},{status:451});});
 const result=await run(request(),env);assert.equal(result.status,503);const body=await result.json();
 assert.equal(body.code,'vision_region_unavailable');assert.ok(!JSON.stringify(body).includes(env.TYPESAFE_API_KEY));assert.ok(!body.decision);assert.equal(calls,1);
});
