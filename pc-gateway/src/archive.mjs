import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {check,id,text,time,hash,compact,jpeg,MAX_ARCHIVE} from './util.mjs';
export async function pythonJson(script,input,{python=process.env.ISEEYOU_PYTHON||'python',limit=65*1024*1024,timeout=30000}={}){
 return await new Promise((resolve,reject)=>{
  const child=spawn(python,['-X','utf8',fileURLToPath(new URL(script,import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});let size=0,parts=[],done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve(value);};
  const timer=setTimeout(()=>finish(Error('helper_timeout')),timeout);
  child.on('error',()=>finish(Error('helper_unavailable')));child.stdin.on('error',()=>finish(Error('helper_input_failed')));
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>limit)finish(Error('helper_output_limit'));else parts.push(chunk);});
  child.stderr.on('data',()=>{});child.on('exit',code=>{if(code!==0)return finish(Error('helper_failed'));try{finish(null,JSON.parse(Buffer.concat(parts).toString('utf8')));}catch{finish(Error('helper_output_invalid'));}});
  child.stdin.end(JSON.stringify(input));
 });
}
export async function exportArchive(memory,account){
 check(memory.account()===account,'account_conflict');const objects=memory.all(),files={};
 const state={account,objects};const manifest={schema:2,snapshotId:crypto.randomUUID(),createdAtMs:Date.now(),stateDigest:hash(compact(state)),state};
 for(const object of objects)for(const entry of [...object.appearances,...object.captures]){const bytes=memory.image(entry.image);check(hash(bytes)===entry.sha256,'image_hash_invalid');files[entry.image]=bytes.toString('base64');}
 const result=await pythonJson('../python/archive.py',{operation:'pack',manifest:compact(manifest),files});const bytes=Buffer.from(result.zip,'base64');check(bytes.length<=MAX_ARCHIVE,'archive_limit');return {bytes,digest:manifest.stateDigest,objectCount:objects.length};
}
export async function readArchive(bytes,account){
 check(bytes.length>0&&bytes.length<=MAX_ARCHIVE,'archive_limit');const result=await pythonJson('../python/archive.py',{operation:'unpack',zip:bytes.toString('base64')});
 const m=JSON.parse(result.manifest),state=m.state;check([1,2].includes(m.schema)&&state.account===account,'archive_account_invalid');check(hash(compact(state))===m.stateDigest,'archive_manifest_hash');
 check(Array.isArray(state.objects)&&state.objects.length<=500,'archive_objects_limit');const ids=new Set(),samples=new Set(),captures=new Set(),events=new Set(),expected=new Set();let histories=0;
 for(const o of state.objects){
  check(!ids.has(id(o.id)),'duplicate_object');ids.add(o.id);text(o.name,40,false);time(o.createdAtMs);check(time(o.updatedAtMs)>=o.createdAtMs,'invalid_time');
  check(Array.isArray(o.aliases)&&o.aliases.length<=40,'invalid_aliases');o.aliases.forEach(x=>text(x,80));if(o.yoloLabel!==null)text(o.yoloLabel,120);if(o.description!==null)text(o.description,2000);
  check(Array.isArray(o.appearances)&&o.appearances.length<=6&&Array.isArray(o.locations),'invalid_object');o.captures??=[];check(m.schema!==1||o.captures.length===0,'invalid_schema');check(Array.isArray(o.captures)&&o.captures.length<=20,'capture_limit');const views=new Set();
  for(const s of o.appearances){check(!samples.has(id(s.id)),'duplicate_sample');samples.add(s.id);check(Number.isInteger(s.viewIndex)&&s.viewIndex>=0&&s.viewIndex<=5&&!views.has(s.viewIndex),'invalid_view');views.add(s.viewIndex);time(s.capturedAtMs);const embedding=Buffer.from(text(s.embedding,32768,false),'base64');check(embedding.length>0&&embedding.length<=16384&&embedding.length%4===0,'invalid_embedding');for(let i=0;i<embedding.length;i+=4)check(Number.isFinite(embedding.readFloatLE(i)),'invalid_embedding');}
  for(const l of o.locations){check(!events.has(id(l.id))&&++histories<=20000,'invalid_location');events.add(l.id);text(l.location,600,false);text(l.anchor,600);time(l.recordedAtMs);check(['CAMERA_VERIFIED','USER_STATEMENT','LEGACY_IMPORT'].includes(l.source)&&l.confirmed===(l.source==='CAMERA_VERIFIED'),'invalid_provenance');if(l.observedAtMs!==null)time(l.observedAtMs);check(!l.confirmed||l.observedAtMs!==null,'missing_observation');if(l.placeId!==null)text(l.placeId,160);}
  for(const c of o.captures){check(!captures.has(id(c.id))&&captures.size<10000,'duplicate_capture');captures.add(c.id);time(c.frameId);check(time(c.capturedAtMs)<=time(c.recordedAtMs),'invalid_time');check(['PHONE','ESP32'].includes(c.cameraSource)&&['CAPTURED','SCENE_ONLY','LOCATION_ONLY','APPEARANCE_ONLY','COMPLETE'].includes(c.status),'invalid_capture');for(const field of ['description','suggestedLocation','verifiedLocation'])if(c[field]!==null)text(c[field],field==='description'?2000:600);check(/^[A-Z0-9_]{0,80}$/.test(c.failureKind),'invalid_failure');check(['COMPLETE','LOCATION_ONLY'].includes(c.status)===(c.verifiedLocation!==null),'invalid_status');if(c.verifiedLocation!==null)check(o.locations.some(l=>l.confirmed&&l.location===c.verifiedLocation&&l.observedAtMs===c.capturedAtMs),'unverified_location');}
  for(const [entries,dir] of [[o.appearances,'photos'],[o.captures,'scenes']])for(const e of entries){check(e.image===`${dir}/${e.id}.jpg`&&!expected.has(e.image),'invalid_image_path');expected.add(e.image);const b=jpeg(Buffer.from(result.files[e.image]??'','base64'));check(hash(b)===e.sha256,'image_hash_invalid');}
  if(o.events!==undefined){check(Array.isArray(o.events)&&o.events.length<=20000,'events_limit');for(const e of o.events){id(e.id);check(e.type==='retrieved'&&e.source==='USER_STATEMENT','invalid_event');time(e.recordedAtMs);}}
 }
 check(Object.keys(result.files).length===expected.size&&Object.keys(result.files).every(x=>expected.has(x)),'archive_extra_file');
 return {objects:state.objects,files:new Map(Object.entries(result.files).map(([n,b])=>[n,Buffer.from(b,'base64')])),digest:m.stateDigest};
}
