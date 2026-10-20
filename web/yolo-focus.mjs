import {validateObservation} from './realtime-observation.mjs';

export function validCandidate(candidate){
 const box=candidate?.box;
 return typeof candidate?.label==='string'&&candidate.confidence>=0.5&&candidate.confidence<=1&&candidate.hits>=2&&Array.isArray(box)&&box.length===4&&box.every(n=>Number.isFinite(n)&&n>=0&&n<=1)&&box[2]>box[0]&&box[3]>box[1];
}
export function candidateRegion(box){
 const x=(box[0]+box[2])/2,y=(box[1]+box[3])/2,col=x<1/3?0:x>2/3?2:1,row=y<1/3?0:y>2/3?2:1;
 return [['左上方','上方','右上方'],['左侧','中间','右侧'],['左下方','下方','右下方']][row][col];
}
export async function cropCandidate(image,candidate){
 if(!validCandidate(candidate))throw Error('Invalid local candidate');
 const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(image),char=>char.charCodeAt(0))],{type:'image/jpeg'}));
 try{
  const [left,top,right,bottom]=candidate.box,padX=(right-left)*0.2,padY=(bottom-top)*0.2;
  const x=Math.max(0,Math.floor((left-padX)*bitmap.width)),y=Math.max(0,Math.floor((top-padY)*bitmap.height));
  const width=Math.min(bitmap.width,Math.ceil((right+padX)*bitmap.width))-x,height=Math.min(bitmap.height,Math.ceil((bottom+padY)*bitmap.height))-y;
  if(width<8||height<8)throw Error('Candidate too small');
  const scale=Math.min(3,768/Math.max(width,height)),canvas=new OffscreenCanvas(Math.round(width*scale),Math.round(height*scale));
  canvas.getContext('2d').drawImage(bitmap,x,y,width,height,0,0,canvas.width,canvas.height);
  for(const quality of [0.85,0.7,0.5]){
   const blob=await canvas.convertToBlob({type:'image/jpeg',quality}),bytes=new Uint8Array(await blob.arrayBuffer());
   if(bytes.length>105000)continue;
   let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text);
  }
  throw Error('Candidate crop too large');
 }finally{bitmap.close();}
}
function verified(payload,id,task){
 if(payload?.request_id!==id||payload.frame_received!==true||!['clear','uncertain'].includes(payload.frame_status))throw Error('这次没有获取到对应的画面结果。');
 return {...payload,...validateObservation(payload,task)};
}
function uncertain(full,reason,status){
 return {...full,answer:reason,frame_status:'uncertain',target_visible:null,memory_candidate:null,appearance_match:null,next_step:null,focus:{status}};
}
export async function observeFocusedFrame({frame,candidate,crop,observe}){
 if(!validCandidate(candidate)||!frame.task?.target||frame.task.remember!==false)throw Error('Candidate verification is only for finding');
 const region=candidateRegion(candidate.box),task=frame.task,focusId=crypto.randomUUID();
 const full={...frame,goal:(frame.goal||'').slice(0,200)+`。本地检测仅提出画面${region}的候选，不是已找到的结论。请核对目标颜色及外观，不能因类别相同就认作目标。`};
 const zoom={...frame,image:crop,request_id:focusId,goal:`这张图片是同一帧中画面${region}候选的放大图。只核对是否符合目标及历史外观；裁剪会隐藏杯柄或图案，细节被截断时报告不确定，不要当作不存在。裁剪图的位置不用于整图定位。`};
 const [whole,detail]=await Promise.allSettled([observe(full),observe(zoom)]);
 if(whole.status==='rejected'){
  if(detail.status==='rejected')throw whole.reason;
  const closeResult=verified(detail.value,focusId,task);
  // This receipt proves only the same-frame crop, not an understood background.
  const subset={...closeResult,request_id:frame.request_id,detail_request_id:focusId,source:'current_camera_crop',whole_frame_received:false,objects:[],memory_candidate:null,next_step:null};
  if(closeResult.frame_status==='clear'&&closeResult.target_visible===true&&(!task.reference_appearance||closeResult.appearance_match?.status==='match'))return {...subset,answer:`放大核对后，在画面${region}看到了符合“${task.target}”描述的候选。整图理解未完成，暂不描述周围参照物。`,objects:[{name:task.target,position:'画面'+region}],focus:{status:'confirmed',region,fallback:'crop_only'}};
  return uncertain(subset,'整图理解未完成，放大候选也尚未核对相符，暂不能确认找到。','uncertain');
 }
 const fullResult=verified(whole.value,frame.request_id,task);
 // A failed optional crop must not discard a valid whole-frame observation.
 // Search still requires its second fresh cloud match; no confirmed box is drawn.
 if(detail.status==='rejected')return {...fullResult,memory_candidate:null,focus:{status:'unavailable',fallback:'whole_frame'}};
 const closeResult=verified(detail.value,focusId,task);
 if(closeResult.frame_status!=='clear')return uncertain(fullResult,'这次放大细节还不清楚，尚不能确认。请稍微拉远镜头，把物品主体拍完整。','uncertain');
 if([fullResult,closeResult].some(result=>['different','multiple'].includes(result.appearance_match?.status)))return uncertain(fullResult,'当前候选与记录外观不一致或有多个相近物品，尚未确认找到。','conflict');
 if(closeResult.target_visible===true&&(!task.reference_appearance||closeResult.appearance_match?.status==='match')){
  const objects=fullResult.frame_status==='clear'?fullResult.objects.filter(item=>item.name!==task.target):[];
  return {...fullResult,frame_status:'clear',answer:`放大核对后，在画面${region}看到了符合“${task.target}”描述的候选。`+(fullResult.frame_status==='clear'&&fullResult.target_visible===true?fullResult.answer:''),objects:[{name:task.target,position:'画面'+region},...objects].slice(0,5),target_visible:true,appearance_match:closeResult.appearance_match,memory_candidate:null,next_step:null,focus:{status:'confirmed',region}};
 }
 if(fullResult.target_visible===true||closeResult.target_visible!==false)return uncertain(fullResult,'整图与候选放大核对的结果不一致，暂不确认找到。请把物品稍微拉远、拍完整。','conflict');
 return fullResult.frame_status==='clear'?{...fullResult,target_visible:false,memory_candidate:null,focus:{status:'rejected'}}:uncertain(fullResult,'整图还未看清，放大候选也未确认，暂不判断物品是否在画面里。','uncertain');
}
export function perceptionNotice(status){
 return {verification_unavailable:'放大复核未完成，本轮使用整图继续核对。',disabled:'此浏览器或当前网址未启用 YOLO，当前用千问识别。',loading:'YOLO 正在加载，本轮先用千问。',ready:'YOLO 已就绪。',stable:'YOLO 已检出候选，正在放大核对。',confirmed:'YOLO 候选已由千问复核，继续用新画面确认。',not_confirmed:'YOLO 尚未稳定检出，当前用千问核对整图。',unsupported_target:'该物品不在 YOLO 类别中，当前用千问识别。',unavailable:'YOLO 暂不可用，当前用千问识别。',slow_device:'此设备本地识别较慢，当前用千问识别。',conflict:'外观或两幅图的结论不一致，尚未确认找到。',rejected:'放大候选与目标不符，正在继续寻找。',uncertain:'放大细节未看清，尚未确认找到。'}[status]||'';
}
