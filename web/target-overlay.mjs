// Boxes belong to one analyzed frame and one saved record, never a COCO class.
export function containedBox(box,width,height,videoWidth,videoHeight){
 if(![width,height,videoWidth,videoHeight].every(n=>Number.isFinite(n)&&n>0)||!Array.isArray(box)||box.length!==4||!box.every(n=>Number.isFinite(n)&&n>=0&&n<=1)||box[2]<=box[0]||box[3]<=box[1])return null;
 const scale=Math.min(width/videoWidth,height/videoHeight),w=videoWidth*scale,h=videoHeight*scale;
 return {left:(width-w)/2+box[0]*w,top:(height-h)/2+box[1]*h,width:(box[2]-box[0])*w,height:(box[3]-box[1])*h};
}
function pixels(canvas,source,box=null){
 const ctx=canvas.getContext('2d',{willReadFrequently:true}),w=source.videoWidth||source.width,h=source.videoHeight||source.height;
 if(!w||!h)throw Error('No current video');
 if(box)ctx.drawImage(source,box[0]*w,box[1]*h,(box[2]-box[0])*w,(box[3]-box[1])*h,0,0,canvas.width,canvas.height);
 else ctx.drawImage(source,0,0,canvas.width,canvas.height);
 const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data,rgb=[];
 for(let i=0;i<rgba.length;i+=4)rgb.push(rgba[i],rgba[i+1],rgba[i+2]);
 return rgb;
}
export function fingerprint(source,box,canvas=new OffscreenCanvas(24,18)){
 return {whole:pixels(canvas,source),target:pixels(canvas,source,box)};
}
export async function imageFingerprint(image,box){
 const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(image),c=>c.charCodeAt(0))],{type:'image/jpeg'}));
 try{return fingerprint(bitmap,box);}finally{bitmap.close();}
}
export function motionChanged(before,after){
 const difference=(a,b)=>!a?.length||a.length!==b?.length?Infinity:a.reduce((n,v,i)=>n+Math.abs(v-b[i]),0)/a.length;
 return difference(before?.whole,after?.whole)>20||difference(before?.target,after?.target)>24;
}
export function rememberedTarget(records,task){
 if(!task?.allowHistory||task.saveToken||task.identify||records?.length!==1)return null;
 const record=records[0];
 if(!record?.name||!record.recorded_at||(task.reference_appearance||'')!==(record.appearance||''))return null;
 return {id:record.object_id||record.id||null,name:record.name,recorded_at:record.recorded_at,appearance:record.appearance||''};
}
export function overlayCurrent(snapshot,{target,record,now=Date.now(),active=true}={}){
 if(!snapshot||!active||!Number.isFinite(snapshot.capturedAt)||snapshot.target!==target||!snapshot.fingerprint||now<snapshot.capturedAt||now-snapshot.capturedAt>8000)return false;
 return !!record&&record.name===snapshot.record.name&&(record.object_id||record.id||null)===snapshot.record.id&&record.recorded_at===snapshot.record.recorded_at&&(record.appearance||'')===snapshot.record.appearance;
}
export class TargetOverlay{
 constructor({document,read,clock=()=>Date.now()}){
  Object.assign(this,{document,read,clock});this.video=document.getElementById('preview');this.container=document.getElementById('camera-preview');
  if(!this.video||!this.container)return;
  this.layer=document.createElement('div');this.layer.className='memory-target-overlay';this.layer.hidden=true;this.layer.setAttribute('aria-hidden','true');
  this.label=document.createElement('span');this.label.className='memory-target-label';this.layer.append(this.label);this.container.append(this.layer);
  this.canvas=document.createElement('canvas');this.canvas.width=24;this.canvas.height=18;
  this.resize=new ResizeObserver(()=>this.draw());this.resize.observe(this.container);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)this.invalidate();else this.sync();});
 }
 invalidate(){if(this.snapshot)this.invalidToken=this.snapshot.token;if(this.layer)this.layer.hidden=true;}
 sync(){
  if(!this.layer)return;clearTimeout(this.timer);this.draw();
  if(this.snapshot&&!this.document.hidden)this.timer=setTimeout(()=>this.sync(),160);
 }
 draw(){
  if(!this.layer)return;
  const snapshot=this.read?.();this.snapshot=snapshot;
  if(!snapshot||snapshot.token===this.invalidToken||this.document.hidden||this.clock()-snapshot.capturedAt>8000){this.layer.hidden=true;return;}
  // Once movement invalidates a frame, do not resurrect its box if the camera returns.
  try{if(this.video.readyState<2||motionChanged(snapshot.fingerprint,fingerprint(this.video,snapshot.box,this.canvas))){this.invalidate();return;}}catch{this.invalidate();return;}
  const rect=this.container.getBoundingClientRect(),box=containedBox(snapshot.box,rect.width,rect.height,this.video.videoWidth,this.video.videoHeight);
  if(!box||!rect.width||!rect.height){this.layer.hidden=true;return;}
  const confirmed=snapshot.status==='confirmed'&&!!snapshot.record.appearance;
  this.layer.dataset.status=confirmed?'confirmed':'pending';
  for(const [key,value]of Object.entries(box))this.layer.style[key]=value+'px';
  this.label.style.transform=box.top>35?'translateY(-100%)':'none';
  this.label.style.left=box.left+box.width/2>rect.width/2?'auto':'-3px';
  this.label.style.right=box.left+box.width/2>rect.width/2?'-3px':'auto';
  this.label.textContent=snapshot.record.name+' · '+(confirmed?'外观已核对':'待核对');
  this.layer.hidden=false;
 }
}
