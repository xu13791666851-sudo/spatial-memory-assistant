import {createGateway} from '../src/server.mjs';
import {Providers} from '../src/providers.mjs';
import {Session} from '../src/session.mjs';
import {Memory,labelFor} from '../src/memory.mjs';
import {rankCandidates} from '../src/candidates.mjs';
import {uuid,safeError} from '../src/util.mjs';
import {resolve} from 'node:path';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const gateway=await createGateway();let started=false;
console.log('Updated PC service ready; waiting for the existing app connection.');
const timer=setInterval(async()=>{
 if(started||!gateway.session.providers.key())return;started=true;
 const report={publicFixtureOnly:true,privateSensorsStarted:false,requests:[],phases:[]};
 const providers=new Providers({key:()=>gateway.session.providers.key(),fetcher:async(url,options)=>{
  const at=performance.now(),r=await fetch(url,options);
  report.requests.push({operation:url.includes('openrouter')?'Jev':'Qwen',status:r.status,durationMs:Math.round(performance.now()-at)});return r;
 }});
 const root=resolve(out,'public-cup-memory-'+uuid()),memory=new Memory(root),events=[];
 const s=new Session({memory,providers,detector:gateway.yolo,emit:e=>events.push(e)});
 try {
  await gateway.yolo.started;
  const image=readFileSync(new URL('../test/fixtures/generated-cup.jpg',import.meta.url));
  s.start();s.frame(image,s.source.generation,1,Date.now());
  await s.command({commandId:uuid(),text:'记住蓝色水杯'});
  const object=memory.all()[0];report.receipt=memory.receipt(object.id);
  report.savedReferenceCount=memory.references(object).length;
  s.frame(image,s.source.generation,2,Date.now());const current=s.frozen();
  const detected=await gateway.yolo.run(current,{target:labelFor('蓝色水杯')});
  const ranked=rankCandidates(detected.candidates,memory.photos(object));
  report.detector={label:labelFor('蓝色水杯'),candidates:ranked.length};
  if(ranked.length&&report.savedReferenceCount){
   const c=ranked[0],at=performance.now();
   const r=await providers.review(current,{target:'蓝色水杯',description:object.description,crop:Buffer.from(c.cropJpeg,'base64'),references:memory.references(object).map(p=>memory.image(p))});
   report.comparison={decision:r.decision,elapsedMs:Math.round(performance.now()-at)};
  }
  memory.close();const reopened=new Memory(root);
  try{report.reopened=!!reopened.history(object.id)&&reopened.matching('我的杯子')[0]?.id===object.id;}finally{reopened.close();}
  report.passed=report.receipt.appearance&&!!report.receipt.location&&report.reopened&&report.comparison?.decision==='CONFIRM';
 }catch(error){report.failure=safeError(error);}
 finally{s.stop();try{memory.close();}catch{}writeFileSync(resolve(out,'public-cup-live-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({publicCupCheck:report.passed??false,detector:report.detector,comparison:report.comparison,failure:report.failure}));}
},500);timer.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{clearInterval(timer);await gateway.close();process.exit(0);});
