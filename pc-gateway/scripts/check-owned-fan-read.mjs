import {WebSocket} from 'ws';import {once} from 'node:events';import {readFileSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';import {uuid} from '../src/util.mjs';
const out=resolve(process.argv[2]),runtime=new URL('../runtime/',import.meta.url);
let ws;for(let attempt=0;attempt<10;attempt++){
 const next=new WebSocket('wss://127.0.0.1:8765/v1/session',{ca:readFileSync(new URL('server-cert.pem',runtime)),headers:{Authorization:'Bearer '+readFileSync(new URL('pair-token',runtime),'utf8').trim()}});
 try{await once(next,'open');ws=next;break;}catch{next.terminate();await new Promise(r=>setTimeout(r,100));}
}
if(!ws)throw Error('owned_gateway_not_available');
const pending=new Map(),replies=[];
ws.on('message',bytes=>{const message=JSON.parse(bytes.toString());if(message.type==='result')pending.get(message.requestId)?.(message);else if(message.type==='reply')replies.push(message);});
async function call(type,data={}){
 const requestId=uuid();let timer;
 try{return await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('read_check_timeout')),5000);pending.set(requestId,m=>m.error?reject(Error('owned_read_failed')):resolve(m.result));ws.send(JSON.stringify({type,requestId,...data}));});}finally{clearTimeout(timer);pending.delete(requestId);}
}
try{
 await call('hello',{conversationId:'owned-read-only-fan-check'});
 await call('command',{command:{commandId:uuid(),text:'你记住小风扇了吗'}});const check=replies.at(-1);
 if(!check?.message.includes('桌面上')||!check?.message.includes('样子已经记住'))throw Error('fan_memory_not_combined');
 await call('command',{command:{commandId:uuid(),text:'他上次在哪'}});const history=replies.at(-1);
 if(history.objectId!==check.objectId||!history.message.includes('桌面上'))throw Error('pronoun_did_not_resolve');
 await call('command',{command:{commandId:uuid(),text:'他的外观'}});const appearance=replies.at(-1);
 if(appearance.objectId!==check.objectId||!appearance.message.includes('已保存的外观描述'))throw Error('appearance_read_failed');
 writeFileSync(resolve(out,'owned-fan-read.private.json'),JSON.stringify({passed:true,replies:[check,history,appearance]},null,2));
 console.log(JSON.stringify({existingFanMemoryCombined:true,savedPositionReadBack:true,savedAppearanceReadBack:true,pronounResolvedToSameObject:true,noModelCalls:true}));
}finally{ws.close();await once(ws,'close');}
