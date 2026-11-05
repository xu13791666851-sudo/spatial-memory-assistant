import {check} from './util.mjs';
import {validBox} from './providers.mjs';
import {pythonJson} from './archive.mjs';
import {validateSemantic} from './intent.mjs';
import {OmniRealtime,OMNI_MODEL} from './omni-realtime.mjs';
export {OMNI_MODEL};
const claims=/已(?:经)?(?:记住|保存)|保存成功|记住了|我记得/;
const json=raw=>{try{return JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1'));}catch{throw Error('omni_json_invalid');}};
export class OmniProviders {
 constructor({client=new OmniRealtime(),intentClient=new OmniRealtime({timeoutMs:4000}),now=Date.now,prepare=async(current,reference)=>Buffer.from((await pythonJson('../python/omni-image.py',
  {current:current.toString('base64'),reference:reference?.toString('base64')},{limit:400000,timeout:3000})).jpeg,'base64')}={}) {
  Object.assign(this,{client,intentClient,now,prepare,singlePassMemory:true,trackCandidates:true,failures:0,retryAt:0});
  this.intent=this.interpret.bind(this);
 }
 async interpret(raw,focus,names) {
  const prompt='你是找物助手的意图理解器。只返回JSON：{"action":"...","target":"物品名","answer":"普通问答或澄清，最多100字"}。action选find(现在找)、remember(记住)、history(上次位置)、check(是否记住)、appearance(已存外观)、describe(当前画面)、continue、cancel、complete、chat、clarify、ignore。指代用focus。你看不到相机、没有物品记录，禁止编造眼前内容、保存成功或物品位置；分流到相应action。数据：'+JSON.stringify({raw,focus,names:names.slice(0,40)});
  const parsed=validateSemantic(json(await this.intentClient.request(prompt,null)),raw,focus);
  // Non-chat answers are discarded; only the selected application operation may speak.
  if(parsed&&!['chat','clarify'].includes(parsed.action))delete parsed.answer;
  return parsed;
 }
 async describe(frame,target,question,signal) {
  const prompt='只分析本轮图片。禁止宣称保存成功或编造不可见位置。只返回JSON：'+(target?
   '{"f":画面编号,"v":目标是否明确可见,"d":"外观特征最多30字","l":"可见相对位置最多30字或空字符串","a":"参照物或空字符串","b":[左,上,右,下]}。框为相对整张图0到1坐标，无法框选用null；多件不明确时v=false。':
   '{"f":画面编号,"v":true,"answer":"针对问题自然回答，最多100字"}。')+'请求数据：'+JSON.stringify({frame_id:frame.frameId,target,question});
  const image=await this.prepare(frame.jpeg);if(signal?.aborted)throw Error('operation_cancelled');
  const r=json(await this.client.request(prompt,image,signal));
  check(r.f===frame.frameId&&Number.isSafeInteger(r.f)&&typeof r.v==='boolean','omni_frame_invalid');
  if(target){for(const [k,max]of [['d',80],['l',100],['a',40]])check(typeof r[k]==='string'&&r[k].length<=max&&!claims.test(r[k]),'omni_output_invalid');r.b=validBox(r.b)?r.b:null;}
  else check(typeof r.answer==='string'&&r.answer.length<=280&&!claims.test(r.answer),'omni_output_invalid');
  return r;
 }
 async review(frame,{target,description='',crop=null,references=[],features=''},signal) {
  check(this.now()>=this.retryAt,'omni_review_cooldown');if(signal?.aborted)throw Error('operation_cancelled');
  const reference=references.at(-1);
  const prompt=(reference?'本轮图片左栏CURRENT是当前'+(crop?'唯一候选裁图':'场景')+'，右栏HISTORICAL REFERENCE是历史参考。历史参考不能证明当前存在。':'本轮图片是当前'+(crop?'候选裁图':'场景')+'，没有历史参考。')+
   '只返回JSON：{"f":画面编号,"visible":布尔,"clear":布尔,"distinctive":是否有类别颜色以外的独特个体细节,"same":"MATCH或DIFFERENT或UNCERTAIN","evidence":"最多30字的可见依据"}。'+
   '有历史参考时，必须比较同一件物品的独特标记或细节；只有类别颜色相同、同款无可辨特征、模糊遮挡或多件歧义都返回UNCERTAIN。MATCH需要具体可见依据，不得编造位置、置信度或保存结果。请求数据：'+JSON.stringify({frame_id:frame.frameId,target,description,features});
  try {
   const image=await this.prepare(crop??frame.jpeg,reference);
   const raw=await this.client.request(prompt,image,signal);
   const result=parseOmniReview(raw,frame.frameId,!!reference);this.failures=0;this.retryAt=0;return result;
  }catch(error){if(!signal?.aborted&&++this.failures>=3)this.retryAt=this.now()+15000;throw error;}
 }
 reset(){this.client.reset();this.intentClient.reset();this.failures=0;this.retryAt=0;}
 close(){this.client.close();this.intentClient.close();}
}
export function parseOmniReview(raw,frameId,personal) {
 const r=json(raw);
 check(r.f===frameId&&Number.isSafeInteger(r.f),'omni_frame_invalid');
 check(typeof r.visible==='boolean'&&typeof r.clear==='boolean'&&typeof r.distinctive==='boolean'&&['MATCH','DIFFERENT','UNCERTAIN'].includes(r.same)&&typeof r.evidence==='string'&&r.evidence.length<=120&&!claims.test(r.evidence),'omni_output_invalid');
 const decision=r.clear&&r.visible&&r.same==='MATCH'&&(!personal||r.distinctive)&&r.evidence.trim()?'CONFIRM':r.clear&&(!r.visible||personal&&r.same==='DIFFERENT')?'REJECT':'UNCERTAIN';
 return {decision,evidence:r.evidence,provider:'omni',referenceCompared:personal};
}
