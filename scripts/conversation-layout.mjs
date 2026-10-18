export function applyConversationLayout(js,template){
  // The hosted page uses the same media nodes and handlers; changing views never
  // remounts the video element or requests the camera a second time.
  template=template.replace(/<details class="disclosure"><summary>对话记录<\/summary>[\s\S]*?<\/details>/,'');
  template=template.replace(/<div class="place-control">[\s\S]*?<\/div>/,'');
  template=template.replace('<h1>{{title}}</h1>','<h1>{{title}}</h1><label class="scene-picker"><span class="sr-only">当前场景</span><select id="place-mode"><option value="explore">普通场景</option><option value="home">家</option></select></label>');
  template=template.replace('</video>','</video><button id="expand-video" type="button" aria-pressed="false">放大画面</button>');
  const chat=`<section id="conversation-panel" aria-label="对话记录"><div class="chat-heading"><h2>对话记录</h2><button id="expand-chat" type="button" aria-pressed="false">展开记录</button></div><div class="chat-history-tools"><label class="sr-only" for="chat-session">选择一次对话</label><select id="chat-session"></select><button id="delete-chat" type="button">删除</button></div><div id="chat-empty"><p>开始对话，或用文字告诉我你想找什么。</p><p>对话文字保存在此浏览器，可随时删除。</p></div><div id="chat" role="log" aria-live="off" aria-label="对话记录" tabindex="0"></div><button id="chat-jump" type="button" hidden>有新消息 · 回到最新 ↓</button></section>`;
  template=template.replace('<section class="answer-card"',chat+'<section class="answer-card"');
  template=template.replace('</section>\n<div id="main-action"','<button id="return-chat" type="button">返回完整对话</button></section>\n<div id="main-action"');
  const text=template.match(/<details id="text-tools"[\s\S]*?<\/details>/)?.[0];
  if(!text)throw Error('Missing text tools');template=template.replace(text,'');
  template=template.replace('<div id="main-action"','<div class="conversation-footer"><p id="dialogue-state" role="status" aria-live="off">尚未开始对话</p>'+text+'<div id="main-action"');
  const actionsEnd=template.indexOf('</div>',template.indexOf('id="main-action"'));
  if(actionsEnd<0)throw Error('Missing primary actions');
  template=template.slice(0,actionsEnd+6)+'<button id="end-conversation" type="button" hidden>结束对话</button></div>'+template.slice(actionsEnd+6);
  template=template.replace('</main>','</main><dialog id="delete-chat-dialog" aria-labelledby="delete-chat-title"><h2 id="delete-chat-title">删除这次对话？</h2><p>只删除本机文字对话，不影响已经记住的物品位置。</p><div class="two-buttons"><button id="delete-chat-cancel" type="button">取消</button><button id="delete-chat-confirm" type="button">删除对话</button></div></dialog>');
  js="import {ConversationView} from './conversation.mjs';\n"+js;
  js=js.replace(/function bubble\(text,user=false\)\{[^\n]*\}/,'function bubble(text,user=false,meta={}){return conversation.add(text,user,meta);}')
    .replace('function localAnswer(text){lastAnswer=text;bubble(text);','function localAnswer(text,meta={}){lastAnswer=text;bubble(text,false,meta);')
    .replace('localAnswer(data.answer);','localAnswer(data.answer,data);');
  js=js.replace("$('latest-answer').focus()","$('chat').focus()");
  js=js.replace('async function handleCloud(event){switch(event.type){','async function handleCloud(event){if(event.replay)return;switch(event.type){');
  const start=js.indexOf(" case 'response.audio_transcript.delta':"),endCase=js.indexOf(" case 'app.observe':",start);
  if(start<0||endCase<0)throw Error('Missing response handlers');
  js=js.slice(0,start)+` case 'response.audio_transcript.delta':case 'response.text.delta':conversation.stream(event.item_id||event.response_id||'cloud',event.delta||'',{append:true});break;
 case 'response.audio_transcript.done':case 'response.text.done':{const text=event.transcript||event.text||'';conversation.stream(event.item_id||event.response_id||'cloud',text,{done:true});lastAnswer=text;showAnswer(text,true);break;}
`+js.slice(endCase);
  js=js.replace("case 'app.scene_begin':sceneText='';","case 'app.scene_begin':sceneText='';sceneMessageKey=event.token;")
    .replace("sceneSpeech?.append(event.text);break;","conversation.stream(sceneMessageKey,sceneText,{meta:{source:'observation'}});sceneSpeech?.append(event.text);break;")
    .replace("case 'app.scene_cancel':sceneSpeech?.cancel();break;","case 'app.scene_cancel':sceneSpeech?.cancel();conversation.finishDrafts();sceneMessageKey=null;break;")
    .replace('playSceneAnswer(event.answer,event.token,event.streamed);','playSceneAnswer(event.answer,event.token,event.streamed,event);')
    .replace("case 'app.scene_fallback':localAnswer(event.answer);","case 'app.scene_fallback':localAnswer(event.answer,event);")
    .replace('renderPending(event.pending);localAnswer(event.answer);','renderPending(event.pending);localAnswer(event.answer,event);');
  js=js.replace('function playSceneAnswer(text,token,streamed=false){','function playSceneAnswer(text,token,streamed=false,meta={}){')
    .replace('lastAnswer=text;bubble(text);',"lastAnswer=text;if(streamed&&sceneMessageKey)conversation.stream(sceneMessageKey,text,{done:true,meta});else bubble(text,false,meta);sceneMessageKey=null;");
  js=js.replace("if(event.transcript){bubble(event.transcript,true);","if(event.transcript){conversation.finishDrafts();bubble(event.transcript,true);");
  js=js.replace('function startVoice(){','function startVoice(options={}){')
    .replace('const attempt=++voiceGeneration;',"if(!options.replay)conversation.begin();\n const attempt=++voiceGeneration;")
    .replace('if(!await startVoice())return;}\n  stopPlayback();socket?.replayAnswer(text);','if(!await startVoice({replay:true}))return;}\n  stopPlayback();socket?.replayAnswer(text);')
    .replace('async function stop(){voiceGeneration++;','async function stop(){conversation.end();voiceGeneration++;');
  js=js.replace("$('main-toggle').textContent=active?(ready?'结束对话':'取消开启'):('开始对话')", "$('main-toggle').textContent=active?(ready?(paused?'继续对话':'暂停对话'):'取消开启'):'开始对话'");
  js=js.replace("$('main-toggle').classList.toggle('active',active);", "$('main-toggle').classList.toggle('active',active);$('end-conversation').hidden=!active;");
  js=js.replace("$('main-toggle').onclick=async()=>{if(sessionActive())await stop();", "$('main-toggle').onclick=async()=>{if(ready){$('pause').click();return;}if(sessionActive())await stop();");
  // Construct history before the bootstrap IIFE can render an offline response.
  const marker="(async()=>{try{const status=window.spatialRuntime.status();";
  if(!js.includes(marker))throw Error('Missing hosted bootstrap');
  js=js.replace(marker,`let sceneMessageKey=null;
const conversation=new ConversationView({document,storage:localStorage,place:()=>runtime.place(),onReplay:text=>speak(text),onError:message=>notify(message,0)});
const restored=conversation.latest();if(restored){lastAnswer=restored;$('latest-answer').textContent=restored;$('replay').disabled=false;}
$('end-conversation').onclick=()=>stop();
let layout='split';function setLayout(value){layout=value;document.body.dataset.layout=value;$('expand-video').textContent=value==='video'?'缩小画面':'放大画面';$('expand-video').setAttribute('aria-pressed',String(value==='video'));$('expand-chat').textContent=value==='history'?'恢复分屏':'展开记录';$('expand-chat').setAttribute('aria-pressed',String(value==='history'));}
$('expand-video').onclick=()=>setLayout(layout==='video'?'split':'video');$('expand-chat').onclick=()=>setLayout(layout==='history'?'split':'history');$('return-chat').onclick=()=>{setLayout('split');$('expand-chat').focus();};setLayout('split');
new MutationObserver(()=>$('dialogue-state').textContent=$('voice-state').textContent||'尚未开始对话').observe($('voice-state'),{childList:true,characterData:true,subtree:true});
const viewport=window.visualViewport;const resize=()=>document.documentElement.style.setProperty('--app-height',(viewport?.height||window.innerHeight)+'px');viewport?.addEventListener('resize',resize);window.addEventListener('resize',resize);resize();
window.addEventListener('pagehide',()=>conversation.end());
`+marker);
  return {js,template};
}
