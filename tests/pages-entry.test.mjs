import test from 'node:test';
import assert from 'node:assert/strict';
import entry from '../cloudflare/pages/worker.mjs';
import {createHandler} from '../cloudflare/worker.mjs';

const origin='https://entry.pages.dev';
test('Pages serves the latest Worker assets without a public workers.dev fetch',async()=>{
 const request=new Request(origin+'/video/');let called=0;
 const worker=createHandler(()=>{throw Error('No provider call for assets');});
 const env={ASSETS:{fetch:async req=>{called++;assert.equal(req,request);return new Response('current UI',{headers:{'Content-Type':'text/html'}});}}};
 const response=await entry.fetch(request,{MEMORY_API:{fetch:req=>worker(req,env)}});
 assert.equal(response.status,200);assert.equal(await response.text(),'current UI');assert.equal(called,1);
 assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-Frame-Options'),'DENY');
});

test('Pages keeps POST body, origin, client identity, cookies and streamed replies intact',async()=>{
 const request=new Request(origin+'/api/vision',{method:'POST',headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.10',Cookie:'session=test'},body:'{"stream":true}'});
 const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: first\n\n'));controller.close();}});
 const response=new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
 const actual=await entry.fetch(request,{MEMORY_API:{fetch:async req=>{
  assert.equal(req,request);assert.equal(req.url,origin+'/api/vision');assert.equal(req.headers.get('Origin'),origin);assert.equal(req.headers.get('CF-Connecting-IP'),'192.0.2.10');assert.equal(req.headers.get('Cookie'),'session=test');assert.equal(await req.text(),'{"stream":true}');return response;
 }}});
 assert.equal(actual,response);assert.equal(actual.body,stream);assert.equal(await actual.text(),'data: first\n\n');
});

test('Pages retains original API origin checks and independent request limits',async()=>{
 const worker=createHandler(()=>{throw Error('No provider calls expected');});
 const env={ASSETS:{fetch:()=>{throw Error('API must not become an asset');}},ACCESS_LIMITER:{limit:async()=>({success:true})}};
 const binding={MEMORY_API:{fetch:req=>worker(req,env)}};
 assert.equal((await entry.fetch(new Request(origin+'/api/access'),binding)).status,200);
 assert.equal((await entry.fetch(new Request(origin+'/api/access',{method:'POST',headers:{Origin:'https://elsewhere.test'},body:'{}'}),binding)).status,403);
 env.ACCESS_LIMITER.limit=async()=>({success:false});
 assert.equal((await entry.fetch(new Request(origin+'/api/access'),binding)).status,429);
 assert.equal((await entry.fetch(new Request(origin+'/api/unknown'),binding)).status,404);
});
