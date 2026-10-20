import {StableCandidateGate,targetClasses} from './yolo-core.mjs';
import {localYoloEnabled} from './yolo-config.mjs';

const aborted=()=>new DOMException('Cancelled','AbortError');
export class LocalYolo{
 constructor({Worker:WorkerClass=globalThis.Worker,origin=globalThis.location?.origin,clock=()=>performance.now(),timeoutMs=4000,loadTimeoutMs=90000,budgetMs=4000}={}){
  Object.assign(this,{WorkerClass,clock,timeoutMs,loadTimeoutMs,budgetMs});this.enabled=!!WorkerClass&&localYoloEnabled(origin);this.pending=new Map();this.serial=0;
 }
 warm(){
  if(!this.enabled||this.closed||this.failed)return Promise.resolve(false);
  if(this.loading)return this.loading;
  this.loading=(async()=>{
   try{
    this.worker=new this.WorkerClass('/static/yolo-worker.js');
    this.worker.onmessage=({data})=>{const pending=this.pending.get(data.id);if(!pending)return;this.pending.delete(data.id);clearTimeout(pending.timer);if(data.error){this.lastError=data.detail||data.error;pending.reject(Error(data.error));}else pending.resolve(data.result);};
    this.worker.onerror=event=>{this.lastError=event.message;this.fail();};
    this.info=await this.call('init',{},this.loadTimeoutMs);this.ready=true;return true;
   }catch{this.fail();return false;}
  })();return this.loading;
 }
 fail(){this.failed=true;this.ready=false;this.worker?.terminate();for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(Error('local_detector_unavailable'));}this.pending.clear();}
 call(type,body={},timeout=this.timeoutMs){
  if(this.closed||this.failed)return Promise.reject(Error('local_detector_unavailable'));
  return new Promise((resolve,reject)=>{const id=++this.serial,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('local_detector_timeout'));this.fail();},timeout);this.pending.set(id,{resolve,reject,timer});try{this.worker.postMessage({id,type,...body});}catch{this.fail();}});
 }
 async prepare({target,capture,signal,stillCurrent=()=>true}){
  const current=()=>!signal?.aborted&&stillCurrent()&&!this.closed;
  if(!current())throw aborted();
  const started=this.clock();let image;
  const fallback=reason=>{if(!current())throw aborted();return {image:capture(),stableCandidate:false,local:{status:reason,latencyMs:this.clock()-started}};};
  if(!this.ready){void this.warm();return fallback(this.failed?'unavailable':'loading');}
  if(this.slow)return fallback('slow_device');
  const classes=targetClasses(target,this.info.labels,this.info.aliases);
  if(!classes.length)return fallback('unsupported_target');
  const gate=new StableCandidateGate();let inferenceMs=0,candidate=null;
  try{
   for(let i=0;i<2;i++){
    if(!current())throw aborted();image=capture();
    const remaining=this.budgetMs-(this.clock()-started);
    if(remaining<=0){this.slow=true;return fallback('slow_device');}
    const result=await this.call('detect',{image},Math.min(this.timeoutMs,remaining));
    if(!current())throw aborted();inferenceMs+=result.latencyMs;candidate=gate.offer(result.detections,classes);
    if(i===0)await new Promise((resolve,reject)=>{
     const onAbort=()=>{clearTimeout(timer);reject(aborted());};
     const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},160);signal?.addEventListener('abort',onAbort,{once:true});
    });
   }
   // Slow devices keep the original cloud path; a delayed local image must
   // never be presented as a current view after the phone has moved.
   if(this.clock()-started>this.budgetMs){this.slow=true;return fallback('slow_device');}
   return {image,stableCandidate:!!candidate,candidate:candidate||null,local:{status:candidate?'stable':'not_confirmed',latencyMs:this.clock()-started,inferenceMs,label:candidate?.label||null}};
  }catch(error){if(!current()||error.name==='AbortError')throw aborted();return fallback('unavailable');}
 }
 close(){if(this.closed)return;this.closed=true;this.fail();}
}
