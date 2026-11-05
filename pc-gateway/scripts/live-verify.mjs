import {createGateway} from '../src/server.mjs';import {SupabaseMemory} from '../src/supabase.mjs';import {Memory} from '../src/memory.mjs';import {jpeg,check,hash} from '../src/util.mjs';
import {resolve} from 'node:path';import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});const root=fileURLToPath(new URL('../runtime',import.meta.url));
const gateway=await createGateway({root,port:8765});
console.log('Live PC gateway ready; waiting for app pairing without starting sensors.');
writeFileSync(resolve(out,'live-pair.private'),gateway.links[0],{mode:0o600});
const report={version:'0.12.0',at:new Date().toISOString(),sensorCapture:false,privateSceneSentToVision:false};
let verifying=false;
async function verify(){
 if(verifying||!gateway.backup.credentials||!gateway.memory.db.prepare("SELECT value FROM meta WHERE key='android-import'").get())return;
 verifying=true;
 try{
  const uploaded=await gateway.backup.backup();report.realSupabase={uploadedAndDownloadedHashMatched:true,objects:uploaded.objectCount,sha256:uploaded.sha256??null};
  const isolated=new Memory(resolve(out,'private-cloud-restore'));const restored=new SupabaseMemory(isolated);restored.setSession({...gateway.backup.credentials});try{report.realSupabase.restore=await restored.restore();check(gateway.memory.all().every(o=>isolated.get(o.id)),'restored_object_missing');report.realSupabase.restoredSceneCount=isolated.all().reduce((n,o)=>n+o.captures.length,0);}finally{isolated.close();}
  const s=await gateway.backup.session(),list=await gateway.backup.request('storage/v1/object/list/iseeyou-memory-backups',{token:s.accessToken,body:{prefix:s.userId+'/',limit:10,offset:0,sortBy:{column:'name',order:'desc'}}});const name=list.filter(x=>/^[0-9]{13}-[a-f0-9-]{36}\.zip$/.test(x.name)).sort((a,b)=>b.name.localeCompare(a.name))[0]?.name;
  const response=await fetch(`https://i-see-you-android-core-test.pages.dev/api/android/backup/storage/v1/object/public/iseeyou-memory-backups/${s.userId}/${name}`,{redirect:'manual',signal:AbortSignal.timeout(30000)});report.realSupabase.anonymousReadDenied=[400,401,403,404].includes(response.status);await response.body?.cancel();check(report.realSupabase.anonymousReadDenied,'private_backup_readable');
  console.log('Real Supabase upload/download verification and isolated restore passed.');
  const bytes=readFileSync(new URL('../../android/app/src/androidTest/assets/bus.jpg',import.meta.url));const frame={jpeg:bytes,frameId:98701,capturedAtMs:Date.now()};
  try{const r=await gateway.session.providers.describe(frame,null,'当前画面有什么');report.realQwenPublicImage={passed:true,itemCount:r.i.length};}catch(e){report.realQwenPublicImage={passed:false,code:/^[a-z0-9_]+$/.test(e.message)?e.message:'network_error'};}
  try{const r=await gateway.session.providers.review(frame,{target:'公交车'});report.realJevPublicImage={passed:true,decision:r.decision};}catch(e){report.realJevPublicImage={passed:false,code:/^[a-z0-9_]+$/.test(e.message)?e.message:'network_error'};}
  report.memory={objects:gateway.memory.all().length,photos:gateway.memory.all().reduce((n,o)=>n+o.appearances.length,0),scenes:gateway.memory.all().reduce((n,o)=>n+o.captures.length,0)};
  writeFileSync(resolve(out,'live-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({liveVerificationCompleted:true,realSupabase:report.realSupabase,realQwenPublicImage:report.realQwenPublicImage,realJevPublicImage:report.realJevPublicImage,memory:report.memory}));
 }catch(e){report.failed=/^[a-z0-9_]+$/.test(e.message)?e.message:'operation_failed';writeFileSync(resolve(out,'live-verification.json'),JSON.stringify(report,null,2));console.log('Live verification did not finish: '+report.failed);}
}
const timer=setInterval(()=>void verify(),1000);timer.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{clearInterval(timer);await gateway.close();process.exit(0);});
