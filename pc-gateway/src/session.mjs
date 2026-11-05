import {CandidateContinuity} from './tracking.mjs';
import {PhoneLatest} from '../vendor/plan-b/g06-phone-source.mjs';
import {check,text,uuid,hash,safeError} from './util.mjs';
import {labelFor} from './memory.mjs';
import {parseIntent,validateSemantic} from './intent.mjs';
import {pythonJson} from './archive.mjs';
import {validBox} from './providers.mjs';
import {rankCandidates} from './candidates.mjs';
import {detectionLabels} from './object-names.mjs';

const overlap=(a,b)=>{const i=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));return i/Math.max(1e-9,(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-i);};
export class Session {
 constructor({memory,backup,providers,detector,emit=()=>{},now=Date.now,crop=null}={}){
  Object.assign(this,{memory,backup,providers,detector,emit,now,focus:null,task:null,serial:0,generation:0,source:new PhoneLatest(),state:'IDLE',lastAnalyzed:null,lastFrameKey:null,active:new Set(),commands:new Map(),choices:null,rejections:[],lastReview:0,reviewing:false,lastConfirmed:null,cloudRequests:0,lastTarget:null});
  this.crop=crop??(async(frame,box)=>{const r=await pythonJson('../python/image.py',{jpeg:frame.jpeg.toString('base64'),box},{limit:4*1024*1024});return {...r,jpeg:Buffer.from(r.jpeg,'base64')};});
 }
 start(source='PHONE'){this.cancel(false);check(['PHONE','ESP32'].includes(source),'invalid_source');this.cameraSource=source;this.source.start();return {generation:this.source.generation};}
 stop(){this.providers.reset?.();this.cancel(false);this.source.stop();this.emit({type:'state',state:'IDLE',message:'观察已结束'});}
 bindConversation(conversationId) {
  check(typeof conversationId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(conversationId), 'invalid_conversation');
  if(this.conversationId === conversationId) return;
  this.providers.reset?.();
  this.serial++;
  this.cancel(false);
  this.source.stop();
  this.focus = null;
  this.lastTarget = null;
  this.rejections = [];
  this.commands.clear();
  this.lastAnalyzed = null;
  this.lastFrameKey = null;
  this.lastReview = 0;
  this.cloudRequests = 0;
  this.conversationId = conversationId;
  this.update('新会话已开始');
 }
 frame(jpeg,generation,sequence,capturedAtMs,ageMs=0){check(Number.isSafeInteger(capturedAtMs)&&capturedAtMs>=0&&Number.isFinite(ageMs)&&ageMs>=0&&ageMs<2000,'stale_frame');const f=this.source.accept(jpeg,generation,sequence);f.capturedAtMs=Math.min(capturedAtMs,this.now());f.cameraSource=this.cameraSource;f.clientFrameId=sequence;f.receivedMs-=ageMs;f.receivedAtMs=this.now()-ageMs;return f;}
 frozen(){const f=this.source.fresh();check(f,'fresh_frame_required');return {...f,jpeg:Buffer.from(f.jpeg)};}
 say(message,serial=this.serial){if(serial!==this.serial)return;this.lastReplySerial=serial;this.emit({type:'reply',eventId:uuid(),serial,message:text(message,2000,false),objectId:this.focus?.id??null});}
 update(message=''){this.emit({type:'state',state:this.state,target:this.task?.target??null,objectId:this.focus?.id??null,message});}
 changed(){this.backup?.schedule();this.emit({type:'memory.changed'});}
 cancel(reply=true){this.generation++;for(const controller of this.active)controller.abort();this.active.clear();this.task=null;this.choices=null;this.reviewing=false;this.state='IDLE';this.lastConfirmed=null;this.reviewTrack=null;this.update();if(reply)this.say('已取消当前任务，已经保存的画面仍保留。');}
 async command(command){
  const commandId=text(command.commandId,160,false);if(this.commands.has(commandId))return this.commands.get(commandId);
  const run=this.execute(command);this.commands.set(commandId,run);while(this.commands.size>128)this.commands.delete(this.commands.keys().next().value);return run;
 }
 async execute(command){
  if(!command.action&&parseIntent(command.text??'',this.task?.target??this.focus?.name??this.lastTarget)?.action==='ignore')return;
  const serial=++this.serial,started=performance.now();
  try {
  if(this.state==='LEARNING'){this.state='IDLE';this.update();}
  this.focus=this.focus?this.memory.get(this.focus.id):null;this.emit({type:'speech.clear',serial});const raw=text(command.text??'',600);let snapshot=null;try{snapshot=this.frozen();}catch{}
  let intent=command.action?{action:command.action,target:command.target,objectId:command.objectId,index:command.index}:parseIntent(raw,this.task?.target??this.focus?.name??this.lastTarget);
  if(!intent&&this.providers.intent){try{intent=validateSemantic(await this.providers.intent(raw,this.task?.target??this.focus?.name??this.lastTarget,this.memory.all().map(o=>o.name).slice(0,40)),raw,this.focus?.name);}catch(error){this.emit({type:'diagnostic',operation:'intent',code:safeError(error)});}if(serial!==this.serial)return;}
  if(!intent){this.say(this.lastTarget||this.focus||this.task?'这次没能理解这句追问，正在谈的仍是'+(this.task?.target??this.focus?.name??this.lastTarget)+'。可以说“上次在哪里”或“现在帮我找”。':'你希望我帮你看什么，或者记住哪件物品？',serial);return;}
  if(intent.target&&['find','remember','history','check','appearance'].includes(intent.action))this.lastTarget=intent.target;
  if(intent.action==='ignore')return;
  if(['chat','clarify'].includes(intent.action)){this.say(intent.answer,serial);return;}
  if(['find','remember','history','check','appearance'].includes(intent.action)&&!intent.target&&!intent.objectId){this.say('你说的是哪件物品？',serial);return;}
  if(intent.action==='select'){check(this.choices&&Number.isInteger(intent.index)&&this.choices.ids[intent.index],'invalid_choice');const choice=this.choices;this.choices=null;return await this.executeIntent({...choice.intent,objectId:choice.ids[intent.index]},choice.snapshot,serial,command.commandId);}
  return await this.executeIntent(intent,snapshot,serial,command.commandId);
  }catch(error){
   this.emit({type:'diagnostic',operation:'command',code:safeError(error)});
   if(serial!==this.serial||this.lastReplySerial===serial)return;
   const timed=['TimeoutError','AbortError'].includes(error.name)||/_timeout$/.test(error.message);
   const detail=timed?'连接有些慢，图片分析超时了':/^qwen_http_|^jev_http_/.test(error.message)?'图片分析服务暂时不可用':/invalid|output_limit/.test(error.message)?'图片分析返回的内容不完整':error.message==='provider_network_failed'?'连接图片分析服务失败':'这次未能完成图片分析';
   const message=['fresh_frame_required','stale_frame'].includes(error.message)?'还没有新的画面，请先打开镜头。':error.message==='invalid_choice'?'你指的是哪一件？':error.message==='memory_changed'?'这件物品刚刚有了新记录，请再试一次。':detail+'。已保存的记忆仍保留，可以重试。';
   this.say(message,serial);
  }finally{this.emit({type:'diagnostic',operation:'turn',serial,durationMs:Math.round(performance.now()-started)});}
 }
 resolve(intent,snapshot){
  if(intent.objectId){const o=this.memory.get(intent.objectId);check(o,'object_missing');this.focus=o;return o;}
  const list=this.memory.matching(intent.target??'');if(list.length===1){this.focus=list[0];return list[0];}
  if(list.length>1){if(this.focus&&list.some(o=>o.id===this.focus.id))return this.memory.get(this.focus.id);this.choices={ids:list.map(o=>o.id),intent,snapshot};this.emit({type:'choices',items:list.map(o=>({id:o.id,name:o.name,detail:this.memory.receipt(o.id).message}))});this.say('有多件同名物品，请选一件，或说第一件、第二件。');return undefined;}return null;
 }
 async executeIntent(intent,snapshot,serial,commandId){
  const action=intent.action;
  if(action==='cancel'){this.cancel();return;}
  if(action==='complete'){if(this.focus){this.memory.recordRetrieved(this.focus.id);this.changed();}this.cancel(false);this.state='COMPLETED';this.update();this.say(this.focus?'已记录你拿到了'+this.focus.name+'，之后放在哪里还没有记录。':'本次寻找已结束。');return;}
  if(action==='reject'||action==='continue'||action==='features'){
   if(!this.task){if(action==='continue'&&(this.focus||this.lastTarget))return this.executeIntent({action:'find',target:this.focus?.name??this.lastTarget,objectId:this.focus?.id},snapshot,serial,commandId);this.say('请先说要找哪件物品。');return;}if(action==='reject'&&this.lastConfirmed)this.rejections.push({box:this.lastConfirmed.box,frameHash:this.lastConfirmed.frameHash,generation:this.source.generation,at:this.now()});
   const features=action==='features'?text(intent.description,120,false):this.task.features;this.generation++;this.task={...this.task,features,generation:this.generation};for(const c of this.active)c.abort();this.active.clear();this.reviewing=false;this.lastConfirmed=null;this.state='SEARCHING';this.lastReview=0;this.update();this.say(action==='reject'?'已排除刚才的候选，继续寻找。':action==='features'?'已补充本轮特征，继续寻找。':'继续寻找。');return;
  }
  if(action==='accept'){this.say('已收到你的确认，拿到后可以告诉我“拿到了”。');return;}
  if(action==='describe'){check(snapshot,'fresh_frame_required');this.update('正在看眼前的画面');const c=new AbortController();this.active.add(c);try{const r=await this.providers.describe(snapshot,null,intent.question??'眼前有什么',c.signal);if(!c.signal.aborted)this.say(r.answer?.trim()||(r.i.length?'当前画面可以看到：'+r.i.join('、')+'。':'我还看不清，请把镜头稍微移近一些。'),serial);}finally{this.active.delete(c);}return;}
  if(action==='remember'){
   check(snapshot,'fresh_frame_required');const target=text(intent.target,40,false);let object=null;
   if(intent.objectId){object=this.memory.get(intent.objectId);check(object,'object_missing');}
   else if(!intent.newIdentity){object=this.resolve(intent,snapshot);if(object===undefined)return;}
   const prior=this.memory.all().find(o=>o.captures.some(c=>c.id===commandId));if(prior){this.focus=prior;this.say(this.memory.receipt(prior.id).message,serial);return;}
   this.cancel(false);const receipt=this.memory.capture(target,snapshot,{objectId:object?.id,captureId:commandId});this.focus=this.memory.get(receipt.objectId);this.state='LEARNING';this.changed();this.update('正在记住'+target+'的样子和位置');
   if(this.providers.singlePassMemory)return this.rememberObservation(receipt,snapshot,intent,serial);
   const controller=new AbortController();this.active.add(controller);let saved=null,announced=false;
   try{
    // Both helpers see the command's frozen frame. Never substitute a later detection.
    let candidate=null,earlyResult=null;
    const earlyReview=(async()=>{
     const label=labelFor(target);if(!label||!this.detector?.ready)return null;
     const until=performance.now()+500;while(this.detector.busy&&performance.now()<until&&!controller.signal.aborted)await new Promise(r=>setTimeout(r,10));
     if(this.detector.busy||controller.signal.aborted)return null;
     const labels=detectionLabels(target,label);const detected=await this.detector.run(snapshot,{target:label,targets:labels});
     const found=detected.frameId===snapshot.frameId?(detected.detections??[]).filter(x=>labels.includes(x.label)&&x.score>=.5&&validBox(x.box)):[];
     if(found.length!==1||controller.signal.aborted)return null;
     const box=found[0].box,photo=await this.crop(snapshot,box);candidate={box,photo};
     if(controller.signal.aborted)return null;
     const result=await this.providers.review(snapshot,{target,memory:true,proposalBox:box,crop:photo.jpeg},controller.signal);
     earlyResult={box,photo,result};return earlyResult;
    })().catch(error=>{this.emit({type:'diagnostic',operation:'early_review',code:safeError(error)});return null;});
    let words=null;try{words=await this.providers.describe(snapshot,target,'描述并定位用户要记住的物品，说明其可见相对位置',controller.signal);}catch(error){this.emit({type:'diagnostic',operation:'memory_describe',code:safeError(error),frameId:snapshot.frameId});}
    if(controller.signal.aborted)return;
    const d=words?.v?words:null;
    const proposalBox=candidate?.box??(validBox(d?.b)?d.b:null);
    let proposedPhoto=candidate?.photo??null;if(proposalBox&&!proposedPhoto)try{proposedPhoto=await this.crop(snapshot,proposalBox);}catch{}
    if(controller.signal.aborted)return;
    const negative=r=>r&&(r.visible<=.1||r.clear<=.1||(typeof r.candidateMatch==='number'&&r.candidateMatch<=.1));
    // Durable observation is useful memory even when the independent check is uncertain.
    // The original scene is the reference when an isolated crop cannot be produced.
    if(d?.d&&d?.l&&!negative(earlyResult?.result)){
     saved=this.memory.finish(receipt,{appearance:proposedPhoto,description:d.d,suggestedLocation:d.l,failureKind:'REVIEW_PENDING'});
     this.changed();if(serial===this.serial){this.focus=this.memory.get(saved.objectId);this.state='IDLE';this.update();this.say(saved.message,serial);announced=true;}
    }
    const fast=await earlyReview;if(controller.signal.aborted)return;
    let r=fast?.result??null;
    let rejected=negative(r);
    if(!rejected&&(!r?.box||!r?.location))try{r=await this.providers.review(snapshot,{target,memory:true,description:d?.d??'',proposalBox:proposedPhoto?proposalBox:null,crop:proposedPhoto?.jpeg??null,proposalLocation:d?.l??'',proposalAnchor:d?.a??''},controller.signal);}catch(error){this.emit({type:'diagnostic',operation:'memory_review',code:safeError(error)});}
    let appearance=null,failureKind=r?.failureKind??'REVIEW_UNAVAILABLE';
    rejected=negative(r);
    if(r?.box){try{appearance=proposedPhoto&&r.box.every((v,i)=>Math.abs(v-proposalBox[i])<.00001)?proposedPhoto:await this.crop(snapshot,r.box);}catch{failureKind='CROP_UNAVAILABLE';}}
    if(controller.signal.aborted)return;let result;
    if(rejected)failureKind='REVIEW_REJECTED';else if(saved)failureKind=r?.box&&r?.location?'':r?'REVIEW_UNCERTAIN':'REVIEW_UNAVAILABLE';
    try{result=this.memory.finish(saved??receipt,{appearance:rejected?null:appearance,description:rejected?null:d?.d,suggestedLocation:d?.l,location:rejected?null:r?.location,failureKind,review:!!saved});}catch(error){if(appearance&&error.message!=='memory_changed')result=this.memory.finish(saved??receipt,{description:d?.d,suggestedLocation:d?.l,location:r?.location,failureKind:saved?'REVIEW_UNCERTAIN':'PHOTO_WRITE_FAILED',review:!!saved});else throw error;}
    if(intent.location){this.memory.addLocation(result.objectId,intent.location);result=this.memory.receipt(result.objectId);result.message+=' 另已记录你提供的位置：'+intent.location+'。';}
    this.changed();if(serial===this.serial){this.focus=this.memory.get(result.objectId);this.state='IDLE';this.update();if(!announced)this.say(result.message,serial);}return result;
   }catch(error){if(!controller.signal.aborted){try{this.memory.finish(saved??receipt,{failureKind:saved?'REVIEW_UNAVAILABLE':'ANALYSIS_FAILED',review:!!saved});this.changed();}catch{}this.emit({type:'diagnostic',operation:'memory',code:safeError(error)});if(!announced)this.say('这次没能记全'+target+'，请调整一下镜头再试一次。',serial);}}finally{this.active.delete(controller);}
   return;
  }
  const object=this.resolve(intent,snapshot);if(object===undefined)return;
  if(['check','history','appearance'].includes(action)){
   if(!object){this.say('记忆库中还没有这件物品的记录。',serial);return;}
   this.say(action==='check'?this.memory.receipt(object.id).message:action==='history'?this.memory.history(object.id):object.description?'已保存的外观描述是：'+object.description+'。':object.appearances.length?'已经保存了目标参考照片，尚无文字外观描述。':'还没有保存这件物品的目标外观照片。',serial);return;
  }
  if(action==='find'){
   const target=text(intent.target,40,false);this.cancel(false);this.focus=object;this.rejections=[];this.lastReview=0;this.cloudRequests=0;this.lastTarget=target;this.lastFrameKey=null;this.task={id:uuid(),target,label:object?.yoloLabel??labelFor(object?.name??target),labels:detectionLabels(object?.name??target,object?.yoloLabel??labelFor(target)),objectId:object?.id??null,features:'',generation:this.generation,serial};this.state='SEARCHING';this.update();this.say('开始寻找'+target+'。'+(object&&!this.memory.references(object).length?'这件物品还没有目标参考画面，暂时不能确认是否是你的那一件。':''),serial);return;
  }
  this.say('请再明确一下要进行的操作。',serial);
 }
 async rememberObservation(receipt,snapshot,intent,serial) {
  const controller=new AbortController();this.active.add(controller);
  const started=performance.now();
  try {
   const d=await this.providers.describe(snapshot,intent.target,'描述并定位用户要记住的物品，说明其可见相对位置',controller.signal);
   if(controller.signal.aborted)return;
   let appearance=null;
   if(d.v&&validBox(d.b))try{appearance=await this.crop(snapshot,d.b);}catch(error){this.emit({type:'diagnostic',operation:'memory_crop',code:safeError(error)});}
   if(controller.signal.aborted)return;
   // A single Omni observation is not an independent verification. Keep existing
   // v2 provenance semantics so old tablets and backups can read these records.
   let result=this.memory.finish(receipt,{appearance,description:d.v?d.d:null,suggestedLocation:d.v?d.l:null,failureKind:d.v?'REVIEW_UNCERTAIN':'TARGET_UNCERTAIN'});
   if(intent.location){this.memory.addLocation(result.objectId,intent.location);result=this.memory.receipt(result.objectId);}
   this.changed();
   if(serial===this.serial){this.focus=this.memory.get(result.objectId);this.state='IDLE';this.update();this.say(result.message,serial);}
   return result;
  } catch(error) {
   if(!controller.signal.aborted){
    try{this.memory.finish(receipt,{failureKind:'ANALYSIS_FAILED'});this.changed();}catch{}
    this.emit({type:'diagnostic',operation:'omni_memory',code:safeError(error)});
    if(serial===this.serial){this.state='IDLE';this.update();this.say('当时画面已保存，但这次分析没有完成，外观和位置还未确认。',serial);}
   }
  } finally {this.active.delete(controller);this.emit({type:'diagnostic',operation:'omni_memory',frameId:snapshot.frameId,durationMs:Math.round(performance.now()-started)});}
 }
 async tick(){
  if(this.state==='LEARNING')return;
  const frame=this.source.fresh();
  if(!frame&&this.state==='GUIDING'){this.emit({type:'speech.clear',serial:this.serial});this.state='SEARCHING';this.lastConfirmed=null;this.update('当前画面已过期，请调整镜头继续寻找。');}
  if(!frame||!this.detector?.ready||this.detector.busy)return;
  const key=`${frame.sourceGeneration}:${frame.frameId}`;if(key===this.lastFrameKey)return;this.lastFrameKey=key;const task=this.task;
  try{const result=await this.detector.run(frame,{target:task?.label,targets:task?.labels});if(frame.sourceGeneration!==this.source.generation)return;
   this.reviewTrack?.update(frame,result,this.now());
   this.lastAnalyzed={...result,at:this.now()};this.emit({type:'detections',clientFrameId:frame.clientFrameId,frameId:frame.frameId,inferenceMs:result.inferenceMs,detections:result.detections});
   if(this.state==='GUIDING'&&this.lastConfirmed&&this.providers.trackCandidates){
    const old=this.lastConfirmed;
    const found=result.detections.filter(d=>Number.isSafeInteger(old.trackId)&&d.trackId===old.trackId&&d.label===old.label&&overlap(d.box,old.box)>.35);
    const current=found[0];
    const ambiguous=current&&result.detections.some(d=>d!==current&&d.label===current.label&&overlap(d.box,current.box)>.25);
    if(found.length===1&&!ambiguous&&this.now()-old.at<=1500){
     const zone=b=>(b[0]+b[2])/2<1/3?'左侧':(b[0]+b[2])/2>2/3?'右侧':'中央';
     if(zone(current.box)!==zone(old.box))this.say('目标现在在画面'+zone(current.box)+'。');
     this.lastConfirmed={...old,box:current.box,at:this.now()};
    }else{this.state='SEARCHING';this.lastConfirmed=null;this.emit({type:'speech.clear',serial:this.serial});this.update('目标跟踪中断，正在重新核对。');}
   }
   if(this.state==='GUIDING'&&this.lastConfirmed&&!result.detections.some(d=>(task?.labels?.includes(d.label)||d.label===(this.lastConfirmed.label??task?.label))&&overlap(d.box,this.lastConfirmed.box)>.5)){this.state='SEARCHING';this.lastConfirmed=null;this.emit({type:'speech.clear',serial:this.serial});this.update('目标已离开刚才的位置，继续寻找。');}
   if(!task||this.task!==task||this.state==='GUIDING'||this.reviewing||this.now()-this.lastReview<3000)return;
   const object=task.objectId?this.memory.get(task.objectId):null;
   const candidates=rankCandidates((result.candidates??[]).filter(c=>(!task.labels?.length||task.labels.includes(c.label))&&validBox(c.box)&&!this.rejections.some(r=>r.generation===frame.sourceGeneration&&this.now()-r.at<30000&&overlap(r.box,c.box)>.65)),object?this.memory.photos(object):[]);
   const candidate=candidates[0]??null;if(!candidate&&task.label){this.searchNotice(task,'no_candidate','本地检测暂未圈出'+task.target+'，正在用当前画面和参考照片继续核对。');}if(!candidate&&this.now()-this.lastReview<6000)return;
   if(this.cloudRequests>=60)return;
   if(task.objectId&&!this.memory.references(object).length){this.searchNotice(task,'no_reference','已找到这件物品的文字记录，但还没有可用的参考照片，暂时无法确认是否是同一件。');return;}
   this.lastReview=this.now();this.reviewing=true;this.cloudRequests++;void this.verify(frame,candidate,task).finally(()=>{if(this.task===task)this.reviewing=false;});
  }catch(error){this.emit({type:'diagnostic',code:safeError(error)});}
 }
 searchNotice(task,code,message){if(this.task!==task)return;task.notices??=new Set();if(task.notices.has(code))return;task.notices.add(code);this.say(message);}
 async verify(frame,candidate,task){
  const c=new AbortController();this.active.add(c);const serial=this.serial,generation=task.generation,started=performance.now();this.state='VERIFYING';this.update();
  const track=this.providers.trackCandidates?new CandidateContinuity(candidate,frame,this.now()):null;this.reviewTrack=track;
  try{const object=task.objectId?this.memory.get(task.objectId):null;const refs=object?this.memory.references(object).map(path=>this.memory.image(path)):[];const r=await this.providers.review(frame,{target:task.target,description:object?.description??'',crop:candidate?Buffer.from(candidate.cropJpeg,'base64'):null,references:refs,features:task.features},c.signal);
   if(c.signal.aborted||this.task!==task||this.generation!==generation||serial!==this.serial)return;
   const current=this.source.fresh(),tracked=track?.current(this.now());if(!current||current.sourceGeneration!==frame.sourceGeneration||(this.now()-frame.receivedAtMs>3000&&!tracked)){this.emit({type:'diagnostic',operation:'find_review',code:'review_frame_expired',frameId:frame.frameId,durationMs:Math.round(performance.now()-started)});this.searchNotice(task,'expired',r.decision==='CONFIRM'?'刚才的画面中看到了与参考相符的'+task.target+'，但结果返回时画面已过期，正在继续确认当前位置。':'这次对比返回时画面已过期，正在继续寻找'+task.target+'。');return;}
   if(candidate&&!tracked&&(!this.lastAnalyzed||this.now()-this.lastAnalyzed.at>1500||!this.lastAnalyzed.detections.some(d=>(task.labels?.includes(d.label)||d.label===candidate.label)&&overlap(d.box,candidate.box)>.5))){this.emit({type:'diagnostic',operation:'find_review',code:'candidate_changed',frameId:frame.frameId});this.searchNotice(task,'candidate_changed','候选已离开刚才的位置，继续寻找'+task.target+'。');return;}
   if(track&&Number.isSafeInteger(track.id)&&!track.valid){this.searchNotice(task,'track_lost','目标跟踪中断，正在重新核对。');return;}
   if(r.decision==='REJECT'&&candidate){this.rejections.push({box:candidate.box,frameHash:hash(frame.jpeg),generation:frame.sourceGeneration,at:this.now()});this.searchNotice(task,'rejected','已排除一个不相符的候选，继续寻找'+task.target+'。');}
   if(r.decision==='UNCERTAIN')this.searchNotice(task,'uncertain','看到了相近的候选，但还不能确认是'+task.target+'。请保持镜头稳定或稍微靠近。');
   if(r.decision==='CONFIRM'){this.lastConfirmed={box:tracked??candidate?.box??[0,0,1,1],trackId:candidate?.trackId??null,label:candidate?.label??task.label,frameHash:hash(frame.jpeg),at:this.now()};this.state='GUIDING';const currentBox=tracked??candidate?.box;const center=currentBox?(currentBox[0]+currentBox[2])/2:null;this.say('发现'+(object?'与你保存的参考相符的':'一件')+task.target+(center===null?'。':center<1/3?'，在画面左侧。':center>2/3?'，在画面右侧。':'，在画面中央。'),serial);this.update();}
  }catch(error){this.emit({type:'diagnostic',operation:'find_review',code:safeError(error),frameId:frame.frameId,durationMs:Math.round(performance.now()-started)});if(!c.signal.aborted&&serial===this.serial)this.searchNotice(task,'review_failed','这次物品对比未完成，仍在寻找'+task.target+'，已保存的照片和位置仍保留。');}finally{if(this.reviewTrack===track)this.reviewTrack=null;this.active.delete(c);if(this.task===task&&this.state==='VERIFYING'){this.state='SEARCHING';this.update();}}
 }
}
