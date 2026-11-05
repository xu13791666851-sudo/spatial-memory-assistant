// Explicit owned-device test: use the app's current frame and existing reference,
// never write a new object/location, and keep credentials inside the gateway.
import {createGateway} from '../src/server.mjs';
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {rankCandidates} from '../src/candidates.mjs';
import {detectionLabels} from '../src/object-names.mjs';
import {safeError} from '../src/util.mjs';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const g=await createGateway();let ran=false,readyAt=0;
console.log('Current-cup test service ready. Waiting for an explicit camera search.');
const timer=setInterval(async()=>{
 if(ran||!g.session.providers.key()||!g.session.source.fresh()||!g.session.task||g.yolo.busy)return;
 if(!readyAt){readyAt=Date.now();return;}if(Date.now()-readyAt<2500)return;
 ran=true;const report={at:new Date().toISOString(),currentCameraFrame:true,microphoneRequested:false,memoryMutated:false};
 const object=g.memory.all().find(o=>o.name==='蓝色水杯');
 try{
  if(!object)throw Error('saved_cup_missing');
  const f=g.session.frozen(),start=performance.now();
  const found=await g.yolo.run(f,{target:object.yoloLabel??'cup',targets:detectionLabels(object.name)});
  const candidates=rankCandidates(found.candidates,g.memory.photos(object));
  report.detections=found.detections.map(d=>({label:d.label,score:d.score}));
  report.candidateCount=candidates.length;report.references=g.memory.references(object).length;
  if(report.references){
   const c=candidates[0]??null,at=performance.now();
   const r=await g.session.providers.review(f,{target:object.name,description:object.description,crop:c?Buffer.from(c.cropJpeg,'base64'):null,references:g.memory.references(object).map(p=>g.memory.image(p))});
   report.comparison={...r,durationMs:Math.round(performance.now()-at),candidateLabel:c?.label??null,route:c?'YOLO_CROP':'FULL_SCENE_FALLBACK'};
  }
  report.durationMs=Math.round(performance.now()-start);
  report.passed=report.comparison?.decision==='CONFIRM';
 }catch(e){report.failure=safeError(e);report.passed=false;}
 finally{writeFileSync(resolve(out,'current-cup-live-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
},250);timer.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{clearInterval(timer);await g.close();process.exit(0);});
