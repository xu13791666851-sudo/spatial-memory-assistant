// Text-only local history. This store never writes to the object-memory key.
export class ConversationStore {
  constructor(storage,onError=()=>{}){
    this.storage=storage;this.onError=onError;this.key='spatial-conversations.v1';this.sessions=[];this.readable=true;
    try{
      const raw=JSON.parse(storage.getItem(this.key)||'[]');
      if(!Array.isArray(raw)||raw.some(s=>!s||typeof s.id!=='string'||!Array.isArray(s.messages)))throw Error('Invalid history');
      this.sessions=raw.map(s=>({id:s.id,at:s.at,place:s.place==='home'?'home':'explore',messages:s.messages.filter(m=>m&&typeof m.id==='string'&&typeof m.text==='string'&&['user','assistant'].includes(m.role)).map(m=>({id:m.id,text:m.text.slice(0,10000),role:m.role,at:m.at,kind:['saved','history','observation'].includes(m.kind)?m.kind:'',observedAt:m.observedAt||null,complete:m.complete!==false}))}));
    }catch{this.readable=false;onError('已有对话记录暂时无法读取，新消息仅在本页显示，未覆盖旧数据。');}
  }
  save(){
    if(!this.readable)return false;
    try{const data=JSON.stringify(this.sessions);if(data.length>1800000)throw Error('Full');this.storage.setItem(this.key,data);return true;}
    catch{this.onError('本机对话记录未保存成功。新消息仍可查看，请删除不需要的旧对话后重试。');return false;}
  }
  start(place){const s={id:crypto.randomUUID(),at:new Date().toISOString(),place,messages:[]};this.sessions.push(s);return s.id;}
  get(id){return this.sessions.find(s=>s.id===id);}
  put(id,message){const session=this.get(id);if(!session)return false;const existing=session.messages.find(m=>m.id===message.id);if(existing)Object.assign(existing,message);else session.messages.push(message);return this.save();}
  remove(id){const before=this.sessions;this.sessions=this.sessions.filter(s=>s.id!==id);if(!this.save()){this.sessions=before;return false;}return true;}
}
const date=value=>Number.isFinite(Date.parse(value))?new Date(value):null;
const clock=value=>date(value)?.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})||'';
export class ConversationView{
  constructor({document,storage,onReplay,onError,place}){
    Object.assign(this,{document,onReplay,place});this.store=new ConversationStore(storage,onError);this.active=null;this.selected=this.store.sessions.at(-1)?.id||null;this.nodes=new Map();this.streaming=new Map();this.follow=true;this.unseen=0;
    this.chat=document.getElementById('chat');this.select=document.getElementById('chat-session');this.jump=document.getElementById('chat-jump');this.empty=document.getElementById('chat-empty');
    this.chat.addEventListener('scroll',()=>{this.follow=this.chat.scrollHeight-this.chat.clientHeight-this.chat.scrollTop<48;if(this.follow&&this.selected===this.active){this.unseen=0;this.jump.hidden=true;}});
    this.jump.onclick=()=>{if(this.active&&this.selected!==this.active)this.selectSession(this.active);this.follow=true;this.unseen=0;this.chat.scrollTop=this.chat.scrollHeight;this.jump.hidden=true;};
    this.select.onchange=()=>this.selectSession(this.select.value);
    const dialog=document.getElementById('delete-chat-dialog');document.getElementById('delete-chat').onclick=()=>{if(this.selected){this.deleteTarget=this.selected;dialog.showModal();}};
    document.getElementById('delete-chat-cancel').onclick=()=>dialog.close();
    document.getElementById('delete-chat-confirm').onclick=()=>{const id=this.deleteTarget;if(this.store.remove(id)){if(id===this.active)this.active=null;this.selected=this.store.sessions.at(-1)?.id||null;this.render();dialog.close();}};
    dialog.addEventListener('close',()=>document.getElementById('delete-chat').focus());
    this.render();
  }
  begin(){if(!this.active){this.active=this.store.start(this.place());this.selected=this.active;this.follow=true;this.render();}return this.active;}
  end(){this.finishDrafts();this.active=null;this.options();}
  latest(){return this.store.get(this.selected)?.messages.filter(m=>m.role==='assistant').at(-1)?.text||'';}
  options(){
    this.select.replaceChildren();
    for(const session of [...this.store.sessions].reverse()){
      const option=this.document.createElement('option');option.value=session.id;
      option.textContent=(date(session.at)?.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})||'先前对话')+' · '+(session.place==='home'?'家':'普通场景')+(session.id===this.active?' · 当前':'');this.select.append(option);
    }
    if(this.selected)this.select.value=this.selected;this.select.disabled=!this.store.sessions.length;
    this.document.getElementById('delete-chat').disabled=!this.selected;
  }
  selectSession(id){this.selected=id;this.follow=true;this.render();}
  render(){
    this.nodes.clear();this.chat.replaceChildren();this.options();
    for(const message of this.store.get(this.selected)?.messages||[])this.draw(message);
    this.empty.hidden=!!this.chat.children.length;this.chat.scrollTop=this.chat.scrollHeight;
    this.jump.hidden=this.selected===this.active||!this.unseen;
  }
  draw(message){
    const doc=this.document,box=doc.createElement('article');box.className='chat-turn '+message.role;
    const label=doc.createElement('div');label.className='chat-speaker';label.textContent=(message.role==='user'?'我':'小忆')+' · '+clock(message.at);
    const bubble=doc.createElement('div');bubble.className='chat-bubble';
    const tag=doc.createElement('span');tag.className='chat-tag';
    const p=doc.createElement('p');p.textContent=message.text;
    bubble.append(label,tag,p);box.append(bubble);
    let replay=null;if(message.role==='assistant'){replay=doc.createElement('button');replay.type='button';replay.className='message-replay';replay.textContent='重听这一条';replay.setAttribute('aria-label','重听小忆在'+clock(message.at)+'的回答');replay.onclick=()=>this.onReplay(message.text);box.append(replay);}
    const node={box,p,tag,replay,message};this.nodes.set(message.id,node);this.chat.append(box);this.updateNode(node);return p;
  }
  updateNode({p,tag,replay,message}){
    p.textContent=message.text;
    tag.textContent=message.kind==='saved'?'已存入物品记忆':message.kind==='history'?'历史位置 · 尚未确认':message.kind==='observation'?'本次观察 · '+clock(message.observedAt):'';
    if(!message.complete)tag.textContent=tag.textContent?tag.textContent+' · 回答未完成':'回答未完成';
    tag.hidden=!tag.textContent;if(replay)replay.disabled=!message.text;
  }
  changed(message,isNew){
    this.options();this.empty.hidden=!!this.store.get(this.selected)?.messages.length;
    if(this.selected===this.active){const node=this.nodes.get(message.id);if(node)this.updateNode(node);else this.draw(message);}
    if(this.follow&&this.selected===this.active){this.chat.scrollTop=this.chat.scrollHeight;this.jump.hidden=true;}
    else{if(isNew)this.unseen++;this.jump.textContent='有新消息 · 回到最新 ↓';this.jump.hidden=false;}
  }
  add(text,user=false,meta={}){
    this.begin();const message={id:crypto.randomUUID(),role:user?'user':'assistant',text:String(text),at:new Date().toISOString(),kind:meta.saved?'saved':meta.source==='history'?'history':meta.source==='observation'?'observation':'',observedAt:meta.observedAt||null,complete:true};
    this.store.put(this.active,message);this.changed(message,true);return this.nodes.get(message.id)?.p;
  }
  stream(key,text,{append=false,done=false,meta={}}={}){
    this.begin();let entry=this.streaming.get(key),isNew=!entry;
    if(!entry){entry={session:this.active,message:{id:crypto.randomUUID(),role:'assistant',text:'',at:new Date().toISOString(),kind:meta.source==='observation'?'observation':'',observedAt:meta.observedAt||null,complete:false}};this.streaming.set(key,entry);}
    if(entry.session!==this.active)return;
    const message=entry.message;message.text=append?message.text+String(text):String(text);message.complete=done;
    if(done){message.kind=meta.saved?'saved':meta.source==='history'?'history':meta.source==='observation'?'observation':message.kind;message.observedAt=meta.observedAt||message.observedAt;}
    // Persist only final/interrupted text, not every network token.
    const session=this.store.get(this.active);if(!session.messages.some(m=>m.id===message.id))session.messages.push(message);
    if(done)this.store.save();this.changed(message,isNew);return message;
  }
  finishDrafts(){for(const entry of this.streaming.values())if(!entry.message.complete&&entry.message.text){this.store.save();const node=this.nodes.get(entry.message.id);if(node)this.updateNode(node);}this.streaming.clear();}
}
