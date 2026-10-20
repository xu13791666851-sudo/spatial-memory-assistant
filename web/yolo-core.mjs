export function iou(a,b){
 const intersection=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
 const area=box=>Math.max(0,box[2]-box[0])*Math.max(0,box[3]-box[1]);
 const union=area(a)+area(b)-intersection;return union>0?intersection/union:0;
}
export function decodeYolo(values,shape,labels,{width,height,inputWidth,inputHeight,scale,padX,padY,threshold=0.5,nms=0.45}){
 if(shape.length!==3||shape[0]!==1||values.length!==shape[1]*shape[2])throw Error('Invalid YOLO output');
 const channelsFirst=shape[1]===labels.length+4,channels=channelsFirst?shape[1]:shape[2],count=channelsFirst?shape[2]:shape[1];
 if(channels!==labels.length+4)throw Error('YOLO labels do not match model');
 const at=(row,col)=>values[channelsFirst?col*count+row:row*channels+col];
 let normalized=true;
 for(let row=0;row<count&&normalized;row++)for(let col=0;col<4;col++)if(Math.abs(at(row,col))>2)normalized=false;
 const clamp=(value,max)=>Math.max(0,Math.min(max,value)),found=[];
 for(let row=0;row<count;row++){
  let classId=0,confidence=at(row,4);
  for(let col=1;col<labels.length;col++)if(at(row,col+4)>confidence){classId=col;confidence=at(row,col+4);}
  if(!Number.isFinite(confidence)||confidence<threshold)continue;
  const cx=at(row,0)*(normalized?inputWidth:1),cy=at(row,1)*(normalized?inputHeight:1),w=at(row,2)*(normalized?inputWidth:1),h=at(row,3)*(normalized?inputHeight:1);
  const box=[clamp((cx-w/2-padX)/scale,width),clamp((cy-h/2-padY)/scale,height),clamp((cx+w/2-padX)/scale,width),clamp((cy+h/2-padY)/scale,height)];
  if(box.every(Number.isFinite)&&box[2]-box[0]>1&&box[3]-box[1]>1)found.push({classId,label:labels[classId],confidence,box:box.map((v,i)=>v/(i%2?height:width))});
 }
 const kept=[];
 for(const detection of found.sort((a,b)=>b.confidence-a.confidence))if(!kept.some(other=>other.classId===detection.classId&&iou(other.box,detection.box)>nms))kept.push(detection);
 return kept.slice(0,60);
}
export function targetClasses(target,labels,aliases){
 const text=String(target||'').toLowerCase().replace(/[\s，。！？,!?]/g,'');
 const exact=Object.entries(aliases).find(([name])=>text===name.toLowerCase());
 if(exact)return exact[1].filter(label=>labels.includes(label));
 const names=Object.keys(aliases).sort((a,b)=>b.length-a.length);
 const name=names.find(name=>text.endsWith(name.toLowerCase()));
 if(name)return aliases[name].filter(label=>labels.includes(label));
 return labels.filter(label=>text===label.toLowerCase());
}
export class StableCandidateGate{
 reset(){this.previous=null;this.hits=0;}
 constructor(){this.reset();}
 offer(detections,classes){
  const eligible=detections.filter(d=>classes.includes(d.label)&&d.confidence>=0.5);
  // Several same-category objects are never a unique local confirmation.
  if(eligible.length!==1){this.reset();return null;}
  const current=eligible[0];this.hits=this.previous?.label===current.label&&iou(this.previous.box,current.box)>=0.2?this.hits+1:1;
  this.previous=current;return this.hits>=2?{...current,hits:this.hits}:null;
 }
}
