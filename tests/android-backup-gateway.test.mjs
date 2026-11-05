import test from 'node:test';
import assert from 'node:assert/strict';
import {androidGateway} from '../cloudflare/android/gateway.mjs';
const env={IMAGE_LIMITER:{limit:async()=>({success:true})}};
const owner='00000000-0000-4000-8000-000000000001';
const token='eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({sub:owner,role:'authenticated'})).toString('base64url')+'.signature';
const prefix='https://app.test/api/android/backup/',bucket='iseeyou-memory-backups';
const filename='1700000000000-00000000-0000-4000-8000-000000000002.zip';
const req=(path,{body,method='POST',auth=true,headers={}}={})=>new Request(prefix+path,{method,headers:{...(auth?{Authorization:'Bearer '+token}:{}),...headers},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});

test('backup settings use one fixed project and no administrator key or cookies',async()=>{
 let call;const run=androidGateway(async(url,options)=>{call={url,options};return Response.json({external:{email:true}});});
 const result=await run(req('auth/v1/settings',{method:'GET',auth:false,headers:{apikey:'injected',Cookie:'secret-cookie'}}),env);
 assert.equal(result.status,200);assert.equal(call.url,'https://awkzcvvzrsfjvqlloqqi.supabase.co/auth/v1/settings');
 assert.ok(call.options.headers.get('apikey').startsWith('sb_publishable_'));assert.equal(call.options.headers.get('Cookie'),null);assert.equal(result.headers.get('Cache-Control'),'no-store');
});
test('private upload is immutable and forwards only the authenticated user token',async()=>{
 let call;const run=androidGateway(async(url,options)=>{call={url,options};assert.equal(await new Response(options.body).text(),'zip-data');return Response.json({Key:'ok'});});
 const response=await run(req(`storage/v1/object/${bucket}/${owner}/${filename}`,{body:'zip-data',headers:{'Content-Type':'application/zip','x-upsert':'true'}}),env);
 assert.equal(response.status,200);assert.equal(call.options.headers.get('x-upsert'),'false');assert.equal(call.options.headers.get('Authorization'),'Bearer '+token);assert.equal(call.options.redirect,'manual');
});
test('anonymous reads reach Supabase so a private bucket denial is not fabricated by the relay',async()=>{
 let called=false;const run=androidGateway(async()=>{called=true;return Response.json({error:'not_found'},{status:404});});
 const result=await run(req(`storage/v1/object/public/${bucket}/${owner}/${filename}`,{method:'GET',auth:false}),env);
 assert.equal(result.status,404);assert.ok(called);
});
test('storage list is confined to a user directory and a bounded immutable listing',async()=>{
 let call;const run=androidGateway(async(url,options)=>{call=JSON.parse(options.body);return Response.json([]);});
 assert.equal((await run(req(`storage/v1/object/list/${bucket}`,{body:{prefix:owner+'/',limit:999999,offset:400}}),env)).status,200);
 assert.deepEqual(call,{prefix:owner+'/',limit:10,offset:0,sortBy:{column:'name',order:'desc'}});
});
test('unknown destinations, management calls, deletes and elevated credentials are never forwarded',async()=>{
 let calls=0;const run=androidGateway(async()=>{calls++;return Response.json({});});
 const elevated='eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({sub:owner,role:'service_role'})).toString('base64url')+'.signature';
 for(const request of [req('https://attacker.test',{method:'GET'}),req('auth/v1/admin/users',{body:{}}),req(`storage/v1/object/${bucket}/${owner}/${filename}`,{method:'DELETE'}),req(`storage/v1/object/list/${bucket}`,{body:{prefix:owner+'/'},headers:{Authorization:'Bearer '+elevated}}),req(`storage/v1/object/list/${bucket}`,{body:{prefix:'../'},auth:true})])assert.ok((await run(request,env)).status>=400);
 assert.equal(calls,0);
});
test('mail verification forwards only one-use proof, never arbitrary links or redirect destinations',async()=>{
 let payload;const run=androidGateway(async(url,options)=>{payload=JSON.parse(options.body);return Response.json({user:{id:owner}});});
 const response=await run(req('auth/v1/verify',{auth:false,body:{token_hash:'a'.repeat(64),type:'magiclink',redirect_to:'https://attacker.test',url:'https://attacker.test'}}),env);
 assert.equal(response.status,200);assert.deepEqual(payload,{token_hash:'a'.repeat(64),type:'magiclink'});
});
test('unexpected query parameters, redirects and rate limits fail without disclosing provider details',async()=>{
 let calls=0;const run=androidGateway(async()=>{calls++;return new Response('provider-secret',{status:302,headers:{Location:'https://attacker.test'}});});
 assert.equal((await run(req('auth/v1/settings?url=evil',{method:'GET',auth:false}),env)).status,400);assert.equal(calls,0);
 const redirect=await run(req('auth/v1/settings',{method:'GET',auth:false}),env);assert.equal(redirect.status,502);assert.ok(!(await redirect.text()).includes('provider-secret'));
 const rate=await run(req('auth/v1/settings',{method:'GET',auth:false}),{IMAGE_LIMITER:{limit:async()=>({success:false})}});assert.equal(rate.status,429);
});
