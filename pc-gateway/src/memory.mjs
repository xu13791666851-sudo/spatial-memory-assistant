import {detectionLabel,matchingObjects} from './object-names.mjs';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {mkdirSync,readFileSync,existsSync} from 'node:fs';
import {check,id,text,time,uuid,hash,jpeg,writeNew} from './util.mjs';

export const labelFor=detectionLabel;
export const statusLabel={CAPTURED:'当时画面已保存，分析未完成',SCENE_ONLY:'当时画面已保存，外观和位置待确认',APPEARANCE_ONLY:'外观已保存，位置待确认',LOCATION_ONLY:'位置已保存，目标照片待补充',COMPLETE:'外观和位置均已保存'};
export class Memory {
 constructor(root,{now=Date.now}={}){
  this.root=resolve(root);this.now=now;mkdirSync(this.root,{recursive:true});
  this.db=new DatabaseSync(resolve(root,'memory.sqlite'));this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY,body TEXT NOT NULL);');
  this.getRow=this.db.prepare('SELECT body FROM objects WHERE id=?');this.allRows=this.db.prepare('SELECT body FROM objects ORDER BY rowid');
  this.putRow=this.db.prepare('INSERT INTO objects(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body');
 }
 account(){return this.db.prepare("SELECT value FROM meta WHERE key='account'").get()?.value??null;}
 bindAccount(account){check(/^[a-f0-9-]{36}$/.test(account),'invalid_account');check(!this.account()||this.account()===account,'account_conflict');this.db.prepare("INSERT OR IGNORE INTO meta VALUES('account',?)").run(account);}
 all(){return this.allRows.all().map(row=>JSON.parse(row.body));}
 get(key){const row=this.getRow.get(id(key));return row?JSON.parse(row.body):null;}
 matching(name){return matchingObjects(this.all(),name);}
 photos(object){return object.appearances.filter(p=>!object.captures.some(c=>c.capturedAtMs===p.capturedAtMs&&c.failureKind==='REVIEW_REJECTED'));}
 references(object){const photos=this.photos(object).slice(0,3).map(p=>p.image);const scene=object.captures.filter(c=>c.description&&(this.observation(c)||['COMPLETE','LOCATION_ONLY'].includes(c.status))).at(-1);if(!photos.length)return scene?[scene.image]:[];if(scene&&this.observation(scene))return [...photos.slice(0,2),scene.image];return photos;}
 observation(c){return c&&['REVIEW_PENDING','REVIEW_UNCERTAIN','REVIEW_UNAVAILABLE'].includes(c.failureKind);}
 locationHistory(key){
  const o=this.get(key);check(o,'object_missing');
  const observed=o.captures.filter(c=>this.observation(c)&&c.suggestedLocation&&!c.verifiedLocation).map(c=>({id:c.id,placeId:null,location:c.suggestedLocation,anchor:'当时画面观察',observedAtMs:c.capturedAtMs,recordedAtMs:c.recordedAtMs,confirmed:false,source:'CAMERA_OBSERVED'}));
  return [...o.locations,...observed].sort((a,b)=>(b.observedAtMs??b.recordedAtMs)-(a.observedAtMs??a.recordedAtMs));
 }
 put(object){this.putRow.run(object.id,JSON.stringify(object));return object;}
 file(name){check(/^(photos|scenes)\/[A-Za-z0-9][A-Za-z0-9_-]{0,159}\.jpg$/.test(name),'invalid_image_path');return resolve(this.root,name);}
 image(name){return readFileSync(this.file(name));}
 capture(name,frame,{objectId=null,captureId=uuid()}={}){
  text(name,40,false);jpeg(frame.jpeg);time(frame.capturedAtMs);time(frame.frameId);check(['PHONE','ESP32'].includes(frame.cameraSource),'invalid_source');
  const existing=objectId?this.get(objectId):null;check(!objectId||existing,'object_missing');check(this.all().length<500||existing,'memory_limit');
  const now=Math.max(this.now(),frame.capturedAtMs),oid=existing?.id??uuid();
  const object=existing??{id:oid,name,aliases:[],yoloLabel:labelFor(name),description:null,createdAtMs:now,updatedAtMs:now,appearances:[],locations:[],captures:[],events:[]};
  check(object.captures.length<20,'capture_limit');
  const capture={id:id(captureId),image:`scenes/${captureId}.jpg`,sha256:hash(frame.jpeg),frameId:frame.frameId,cameraSource:frame.cameraSource,capturedAtMs:frame.capturedAtMs,recordedAtMs:now,status:'CAPTURED',description:null,suggestedLocation:null,verifiedLocation:null,failureKind:''};
  writeNew(this.file(capture.image),frame.jpeg);object.captures.push(capture);object.updatedAtMs=Math.max(now,object.updatedAtMs+1);this.put(object);
  return {objectId:oid,captureId,revision:object.updatedAtMs};
 }
 finish(receipt,{appearance=null,description=null,suggestedLocation=null,location=null,failureKind='',review=false}={}){
  const object=this.get(receipt.objectId);check(object&&object.updatedAtMs===receipt.revision,'memory_changed');
  const capture=object.captures.find(x=>x.id===receipt.captureId);check(capture&&(capture.status==='CAPTURED'||review&&capture.failureKind==='REVIEW_PENDING'),'capture_changed');
  if(!review)capture.previousDescription=object.description;
  let sample=null;
  if(appearance){sample=object.appearances.find(p=>p.sha256===hash(appearance.jpeg)&&p.capturedAtMs===capture.capturedAtMs)??null;}
  if(appearance&&!sample&&object.appearances.length<6){
   const sid=uuid(),bytes=jpeg(appearance.jpeg);const used=object.appearances.map(x=>x.viewIndex);const viewIndex=[0,1,2,3,4,5].find(x=>!used.includes(x));
   const embedding=appearance.embedding;check(typeof embedding==='string'&&Buffer.from(embedding,'base64').length===48*4,'appearance_descriptor_missing');
   sample={id:sid,image:`photos/${sid}.jpg`,sha256:hash(bytes),embedding,viewIndex,capturedAtMs:capture.capturedAtMs};
   writeNew(this.file(sample.image),bytes);object.appearances.push(sample);
  }
  if(location){text(location.location,600,false);object.locations.push({id:uuid(),placeId:null,location:location.location,anchor:text(location.anchor||'',600),observedAtMs:capture.capturedAtMs,confirmed:true,recordedAtMs:this.now(),source:'CAMERA_VERIFIED'});capture.verifiedLocation=location.location;}
  capture.description=description?text(description,2000):capture.description;capture.suggestedLocation=suggestedLocation?text(suggestedLocation,600):capture.suggestedLocation;capture.failureKind=text(failureKind,80);
  capture.status=sample?(location?'COMPLETE':'APPEARANCE_ONLY'):(location?'LOCATION_ONLY':'SCENE_ONLY');
  if(capture.description)object.description=capture.description;
  if(failureKind==='REVIEW_REJECTED')object.description=capture.previousDescription??null;
  object.updatedAtMs=Math.max(this.now(),object.updatedAtMs+1);this.put(object);return this.receipt(object.id);
 }
 receipt(key){
  const object=this.get(key);check(object,'object_missing');const capture=object.captures.at(-1);const photo=this.photos(object).length>0;const place=this.locationHistory(key)[0];
  const observed=this.observation(capture),appearance=photo||!!(observed&&capture.description),complete=appearance&&!!place;
  let message;if(capture?.status==='COMPLETE')message=`已记住${object.name}的外观和位置：${object.description?object.description+'，在':''}${capture.verifiedLocation}。`;
  else if(capture?.status==='CAPTURED')message=this.now()-capture.recordedAtMs<30_000?`正在分析${object.name}的外观和位置，还没有完成。`:`上次对${object.name}的分析没有完成，参考画面已经保留。`;
  else if(capture?.failureKind==='REVIEW_REJECTED')message=`这次画面的复核有分歧，我保留了原来的记录。你指的是哪一件${object.name}？`;
  else if(observed&&capture.description&&capture.suggestedLocation)message=`已记录${object.name}：${capture.description}，${capture.suggestedLocation}。这是当时画面的观察，位置尚待核对。`;
  else if(complete)message=`${object.name}的样子已经记住，${place.observedAtMs===capture?.capturedAtMs?'这次记录在':'上次记录在'}${place.location}。`;
  else if(capture?.status==='LOCATION_ONLY')message=`记住了${object.name}的位置，在${capture.verifiedLocation}。外观还没看清，请让它靠近镜头一些。`;
  else if(capture?.status==='APPEARANCE_ONLY')message=`记住了${object.name}的样子，但还看不清它放在哪里。请稍微拉远镜头，让周围也入镜。`;
  else if(capture)message=['ANALYSIS_FAILED','REVIEW_UNAVAILABLE'].includes(capture.failureKind)?`当时画面已保存，但分析服务未完成，${object.name}的外观和位置还未确认。`:`当时画面已保存，${object.name}的外观和位置还待确认。`;
  else message=`已有${object.name}的记录${photo?'和外观照片':''}${place?'、位置历史':''}，没有本次画面。`;
  return {objectId:object.id,captureId:capture?.id,revision:object.updatedAtMs,status:capture?.status??'LEGACY',appearance,complete,observed,sceneCount:object.captures.length,location:place?.location??null,message};
 }
 history(key){
  const object=this.get(key);check(object,'object_missing');const place=this.locationHistory(key)[0];const event=object.events?.at(-1);
  if(event?.type==='retrieved'&&(!place||event.recordedAtMs>=place.recordedAtMs))return `你已确认拿到了${object.name}，之后放在哪里还没有记录。`;
  if(!place)return `还没有确认${object.name}的位置${object.captures.length?'，当时画面仍然保留':''}。`;
  return `上次${place.confirmed?'在画面中确认':place.source==='CAMERA_OBSERVED'?'画面里看到':'你告诉我'}${object.name}在${place.location}，记录时间是${new Date(place.observedAtMs??place.recordedAtMs).toLocaleString('zh-CN')}。现在是否还在那里需要重新查看。`;
 }
 recordRetrieved(key){const object=this.get(key);check(object,'object_missing');(object.events??=[]).push({id:uuid(),type:'retrieved',recordedAtMs:this.now(),source:'USER_STATEMENT'});object.updatedAtMs=Math.max(this.now(),object.updatedAtMs+1);this.put(object);}
 addLocation(key,location){const object=this.get(key);check(object,'object_missing');object.locations.push({id:uuid(),placeId:null,location:text(location,600,false),anchor:'用户提供',observedAtMs:null,confirmed:false,recordedAtMs:this.now(),source:'USER_STATEMENT'});object.updatedAtMs=Math.max(this.now(),object.updatedAtMs+1);this.put(object);}
 records(){return this.all().map(o=>{const c=o.captures.at(-1),l=this.locationHistory(o.id)[0],e=o.events?.at(-1),r=this.receipt(o.id);return {id:o.id,name:o.name,appearance:o.description??'',sample_count:this.photos(o).length,appearance_observed:r.appearance,scene_count:o.captures.length,capture_status_label:c?.failureKind==='REVIEW_REJECTED'?'本次观察有分歧，原记录已保留':r.complete?(r.observed?'外观和位置已记录（相机观察）':'外观和位置已保存'):statusLabel[c?.status]??'',suggested_location:c&&!c.verifiedLocation&&!this.observation(c)?c.suggestedLocation??'':'',recorded_at:new Date(o.updatedAtMs).toISOString(),created_at:new Date(o.createdAtMs).toISOString(),location:e?.type==='retrieved'&&(!l||e.recordedAtMs>=l.recordedAtMs)?'已拿到，之后的位置未记录':l?.location??'尚未记录位置',location_source:l?.source??'',location_recorded_at:l?.recordedAtMs??0,aliases:o.aliases,relations:[]};});}
 edit(p){const o=this.get(p.id);check(o&&new Date(o.updatedAtMs).toISOString()===p.recorded_at,'memory_changed');o.name=text(p.name,40,false);o.description=text(p.appearance,150);const loc=text(p.location,600,false);if(loc!=='尚未记录位置'&&loc!==this.records().find(x=>x.id===p.id).location)o.locations.push({id:uuid(),placeId:null,location:loc,anchor:'用户提供',observedAtMs:null,confirmed:false,recordedAtMs:this.now(),source:'USER_STATEMENT'});o.updatedAtMs=Math.max(this.now(),o.updatedAtMs+1);this.put(o);}
 delete(p){const o=this.get(p.id);check(o&&new Date(o.updatedAtMs).toISOString()===p.recorded_at,'memory_changed');this.db.prepare('DELETE FROM objects WHERE id=?').run(o.id);/* Original photographs and immutable cloud snapshots are retained. */}
 importObjects(objects,files,{preferNewer=false}={}){
  let restored=0,kept=0,updated=0;this.db.exec('BEGIN IMMEDIATE');try{for(const object of objects){const existing=this.get(object.id);if(existing&&(!preferNewer||existing.updatedAtMs>=object.updatedAtMs)){kept++;continue;}for(const entry of [...object.appearances,...object.captures]){const bytes=files.get(entry.image);check(bytes&&hash(bytes)===entry.sha256,'image_hash_invalid');const path=this.file(entry.image);if(existsSync(path))check(hash(readFileSync(path))===entry.sha256,'image_conflict');else writeNew(path,bytes);}this.put({...object,events:object.events??[]});if(existing)updated++;else restored++;}this.db.exec('COMMIT');return updated?{restored,kept,updated}:{restored,kept};}catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 close(){this.db.close();}
}
