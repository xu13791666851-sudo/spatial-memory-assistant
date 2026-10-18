import {nameSimilarity} from './memory.mjs';
import {details} from './spatial-record.mjs';
export function visualTarget(record){
  const d=details(record);return record?{name:record.name,appearance:d.appearance,aliases:d.aliases}:null;
}
export function groundTarget(result,target){
  if(!target)return result;
  const labels=[target.name,...(target.aliases||[])];
  const colors=s=>new Set(String(s||'').match(/红色|蓝色|绿色|白色|黑色|灰色|黄色|紫色|粉色|棕色|橙色|透明/g)||[]);
  const expected=colors(target.name+' '+target.appearance);
  const candidates=(result.objects||[]).filter(o=>{
    const observed=colors(o.name+' '+o.appearance);
    if(expected.size&&observed.size&&![...expected].some(c=>observed.has(c)))return false;
    return labels.some(label=>Math.max(nameSimilarity(label,o.name),...(o.aliases||[]).map(a=>nameSimilarity(label,a)))>=60);
  });
  if(candidates.length&&(result.target_visible===false||candidates.length>1))return {...result,target_visible:null,target_status:'candidate',answer:`画面里有${candidates.slice(0,3).map(o=>o.name+(o.position?'，在'+o.position:'')).join('；')}。${candidates.length===1?'这是你记住的“'+target.name+'”吗？':'还不能确认哪一个是你记住的“'+target.name+'”，可以再描述一个特征吗？'}`};
  if(result.target_visible===false)return {...result,target_status:'unconfirmed',answer:`这次识别还没有确认到“${target.name}”，不代表它不在这里。可以把镜头靠近目标区域再看一下。`};
  return {...result,target_status:result.target_visible===true?'visible':'uncertain'};
}
