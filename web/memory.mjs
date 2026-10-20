const clean=(value,max=120)=>{
  if(typeof value!=='string')throw Error('请提供有效的名称或位置。');
  value=value.trim().replace(/^[，。！？!?,\s]+|[，。！？!?,\s]+$/g,'');
  if(!value||value.length>max||/[\x00-\x1f]/.test(value))throw Error('请提供简短、有效的名称或位置。');
  return value;
};
export const normalizeName=value=>String(value||'').trim().replace(/[，。！？!?,]+$/,'').replace(/^(?:这个|那个|这只|那只|这一个|那一个|一个|一只)(?:的)?/,'').trim();
export const appearanceText=value=>typeof value==='string'&&value.trim().length<=150&&!/[\x00-\x1f]/.test(value)?value.trim():'';
const canonical=value=>normalizeName(value).replace(/^我的/,'').replace(/玻璃杯|水杯/g,'杯子').replace(/杯$/,'杯子').replace(/的/g,'');
export const sameType=(a,b)=>{
  a=canonical(a);b=canonical(b);
  return !!a&&!!b&&(a===b||a.endsWith(b)||b.endsWith(a));
};
// Remove only direct request prefixes, never negation or reported speech.
export const requestText=text=>String(text||'').trim().replace(/^(?:你好)?(?:小忆|小意|小易)[，,\s]*/,'').replace(/^(?:(?:请|麻烦)(?:你)?|你(?:能不能|可以)?(?:帮我|给我)|帮我|给我|你(?=记住|更新|找|看))+/,'').trim();
export function rememberCommand(text){
  const value=requestText(text);
  if(/(?:现在)?的(?:具体)?位置$/.test(value.replace(/[。！!]+$/,''))&&!/放在/.test(value))return null;
  const match=value.match(/^(?:记住|请记住|帮我记住)[，,：:\s]*(?:我)?(?:(昨天|刚刚|刚才|今天)[，,\s]*)?(?:把)?(.+?)(?:刚放在|放在|在)(.+?)[。！!]?$/);
  return match?{action:'record',name:match[2],location:match[3],event_time:match[1]||'时间未说明'}:null;
}
// Shared by provider validation and local persistence: a result cannot pass
// observation validation and then fail the same location rule at save time.
export function visualCandidateProblem(candidate){
  try{
    const location=clean(candidate?.location),anchor=clean(candidate?.anchor,60);
    if(candidate.unique!==true||candidate.location_supported!==true)return 'unsupported';
    if(/^(?:画面|这里|那里|镜头)$/.test(anchor)||/^(?:画面)?(?:左|右|上|下|前|后)(?:边|侧|面|方)?$/.test(anchor))return 'unstable_anchor';
    if(!location.includes(anchor))return 'missing_anchor_reference';
    return null;
  }catch{return 'invalid_location';}
}
export class VisualEvidenceError extends Error{}
export class MemoryPersistenceError extends Error{}
export class Memory {
  constructor(storage,clock=()=>Date.now(),uuid=()=>crypto.randomUUID()){
    this.storage=storage;this.clock=clock;this.uuid=uuid;this.pending=null;this.last='';this.key='spatial-memory.records.v1';
  }
  rows(){
    const raw=JSON.parse(this.storage.getItem(this.key)||'[]');
    if(!Array.isArray(raw))throw Error('本机记录无法读取，请先检查浏览器数据。');
    return raw.filter(r=>r&&typeof r.name==='string'&&typeof r.location==='string'&&typeof r.recorded_at==='string'&&['MANUAL','USER_REQUESTED_VISUAL'].includes(r.source)&&r.state==='HISTORICAL'&&(!r.place||r.place==='home'));
  }
  all(){const map=new Map();for(const r of this.rows())map.set(normalizeName(r.name),r);return [...map.values()].reverse();}
  find(name){return this.all().filter(r=>sameType(r.name,name));}
  get(name){const rows=this.find(name);return rows.length===1?rows[0]:null;}
  answer(name){
    const rows=this.find(name);
    if(rows.length>1)return `找到多条可能的记录：${rows.map(r=>r.name+'在'+r.location).join('；')}。你要找哪一个？`;
    const r=rows[0];return r?`你上次让我记住的家中记录：${r.name}在${r.location}，记录于${new Date(r.recorded_at).toLocaleString('zh-CN')}。还没有确认现在的位置。`:`没有找到${name}的家中位置记录。`;
  }
  edit({id,recorded_at,original_name,name,location,appearance=''}){
    const current=this.all().find(r=>(r.id?r.id===id:id==null&&typeof original_name==='string'&&r.name===original_name)&&r.recorded_at===recorded_at);
    if(!current)throw Error('这条记录已经变化，请重新打开后核对。');
    name=clean(normalizeName(name),40);location=clean(location,600);
    if(this.all().some(r=>r!==current&&normalizeName(r.name)!==normalizeName(current.name)&&normalizeName(r.name)===normalizeName(name)))throw Error('已经有同名物品，请用颜色或外观区分。');
    if(typeof appearance!=='string'||appearance.length>150)throw Error('请提供简短的外观说明。');
    const renamed=normalizeName(name)!==normalizeName(current.name);
    const rows=this.rows().filter(r=>!renamed||normalizeName(r.name)!==normalizeName(current.name));
    const record={...current,id:this.uuid(),object_id:current.object_id||current.id,name,location,appearance:appearance.trim(),recorded_at:new Date(this.clock()).toISOString(),source:'MANUAL',state:'HISTORICAL'};
    // Changing the placement cannot retain stale observed spatial relations.
    if(location!==current.location){delete record.relations;delete record.anchor;delete record.observed_at;}
    this.storage.setItem(this.key,JSON.stringify([...rows,record]));this.last=name;this.pending=null;
    return {...this.result('已保存你修改的“'+name+'”记录，尚未确认现在的位置。'),saved:true,record};
  }
  saveVisual(name,candidate,observedAt){
    name=clean(normalizeName(name),60);
    if(visualCandidateProblem(candidate))throw new VisualEvidenceError('物品与位置参照之间的关系还不完整。');
    const location=clean(candidate.location),anchor=clean(candidate.anchor,60);
    let rows,old;
    try{rows=this.rows();old=this.all().find(r=>normalizeName(r.name)===name);}catch{throw new MemoryPersistenceError('浏览器中的物品记忆暂时无法读取。');}
    const observedAppearance=appearanceText(candidate.appearance),appearance=observedAppearance||appearanceText(old?.appearance);
    const record={id:this.uuid(),object_id:old?.object_id||old?.id||this.uuid(),place:'home',name,location,anchor,appearance,event_time:'观察时',observed_at:observedAt||new Date(this.clock()).toISOString(),recorded_at:new Date(this.clock()).toISOString(),source:'USER_REQUESTED_VISUAL',state:'HISTORICAL'};
    rows.push(record);
    try{
      this.storage.setItem(this.key,JSON.stringify(rows));
      if(!this.rows().some(r=>r.id===record.id&&r.name===name&&r.location===location&&r.appearance===appearance))throw Error('write not retained');
    }catch{throw new MemoryPersistenceError('浏览器没有成功保存物品记忆。');}
    this.last=name;this.pending=null;
    return {...this.result(`已记住：${name}在${location}。${observedAppearance?'外观也已保存：'+observedAppearance+'。':appearance?'这次外观未看清，保留原来的外观记录。':'这次只记下位置，外观还没看清；可以把物品拍近一些，再让我记住。'}`),saved:true,record};
  }
  remember(text){
    const command=rememberCommand(text);if(!command)return null;
    const name=clean(normalizeName(command.name),40),location=clean(command.location),event_time=clean(command.event_time,80);
    const rows=this.rows(),old=this.all().find(r=>normalizeName(r.name)===name);
    rows.push({id:this.uuid(),object_id:old?.object_id||old?.id,appearance:appearanceText(old?.appearance),place:'home',name,location,event_time,recorded_at:new Date(this.clock()).toISOString(),source:'MANUAL',state:'HISTORICAL'});
    this.storage.setItem(this.key,JSON.stringify(rows));
    this.last=name;this.pending=null;
    return {...this.result(`已记住：${name}在${location}。这是你提供的家中历史位置，需要时我会重新看眼前确认。`),saved:true};
  }
  prepare({action,name,location='',event_time='时间未说明'}){
    if(!['record','move','correct','delete'].includes(action))throw Error('不支持这个操作。');
    name=clean(name,40);
    const matches=this.find(name);if(['delete','correct','move'].includes(action)){if(matches.length>1)throw Error('有多条匹配记录，请说明是哪一件。');if(matches.length===1)name=matches[0].name;}
    if(action!=='delete')location=clean(location);event_time=clean(event_time,80);
    if(action==='correct'&&!this.get(name))throw Error('没有可以更正的记录。');
    this.last=name;this.pending={action,name,location,event_time,token:this.uuid(),expires:this.clock()+300000};
    return {answer:'请说“确认”或点击确认按钮，确认后才会保存或删除。',pending:this.pending,saved:false};
  }
  confirm(token,cancel=false){
    const p=this.pending;
    if(!p||p.token!==token||p.expires<=this.clock()){this.pending=null;throw Error('待确认操作已失效，请重新说明。');}
    if(cancel){this.pending=null;return this.result('已取消。');}
    const rows=this.rows();const old=this.all().find(r=>normalizeName(r.name)===normalizeName(p.name));
    const next=p.action==='delete'?rows.filter(r=>normalizeName(r.name)!==normalizeName(p.name)):[...rows,{id:this.uuid(),object_id:old?.object_id||old?.id,appearance:appearanceText(old?.appearance),place:'home',name:p.name,location:p.location,event_time:p.action==='correct'?old.event_time:p.event_time,recorded_at:new Date(this.clock()).toISOString(),source:'MANUAL',state:'HISTORICAL'}];
    this.storage.setItem(this.key,JSON.stringify(next));
    this.pending=null;return this.result(p.action==='delete'?'已删除这件物品的本机记录。':'已保存你提供的位置，尚未确认现在的位置。');
  }
  result(answer){return {answer,items:this.all(),pending:this.pending};}
  command(text){
    text=clean(text,400);
    const remembered=this.remember(text);if(remembered)return remembered;
    let match=text.match(/^(.+?)(?:在哪|在哪里|放哪了)[？?]?$/);
    if(match){this.last=clean(match[1],40);return this.result(this.answer(this.last));}
    match=text.match(/^删除(.+?)(?:的记录)?$/);
    if(match){this.prepare({action:'delete',name:match[1]});return this.result('请确认删除。');}
    if(text==='确认'&&this.pending)return this.confirm(this.pending.token);
    if(text==='取消'&&this.pending)return this.confirm(this.pending.token,true);
    if(text==='什么时候记录的'&&this.last)return this.result(this.answer(this.last));
    return this.result('文字测试可以说“记住，钥匙放在玄关桌上”或“钥匙在哪”。自由语音对话请先配置千问。');
  }
}
