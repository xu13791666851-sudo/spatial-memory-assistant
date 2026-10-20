import {icon,wordmark} from '../web/retro-design.mjs';
// Final presentation layer: keep the existing media/session owners and move
// only the home layout. Records and their controls keep the original markup.
export function applyCameraLayout(js,template){
 const originalRecords=template.match(/<dialog id="records-dialog"[\s\S]*?<\/dialog>/)?.[0];
 const take=(pattern,label)=>{const value=template.match(pattern)?.[0];if(!value)throw Error('Missing camera layout '+label);template=template.replace(value,'');return value;};
 const camera=take(/<section class="camera-panel[^>]*>[\s\S]*?<\/section>/,'camera');
 const pending=take(/<section id="pending"[\s\S]*?<\/section>/,'confirmation');
 const main=take(/<button id="main-toggle"[^>]*>[\s\S]*?<\/button>/,'start');
 const records=take(/<button id="open-records"[^>]*>[\s\S]*?<\/button>/,'records').replace(/>[\s\S]*<\/button>/,'>对话记录</button>');
 const answer=take(/<p id="latest-answer"[^>]*>[\s\S]*?<\/p>/,'answer');
 const live=['answer-live','voice-state','camera-state'].map(id=>take(new RegExp('<p id="'+id+'"[^>]*>[\\s\\S]*?<\\/p>'),id)).join('');
 const oldMain=template.match(/<main[\s\S]*?<\/main>/)?.[0];
 // Legacy status nodes are still consumed by the session; keep them offscreen.
 const support=oldMain.replace(/^<main[^>]*>/,'<div hidden id="session-support">').replace(/<\/main>$/,'</div>');
 template=template.replace(oldMain,`<main class="camera-app pixel-frame" aria-label="空间记忆助手"><h1 class="sr-only">空间记忆助手</h1><div class="camera-brand" aria-hidden="true">${icon('logo')}${wordmark()}</div><section class="camera-stage" aria-label="拍摄画面">${camera}<div class="camera-topline"><span id="camera-session-status" role="status">尚未开始</span><span id="scene-label">普通场景</span></div><div class="camera-caption sr-only" hidden>${answer}</div>${pending}</section><footer id="main-action" class="camera-actions" tabindex="-1">${main}${records}</footer>${live}${support}</main>`);
 // There must be only one action landmark after moving the primary button.
 template=template.replace('<div id="main-action" class="main-actions" tabindex="-1">','<div class="legacy-actions">');
 template=template.replace(/<label class="scene-picker"[\s\S]*?<\/label>/,'');
 template=template.replace('</head>','<link rel="stylesheet" href="/static/camera-home.css"></head>');
 template=template.replace('点击开始，准备好后再提问','点击开始，和小忆说话');
 // Retain preview controls only as internal compatibility hooks. Recovery uses
 // the primary button, so the camera surface never grows another action row.
 template=template.replace('<section class="camera-panel','<section class="camera-panel camera-full');
 js=js.replace("import {installRetroSkin} from './retro-design.mjs';","import {installCameraHome} from './camera-home.mjs';");
 js=js.replace("installRetroSkin({document,state:()=>({active:sessionActive(),ready,paused})});","installCameraHome({document,runtime,state:()=>({active:sessionActive(),ready,paused,camera:!!cameraStream,opening:videoOpening})});");
 js=js.replace("function syncPlace(place){$('place-mode').value=place;unifiedHome.renderMemories();}","function syncPlace(place){$('scene-label').textContent=place==='home'?'家中场景':'普通场景';unifiedHome.renderMemories();}");
 js=js.replace(/^\$\('place-mode'\)\.onchange=.*$/m,'');
 const oldHandler="$('main-toggle').onclick=async()=>{if(ready){$('pause').click();return;}if(sessionActive())await stop();else if(PAGE==='video'||PAGE==='assistant')await startVideo();else await startVoice();};";
 if(!js.includes(oldHandler))throw Error('Missing main session action');
 js=js.replace(oldHandler,"$('main-toggle').onclick=async()=>{try{if(paused){await $('pause').onclick();if(ready&&!cameraStream)await startVideo();}else if(ready&&!cameraStream&&!videoOpening){await startVideo();}else if(sessionActive())await stop();else await startVideo();}catch(err){notify(err.message);}};");
 if(template.match(/<dialog id="records-dialog"[\s\S]*?<\/dialog>/)?.[0]!==originalRecords)throw Error('Camera layout must not change records');
 return {js,template};
}
