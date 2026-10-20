import test from 'node:test';
import assert from 'node:assert/strict';
import {androidGateway} from '../cloudflare/android/gateway.mjs';
const env={QWEN_API_KEY:'test-only-credential',VOICE_LIMITER:{limit:async()=>({success:true})},IMAGE_LIMITER:{limit:async()=>({success:true})}};
const request=(path,body={})=>new Request('https://android.test'+path,{method:'POST',body:JSON.stringify(body)});
test('Android gateway fixes provider and models, returns only ephemeral credentials and never returns the API key',async()=>{
 const calls=[];const run=androidGateway(async(url,options)=>{calls.push({url,options});return Response.json({aoqTokenForClient:'temporary',sid:'session',clientRelayCertFingerprint:'cert',clientRelayEndpoints:[],api_key:env.QWEN_API_KEY,sidExpiresInSecs:999999});});
 const result=await run(request('/api/android/credential',{url:'https://attacker.test',model:'other'}),env),body=await result.text();assert.equal(result.status,200);assert.ok(!body.includes(env.QWEN_API_KEY));assert.equal(JSON.parse(body).sidExpiresInSecs,7200);assert.ok(calls[0].url.startsWith('https://maas.qianwenaiapi.com/'));assert.equal(calls[0].options.redirect,'manual');assert.equal(calls[0].options.headers.Authorization,'Bearer '+env.QWEN_API_KEY);
});
test('Android image checks accept only JPEGs embedded in a bounded candidate request, not remote image addresses',async()=>{
 const calls=[];const run=androidGateway(async(url,options)=>{calls.push({url,options});return Response.json({choices:[{message:{content:'TARGET_CHECK|visible=false'}}],key:env.QWEN_API_KEY});});
 const content=[{type:'image_url',image_url:{url:'data:image/jpeg;base64,/9j/AAAA'}},{type:'text',text:'Find cup'}];
 const body={model:'other',messages:[{role:'user',content}]};let response=await run(request('/api/android/image',body),env);assert.equal(response.status,200);assert.equal(JSON.parse(calls[0].options.body).model,'qwen3.8-omni-flash');assert.equal(JSON.parse(calls[0].options.body).max_tokens,120);assert.ok(!(await response.text()).includes(env.QWEN_API_KEY));
 content[0].image_url.url='http://private-host/picture';response=await run(request('/api/android/image',body),env);assert.equal(response.status,400);assert.equal(calls.length,1);
});
test('Android gateway errors, missing config and rate limits fail without leaking upstream responses',async()=>{
 const run=androidGateway(async()=>Response.json({secret:env.QWEN_API_KEY},{status:401}));
 for(const input of [env,{...env,QWEN_API_KEY:''},{...env,VOICE_LIMITER:{limit:async()=>({success:false})}}]){const response=await run(request('/api/android/credential'),input);assert.ok(response.status>=400);assert.ok(!(await response.text()).includes(env.QWEN_API_KEY));}
});
