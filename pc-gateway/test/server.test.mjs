import test from 'node:test';import assert from 'node:assert/strict';
import https from 'node:https';import {once} from 'node:events';import {readFileSync} from 'node:fs';import {resolve} from 'node:path';import {WebSocket} from 'ws';
import {createGateway} from '../src/server.mjs';import {Memory} from '../src/memory.mjs';import {exportArchive,readArchive} from '../src/archive.mjs';import {uuid} from '../src/util.mjs';
import {directory,picture,frame,account,credentials,fakeCloud} from './helpers.mjs';
function client(gateway,root){const ws=new WebSocket(`wss://127.0.0.1:${gateway.port}/v1/session`,{ca:readFileSync(resolve(root,'server-cert.pem')),headers:{Authorization:'Bearer '+gateway.token}});const pending=new Map(),events=[];ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type==='result'){pending.get(m.requestId)?.(m);pending.delete(m.requestId);}else events.push(m);});return {ws,events,async call(type,fields={}){const requestId=uuid();const reply=new Promise(r=>pending.set(requestId,r));ws.send(JSON.stringify({type,requestId,...fields}));const m=await reply;if(m.error)throw Error(m.error);return m.result;}};}
test('asynchronous acceptance releases the client and saved observation can be queried while review is pending',async t=>{
 let answer,review;const words=new Promise(r=>answer=r),checked=new Promise(r=>review=r);const root=directory();
 const g=await createGateway({root,port:0,host:'127.0.0.1',detector:{ready:false,started:Promise.resolve(),close(){}},providers:{describe:()=>words,review:()=>checked}});t.after(()=>g.close());
 const c=client(g,root);await once(c.ws,'open');await c.call('hello',{conversationId:'async-memory'});
 const start=await c.call('start',{source:'PHONE'});await c.call('frame',{generation:start.generation,sequence:1,capturedAtMs:Date.now(),ageMs:0,jpeg:picture.toString('base64')});
 assert.deepEqual(await c.call('command',{async:true,command:{commandId:uuid(),text:'记住小风扇'}}),{accepted:true});
 answer({v:true,d:'蓝色小风扇',l:'键盘右侧'});
 const deadline=Date.now()+3000;while(!c.events.some(e=>e.type==='reply')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 const records=await c.call('records');assert.equal(records[0].location,'键盘右侧');assert.equal(records[0].appearance_observed,true);
 await c.call('command',{command:{commandId:uuid(),text:'他上次在哪'}});assert.match(c.events.filter(e=>e.type==='reply').at(-1).message,/键盘右侧/);
 review({visible:.5,clear:.5,box:null,location:null});await new Promise(r=>setTimeout(r,20));
 c.ws.close();await once(c.ws,'close');
});
test('actual TLS/WebSocket gateway imports Android archive, executes memory, backs up and exports without sensors',async t=>{
 const root=directory(),cloud=fakeCloud();const detector={ready:true,started:Promise.resolve(),busy:false,run:async()=>({detections:[],candidates:[],inferenceMs:1}),close(){}};
 const providers={describe:async f=>({f:f.frameId,v:true,d:'生成图中的蓝杯',l:'桌面上',i:['杯子']}),review:async()=>({box:[.3,.2,.7,.8],location:{location:'桌面上',anchor:'桌面'}})};
 const g=await createGateway({root,port:0,host:'127.0.0.1',detector,providers,backupOptions:{root:'http://127.0.0.1/',fetcher:cloud.fetcher}});t.after(()=>g.close());
 const c=client(g,root);await once(c.ws,'open');await c.call('hello',{session:credentials()});const start=await c.call('start',{source:'PHONE'});
 await c.call('frame',{generation:start.generation,sequence:1,capturedAtMs:Date.now(),ageMs:0,jpeg:picture.toString('base64')});
 await c.call('command',{command:{commandId:uuid(),text:'记住这个杯子'}});assert.equal((await c.call('records'))[0].capture_status_label,'外观和位置已保存');
 assert.match(c.events.filter(e=>e.type==='reply').at(-1).message,/已记录.*蓝杯.*桌面上/);
 const backup=await c.call('backup');assert.equal(backup.objectCount,1);assert.equal(cloud.objects.size,1);
 const options={hostname:'127.0.0.1',port:g.port,ca:readFileSync(resolve(root,'server-cert.pem')),headers:{Authorization:'Bearer '+g.token}};
 const get=path=>new Promise((resolve,reject)=>{https.get({...options,path},res=>{const data=[];res.on('data',x=>data.push(x));res.on('end',()=>resolve({status:res.statusCode,bytes:Buffer.concat(data)}));}).on('error',reject);});
 const exported=await get('/v1/export');assert.equal(exported.status,200);const parsed=await readArchive(exported.bytes,account);assert.equal(parsed.objects[0].appearances.length,1);
 const old=new Memory(directory());old.bindAccount(account);old.capture('原有杯子',frame());const zip=await exportArchive(old,account);old.close();
 const imported=await new Promise((resolve,reject)=>{const req=https.request({...options,path:'/v1/import',method:'POST',headers:{...options.headers,'Content-Type':'application/zip'}},res=>{const data=[];res.on('data',x=>data.push(x));res.on('end',()=>resolve(JSON.parse(Buffer.concat(data).toString())));});req.on('error',reject);req.end(zip.bytes);});assert.equal(imported.restored,1);assert.equal(g.memory.all().length,2);
 c.ws.close();await once(c.ws,'close');
});
test('unpaired client cannot access memory or start a websocket session',async t=>{
 const root=directory();const g=await createGateway({root,port:0,host:'127.0.0.1',detector:{ready:false,close(){},started:Promise.resolve()}});t.after(()=>g.close());const ca=readFileSync(resolve(root,'server-cert.pem'));
 const status=await new Promise((resolve,reject)=>https.get({hostname:'127.0.0.1',port:g.port,ca,path:'/v1/export'},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));assert.equal(status,401);
 const ws=new WebSocket(`wss://127.0.0.1:${g.port}/v1/session`,{ca});const [error]=await once(ws,'error');assert.match(error.message,/403/);
});
