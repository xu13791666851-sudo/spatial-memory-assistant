import {visualCandidateProblem,appearanceText} from './memory.mjs';

// Evidence is model output, never authority to save. The caller owns consent,
// scene identity, cancellation, and the actual storage transaction.
export function validateObservation(result,task=null){
  if(!result||typeof result.answer!=='string'||!result.answer.trim()||result.answer.length>1600)throw Error('实时模型没有返回完整的画面描述，请重新观察。');
  const objects=Array.isArray(result.objects)?result.objects.filter(o=>typeof o?.name==='string'&&typeof o?.position==='string'&&o.name.length<100&&o.position.length<500).slice(0,5):[];
  const short=(v,n)=>typeof v==='string'&&v.trim()&&v.length<=n&&!/[\x00-\x1f]/.test(v);
  const knownAnchor=v=>short(v,60)&&objects.some(o=>o.name===v)&&!/^(?:画面|这里|那里|左边|右边|上方|下方|镜头)$/.test(v);
  const raw=result.memory_candidate,step=result.next_step,comparison=result.appearance_match;
  let appearance_match=null;
  if(appearanceText(task?.reference_appearance)&&comparison&&['match','different','uncertain','multiple'].includes(comparison.status)){
    const reason=short(comparison.reason,200)?comparison.reason.trim():'';
    const verified=comparison.status==='match'&&result.target_visible===true&&comparison.unique===true&&!!reason;
    appearance_match={status:comparison.status==='match'&&!verified?'uncertain':comparison.status,unique:comparison.unique===true,reason:reason||'还没看清可核对的外观细节。'};
  }
  return {answer:result.answer.trim(),objects,target_visible:typeof result.target_visible==='boolean'?result.target_visible:null,
    appearance_match,
    memory_candidate:task?.remember&&raw&&typeof raw.unique==='boolean'?{unique:raw.unique,location_supported:!visualCandidateProblem(raw)&&!!knownAnchor(raw.anchor)&&!!short(raw.location,120),anchor:knownAnchor(raw.anchor)?raw.anchor:'',location:short(raw.location,120)?raw.location:'',appearance:appearanceText(raw.appearance)}:null,
    next_step:task&&step?.kind==='reframe'&&knownAnchor(step.anchor)&&short(step.question,100)?{kind:'reframe',anchor:step.anchor,question:step.question}:null};
}
const str={type:'string'},bool={type:'boolean'};
export const observationTool={type:'function',function:{name:'report_observation',description:'只提交本次实时视频的可见证据，不能保存记忆。',parameters:{type:'object',properties:{
  observation_id:str,frame_status:{type:'string',enum:['clear','uncertain']},answer:str,objects:{type:'array',items:{type:'object',properties:{name:str,position:str},required:['name','position']}},
  target_visible:bool,memory_candidate:{type:'object',properties:{unique:bool,location_supported:bool,appearance:{type:'string',description:'150字以内，只记录目标实际可见的颜色、形状、杯盖/把手/图案等区分特征；不包含位置或周围物品，不从目标名称猜测，看不清则为空字符串'},anchor:{type:'string',description:'稳定参照物名称，与objects中的name完全相同'},location:{type:'string',description:'目标在承载面及参照物附近的位置，必须包含完整anchor原文；如anchor为笔记本电脑，则不能缩写成电脑'}},required:['unique','location_supported','anchor','location','appearance']},
  appearance_match:{type:'object',properties:{status:{type:'string',enum:['match','different','uncertain','multiple']},unique:bool,reason:{type:'string',description:'200字以内，说明本次实际看见的特征如何与reference_appearance一致、冲突或哪些细节被遮挡；不得用历史位置证明匹配'}},required:['status','unique','reason']},
  next_step:{type:'object',properties:{kind:{type:'string',enum:['reframe']},anchor:str,question:str}}
},required:['observation_id','frame_status','answer','objects'],additionalProperties:false}}};

