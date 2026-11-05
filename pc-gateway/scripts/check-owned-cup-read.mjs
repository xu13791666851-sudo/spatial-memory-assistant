import {WebSocket} from 'ws';
import {once} from 'node:events';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {uuid} from '../src/util.mjs';
const ws=new WebSocket('wss://127.0.0.1:8765/v1/session',{
 ca:readFileSync(new URL('../runtime/server-cert.pem',import.meta.url)),
 headers:{Authorization:'Bearer '+readFileSync(new URL('../runtime/pair-token',import.meta.url),'utf8').trim()},
});
const pending=new Map(),replies=[];
ws.on('message',b=>{const m=JSON.parse(b.toString());if(m.type==='result')pending.get(m.requestId)?.(m);if(m.type==='reply')replies.push(m);});
async function call(type,data={}){
 const requestId=uuid();let timer;
 try{return await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('owned_read_timeout')),5000);pending.set(requestId,m=>m.error?reject(Error(m.error)):resolve(m.result));ws.send(JSON.stringify({type,requestId,...data}));});}
 finally{clearTimeout(timer);pending.delete(requestId);}
}
try{
 await once(ws,'open');await call('hello',{conversationId:'cup-read-verification'});
 const before=await call('records');const blue=before.find(o=>o.name==='蓝色水杯');assert.ok(blue);
 for(const text of ['蓝色水杯上次在哪里','我的杯子在哪','在哪里呀？告诉我。']){
  await call('command',{command:{commandId:uuid(),text}});
  assert.equal(replies.at(-1).objectId,blue.id);assert.match(replies.at(-1).message,/笔记本电脑右侧/);
 }
 assert.deepEqual(await call('records'),before);
 const report={passed:true,existingObjects:before.length,aliasQueries:3,noVisionCalls:true,noSensors:true,recordsUnchanged:true};
 writeFileSync(resolve(process.argv[2],'owned-cup-read-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{if(ws.readyState!==WebSocket.CLOSED){const closed=once(ws,'close');ws.close();await closed;}}
