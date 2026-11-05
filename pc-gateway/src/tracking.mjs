// A track ID is continuity evidence, never proof of personal identity. Any lost,
// ambiguous or stale update invalidates this bridge; cloud comparison is still required.
export const iou=(a,b)=>{
 const n=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
 return n/Math.max(1e-9,(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-n);
};
export class CandidateContinuity {
 constructor(candidate,frame,now) {
  this.id=candidate?.trackId;this.valid=Number.isSafeInteger(this.id);this.label=candidate?.label;
  this.generation=frame.sourceGeneration;this.started=now;this.at=now;this.frameId=frame.frameId;
  this.box=candidate?.box;this.samples=1;
 }
 update(frame,result,now) {
  if(!this.valid||frame.frameId===this.frameId)return;
  const matches=result.detections.filter(d=>d.trackId===this.id&&d.label===this.label);
  const current=matches[0];
  if(frame.sourceGeneration!==this.generation||now-this.at>1500||now-frame.receivedAtMs>1500||matches.length!==1||
    iou(this.box,current.box)<.35||result.detections.some(d=>d!==current&&d.label===this.label&&iou(d.box,current.box)>.25)) {this.valid=false;return;}
  this.at=now;this.frameId=frame.frameId;this.box=current.box;this.samples++;
 }
 current(now) {return this.valid&&this.samples>=3&&now-this.at<=1000&&now-this.started<=8000?this.box:null;}
}
