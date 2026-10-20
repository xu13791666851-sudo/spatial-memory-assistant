import {normalizeName,rememberCommand,VisualEvidenceError,MemoryPersistenceError} from './memory.mjs';

const clean=text=>String(text||'').trim().replace(/^(?:你好)?(?:小忆|小意|小易)[，,\s]*/,'').replace(/[。！？!?]+$/,'');
export function visualRememberIntent(text,focus=''){
  const value=clean(text);
  if(rememberCommand(value))return null;
  if(/^(?:请|帮我)?(?:记住|更新)(?:它|这个|那个)?(?:现在的)?位置(?:到这里)?$/.test(value)||/^(?:请|帮我)?更新到这里$/.test(value))return {name:focus};
  const match=value.match(/^(?:请|帮我)?记住[，,：:\s]*(.{1,60}?)(?:现在)?的位置$/);
  if(!match)return null;
  const name=normalizeName(match[1]);
  return {name:/^(它|这个|那个|物品|东西)$/.test(name)?focus:name};
}
export function searchTarget(text,focus=''){
  const value=clean(text).replace(/^(?:请|帮我)/,'');
  const match=value.match(/^(?:找(?:一下)?|寻找|看看)(.{1,60})$/)||value.match(/^(.{1,60}?)(?:现在)?(?:在哪里|在哪儿|在哪|放哪了)$/);
  if(!match)return '';
  let name=match[1].replace(/^(?:我)?(?:刚才|之前|上次|以前)(?:让你|请你|帮我)?(?:记住|记录)(?:的)?/,'').replace(/^(?:之前|上次|以前)(?:记录的)?/,'');
  name=normalizeName(name.replace(/(?:现在)?(?:具体)?$/,''));
  if(/^(周围|环境|眼前|画面|这里|什么|东西)$/.test(name))return '';
  return /^(它|这个|那个)$/.test(name)?focus:name;
}
export const searchFollowup=text=>/^(这样(?:呢|可以吗)?|这里(?:呢|没有|也没有)|那里没有|没(?:有)?(?:看见|看到|找到)|已经对准了?|对准了?|再看(?:一)?下|再看看|继续找|然后呢|现在呢|这边呢|那边呢)$/.test(clean(text));
const selection=text=>/^(?:是|要|记住)?(?:左边|右边|中间|最左边|最右边|前面|后面|靠近.{1,12}|旁边|蓝色|红色|绿色|透明)(?:的)?(?:那个|那只|那一个|杯子)?$/.test(clean(text));
const cancelled=text=>/^(?:不用找了|别找了|停止找物|取消|不用记了|不要记了|停止观察|关闭摄像头)$/.test(clean(text));

// Only an explicit user request opens a short-lived write authorization.
// Every observation carries that authorization's token; stale responses cannot save.
export class FindDialogue{
  constructor(memory,clock=()=>Date.now()){this.memory=memory;this.clock=clock;this.reset();}
  reset(){this.allowHistory=false;this.target='';this.objectId=null;this.saving=null;this.misses=0;this.choices=[];this.lastQuestion='';}
  focus(name){if(this.target!==name){this.misses=0;this.objectId=null;this.lastQuestion='';this.choices=[];}this.target=name;}
  summary(){return {target:this.target||null,object_id:this.objectId,missing_observations:this.misses,last_question:this.lastQuestion||null,awaiting_save_clarification:!!this.saving};}
  intent(text,place){
    if(this.saving&&this.saving.expires<=this.clock())this.saving=null;
    if(cancelled(text)){this.reset();return {kind:'cancel',answer:'好的，已停止这次寻找或记录。'};}
    const save=visualRememberIntent(text,this.target);
    if(save){
      this.saving=null;
      if(place!=='home')return {kind:'answer',answer:'请先切换到家中场景，再让我记住物品位置。'};
      if(!save.name)return {kind:'answer',answer:'你想让我记住哪件物品的位置？请说出物品名称。'};
      this.allowHistory=true;this.focus(save.name);this.saving={name:save.name,token:crypto.randomUUID(),expires:this.clock()+300000,selector:''};
      return this.observation();
    }
    if(this.saving&&(selection(text)||searchFollowup(text))){
      if(selection(text))this.saving.selector=clean(text);
      return this.observation();
    }
    // An unrelated utterance cancels permission; the model cannot keep it alive.
    this.saving=null;
    if(this.choices.length&&(selection(text)||clean(text).length<=40)){
      const value=clean(text),matches=this.choices.filter(r=>value.includes(r.name)||[r.name,r.location].some(s=>s.includes(value.replace(/^(?:是|要)/,'').replace(/(?:的)?(?:那个|那只|那一个)$/,''))));
      if(matches.length===1){this.choices=[];this.focus(matches[0].name);this.misses=1;this.objectId=matches[0].object_id||matches[0].id;return {kind:'answer',history:true,answer:this.memory.answer(matches[0].name)+' 可以把镜头对准记录的位置吗？'};}
    }
    const target=searchTarget(text,this.target);
    if(target){
      this.focus(target);
      const history=/(之前|上次|以前|记住|记录|放哪了)/.test(text);
      this.allowHistory=place==='home'||history;
      if(history||(place==='home'&&!/现在|眼前|画面/.test(text)&&!/^(?:请|帮我)?(?:找|寻找|看看)/.test(clean(text)))){
        const records=this.memory.find(target);this.choices=records.length>1?records:[];
        if(records.length===1){this.focus(records[0].name);this.objectId=records[0].object_id||records[0].id;this.misses=1;}
        const question=records.length===1?'可以把镜头对准记录的位置吗？':records.length===0?'你最后一次使用它是在什么地方？':'';
        this.lastQuestion=question;
        return {kind:'answer',history:records.length>0,answer:this.memory.answer(target)+(question?' '+question:'')};
      }
      return this.observation();
    }
    if(this.target&&searchFollowup(text))return this.observation();
    // A location clue is a conversational hint, never a write request or evidence.
    if(this.target&&/^(?:我)?(?:最后|刚才|可能|应该|好像|记得|在|放在|拿到)/.test(clean(text))){
      this.lastQuestion='可以把镜头对准你提到的位置，再说“这样呢”吗？';
      return {kind:'answer',answer:'我会把这作为这次寻找的线索，尚未确认。'+this.lastQuestion};
    }
    return null;
  }
  observation(){
    if(!this.saving&&this.allowHistory){const records=this.memory.find(this.target);if(records.length===1){this.target=records[0].name;this.objectId=records[0].object_id||records[0].id;}}
    const target=this.target,save=this.saving;
    return {kind:'observe',goal:`寻找${target}。${save?.selector?'用户选择：'+save.selector+'。':''}只描述当前可见证据。`,task:{target,allowHistory:this.allowHistory,saveToken:save?.token||null,selector:save?.selector||''}};
  }
  complete(task,result){
    if(!task||task.target!==this.target)return {answer:result.answer};
    if(task.saveToken){
      const pending=this.saving;
      if(!pending||pending.token!==task.saveToken||pending.expires<=this.clock()){this.saving=null;return {answer:'这次记录请求已取消或过期，没有保存。'};}
      const candidate=result.memory_candidate;
      if(result.target_visible===true&&candidate?.unique===true&&candidate.location_supported===true&&candidate.anchor&&candidate.location){
        let saved;
        try{saved=this.memory.saveVisual(pending.name,candidate,result.observedAt);}
        catch(error){
          if(error instanceof VisualEvidenceError){
            this.lastQuestion=`还没确认${pending.name}与参照物的位置关系。请把它和所在桌面或柜子一起拍清楚，再说“这样呢”。`;
            return {answer:'还没有保存。'+this.lastQuestion,saved:false};
          }
          this.saving=null;
          return {answer:error instanceof MemoryPersistenceError?`这次位置没有保存成功：浏览器未能读写物品记忆。你的“记住${pending.name}的位置”指令没有问题。请检查浏览器存储权限；如果在微信内打开，可以改用 Safari 后重新记录。`:`记录${pending.name}时发生了错误，这次未能确认保存成功。请稍后重试。`,saved:false};
        }
        this.saving=null;this.misses=0;this.objectId=saved.record.object_id||saved.record.id;
        return saved;
      }
      // Never relay a model's uncommitted "已记住" acknowledgement.
      const question=result.target_visible===false?'当前画面没有看到目标，请把镜头对准它，再说“这样呢”。':candidate?.unique===false?'画面中无法唯一确定目标。你指的是哪一个？可以说“左边那个”，或把镜头靠近目标。':'还没有看清物品和稳定的位置参照，请把物品及所在桌面、柜子一起拍进来，再说“这样呢”。';
      this.lastQuestion=question;
      return {answer:'还没有保存。'+question,saved:false};
    }
    if(result.target_visible===true){this.misses=0;this.lastQuestion='';return {answer:`当前画面中看到了符合“${this.target}”描述的物品。${result.answer} 外观相似还不能确认是同一件。`};}
    if(result.target_visible!==false)return {answer:result.answer+' 请把目标区域拍清楚，再说“这样呢”。'};
    this.misses++;
    const matches=task.allowHistory?this.memory.find(this.target):[],saved=matches.length===1?matches[0]:null;
    let answer=result.answer;
    if(this.misses===1&&saved){
      this.objectId=saved.object_id||saved.id;answer+=` 你上次记录${saved.name}在${saved.location}，但我现在还没看到，不能确认仍在那里。`;
      this.lastQuestion='可以把镜头对准这个位置吗？';
    }else if(this.misses===1&&matches.length>1){this.choices=matches;this.lastQuestion=this.memory.answer(this.target);}
    else if(result.next_step?.kind==='reframe'&&result.next_step.anchor&&result.next_step.question&&result.next_step.question!==this.lastQuestion){this.lastQuestion=result.next_step.question;}
    else this.lastQuestion=saved?'那里暂时没找到。你后来有没有把它拿到其他地方？':'你最后一次使用它是在什么地方？';
    return {answer:answer+' '+this.lastQuestion};
  }
}
