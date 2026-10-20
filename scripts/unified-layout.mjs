// This layer rearranges the existing hosted controls. Media nodes, storage keys,
// model routes and conversation sessions remain owned by their original modules.
export function applyUnifiedLayout(js,template){
  const take=(pattern,label)=>{const match=template.match(pattern)?.[0];if(!match)throw Error('Missing unified layout '+label);template=template.replace(match,'');return match;};
  const camera=take(/<section class="camera-panel[^>]*>[\s\S]*?<\/section>/,'camera').replace('<section class="camera-panel', '<section class="camera-panel').replace('<div id="camera-preview"','<div class="camera-heading"><h2>周围的画面</h2><button id="collapse-camera" type="button" aria-expanded="true" aria-controls="camera-preview">收起画面</button></div><div id="camera-preview"');
  const chat=take(/<section id="conversation-panel"[\s\S]*?<\/section>/,'conversation').replace('<h2>对话记录</h2>','<h2 class="sr-only">对话记录</h2>').replace('展开记录','展开');
  const answer=take(/<section class="answer-card"[\s\S]*?<\/section>/,'answer').replace('<h2 id="answer-title" class="sr-only">助手回答</h2>','<h2 id="answer-title">小忆</h2>').replace('<button id="return-chat"','<button id="answer-detail" type="button" aria-expanded="false">展开全文</button><button id="return-chat"').replace('返回完整对话','打开记录');
  const pending=take(/<section id="pending"[\s\S]*?<\/section>/,'pending');
  const memory=take(/<details id="home-memory-section"[\s\S]*?<\/details>/,'memory').replace(/^<details[^>]*>/,'<section id="home-memory-section">').replace(/<summary>[\s\S]*?<\/summary>/,'<h3 class="sr-only">我的物品记忆 <span id="count">0 件</span></h3>').replace(/<\/details>$/,'</section>');
  const text=take(/<details id="text-tools"[\s\S]*?<\/details>/,'text entry');
  const actions=take(/<div id="main-action"[\s\S]*?<\/div>/,'actions');
  const end=take(/<button id="end-conversation"[^>]*>[\s\S]*?<\/button>/,'end');
  const source=take(/<label class="scene-picker"[\s\S]*?<\/label>/,'scene');
  const moreStart=template.indexOf('<details id="more-tools"'),mainEnd=template.indexOf('</main>',moreStart);
  if(moreStart<0||mainEnd<0)throw Error('Missing more tools');
  const more=template.slice(moreStart,mainEnd);
  const newMain=`<main class="unified-app">
<header class="page-header"><div class="unified-brand"><span aria-hidden="true" class="brand-mark">忆</span><div><h1>小忆</h1><p>看见周围，记住生活</p></div></div><div class="header-tools"><button id="open-accessibility" type="button" aria-label="文字大小与声音设置">Aa</button><button id="open-records" type="button" aria-haspopup="dialog">记录</button></div></header>
<div class="unified-status"><span id="input-source">手机摄像头 · 按需识别</span>${source}</div>
<section class="session" aria-label="对话控制"><div class="home-content">${camera}<div class="answer-column"><div class="task-heading"><p id="task-kind">随时说出你想做的事</p><h2 id="current-task">看见周围，记住位置。</h2><div id="search-controls" hidden><p id="search-status" role="status" aria-live="polite"></p><div class="two-buttons"><button id="search-pause" type="button">暂停寻找</button><button id="search-cancel" type="button">取消寻找</button></div></div></div>${answer}<p class="home-hint">直接说，也可以点。打开记录时，当前任务仍然保留。</p></div></div>${pending}
<div class="conversation-footer"><div class="footer-status"><p id="dialogue-state" role="status" aria-live="off">尚未开始对话</p></div>${text}${actions}${end}</div>
<p id="connection" class="sr-only">文字记忆可用</p><p id="scene-time" class="sr-only" aria-live="off"></p><p id="camera-state" class="sr-only" role="status" aria-atomic="true"></p><p id="voice-state" class="sr-only" role="status" aria-atomic="true"></p><p id="session-privacy" class="sr-only">开始后开启语音和摄像头。请求找物后会连续识别新画面，找到后停止；离开页面会停止采集。</p><p id="answer-live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p></section>${more}
</main>
<dialog id="records-dialog" aria-labelledby="records-title"><div class="sheet-handle" aria-hidden="true"></div><header class="records-heading"><h2 id="records-title" tabindex="-1">记录</h2><button id="close-records" type="button">关闭</button></header><div class="records-task"><span id="records-task">查看记录，随时回到首页</span><button id="records-home" type="button">回到首页</button></div><div class="record-tabs" role="tablist" aria-label="记录类型"><button id="record-tab-chat" role="tab" type="button" aria-selected="true" aria-controls="record-panel-chat">对话</button><button id="record-tab-memory" role="tab" type="button" tabindex="-1" aria-selected="false" aria-controls="record-panel-memory">物品记忆</button></div><div id="record-panel-chat" role="tabpanel" aria-labelledby="record-tab-chat">${chat}</div><div id="record-panel-memory" role="tabpanel" aria-labelledby="record-tab-memory" hidden><label class="sr-only" for="memory-search">搜索物品</label><input id="memory-search" type="search" placeholder="搜索名称、外观或位置">${memory}</div><footer class="records-footer"><span>关闭后继续当前任务</span><button id="records-end" type="button" disabled>结束当前对话</button></footer></dialog>
<dialog id="memory-editor" aria-labelledby="memory-editor-title"><form id="memory-edit-form"><header class="section-heading"><h2 id="memory-editor-title">编辑物品记忆</h2><button id="memory-edit-close" type="button">取消</button></header><label for="memory-name">物品名称</label><input id="memory-name" required maxlength="40"><label for="memory-appearance">外观或别称</label><input id="memory-appearance" maxlength="150"><label for="memory-location">位置和参照关系</label><textarea id="memory-location" required maxlength="600" rows="4"></textarea><p class="muted small">例如：书桌靠墙的位置，电脑左侧、台灯旁边。修改后仍是你提供的历史位置。</p><div class="two-buttons"><button id="memory-delete" type="button">删除这条记忆</button><button class="primary" type="submit">保存修改</button></div></form></dialog>
<dialog id="memory-delete-dialog" aria-labelledby="memory-delete-title"><h2 id="memory-delete-title">删除这条物品记忆？</h2><p id="memory-delete-text"></p><div class="two-buttons"><button id="memory-delete-cancel" type="button">保留</button><button id="memory-delete-confirm" type="button">确认删除</button></div></dialog>`;
  template=template.replace(/<main>[\s\S]*?<\/main>/,newMain);
  template=template.replace('</head>','<link rel="stylesheet" href="/static/unified-home.css"><meta name="theme-color" content="#f6f7f2"></head>');
  template=template.replace(/<select id="video-duration">[\s\S]*?<\/select>/,'<select id="video-duration"><option value="300" selected>5 分钟</option><option value="600">10 分钟</option></select>').replace('每轮对话最长 10 分钟','每轮对话最长 15 分钟').replace('点击开始，查看周围','点击开始，准备好后再提问');
  js="import {UnifiedHome} from './unified-home.mjs';\nimport {interfaceCommand} from './interface-commands.mjs';\n"+js;
  // Local records and layout controls must work while the network check waits.
  js=js.replace('await runtime.loaded;',"let accessReady=false;runtime.loaded.then(()=>{accessReady=true;});");
  js=js.replace('(async()=>{try{const status=window.spatialRuntime.status();','(async()=>{try{await runtime.loaded;const status=window.spatialRuntime.status();');
  js=js.replace('function startVoice(options={}){','function startVoice(options={}){\n if(!accessReady)return runtime.loaded.then(()=>startVoice(options));');
  js=js.replace('async function startVideo(goal="",describe=!!goal){','async function startVideo(goal="",describe=!!goal){\n await runtime.loaded;');
  js=js.replace('async function sendText(text){text=text.trim();if(!text)return;',"async function sendText(text){text=text.trim();if(!text)return;const command=interfaceCommand(text);if(command&&(!['confirm','cancel-confirmation'].includes(command.type)||pending)){bubble(text,true);unifiedHome.command(command);return;}");
  js=js.replace('return;}if(!ready&&configured){if(!await startVoice','return;}await runtime.loaded;if(!ready&&configured){if(!await startVoice');
  js=js.replace("async function handleCloud(event){if(event.replay)return;switch(event.type){","async function handleCloud(event){if(event.replay)return;if(event.type==='app.interface_command'){bubble(event.text,true);unifiedHome.command(event.action);return;}switch(event.type){");
  js=js.replace(/function renderMemories\(items\)\{[\s\S]*?\r?\nfunction renderPending/,"function renderMemories(items){unifiedHome.renderMemories();}\nfunction renderPending");
  js=js.replace("$('chat').focus()","$('latest-answer').focus()");
  js=js.replace("if(ready&&!paused)wsSend({type:'text',text:'应用本地程序已执行用户点击的确认/取消，回执：'+result.answer+'。请据此继续，不要再次执行同一个操作。'});","if(ready&&!paused)socket?.noteMemoryReceipt(result);if(!$('screen-reader-mode').checked&&!$('read-aloud').checked)speak(result.answer);");
  const layoutStart=js.indexOf("let layout='split';"),layoutEnd=js.indexOf("new MutationObserver",layoutStart);
  if(layoutStart<0||layoutEnd<0)throw Error('Missing prior layout bindings');
  js=js.slice(0,layoutStart)+`const unifiedHome=new UnifiedHome({document,runtime,conversation,interfaceCommand,
    actions:{send:text=>sendText(text),replay:text=>speak(text),pause:()=>ready?$('pause').click():undefined,resume:()=>{if(paused)$('pause').click();},stop:()=>stop(),confirm:cancel=>confirmPending(!!cancel),settings:trigger=>openSettings(trigger)},
    state:()=>({active:sessionActive(),ready,paused,lastAnswer}),notice:message=>notify(message,0)});
`+js.slice(layoutEnd);
  js=js.replace("function syncPlace(place){$('place-mode').value=place;$('home-memory-section').hidden=place!=='home';}","function syncPlace(place){$('place-mode').value=place;unifiedHome.renderMemories();}");
  js=js.replace("$('end-conversation').hidden=!active;","$('end-conversation').hidden=false;$('end-conversation').disabled=!active;unifiedHome?.syncState();");
  js=js.replace("$('video-again').onclick=()=>startVideo('',true);","$('video-again').onclick=()=>startVideo('',true);");
  return {js,template};
}
