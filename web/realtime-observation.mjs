import {PERSON_CONTEXT_RULES} from './person-context.mjs';

// Evidence is model output, never authority to save. The caller owns consent,
// scene identity, cancellation, and the actual storage transaction.
export function validateObservation(result,task=null){
  if(!result||typeof result.answer!=='string'||!result.answer.trim()||result.answer.length>1600)throw Error('实时模型没有返回完整的画面描述，请重新观察。');
  const objects=Array.isArray(result.objects)?result.objects.filter(o=>typeof o?.name==='string'&&typeof o?.position==='string'&&o.name.length<100&&o.position.length<500).slice(0,5):[];
  const short=(v,n)=>typeof v==='string'&&v.trim()&&v.length<=n&&!/[\x00-\x1f]/.test(v);
  const knownAnchor=v=>short(v,60)&&objects.some(o=>o.name===v)&&!/^(?:画面|这里|那里|左边|右边|上方|下方|镜头)$/.test(v);
  const raw=result.memory_candidate,step=result.next_step;
  return {answer:result.answer.trim(),objects,target_visible:typeof result.target_visible==='boolean'?result.target_visible:null,
    memory_candidate:task?.remember&&raw&&typeof raw.unique==='boolean'?{unique:raw.unique,location_supported:raw.location_supported===true&&!!knownAnchor(raw.anchor)&&!!short(raw.location,120),anchor:knownAnchor(raw.anchor)?raw.anchor:'',location:short(raw.location,120)?raw.location:''}:null,
    next_step:task&&step?.kind==='reframe'&&knownAnchor(step.anchor)&&short(step.question,100)?{kind:'reframe',anchor:step.anchor,question:step.question}:null};
}
const str={type:'string'},bool={type:'boolean'};
export const observationTool={type:'function',function:{name:'report_observation',description:'只提交本次实时视频的可见证据，不能保存记忆。',parameters:{type:'object',properties:{
  observation_id:str,frame_status:{type:'string',enum:['clear','uncertain']},answer:str,objects:{type:'array',items:{type:'object',properties:{name:str,position:str},required:['name','position']}},
  target_visible:bool,memory_candidate:{type:'object',properties:{unique:bool,location_supported:bool,anchor:str,location:str}},
  next_step:{type:'object',properties:{kind:{type:'string',enum:['reframe']},anchor:str,question:str}}
},required:['observation_id','frame_status','answer','objects'],additionalProperties:false}}};

