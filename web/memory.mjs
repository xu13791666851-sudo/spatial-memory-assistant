const clean=(value,max=120)=>{
  if(typeof value!=='string')throw Error('请提供有效的名称或位置。');
  value=value.trim().replace(/^[，。！？!?,\s]+|[，。！？!?,\s]+$/g,'');
  if(!value||value.length>max||/[\x00-\x1f]/.test(value))throw Error('请提供简短、有效的名称或位置。');
  return value;
};
export function rememberCommand(text){
  const value=String(text||'').trim().replace(/^(?:你好)?(?:小忆|小意|小易)[，,\s]*/,'');
  const match=value.match(/^(?:记住|请记住|帮我记住)[，,：:\s]*(?:我)?(?:(昨天|刚刚|刚才|今天)[，,\s]*)?(?:把)?(.+?)(?:刚放在|放在|在)(.+?)[。！!]?$/);
  return match?{action:'record',name:match[2],location:match[3],event_time:match[1]||'时间未说明'}:null;
}
export const vagueName=name=>/^(?:它|他|她|这个|那个|这件|那件|这个东西|那个东西|东西|物品)$/.test(String(name||'').trim());
const groups=['杯子 水杯 茶杯 马克杯 保温杯','耳机盒 耳机仓 耳机充电盒 装耳机的盒子','钥匙 钥匙串 钥匙包','眼镜 眼镜盒','遥控器 遥控板','手机 电话','钱包 钱夹','背包 书包 双肩包'];
const normalize=value=>String(value||'').replace(/[的我个只件\s，。？！?,!]/g,'');
export function nameSimilarity(query,name){
  const a=normalize(query),b=normalize(name);if(!a||!b)return 0;
  if(a===b)return 100;
  if(a.includes(b)||b.includes(a))return 70;
  if(groups.some(g=>{const words=g.split(' ').map(normalize);return words.some(w=>a.includes(w))&&words.some(w=>b.includes(w));}))return 60;
  const pairs=s=>new Set(Array.from({length:Math.max(0,s.length-1)},(_,i)=>s.slice(i,i+2)));
  const x=pairs(a),y=pairs(b);return [...x].filter(v=>y.has(v)).length*10;
}
export class Memory {
  constructor(storage,clock=()=>Date.now(),uuid=()=>crypto.randomUUID()){
    this.storage=storage;this.clock=clock;this.uuid=uuid;this.pending=null;this.last='';this.key='spatial-memory.records.v1';
  }
  rows(){
    const raw=JSON.parse(this.storage.getItem(this.key)||'[]');
    if(!Array.isArray(raw))throw Error('本机记录无法读取，请先检查浏览器数据。');
    return raw.filter(r=>r&&typeof r.name==='string'&&typeof r.location==='string'&&typeof r.recorded_at==='string'&&r.source==='MANUAL'&&r.state==='HISTORICAL'&&(!r.place||r.place==='home'));
  }
  all(){const map=new Map();for(const r of this.rows())map.set(r.name,r);return [...map.values()].reverse();}
  get(name){return this.all().find(r=>r.name===name)||null;}
  search(query='',limit=5){
    const rows=this.all();if(!query.trim()||vagueName(query))return rows.slice(0,limit);
    return rows.map(record=>({record,score:nameSimilarity(query,record.name)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,limit).map(x=>x.record);
  }
  answer(name){const r=this.get(name);return r?`你之前提供的家中记录：${name}在${r.location}，放置时间为“${r.event_time}”，记录于${new Date(r.recorded_at).toLocaleString('zh-CN')}。还没有确认现在的位置。`:`没有找到${name}的家中位置记录。`;}
  remember(text){
    const command=rememberCommand(text);if(!command)return null;
    const name=clean(command.name,40),location=clean(command.location),event_time=clean(command.event_time,80);
    if(vagueName(name))return {...this.result('你说的是哪一件？可以描述颜色、用途，或说“我记过什么”，我帮你一起找。'),saved:false};
    const rows=this.rows();
    rows.push({id:this.uuid(),place:'home',name,location,event_time,recorded_at:new Date(this.clock()).toISOString(),source:'MANUAL',state:'HISTORICAL'});
    this.storage.setItem(this.key,JSON.stringify(rows));
    this.last=name;this.pending=null;
    return {...this.result(`已记住：${name}在${location}。这是你提供的家中历史位置，需要时我会重新看眼前确认。`),saved:true};
  }
  prepare({action,name,location='',event_time='时间未说明'}){
    if(!['record','move','correct','delete'].includes(action))throw Error('不支持这个操作。');
    name=clean(name,40);if(action!=='delete')location=clean(location);event_time=clean(event_time,80);
    if(vagueName(name))throw Error('请先确认具体是哪一件物品。');
    if(action==='correct'&&!this.get(name))throw Error('没有可以更正的记录。');
    this.last=name;this.pending={action,name,location,event_time,token:this.uuid(),expires:this.clock()+300000};
    return {...this.result(`要${action==='delete'?'删除'+name+'的记录':'把'+name+'的位置记为'+location}吗？可以说“确认”或“取消”。`),saved:false};
  }
  confirm(token,cancel=false){
    const p=this.pending;
    if(!p||p.token!==token||p.expires<=this.clock()){this.pending=null;throw Error('待确认操作已失效，请重新说明。');}
    if(cancel){this.pending=null;return this.result('已取消。');}
    const rows=this.rows();const old=this.get(p.name);
    const next=p.action==='delete'?rows.filter(r=>r.name!==p.name):[...rows,{id:this.uuid(),place:'home',name:p.name,location:p.location,event_time:p.action==='correct'?old.event_time:p.event_time,recorded_at:new Date(this.clock()).toISOString(),source:'MANUAL',state:'HISTORICAL'}];
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
