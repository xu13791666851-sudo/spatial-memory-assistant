// Only committed public fixtures are sent. No runtime memories, sensors or backups.
import {readFileSync} from 'node:fs';
import {OmniProviders,OMNI_MODEL} from '../src/omni.mjs';
const cup=readFileSync(new URL('../test/fixtures/generated-cup.jpg',import.meta.url));
const bus=readFileSync(new URL('../../android/app/src/androidTest/assets/bus.jpg',import.meta.url));
const p=new OmniProviders();
const checks=[
 ['describe_cup',()=>p.describe({jpeg:cup,frameId:1},'杯子','描述杯子外观和可见位置')],
 ['compare_same_public_image',()=>p.review({jpeg:cup,frameId:2},{target:'杯子',references:[cup]})],
 ['compare_unrelated_image',()=>p.review({jpeg:bus,frameId:3},{target:'杯子',references:[cup]})],
 ['intent',()=>p.interpret('帮我瞧瞧眼前都有些什么',null,[])],
];
try {
 for(const [operation,run] of checks){const start=performance.now();try{const result=await run();console.log(JSON.stringify({model:OMNI_MODEL,operation,elapsedMs:Math.round(performance.now()-start),result}));}catch(e){process.exitCode=1;console.log(JSON.stringify({model:OMNI_MODEL,operation,elapsedMs:Math.round(performance.now()-start),error:e.message}));}}
}finally{p.close();}
