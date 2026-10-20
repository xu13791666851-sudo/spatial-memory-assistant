// A single start/end control and passive camera status. This observes existing
// session state; opening records cannot affect capture or the active target.
export function installCameraHome({document,runtime,state}){
 const $=id=>document.getElementById(id);
 const set=(id,value)=>{if($(id).textContent!==value)$(id).textContent=value;};
 const update=()=>{
  const s=state(),task=runtime.taskState?.(),scan=task?.search;
  const label=!s.active?'开始':s.paused?'继续':s.ready&&!s.camera&&!s.opening?'重新观察':s.ready?'结束':'取消开启';
  set('main-toggle',label);
  $('main-toggle').setAttribute('aria-label',label);
  document.body.classList.toggle('camera-active',s.active);
  let status=!s.active?'尚未开始':s.paused?'已暂停':!s.ready?'正在连接…':!s.camera?'语音已连接 · 画面已关闭':'正在聆听';
  if(s.active&&s.ready&&!s.paused&&s.camera&&scan&&['searching','confirming','paused','found'].includes(scan.state))status=scan.state==='found'?'已找到'+(task.target||'物品'):scan.state==='paused'?'寻找已暂停':scan.state==='confirming'?'正在确认'+(task.target||'物品'):'正在寻找'+(task.target||'物品');
  set('camera-session-status',status);
  set('scene-label',runtime.place()==='home'?'家中场景':'普通场景');
  document.querySelector('.camera-caption').hidden=!s.active||!$('latest-answer').textContent.trim();
 };
 const observer=new MutationObserver(update);
 for(const id of ['main-toggle','voice-state','connection','latest-answer','current-task','search-status','task-kind'])observer.observe($(id),{childList:true,subtree:true,characterData:true});
 update();
}
