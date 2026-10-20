import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {decodeYolo,StableCandidateGate,targetClasses} from '../web/yolo-core.mjs';
import {LocalYolo} from '../web/yolo-local.mjs';
import {localYoloEnabled} from '../web/yolo-config.mjs';
import {ContinuousSearch} from '../web/continuous-search.mjs';
import preview from '../cloudflare/yolo-preview-worker.mjs';

const detection=(label='cup',confidence=0.9,box=[0.1,0.2,0.4,0.8])=>({label,confidence,box});
test('the supplied model reconstructs exactly and its actual output supports 80 categories',async()=>{
 const manifest=JSON.parse(await fs.readFile('models/yolo/manifest.json','utf8'));
 const labels=JSON.parse(await fs.readFile('models/yolo/labels.json','utf8'));
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 const chunks=[];for(const part of manifest.parts){const bytes=await fs.readFile('models/yolo/'+part.file);assert.equal(bytes.length,part.bytes);assert.equal(hash(bytes),part.sha256);assert.ok(bytes.length<25*1024*1024);chunks.push(bytes);}
 const bytes=Buffer.concat(chunks);assert.equal(bytes.length,manifest.bytes);assert.equal(hash(bytes),manifest.sha256);assert.equal(bytes.subarray(4,8).toString(),'TFL3');assert.equal(labels.length,80);
});

test('YOLO decoding undoes padding, supports both output layouts and suppresses only same-class overlaps',()=>{
 const labels=['cup','bottle'],rows=[[50,50,40,20,0.9,0.1],[50,50,40,20,0.8,0.1],[50,50,40,20,0.1,0.85],[50,50,40,20,0.49,0.1]];
 const options={width:100,height:50,inputWidth:100,inputHeight:100,scale:1,padX:0,padY:25};
 const a=decodeYolo(Float32Array.from(rows.flat()),[1,4,6],labels,options);
 const b=decodeYolo(Float32Array.from(Array.from({length:6},(_,col)=>rows.map(row=>row[col])).flat()),[1,6,4],labels,options);
 assert.deepEqual(a,b);assert.equal(a.length,2);assert.deepEqual(a[0].box,[0.3,0.3,0.7,0.7]);
 const normalized=rows.map(row=>row.map((value,i)=>i<4?value/100:value));
 const c=decodeYolo(Float32Array.from(normalized.flat()),[1,4,6],labels,options);
 assert.ok(c[0].box.every((n,i)=>Math.abs(n-a[0].box[i])<0.000001));
 assert.throws(()=>decodeYolo(new Float32Array(4),[1,1,4],labels,options));
});

test('stable local confirmation requires two unique high-confidence views with overlapping positions',()=>{
 const gate=new StableCandidateGate();assert.equal(gate.offer([detection()],['cup']),null);
 assert.ok(gate.offer([detection('cup',0.8,[0.12,0.22,0.42,0.82])],['cup']));
 assert.equal(gate.offer([detection(),detection('cup',0.7,[0.6,0.2,0.9,0.8])],['cup']),null);
 assert.equal(gate.offer([detection()],['cup']),null);
 assert.equal(gate.offer([detection('cup',0.49)],['cup']),null);
 assert.equal(gate.offer([detection()],['cup']),null);
 assert.equal(gate.offer([detection('cup',0.9,[0.7,0.2,0.9,0.8])],['cup']),null);
});

test('target aliases preserve unknown objects and experimental detection never enables on the production origin',async()=>{
 const aliases=JSON.parse(await fs.readFile('models/yolo/aliases.json','utf8')),labels=JSON.parse(await fs.readFile('models/yolo/labels.json','utf8'));
 assert.deepEqual(targetClasses('蓝色水杯',labels,aliases),['cup']);assert.deepEqual(targetClasses('笔记本电脑',labels,aliases),['laptop']);
 for(const target of ['钥匙','紫色收纳袋','耳机','创可贴','鼠标垫'])assert.deepEqual(targetClasses(target,labels,aliases),[]);
 assert.equal(localYoloEnabled('https://i-see-you-spatial-memory.pages.dev'),false);assert.equal(localYoloEnabled('https://i-see-you-yolo-preview.pages.dev'),true);
 assert.equal(localYoloEnabled('https://9f2c39da.i-see-you-yolo-preview.pages.dev'),true);assert.equal(localYoloEnabled('https://i-see-you-yolo-preview.pages.dev.evil.test'),false);
});

test('a local candidate alone never finishes a search or overrides a rejected appearance',()=>{
 const search=new ContinuousSearch({observe:()=>{},setTimer:()=>1,clearTimer:()=>{}});
 search.start({task:{target:'绿杯子',reference_appearance:'绿色杯身'}});
 assert.equal(search.accept({target_visible:false},'clear',{stableCandidate:true}),false);
 assert.equal(search.accept({target_visible:true,appearance_match:{status:'different'}},'clear',{stableCandidate:true}),false);
 assert.equal(search.accept({target_visible:true,appearance_match:{status:'match'}},'uncertain',{stableCandidate:true}),false);
 assert.equal(search.accept({target_visible:true,appearance_match:{status:'match'}},'clear',{stableCandidate:true}),false);
 assert.equal(search.accept({target_visible:true,appearance_match:{status:'match'}},'clear',{stableCandidate:true}),true);
 assert.equal(search.state,'found');
 search.start({task:{target:'cup'}});assert.equal(search.accept({target_visible:true},'clear'),false);assert.equal(search.accept({target_visible:true},'clear'),true);
});

function fakeWorker({delay=0,fail=false,latencyMs=5}={}){
 return class{
  static instances=[];
  constructor(){this.constructor.instances.push(this);}
  terminate(){this.terminated=true;}
  postMessage(msg){setTimeout(()=>{if(this.terminated)return;this.onmessage({data:{id:msg.id,...(fail?{error:'local_detector_unavailable'}:{result:msg.type==='init'?{labels:['cup'],aliases:{水杯:['cup']}}:{detections:[detection()],latencyMs}})}});},delay);}
 };
}
test('local pairing uses the last freshly captured image and cancellation rejects all stale work',async()=>{
 const Worker=fakeWorker(),local=new LocalYolo({Worker,origin:'http://localhost'});assert.equal(await local.warm(),true);let captures=0;
 const prepared=await local.prepare({target:'水杯',capture:()=>'/9j/'+(++captures),signal:new AbortController().signal});
 assert.equal(captures,2);assert.equal(prepared.image,'/9j/2');assert.equal(prepared.stableCandidate,true);
 const controller=new AbortController();let release;
 local.call=()=>new Promise(resolve=>{release=resolve});
 const pending=local.prepare({target:'水杯',capture:()=>'/9j/current',signal:controller.signal});controller.abort();release({detections:[detection()],latencyMs:1});
 await assert.rejects(pending,{name:'AbortError'});local.close();assert.equal(Worker.instances[0].terminated,true);
});

test('unavailable, unknown-category and slow detectors retain fresh cloud fallback without blocking later requests',async()=>{
 const failed=new LocalYolo({Worker:fakeWorker({fail:true}),origin:'http://localhost'});assert.equal(await failed.warm(),false);
 assert.equal((await failed.prepare({target:'水杯',capture:()=>'/9j/fresh'})).image,'/9j/fresh');failed.close();
 let now=0,captures=0;const slow=new LocalYolo({Worker:fakeWorker(),origin:'http://localhost',clock:()=>now});await slow.warm();
 const unknown=await slow.prepare({target:'钥匙',capture:()=>'/9j/keys'});assert.equal(unknown.local.status,'unsupported_target');
 slow.call=async()=>{now+=2400;return {detections:[detection()],latencyMs:2400};};
 const result=await slow.prepare({target:'水杯',capture:()=>'/9j/'+(++captures)});assert.equal(result.local.status,'slow_device');assert.equal(result.stableCandidate,false);assert.equal(result.image,'/9j/3');
 await slow.prepare({target:'水杯',capture:()=>'/9j/'+(++captures)});assert.equal(captures,4);slow.close();
});

test('preview serves isolated detector assets, keeps eval out of documents, and privately delegates current APIs',async()=>{
 const env={ASSETS:{fetch:async()=>new Response('asset')},CORE_API:{fetch:async request=>{assert.equal(request.headers.get('Origin'),'https://i-see-you-yolo-preview.pages.dev');assert.equal(await request.text(),'original');return Response.json({ok:true});}}};
 const origin='https://i-see-you-yolo-preview.pages.dev';
 const response=await preview.fetch(new Request(origin+'/video/'),env);assert.equal(response.headers.get('Cross-Origin-Opener-Policy'),'same-origin');assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'),'require-corp');assert.ok(!response.headers.get('Content-Security-Policy').includes("'unsafe-eval'"));
 const worker=await preview.fetch(new Request(origin+'/static/yolo-worker.js'),env);assert.ok(worker.headers.get('Content-Security-Policy').includes("'unsafe-eval'"));
 const asset=await preview.fetch(new Request(origin+'/static/yolo/model-0-0123456789abcdef.bin'),env);assert.ok(asset.headers.get('Cache-Control').includes('immutable'));
 const api=await preview.fetch(new Request(origin+'/api/vision',{method:'POST',headers:{Origin:origin},body:'original'}),env);assert.deepEqual(await api.json(),{ok:true});assert.equal(api.headers.get('Cache-Control'),'no-store');
});
