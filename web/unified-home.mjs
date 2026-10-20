// Presentation and direct manipulation of the existing assistant. Opening a
// record never starts a session or moves/recreates the mounted video element.
export class UnifiedHome{
  constructor({document,runtime,conversation,actions,state,notice}){
    Object.assign(this,{document,runtime,conversation,actions,state,notice});this.$=id=>document.getElementById(id);this.tab='chat';this.focusBefore=null;this.expanded=false;this.collapsed=false;this.editing=null;this.deleting=null;
    const $=this.$;
    for(const [dialog,id]of [['memory-editor','memory-edit-error'],['memory-delete-dialog','memory-delete-error']]){const error=document.createElement('p');error.id=id;error.className='inline-error';error.setAttribute('role','alert');error.hidden=true;$(dialog).append(error);}
    $('open-records').onclick=()=>this.open();$('close-records').onclick=$('records-home').onclick=()=>this.close();
    $('records-dialog').addEventListener('close',()=>{const focus=this.focusBefore;this.focusBefore=null;if(focus?.isConnected&&!focus.closest('[hidden]'))focus.focus();});
    $('record-tab-chat').onclick=()=>this.select('chat');$('record-tab-memory').onclick=()=>this.select('memory');
    document.querySelector('.record-tabs').onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();this.select(e.key==='Home'?'chat':e.key==='End'?'memory':this.tab==='chat'?'memory':'chat');$('record-tab-'+this.tab).focus();};
    $('expand-chat').onclick=()=>{this.expanded=!this.expanded;$('records-dialog').classList.toggle('expanded',this.expanded);$('expand-chat').textContent=this.expanded?'收起':'展开';$('expand-chat').setAttribute('aria-pressed',String(this.expanded));};
    $('return-chat').onclick=()=>this.open();$('records-end').onclick=()=>{this.actions.stop();this.close();};
    $('expand-video').onclick=()=>this.camera(document.body.dataset.layout==='video'?'home':'video');$('collapse-camera').onclick=()=>this.camera(this.collapsed?'home':'collapsed');
    $('open-accessibility').onclick=()=>this.actions.settings($('open-accessibility'));
    $('answer-detail').onclick=()=>{const expanded=$('answer-detail').getAttribute('aria-expanded')!=='true';$('answer-detail').setAttribute('aria-expanded',String(expanded));$('answer-detail').textContent=expanded?'收起全文':'展开全文';document.querySelector('.answer-card').classList.toggle('full-answer',expanded);};
    $('memory-search').oninput=()=>this.renderMemories();
    $('memory-edit-close').onclick=()=>$('memory-editor').close();
    $('memory-editor').addEventListener('close',()=>{if($('records-dialog').open)$('record-tab-memory').focus();else $('open-records').focus();});
    $('memory-edit-form').onsubmit=e=>{e.preventDefault();if(!this.editing)return;try{const result=runtime.memory.edit({id:this.editing.id,recorded_at:this.editing.recorded_at,original_name:this.editing.name,name:$('memory-name').value,location:$('memory-location').value,appearance:$('memory-appearance').value});this.renderMemories();$('memory-editor').close();this.announce(result.answer);conversation.add(result.answer,false,{saved:true});}catch(err){$('memory-edit-error').hidden=false;$('memory-edit-error').textContent=err.message;}};
    $('memory-delete').onclick=()=>{if(!this.editing)return;this.deleting={...this.editing};$('memory-delete-text').textContent='只删除“'+this.editing.name+'”的物品位置，不删除对话记录。';$('memory-delete-error').hidden=true;$('memory-delete-dialog').showModal();};
    $('memory-delete-cancel').onclick=()=>$('memory-delete-dialog').close();
    $('memory-delete-confirm').onclick=()=>{try{const record=runtime.memory.all().find(r=>r.id===this.deleting?.id&&r.name===this.deleting.name&&r.recorded_at===this.deleting.recorded_at);if(!record)throw Error('这条记录已经变化，请重新打开后核对。');const proposal=runtime.memory.prepare({action:'delete',name:record.name});const result=runtime.memory.confirm(proposal.pending.token);this.renderMemories();$('memory-delete-dialog').close();$('memory-editor').close();this.announce(result.answer);conversation.add(result.answer,false);}catch(err){$('memory-delete-error').hidden=false;$('memory-delete-error').textContent=err.message;}};
    $('memory-delete-dialog').addEventListener('close',()=>{if($('memory-editor').open)$('memory-delete').focus();});
    const observer=new MutationObserver(()=>this.syncState());
    for(const id of ['latest-answer','voice-state','connection','chat'])observer.observe($(id),{childList:true,characterData:true,subtree:true});
    this.syncState();
  }
  announce(text,read=false){this.$('answer-live').textContent=text;if(read&&!this.$('screen-reader-mode').checked)this.actions.replay(text);}
  select(tab){this.tab=tab;for(const name of ['chat','memory']){const selected=name===tab;const button=this.$('record-tab-'+name);button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;this.$('record-panel-'+name).hidden=!selected;}if(tab==='memory')this.renderMemories();}
  open(tab='chat'){
    this.select(tab);const dialog=this.$('records-dialog');if(!dialog.open){this.focusBefore=this.document.activeElement;this.$('more-tools').open=false;dialog.showModal();this.$('records-title').focus();}this.syncState();
  }
  close(){for(const id of ['memory-delete-dialog','memory-editor','records-dialog'])if(this.$(id).open)this.$(id).close();}
  camera(view){
    if(view==='collapsed'){this.collapsed=true;this.document.body.dataset.layout='home';}
    else{this.collapsed=false;this.document.body.dataset.layout=view==='video'?'video':'home';}
    this.document.querySelector('.camera-panel').classList.toggle('collapsed',this.collapsed);
    this.$('collapse-camera').textContent=this.collapsed?'展开画面':'收起画面';this.$('collapse-camera').setAttribute('aria-expanded',String(!this.collapsed));
    this.$('expand-video').textContent=view==='video'?'恢复首页':'放大画面';this.$('expand-video').setAttribute('aria-pressed',String(view==='video'));
  }
  syncState(){
    const state=this.state(),task=this.runtime.taskState?.();const name=state.active?task?.target:null;
    const title=name?(task.awaiting_save_clarification?'正在记住':'寻找')+name:'看见周围，记住位置。';
    if(this.$('current-task').textContent!==title)this.$('current-task').textContent=title;
    const label=name?(state.paused?'任务已暂停':'当前任务'):'随时说出你想做的事';if(this.$('task-kind').textContent!==label)this.$('task-kind').textContent=label;
    const recordText=name?(state.paused?'已暂停 · ':'当前任务 · ')+name:'查看记录，随时回到首页';if(this.$('records-task').textContent!==recordText)this.$('records-task').textContent=recordText;
    this.$('records-end').disabled=!state.active;
  }
  renderMemories(){
    const $=this.$,list=$('memories');list.replaceChildren();$('home-memory-section').hidden=false;let items;
    try{items=this.runtime.memory.all();}catch(err){const p=this.document.createElement('p');p.textContent=err.message;list.append(p);return;}
    $('count').textContent=items.length+' 件';const query=$('memory-search').value.trim().toLowerCase();
    const records=items.filter(r=>[r.name,r.location,r.appearance,...(r.aliases||[]),...(r.relations||[]).map(v=>v.reference+v.relation)].filter(Boolean).join(' ').toLowerCase().includes(query));
    if(!records.length){const p=this.document.createElement('p');p.className='empty';p.textContent=query?'没有找到相近的记录，试试颜色或位置。':'还没有物品记忆。在家中可以说“记住水杯的位置”。';list.append(p);return;}
    for(const record of records){
      const box=this.document.createElement('article');box.className='memory-item';
      const title=this.document.createElement('h3');title.textContent=record.name;
      const appearance=this.document.createElement('p');appearance.className='memory-appearance';appearance.textContent=record.appearance?'外观：'+record.appearance:'外观尚未记录，可在编辑中补充，或对准物品说“记住'+record.name+'的位置”。';
      const position=this.document.createElement('p');const relations=(record.relations||[]).map(v=>v.reference+'的'+v.relation);position.textContent=[record.location,...relations].filter(Boolean).join('；');
      const time=this.document.createElement('time');time.textContent='上次记录：'+new Date(record.recorded_at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
      const buttons=this.document.createElement('div');buttons.className='memory-actions';
      for(const [label,handler]of [['找这件',()=>{this.close();Promise.resolve(this.actions.send('找'+record.name)).catch(err=>this.notice(err.message));}],['听位置',()=>this.actions.replay(this.runtime.memory.answer(record.name))],['编辑',()=>this.edit(record)]]){const b=this.document.createElement('button');b.type='button';b.textContent=label;b.setAttribute('aria-label',label+'，'+record.name);b.onclick=handler;buttons.append(b);}
      box.append(title,appearance,position,time,buttons);list.append(box);
    }
  }
  edit(record){this.editing={...record};this.$('memory-edit-error').hidden=true;this.$('memory-name').value=record.name;this.$('memory-appearance').value=record.appearance||'';this.$('memory-location').value=record.location;this.$('memory-editor').showModal();}
  command(action){
    switch(action.type){
      case 'records':this.open(action.tab);if(action.read){let names;try{names=this.runtime.memory.all().slice(0,5).map(r=>r.name);}catch{names=[];}this.announce(names.length?'你记住过：'+names.join('、')+'。可以说出名称继续找，或问上次的位置。':'还没有可以读取的物品记忆。',true);}else this.announce('已打开对话记录，关闭后继续当前任务。');break;
      case 'close-records':this.close();break;
      case 'camera':this.camera(action.view);this.announce(action.view==='collapsed'?'画面已收起，当前任务保留。':'画面显示已调整，当前任务保留。');break;
      case 'replay':{const text=this.state().lastAnswer||this.conversation.latest();if(text)this.actions.replay(text);else this.announce('还没有可重听的回答。');break;}
      case 'detail':if(this.$('answer-detail').getAttribute('aria-expanded')!=='true')this.$('answer-detail').click();break;
      case 'pause':if(!this.state().paused)this.actions.pause();break;
      case 'resume':this.actions.resume();break;
      case 'end':this.actions.stop();this.close();break;
      case 'confirm':this.close();this.actions.confirm(false);break;
      case 'cancel-confirmation':this.close();this.actions.confirm(true);break;
    }
  }
}
