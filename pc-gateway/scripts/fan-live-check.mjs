import {createGateway} from '../src/server.mjs';import {Providers} from '../src/providers.mjs';import {Session} from '../src/session.mjs';import {Memory} from '../src/memory.mjs';import {uuid} from '../src/util.mjs';
import {resolve} from 'node:path';import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});const gateway=await createGateway();let started=false;
console.log('PC memory service ready. Public fan test waits for app authentication; camera and microphone remain under user control.');
const timer=setInterval(async()=>{
 if(started||!gateway.session.providers.key())return;started=true;
 const report={publicFixtureOnly:true,privateSceneSent:false,passed:false,requests:[],replies:[],diagnostics:[]};
 const providers=new Providers({key:()=>gateway.session.providers.key(),fetcher:async(url,options)=>{
  const at=performance.now(),r=await fetch(url,options);report.requests.push({operation:url.includes('openrouter')?'Jev':'Qwen',status:r.status,durationMs:Math.round(performance.now()-at)});return r;
 }});
 const memoryRoot=resolve(out,'public-fan-memory-'+uuid());let memory=new Memory(memoryRoot),phase='',since=performance.now();
 const session=new Session({memory,providers,detector:gateway.yolo,emit:event=>{if(event.type==='reply')report.replies.push({phase,elapsedMs:Math.round(performance.now()-since),text:event.message});if(event.type==='diagnostic')report.diagnostics.push({...event,phase});}});
 try{
  await gateway.yolo.started;const image=readFileSync(resolve(out,'public-fan-720.jpg'));session.start();
  session.frame(image,session.source.generation,1,Date.now());phase='describe';since=performance.now();await session.command({commandId:uuid(),text:'眼前有什么'});
  session.frame(image,session.source.generation,2,Date.now());phase='remember';since=performance.now();await session.command({commandId:uuid(),text:'记住这个小风扇的位置'});
  const o=memory.all()[0];report.savedReceipt=memory.receipt(o.id);report.savedDescription=o.description;report.referenceCount=memory.references(o).length;
  phase='history';since=performance.now();await session.command({commandId:uuid(),text:'他上次在哪'});
  report.objectCount=memory.all().length;session.stop();memory.close();memory=new Memory(memoryRoot);
  report.reopenedReceipt=memory.receipt(o.id);report.reopenedHistory=memory.history(o.id);
  report.sceneDescribed=report.replies.some(r=>r.phase==='describe'&&r.text.includes('风扇'));
  report.passed=report.sceneDescribed&&report.savedReceipt.complete&&report.reopenedReceipt.complete&&!!report.savedDescription&&!!report.savedReceipt.location&&report.referenceCount>0&&report.objectCount===1;
 }catch(error){report.failure=/^[a-z0-9_]+$/.test(error.message)?error.message:'fan_live_check_failed';}
 finally{session.stop();memory.close();writeFileSync(resolve(out,'public-fan-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({publicFanChecked:true,passed:report.passed,replies:report.replies.map(r=>({phase:r.phase,elapsedMs:r.elapsedMs})),complete:report.savedReceipt?.complete}));}
},1000);timer.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{clearInterval(timer);await gateway.close();process.exit(0);});
