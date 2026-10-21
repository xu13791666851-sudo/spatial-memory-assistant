import {containedBox,fingerprint,motionChanged} from './target-overlay.mjs';

// The full web demo shows the actual server YOLO output. These class boxes do
// not claim that a detected item is the user's remembered object.
const preview=document.getElementById('camera-preview');
const video=document.getElementById('preview');
const layer=document.createElement('div');
layer.className='demo-detection-layer';
layer.setAttribute('aria-hidden','true');
preview.append(layer);
const canvas=document.createElement('canvas');
canvas.width=24;canvas.height=18;
let latest=null,timer=null;

function clear(){latest=null;layer.replaceChildren();clearTimeout(timer);timer=null;}
function redraw(){
 layer.replaceChildren();clearTimeout(timer);timer=null;
 if(!latest||document.hidden||!video.srcObject||video.readyState<2||Date.now()-latest.capturedAt>3000){clear();return;}
 try{if(motionChanged(latest.mark,fingerprint(video,null,canvas))){clear();return;}}catch{clear();return;}
 const rect=preview.getBoundingClientRect();
 for(const detection of latest.detections||[]){
  if(!detection||!Number.isFinite(detection.confidence)||detection.confidence<.25)continue;
  const box=containedBox(detection.box,rect.width,rect.height,latest.width,latest.height);
  if(!box)continue;
  const node=document.createElement('div');node.className='demo-detection-box';
  for(const [key,value] of Object.entries(box))node.style[key]=value+'px';
  node.dataset.label=String(detection.label||'');
  const label=document.createElement('span');label.className='demo-detection-label';
  label.textContent=String(detection.label||'物品')+' '+Math.round(detection.confidence*100)+'%';
  if(box.top<24)node.dataset.topLabel='true';
  node.append(label);layer.append(node);
 }
 timer=setTimeout(redraw,160);
}

window.addEventListener('demo-detections',event=>{
 const frame=event.detail;
 if(!frame||!Array.isArray(frame.detections)||!Number.isFinite(frame.capturedAt)){clear();return;}
 latest=frame;redraw();
});
new ResizeObserver(redraw).observe(preview);
document.addEventListener('visibilitychange',()=>{if(document.hidden)clear();});
