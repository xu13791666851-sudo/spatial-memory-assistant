// The composer follows the visible viewport, including iOS keyboard pan/resize.
// It never replaces the mounted camera or changes the current find target.
export function installTextComposer({document,window,send,state}){
 const $=id=>document.getElementById(id),dialog=$('text-composer'),tools=$('text-tools'),trigger=tools.querySelector('summary'),input=$('message'),button=$('text-send'),status=$('composer-status');
 let busy=false,composing=false,frame=0;
 const update=()=>{button.disabled=busy||!input.value.trim();button.textContent=busy?'发送中…':'发送';input.readOnly=busy;dialog.setAttribute('aria-busy',String(busy));};
 function viewport(){
  const v=window.visualViewport,scale=v?.scale||1;
  const height=v?.height||window.innerHeight,top=v?.offsetTop||0,width=v?.width||window.innerWidth,left=v?.offsetLeft||0;
  const root=document.documentElement;root.style.setProperty('--app-height',height+'px');root.style.setProperty('--visible-height',height+'px');root.style.setProperty('--visible-top',top+'px');root.style.setProperty('--visible-width',width+'px');root.style.setProperty('--visible-left',left+'px');
  // Pinching remains available; only the text panel follows the magnified view.
  document.body.classList.toggle('viewport-zoomed',scale>1.05);
  if(dialog.open){const h=dialog.getBoundingClientRect().height;dialog.style.top=Math.max(top+8,top+height-h-8)+'px';dialog.style.left=(left+width/2)+'px';}
 }
 const schedule=()=>{window.cancelAnimationFrame(frame);frame=window.requestAnimationFrame(viewport);};
 function open(){if(dialog.open)return;tools.open=true;document.body.classList.add('composer-open');dialog.showModal();update();viewport();input.focus({preventScroll:true});schedule();}
 function close(){input.blur();if(dialog.open)dialog.close();}
 trigger.addEventListener('click',e=>{e.preventDefault();open();});
 tools.addEventListener('toggle',()=>{if(tools.open&&!dialog.open)open();else if(!tools.open&&dialog.open)close();});
 $('text-composer-close').onclick=close;
 dialog.addEventListener('close',()=>{tools.open=false;document.body.classList.remove('composer-open');trigger.focus({preventScroll:true});window.scrollTo(0,0);schedule();});
 dialog.addEventListener('cancel',()=>input.blur());
 input.addEventListener('input',()=>{if(!busy)status.textContent='';update();schedule();});
 input.addEventListener('compositionstart',()=>composing=true);input.addEventListener('compositionend',()=>{composing=false;update();});
 input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!composing&&e.keyCode!==229){e.preventDefault();if(!button.disabled)$('chat-form').requestSubmit();}});
 $('chat-form').addEventListener('submit',async e=>{
  e.preventDefault();if(busy||!input.value.trim())return;const text=input.value.trim();busy=true;status.textContent='正在发送…';update();
  try{const accepted=await send(text);if(!accepted){status.textContent=state().paused?'对话已暂停，请点继续后再发送；文字已保留。':'连接未完成，文字已保留，请重试。';return;}input.value='';status.textContent='';close();}
  catch(error){status.textContent=error?.message||'没有发送成功，文字已保留，请重试。';}
  finally{busy=false;update();schedule();}
 });
 window.visualViewport?.addEventListener('resize',schedule);window.visualViewport?.addEventListener('scroll',schedule);window.addEventListener('resize',schedule);window.addEventListener('orientationchange',schedule);
 if(window.ResizeObserver)new window.ResizeObserver(schedule).observe(dialog);
 viewport();update();return {open,close,refresh:viewport};
}
