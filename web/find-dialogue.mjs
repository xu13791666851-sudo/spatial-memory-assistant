import {normalizeName,sameType,rememberCommand,requestText,appearanceText,VisualEvidenceError,MemoryPersistenceError} from './memory.mjs';
import {asksHistory} from './interaction.mjs';
import {identifiedObjectName} from './realtime-observation.mjs';

const clean=text=>String(text||'').trim().replace(/^(?:你好)?(?:小忆|小意|小易)[，,\s]*/,'').replace(/[。！？!?]+$/,'');
const pronoun=name=>/^(?:我|它|他|她|这个|那个|这件|那件|物品|东西|这个物品|那个东西)?$/.test(name);
export const asksCurrentView=text=>!asksHistory(text)&&/(?:现在|当前|眼前|画面|镜头|这里|这边|再看|拍到|照到|对准)/.test(text);
// Parse the location question before the generic “看看…” search command. Scan
// every clause: conversational preambles must not hide the actual query.
export function locationQuery(text,focus=''){
  const clauses=clean(text).split(/[，,；;。！？!?]|(?=(?:你)?帮我)/).filter(Boolean);
  let implicit=null;
  for(const clause of clauses){
    const lost=clause.trim().match(/^(?:我)?(?:现在)?(?:找不到|找不着)(?:我的|我)?(.+?)(?:了)?$/);
    if(lost){
      const name=normalizeName(lost[1]);
      if(pronoun(name)){implicit={target:focus,implicit:true};continue;}
      if(name.length<=60)return {target:name,implicit:false};
    }
    let value=requestText(clause.trim())
      .replace(/^(?:我)?(?:现在)?(?:想要|想|需要|要)(?:知道|查一下|查询|问一下|问问)/,'')
      .replace(/^(?:你)?(?:还)?(?:记不记得|记得)/,'')
      .replace(/^(?:我)?(?:不记得|记不得|记不清|想不起来|忘记了?|忘了)/,'')
      .replace(/^(?:查(?:看|询)?(?:一下)?|看看|看一下|告诉我|说一下)/,'');
    const match=value.match(/^(.*?)(?:放(?:在|到)?(?:了)?(?:哪里|哪儿|哪)|在(?:哪里|哪儿|哪)|(?:的)?(?:具体)?位置)(?:了|呢|吗|呀|啊|来着|在哪里|在哪儿|在哪)*$/)
      ||value.match(/^(?:我)?(?:把)?(.*?)(?:放哪了)$/);
    if(!match)continue;
    let name=match[1]
      .replace(/^(?:(?:我)?(?:刚才|刚刚|之前|上次|以前|昨天)(?:让你|请你|帮我)?(?:记住|记录)(?:的)?)/,'')
      .replace(/^(?:(?:我的|我|把)|(?:刚才|刚刚|之前|上次|以前|昨天|现在)(?:记录的)?)+/,'')
      .replace(/(?:刚才|刚刚|之前|上次|以前|昨天|现在|的)+$/,'');
    name=normalizeName(name);
    if(pronoun(name)){implicit={target:focus,implicit:true};continue;}
    // Do not turn a whole unparsed sentence into a supposedly missing item.
    if(name.length<=60&&!/(?:哪里|在哪|帮我|记得|知道|告诉|看看|找|需要|想要)/.test(name))return {target:name,implicit:false};
  }
  return implicit;
}
export function visualRememberIntent(text,focus=''){
  let value=requestText(clean(text));
  if(rememberCommand(value))return null;
  value=value.replace(/^((?:重新|再次|再)?(?:记住|更新|保存|记录))[，,]\s*/,'$1');
  const clauses=value.split(/[，,；;。]/).map(s=>s.trim()).filter(Boolean);
  if(clauses.length>1){
    // Only a direct placement preamble can precede the save request.
    const moved=clauses[0].match(/^(?:我)?(?:已经|刚刚|刚才|现在)?(?:把|将)(.{1,60}?)(?:移动|移到|挪|放到|放在|换)/);
    if(clauses.length!==2||!moved)return null;
    const named=normalizeName(moved[1]);
    if(!pronoun(named))focus=named;
    value=requestText(clauses[1]);
  }
  if(rememberCommand(value))return null;
  value=value.replace(/^(?:重新|再次|再)(?=记住|更新|保存|记录)/,'');
  if(/^更新到这里$/.test(value))return {name:focus,...(focus==='所指物品'?{identify:true}:{})};
  const match=value.match(/^(?:记住|更新|保存|记录)(?:一下)?[：:\s]*(.{0,60}?)(?:的)?(?:具体)?位置(?:到这里)?$/)
    ||value.match(/^把(.{1,60}?)(?:的)?位置更新到这里$/)
    ||value.match(/^(?:记住|保存|记录)(?:一下)?(.{1,60})$/);
  if(!match)return /^记住/.test(value)?{name:''}:null;
  const name=normalizeName(match[1].replace(/^(?:之前|上次|刚才)(?:保存|记住|记录)的/,'').replace(/(?:(?:现在|当前|最新|新|移动后|移动之后)(?:的)?|的)+$/,''));
  if(/^(?:这个|那个|这件|那件|这只|那只|物品|东西|物体|目标)$/.test(name)||/^(?:这个|那个|这件|那件)(?:物品|东西|物体)?$/.test(match[1])){
    if(!/^(?:之前|上次|刚才)(?:保存|记住|记录)的/.test(match[1]))return {name:'所指物品',identify:true};
  }
  if(/(?:的)?(?:那个|那件|这个|这件)(?:东西|物品)?$/.test(name))return {name:'所指物品',identify:true,selector:name};
  const target=pronoun(name)?focus:focus&&sameType(focus,name)&&focus.length>=name.length?focus:name;
  return {name:target,...(target==='所指物品'?{identify:true}:{})};
}
export function searchRequestText(text){
  return requestText(clean(text)).replace(/^(?:(?:你|请|麻烦你?|帮我|给我|能不能|可不可以|再|重新|再次|开始|持续))+(?=找|寻找)/,'');
}
export function searchTarget(text,focus=''){
  const location=locationQuery(text,focus);
  if(location)return location.target;
  // A spoken request can include a second clause explaining how to look.
  const value=searchRequestText(text).split(/[，,；;。]/)[0]
    .replace(/^我(?:现在)?(?:需要|想要|想)(?:要)?/,'');
  const match=value.match(/^(?:找(?:到|一下)?|寻找|看看)(.{1,60})$/)
    ||value.match(/^(.{1,60}?)(?:现在)?(?:具体)?(?:在哪里|在哪儿|在哪|放哪了)$/)
    ||value.match(/^(?:现在|这次)(?:没)?(?:也|还|还是)?(?:没有|没看到|没看见|没找到)(.{1,60}?)(?:吗|呢)$/)
    ||value.match(/^(?:现在)?(?:画面里|画面中|这里|这边)(?:有没有|能不能看到|能看到|有)(.{1,60}?)(?:吗|呢)?$/);
  if(!match)return '';
  let name=match[1].replace(/^(?:我)?(?:刚才|之前|上次|以前)(?:让你|请你|帮我)?(?:记住|记录)(?:的)?/,'').replace(/^(?:之前|上次|以前)(?:记录的)?/,'');
  name=normalizeName(name.replace(/^[它他她](?=这个|那个)/,'').replace(/(?:的)?(?:具体)?位置$/,'').replace(/(?:现在)?(?:具体)?$/,''));
  if(/^(周围|环境|眼前|画面|这里|什么|东西)$/.test(name))return '';
  if(focus&&/(?:这个|那个|这只|那只)/.test(match[1])&&focus.length>=name.length&&sameType(focus,name))return focus;
  return pronoun(name)?focus:name;
}
export const searchFollowup=text=>{
  const value=requestText(clean(text)).replace(/\s/g,'');
  return /^(这样(?:呢|可以吗)?|这里(?:呢|没有|也没有)|那里没有|没(?:有)?(?:看见|看到|找到)|已经对准了?|对准了?|再看(?:一)?下|再看看|继续找|然后呢|现在呢|这边呢|那边呢)$/.test(value)
    ||/^(?:现在|这次|画面里|画面中)(?:没)?(?:也|还|还是)?(?:没有|没看到|没看见|没找到)(?:了)?(?:吗|么|呢)?$/.test(value)
    ||/^(?:现在|这次)?(?:看见|看到|找到)(?:了)?(?:它|他|她)?(?:了)?(?:吗|没有)$/.test(value)
    ||/^(?:看(?:一)?下|看看)?(?:这个)?(?:画面里|画面中|镜头里)(?:有|有没有)(?:了)?(?:吗|呢)?$/.test(value)
    ||/^(?:我)?(?:已经)?把(?:摄像头|镜头)对准(?:它|他|她|这个|那个)?(?:了)?$/.test(value)
    ||/^(?:我)?(?:都|已经|现在)?(?:把)?(?:摄像头|镜头)?(?:对准|靠近|贴近|怼到).{0,40}(?:了|呢)$/.test(value);
};
const selection=text=>!/(?:不要|不用|别|取消|为什么|他说|我说)/.test(clean(text))&&(/^(?:是|要|记住)?(?:左边|右边|中间|最左边|最右边|前面|后面|靠近.{1,12}|旁边)(?:的)?(?:那个|那只|那一个)?(?:.{1,20})?$/.test(clean(text))||/^(?:是|要|记住)?[^，。！？]{1,30}(?:的)?(?:那个|那只|那一个|这件|那件)$/.test(clean(text))||/^(?:是|要|记住)?[^，。！？]{1,8}色(?:的)?(?:那个|那只|那一个)$/.test(clean(text)));
const cancelled=text=>/^(?:我找到了|找到了|不用找了|别找了|停止找物|取消|不用记了|不要记了|停止观察|关闭摄像头)$/.test(clean(text));

// Only an explicit user request opens a short-lived write authorization.
// Every observation carries that authorization's token; stale responses cannot save.
export class FindDialogue{
  constructor(memory,clock=()=>Date.now()){this.memory=memory;this.clock=clock;this.reset();}
  reset(){this.allowHistory=false;this.target='';this.objectId=null;this.saving=null;this.misses=0;this.choices=[];this.lastQuestion='';}
  focus(name){if(this.target!==name){this.misses=0;this.objectId=null;this.lastQuestion='';this.choices=[];}this.target=name;}
  summary(){return {target:this.target||null,object_id:this.objectId,missing_observations:this.misses,last_question:this.lastQuestion||null,awaiting_save_clarification:!!this.saving};}
  intent(text,place){
    if(this.saving&&this.saving.expires<=this.clock())this.saving=null;
    if(cancelled(text)){
      if(/^(?:我)?找到了$/.test(clean(text))){this.saving=null;this.choices=[];this.misses=0;}
      else this.reset();
      return {kind:'cancel',answer:'好的，已停止这次寻找或记录。'};
    }
    const save=visualRememberIntent(text,this.target);
    if(save){
      this.saving=null;
      if(place!=='home')return {kind:'answer',answer:'请先切换到家中场景，再让我记住物品位置。'};
      if(!save.name)return {kind:'answer',answer:'你想让我记住哪件物品的位置？请说出物品名称。'};
      this.allowHistory=true;this.focus(save.name);this.saving={name:save.name,identify:!!save.identify,token:crypto.randomUUID(),expires:this.clock()+300000,selector:save.selector||''};
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
    const history=asksHistory(text);
    const query=locationQuery(text,this.target||((place==='home'||history)?this.memory.last:''));
    if(query?.implicit&&!query.target){
      const records=history||place==='home'?this.memory.all():[];
      if(records.length===1)query.target=records[0].name;
      else return {kind:'answer',answer:records.length?'你想查哪件物品上次的位置？已记录：'+records.map(r=>r.name).join('、')+'。':'你想找哪件物品？请说一下物品名称。'};
    }
    const target=query?.target||searchTarget(text,this.target);
    if(target){
      this.focus(target);
      this.allowHistory=place==='home'||history||!!this.objectId;
      if(history||(place==='home'&&!asksCurrentView(text)&&(query||this.memory.find(target).length))){
        const records=this.memory.find(target);this.choices=records.length>1?records:[];
        if(records.length===1){if(records[0].name.length>=target.length)this.focus(records[0].name);this.objectId=records[0].object_id||records[0].id;this.misses=1;}
        const question=records.length===1?'需要确认现在是否还在那里时，可以把镜头对准记录的位置，再说“这样呢”。':records.length===0?'你最后一次使用它是在什么地方？':'';
        this.lastQuestion=question;
        return {kind:'answer',history:records.length>0,answer:this.memory.answer(target)+(question?' '+question:'')};
      }
      return this.observation();
    }
    if(searchFollowup(text)){
      if(this.target)return this.observation();
      if(/^(?:再看(?:一)?下|再看看)$/.test(requestText(clean(text))))return null;
      return {kind:'answer',answer:'你想让我重新确认哪件物品？请说一下物品名称。'};
    }
    // A location clue is a conversational hint, never a write request or evidence.
    if(this.target&&/^(?:我)?(?:最后|刚才|可能|应该|好像|记得|在|放在|拿到)/.test(clean(text))){
      this.lastQuestion='可以把镜头对准你提到的位置，再说“这样呢”吗？';
      return {kind:'answer',answer:'我会把这作为这次寻找的线索，尚未确认。'+this.lastQuestion};
    }
    return null;
  }
  observation(){
    let reference_appearance='';
    if(!this.saving&&this.allowHistory){const records=this.memory.find(this.target);if(records.length===1){if(records[0].name.length>=this.target.length)this.target=records[0].name;this.objectId=records[0].object_id||records[0].id;reference_appearance=appearanceText(records[0].appearance);}}
    const target=this.target,save=this.saving;
    return {kind:'observe',goal:`${save?.identify?'识别用户在画面中所指的物品，不沿用上一个物品名称':'寻找'+target}。${save?.selector?'用户选择：'+save.selector+'。':''}只描述当前可见证据。`,task:{target,allowHistory:this.allowHistory,saveToken:save?.token||null,selector:save?.selector||'',reference_appearance,...(save?.identify?{identify:true}:{})}};
  }
  complete(task,result){
    if(!task||task.target!==this.target)return {answer:result.answer};
    if(task.saveToken){
      const pending=this.saving;
      if(!pending||pending.token!==task.saveToken||pending.expires<=this.clock()){this.saving=null;return {answer:'这次记录请求已取消或过期，没有保存。'};}
      const candidate=result.memory_candidate;
      const name=pending.identify?identifiedObjectName(candidate,result.objects):pending.name;
      if(pending.identify&&!name){
        this.lastQuestion='请把要记住的物品靠近镜头或指给我看，也可以说“右边那个”或描述它的外观。';
        return {answer:'还没有保存：尚未唯一确定你指的物品。'+this.lastQuestion,saved:false};
      }
      if(result.target_visible===true&&candidate?.unique===true&&candidate.location_supported===true&&candidate.anchor&&candidate.location){
        let saved;
        try{saved=this.memory.saveVisual(name,candidate,result.observedAt);}
        catch(error){
          if(error instanceof VisualEvidenceError){
            this.lastQuestion=`还没确认${pending.name}与参照物的位置关系。请把它和所在桌面或柜子一起拍清楚，再说“这样呢”。`;
            return {answer:'还没有保存。'+this.lastQuestion,saved:false};
          }
          this.saving=null;
          return {answer:error instanceof MemoryPersistenceError?`这次位置没有保存成功：浏览器未能读写物品记忆。你的“记住${pending.name}的位置”指令没有问题。请检查浏览器存储权限；如果在微信内打开，可以改用 Safari 后重新记录。`:`记录${pending.name}时发生了错误，这次未能确认保存成功。请稍后重试。`,saved:false};
        }
        this.saving=null;this.focus(saved.record.name);this.misses=0;this.objectId=saved.record.object_id||saved.record.id;
        return saved;
      }
      // Never relay a model's uncommitted "已记住" acknowledgement.
      const question=result.target_visible===false?'当前画面没有看到目标，请把镜头对准它，再说“这样呢”。':candidate?.unique===false?'画面中无法唯一确定目标。你指的是哪一个？可以说“左边那个”，或把镜头靠近目标。':'还没有看清物品和稳定的位置参照，请把物品及所在桌面、柜子一起拍进来，再说“这样呢”。';
      this.lastQuestion=question;
      return {answer:'还没有保存。'+question,saved:false};
    }
    const comparison=appearanceText(task.reference_appearance)?result.appearance_match:null;
    if(comparison?.status==='different')return {answer:`眼前物品与保存的外观不一致：${comparison.reason} 请再看看其他位置。`};
    if(comparison?.status==='multiple')return {answer:`画面中有多件相近的物品：${comparison.reason} 请把要找的物品单独拍清楚，再说“这样呢”。`};
    if(comparison?.status==='uncertain')return {answer:`${comparison.reason} 请把相关细节拍清楚，再说“这样呢”。`};
    if(result.target_visible===true){
      this.misses=0;this.lastQuestion='';
      if(comparison?.status==='match')return {answer:`找到了${this.target}，外观与记录相符。${result.answer}`};
      return {answer:`当前画面中看到了符合“${this.target}”描述的物品。${result.answer}`};
    }
    if(result.target_visible!==false)return {answer:result.answer+' 请把目标区域拍清楚，再说“这样呢”。'};
    this.misses++;
    const matches=task.allowHistory?this.memory.find(this.target):[],saved=matches.length===1?matches[0]:null;
    // A model's free-form miss may guess drawers or occluded locations.
    // Compose this answer from the actual saved record and validated framing hint.
    let answer=`当前画面没有看到${this.target}。`;
    if(saved){this.objectId=saved.object_id||saved.id;answer=`你上次记录${saved.name}在${saved.location}。${answer}还不能确认现在是否仍在那里。`;}
    if(matches.length>1){this.choices=matches;this.lastQuestion=this.memory.answer(this.target);}
    else if(result.next_step?.kind==='reframe'&&result.next_step.anchor&&result.next_step.question&&result.next_step.question!==this.lastQuestion){this.lastQuestion=result.next_step.question;}
    else this.lastQuestion=saved?(this.misses>1?'你后来有没有把它拿到其他地方？':'可以把镜头对准记录的位置吗？'):'你最后一次使用它是在什么地方？';
    return {answer:answer+' '+this.lastQuestion};
  }
}
