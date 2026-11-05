import {createGateway} from '../src/server.mjs';
import {Providers} from '../src/providers.mjs';
import {Session} from '../src/session.mjs';
import {Memory} from '../src/memory.mjs';
import {uuid} from '../src/util.mjs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const gateway=await createGateway();
console.log('Updated PC service ready. Public fixture check waits for existing app authentication; no camera or microphone is requested.');
let started=false;
const timer=setInterval(async()=>{
 if(started||!gateway.session.providers.key())return;
 started=true;
 const report={publicFixtureOnly:true,privateSceneSent:false,measurements:[],passed:false};
 const checked=new Providers({key:()=>gateway.session.providers.key(),fetcher:async(url,options)=>{
  const at=performance.now();const response=await fetch(url,options);
  report.measurements.push({operation:url.includes('openrouter')?'Jev':'Qwen',httpStatus:response.status,firstResponseMs:Math.round(performance.now()-at)});
  if(url.includes('openrouter')&&response.ok)report.jevAnswers=(await response.clone().json()).answers;
  return response;
 }});
 const memory=new Memory(resolve(out,'public-fixture-memory-'+uuid()));
 const events=[];
 const session=new Session({memory,providers:checked,detector:gateway.yolo,emit:e=>events.push(e)});
 try{
  await gateway.yolo.started;
  const jpeg=readFileSync(resolve(out,'public-fixture-720.jpg'));
  session.start();session.frame(jpeg,session.source.generation,543210,Date.now());
  let at=performance.now();await session.command({commandId:uuid(),text:'画面里面有什么'});
  report.sceneMs=Math.round(performance.now()-at);report.sceneAnswer=events.filter(e=>e.type==='reply').at(-1)?.message;
  session.frame(jpeg,session.source.generation,543211,Date.now());
  at=performance.now();await session.command({commandId:uuid(),text:'记住这个公交车'});
  report.memoryMs=Math.round(performance.now()-at);
  const object=memory.all()[0];report.memoryStatus=object?.captures.at(-1)?.status;report.photos=object?.appearances.length??0;report.locations=object?.locations.length??0;
  report.memoryAnswer=events.filter(e=>e.type==='reply').at(-1)?.message;
  report.diagnostics=events.filter(e=>e.type==='diagnostic');
  report.passed=report.memoryStatus==='COMPLETE'&&!!report.sceneAnswer;
 }catch(error){report.failure=/^[a-z0-9_]+$/.test(error.message)?error.message:'live_check_failed';}
 finally{session.stop();memory.close();writeFileSync(resolve(out,'public-vision-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({publicVisionChecked:true,passed:report.passed,sceneMs:report.sceneMs,memoryMs:report.memoryMs,status:report.memoryStatus}));}
},1000);timer.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{clearInterval(timer);await gateway.close();process.exit(0);});
