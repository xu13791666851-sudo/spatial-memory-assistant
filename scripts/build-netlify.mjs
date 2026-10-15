import fs from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),dist=path.join(root,'dist');
await fs.mkdir(path.join(dist,'static'),{recursive:true});
await fs.cp(path.join(root,'src/static'),path.join(dist,'static'),{recursive:true});
await fs.copyFile(path.join(root,'web/assistant.css'),path.join(dist,'static/assistant.css'));
await fs.copyFile(path.join(root,'web/memory.mjs'),path.join(dist,'static/memory.mjs'));
await fs.copyFile(path.join(root,'web/runtime.mjs'),path.join(dist,'static/runtime.mjs'));
for(const name of ['interaction','wake','context','stream','scene-speech','person-context'])await fs.copyFile(path.join(root,`web/${name}.mjs`),path.join(dist,`static/${name}.mjs`));
let js=await fs.readFile(path.join(root,'src/static/app.js'),'utf8');
js=js.replace("const PAGE=document.body.dataset.page;","import {runtime} from './runtime.mjs';\nlet PAGE=document.body.dataset.page;\nawait runtime.loaded;");
js=js.replace("const res=await fetch(path,", "if(window.spatialRuntime)return window.spatialRuntime.api(path,body,method);\n const res=await fetch(path,");
js=js.replace(/async function startMic\(\)\{[^\n]*\}\r?\nfunction cameraUI/,"async function startMic(){const generation=++micGeneration;const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});if(generation!==micGeneration||!socket||!ready){stream.getTracks().forEach(t=>t.stop());return false;}micStream=stream;await socket.attachAudio(stream);return generation===micGeneration&&!!socket&&ready;}\nfunction cameraUI");
js=js.replace("await audioContext.audioWorklet.addModule('/static/recorder.js');",'');
js=js.replace("function stopPlayback(){", "function stopPlayback(){sceneSpeech?.cancel();socket?.stopPlayback?.();");
js=js.replace("socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/realtime`);", "socket=new window.spatialRuntime.Bridge();");
js=js.replace("const status=await (await fetch('/api/status')).json();", "const status=window.spatialRuntime.status();");
js=js.replace(/\$\('settings-form'\)\.addEventListener\('submit',[^\n]*\);/,"$('settings-form').addEventListener('submit',async e=>{e.preventDefault();try{const result=await api('/api/config');configured=result.configured;$('config-state').textContent=result.message;$('connection').textContent='连接已设置';notify(result.message);}catch(err){configured=false;$('config-state').textContent=err.message;notify(err.message);}});");
js=js.replace(/\$\('clear-config'\)\.onclick=[^\n]*;/,'');
js=js.replaceAll("$('key').focus()","$('config-state').focus()");
js=js.replace("$('workspace').value=status.workspace;$('region').value=status.region;",'');
js=js.replaceAll('请先在设置里填写密钥并保存连接。','后台连接尚未就绪，请在设置中检查连接。');
js=js.replace("configured?'连接已设置。':'连接尚未设置，填写密钥后保存。'", "configured?'连接已就绪，无须登录，点击开始对话即可。':'后台连接暂不可用，请点击检查连接；若仍未就绪，请联系管理员。'");
js=js.replace("if(id==='screen-reader-mode'&&$(id).checked)stopPlayback();", "if(id==='screen-reader-mode')socket?.updatePlayback?.();if(id==='screen-reader-mode'&&$(id).checked)stopPlayback();");
js=js.replace("case 'app.error':", "case 'app.audio_blocked':notify(event.message,0);break;\n case 'app.error':");
js=js.replace("width:{ideal:640},height:{ideal:480},facingMode", "width:{ideal:640,max:640},height:{ideal:480,max:640},frameRate:{ideal:24,max:30},facingMode");
js=js.replace("const image=captureFrame();if(!image)return false;wsSend({type:'video_frame',id:videoId,image});return true;", "wsSend({type:'video_tick',id:videoId});return true;");
js=js.replaceAll('已发送 0 张画面。','已观察 0 秒。').replaceAll('已发送 ${event.frames} 张画面。','已观察 ${event.frames} 秒。').replaceAll('本次已发送 ${event.frames} 张画面。','本次已观察 ${event.frames} 秒。');
js=js.replace("async function navigateToPage(url){await stop();location.assign(url);}",`async function navigateToPage(url,push=true){
  await stop();
  PAGE=url==='/memory'?'memory':'video';document.body.dataset.page=PAGE;
  document.querySelector('h1').textContent=PAGE==='memory'?'语音记忆':'视频理解';
  document.title=(PAGE==='memory'?'语音记忆':'视频理解')+' · 空间记忆';
  lastAnswer='';$('replay').disabled=true;$('answer-live').textContent='';
  $('latest-answer').textContent=PAGE==='memory'?'你可以说：钥匙在哪？':'开始观察后，你可以问：我手里拿的是什么？';
  $('message').placeholder=PAGE==='memory'?'例如：钥匙在哪':'输入你想问的问题';
  $('connection').textContent=configured?'连接已设置':(PAGE==='memory'?'文字记忆可用':'连接尚未设置');
  document.querySelectorAll('[data-page-link]').forEach(a=>{if(a.dataset.pageLink===PAGE)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  if(push)history.pushState({},'',url);if(PAGE==='memory')await refresh();
  stateUI('点击开始后，直接说话就可以。');
}window.addEventListener('popstate',()=>navigateToPage(location.pathname,false));`);
// The hosted assistant keeps vision and memory in one session and one page.
js=js.replace('let PAGE=document.body.dataset.page;','const PAGE="assistant";');
js=js.replace(/document.querySelectorAll\('\[data-page-link\]'\)\.forEach\(link=>\{[^\n]*\}\);\r?\n/,'');
js=js.replace(/async function navigateToPage\(url,push=true\)\{[\s\S]*?window.addEventListener\('popstate',\(\)=>navigateToPage\(location.pathname,false\)\);/,'');
js=js.replace("if(PAGE!=='video')return;","if(PAGE!=='video'&&PAGE!=='assistant')return;");
js=js.replaceAll("PAGE==='video'?'开始观察':'开始对话'","'开始对话'");
js=js.replace("else if(PAGE==='video')await startVideo();","else if(PAGE==='video'||PAGE==='assistant')await startVideo();");
js=js.replace("if(PAGE==='memory')await refresh();",'await refresh();');
js=js.replaceAll("(PAGE==='memory'?'文字记忆可用':'连接尚未设置')","'文字记忆可用'");
js=js.replace("delete:'删除全部记录'","delete:'删除这件物品的记录'");
js=js.replace('本地程序没有准备好，请刷新或重新启动。','网页没有准备好，请刷新后重试。');
js=js.replace("await stop();notify('连接已结束，麦克风和摄像头已关闭。');","await stop();if($('notice').hidden)notify('连接已结束，麦克风和摄像头已关闭。');");
js=js.replace("import {runtime} from './runtime.mjs';","import {runtime} from './runtime.mjs';\nimport {ForegroundWake} from './wake.mjs';\nimport {SceneSpeech} from './scene-speech.mjs';\nlet sceneSpeech=null,sceneText='';");
js=js.replace('function startVoice(){','function startVoice(){\n wake.suspend();');
js=js.replace('bubble(text,true);if(ready){','bubble(text,true);if(ready){stopPlayback();');
js=js.replace(/function speak\(text\)\{[^\n]*\}/,`function speak(text){
 if($('screen-reader-mode').checked){$('answer-live').textContent=text;return;}
 if(!$('fast-describe').checked){void replayWithQwen(text);return;}
 if(!sceneSpeech){notify('当前浏览器没有可用的手机朗读，文字回答仍可查看。');return;}
 stopPlayback();sceneSpeech.begin('device:'+crypto.randomUUID());sceneSpeech.finish(text);
}`);
js=js.replace("if($('read-aloud').checked&&!$('screen-reader-mode').checked)speak(text);","if(($('read-aloud').checked||$('fast-describe').checked)&&!$('screen-reader-mode').checked)speak(text);");
js=js.replace('function stateUI(text){',"function stateUI(text){$('fast-describe').disabled=sessionActive()||!window.speechSynthesis||!window.SpeechSynthesisUtterance;");
js=js.replace("$('replay').onclick=()=>lastAnswer?speak(lastAnswer):notify('还没有可重播的回答。');","$('replay').onclick=()=>{if(!lastAnswer){notify('还没有可重播的回答。');return;}if($('fast-describe').checked)socket?.prepareDeviceReplay();speak(lastAnswer);};");
js=js.replace("part.textContent+=event.delta;$('chat').scrollTop=$('chat').scrollHeight;break;","part.textContent+=event.delta;$('chat').scrollTop=$('chat').scrollHeight;if($('fast-describe').checked&&!$('screen-reader-mode').checked)sceneSpeech?.reply(event);break;");
js=js.replace('lastAnswer=text;showAnswer(text,true);break;',"lastAnswer=text;showAnswer(text,true);if($('fast-describe').checked&&!$('screen-reader-mode').checked)sceneSpeech?.reply(event);break;");
js=js.replace('audioContext=new AudioContext();await audioContext.resume();','audioContext=audioContext||new AudioContext();await audioContext.resume();');
js=js.replace("else{if(!await startMic())return;paused=false;wsSend({type:'resume'});","else{wsSend({type:'resume'});if(!await startMic())return;paused=false;");
js=js.replace(/async function startVideo\(\)\{[\s\S]*?\r?\n\}\r?\nfunction finishVoice/,`async function startVideo(goal="",observe=false){
 if(paused||videoId||videoOpening)return;
 if(!configured){await startVoice();return;}
 primeSpeech();
 const duration=Number($('video-duration').value),id=crypto.randomUUID();
 videoId=id;videoOpening=true;cameraUI();$('camera-state').textContent='正在打开摄像头，同时连接语音助手。';
 const previewReady=openCamera();
 const voiceReady=ready?true:await startVoice();
 const cameraReady=await previewReady;
 if(videoId!==id)return;
 if(!voiceReady||!cameraReady||!ready||paused){await stopCamera('本次观察未能开启，请重新开始。');return;}
 videoOpening=false;cameraUI();$('camera-state').textContent=observe||goal?'画面已显示，正在准备查看。':'画面已显示。你可以先调整方向，准备好后再提问。';
 wsSend({type:'video_start',id,duration,goal,observe});
 videoRequestTimer=setTimeout(()=>{if(videoId===id&&!frameStream.running)stopCamera('视频连接没有准备好，摄像头已关闭。请重新开启。');},8000);
}
function finishVoice`);
js=js.replace('cameraStream=stream;$(\'preview\').srcObject=stream;$(\'preview\').style.display=\'block\';$(\'camera-empty\').hidden=true;',`cameraStream=stream;$('preview').muted=true;$('preview').playsInline=true;$('preview').srcObject=stream;$('preview').style.display='block';$('camera-empty').hidden=true;cameraUI();await $('preview').play();if(generation!==cameraGeneration)return false;`);
js=js.replace("stateUI('对话已结束，麦克风已关闭。');}","stateUI('对话已结束，麦克风已关闭。');if(wake.enabled&&!document.hidden)setTimeout(()=>{if(!sessionActive()&&!document.hidden)wake.resume();},600);}");
js=js.replace("$('video-again').onclick=startVideo;","$('video-again').onclick=()=>startVideo('',true);");
js=js.replace("case 'app.memory':",`case 'app.observe':if(!paused&&!videoId&&!videoOpening)await startVideo(event.goal,true);break;
 case 'app.introduction':localAnswer(event.answer);if(!$('screen-reader-mode').checked&&!$('read-aloud').checked&&!$('fast-describe').checked)speak(event.answer);break;
 case 'app.scene_begin':sceneText='';$('replay').disabled=true;sceneSpeech?.begin(event.token);break;
 case 'app.scene_delta':sceneText+=event.text;$('latest-answer').textContent=sceneText;sceneSpeech?.append(event.text);break;
 case 'app.scene_cancel':sceneSpeech?.cancel();break;
 case 'app.scene_answer':playSceneAnswer(event.answer,event.token,event.streamed);break;
 case 'app.scene_fallback':localAnswer(event.answer);if(!$('screen-reader-mode').checked&&!$('read-aloud').checked&&!$('fast-describe').checked)speak(event.answer);break;
 case 'app.device_voice_error':notify(event.message,0);break;
 case 'app.scene_loading':$('camera-state').textContent='正在识别当前画面，请稍候。';$('scene-time').textContent='';break;
 case 'app.scene_ready':$('camera-state').textContent='识别完成，正在准备播报。你可以接着问物品的位置。';$('scene-time').textContent='本次画面时间：'+new Date(event.observedAt).toLocaleTimeString('zh-CN')+(Number.isFinite(event.durationMs)?' · 识别用时 '+(event.durationMs/1000).toFixed(1)+' 秒（含网络等待）':'');break;
 case 'app.place_changed':syncPlace(event.place);renderPending(null);localAnswer(event.answer);break;
 case 'app.memory_result':renderMemories(event.items);renderPending(event.pending);localAnswer(event.answer);if(!$('read-aloud').checked&&!$('screen-reader-mode').checked&&!$('fast-describe').checked)speak(event.answer);break;
 case 'app.memory':`);
js=js.replace("if(event.transcript){bubble(event.transcript,true);","if(event.transcript){bubble(event.transcript,true);if(/^(结束对话|退出对话)[。！!\\s]*$/.test(event.transcript.trim())){await stop();break;}");
js=js.replace("case 'app.video_started':{","case 'app.video_started':{");
js=js.replace('视频观察已开启，${event.duration} 秒后自动关闭摄像头。可以边看边说。',"${event.observe?'正在准备识别当前画面。':'你可以先调整手机方向，准备好后再提问。'}${event.duration>=60?event.duration/60+' 分钟':event.duration+' 秒'}后关闭摄像头，语音继续。");
js+=`\nconst wake=new ForegroundWake({Recognition:window.SpeechRecognition||window.webkitSpeechRecognition,isVisible:()=>!document.hidden,
 onState:message=>{$('wake-state').textContent=message;$('wake-toggle').textContent=wake.enabled?'关闭语音唤醒':'启用语音唤醒（前台）';if(!sessionActive())$('voice-state').textContent=message;},
 onWake:async({goal})=>{try{await new Promise(resolve=>setTimeout(resolve,350));if(!document.hidden)await startVideo(goal,!!goal);}catch{notify('唤醒后未能开启，请点击“开始对话”。');}}
});
$('wake-toggle').onclick=async()=>{if(wake.enabled){wake.disable();$('wake-state').textContent='语音唤醒已关闭。';$('wake-toggle').textContent='启用语音唤醒（前台）';if(!sessionActive())$('voice-state').textContent='';return;}
 if(sessionActive()){notify('请先结束对话，再启用唤醒待机。');return;}
 if(!configured){openSettings($('wake-toggle'));notify('后台连接尚未就绪，请先在设置中检查连接。');return;}
 if(wake.supported){primeSpeech();try{audioContext=audioContext||new AudioContext();await audioContext.resume();}catch{}}
 wake.enable();
};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&wake.enabled){wake.disable();$('wake-state').textContent='离开页面后，语音唤醒已关闭。';$('wake-toggle').textContent='启用语音唤醒（前台）';}});
window.addEventListener('pagehide',()=>wake.disable());
function syncPlace(place){$('place-mode').value=place;$('home-memory-section').hidden=place!=='home';}
syncPlace(runtime.place());
$('place-mode').onchange=()=>{try{const result=runtime.setPlace($('place-mode').value);syncPlace(result.place);if(!socket)localAnswer(result.answer);}catch(err){notify(err.message);syncPlace(runtime.place());}};
try{const fast=localStorage.getItem('spatial-device-voice-v1');if(fast!==null)$('fast-describe').checked=fast==='true';}catch{}
if(!window.speechSynthesis||!window.SpeechSynthesisUtterance){$('fast-describe').checked=false;$('fast-describe').disabled=true;$('device-voice-note').textContent='当前浏览器不支持手机朗读，将使用千问声音。';}
$('fast-describe').onchange=()=>{if(sessionActive()){notify('请先结束对话，再切换声音。');return;}try{localStorage.setItem('spatial-device-voice-v1',String($('fast-describe').checked));}catch{}};
async function replayWithQwen(text){
 try{
  if(paused){notify('请先恢复对话，再听一遍。');return;}
  if(!ready){if(sessionActive()){notify('正在连接，请稍后再听一遍。');return;}if(!await startVoice())return;}
  stopPlayback();socket?.replayAnswer(text);$('voice-state').textContent='正在请千问再读一遍。';
 }catch{notify('重播未能完成，请重新连接后再试。');}
}
function applyAnswerSize(){document.documentElement.style.setProperty('--answer-size',$('answer-size').value+'px');}
try{const size=localStorage.getItem('spatial-answer-size');if(['18','22','28'].includes(size))$('answer-size').value=size;}catch{}
applyAnswerSize();$('answer-size').onchange=()=>{applyAnswerSize();try{localStorage.setItem('spatial-answer-size',$('answer-size').value);}catch{}};
sceneSpeech=window.speechSynthesis?new SceneSpeech({synth:speechSynthesis,Utterance:SpeechSynthesisUtterance,
 onStart:()=>{$('voice-state').textContent='正在用手机声音回答，可以打断。';},
 onDone:(token,failed)=>{socket?.finishLocalSpeech(token,failed);if(failed&&/^(reply:|device:)/.test(token))notify('手机朗读未能播放，文字已保留。请点击“再听一遍”，或结束对话后切换千问声音。',0);if(ready)$('voice-state').textContent='正在听你说话';}
}):null;
function playSceneAnswer(text,token,streamed=false){
 const bridge=socket;lastAnswer=text;bubble(text);$('latest-answer').textContent=text;$('replay').disabled=false;
 if($('screen-reader-mode').checked){$('answer-live').textContent=text;bridge?.finishLocalSpeech(token);return;}
 if(!sceneSpeech){bridge?.finishLocalSpeech(token,true);return;}
 if(!streamed)sceneSpeech.begin(token);sceneSpeech.finish(text);
}
function primeSpeech(){if(!window.speechSynthesis)return;try{const primer=new SpeechSynthesisUtterance('准备好');primer.lang='zh-CN';primer.volume=0;speechSynthesis.speak(primer);}catch{}}
`;
let template=await fs.readFile(path.join(root,'src/static/index.html'),'utf8');
template=template.replace('</head>','<link rel="stylesheet" href="/static/assistant.css"></head>');
template=template.replace('密钥仅保存在本次程序运行的内存中。','密钥仅保存在当前页面内存中。建立连接时经本站 Netlify 函数用于千问鉴权；程序不保存密钥，刷新后需重新填写。');
template=template.replace('这里是之前告诉我的位置，尚未确认现在是否仍在那里。','记录只保存在当前浏览器中，清除浏览器数据会删除；它们是历史位置，尚未确认现在是否仍在那里。');
template=template.replace('本地程序没有准备好','网页没有准备好');
template=template.replace('发送一张照片','查看当前画面');
template=template.replace(/<form id="settings-form">[\s\S]*?<\/form>/,'<form id="settings-form"><p>无需登录或填写访问码。点击“开始对话”，允许摄像头和麦克风后即可使用。千问密钥由管理员保存在后台。</p><button class="full-width" type="submit">检查连接</button></form>');
template=template.replace('id="config-state"','id="config-state" tabindex="-1"');
template=template.replace(/密钥仅保存在当前页面内存中。建立连接时经本站 Netlify 函数用于千问鉴权；程序不保存密钥，刷新后需重新填写。/,'千问密钥由管理员保存在 Netlify 后台，不会发送到网页。');
template=template.replace('语音、视频识别效果及手机真机仍待测试；NFC 和房间定位尚未接入。','公网版使用浏览器实时通话。实际千问连接、摄像头及 iPhone 体验仍需真机验证；NFC 和房间定位尚未接入。');
template=template.replace('<details class="disclosure"><summary>对话记录','<audio id="remote-audio" autoplay playsinline aria-label="助手语音" hidden></audio><details class="disclosure"><summary>对话记录');
template=template.replace('<script src="/static/video-stream.js"></script><script src="/static/app.js"></script>','<script src="/static/video-stream.js"></script><script type="module" src="/static/app.js"></script>');
template=template.replace('<div class="preferences">','<div class="preferences"><label for="answer-size">描述文字大小</label><select id="answer-size"><option value="18" selected>标准</option><option value="22">大字</option><option value="28">特大</option></select><label class="checkbox"><input id="fast-describe" type="checkbox" checked aria-describedby="device-voice-note">使用手机声音：描述、对话和重播</label><p id="device-voice-note" class="muted small">测试版默认使用手机或浏览器的中文朗读。千问负责理解问题和图片，不生成播报声音；文字生成完整句子后即可朗读。结束对话后可取消勾选，切回千问声音。手机重播无需重新连接千问。</p>');
template=template.replace(/<p class="intro memory-only">[\s\S]*?<\/p>\s*<p class="intro video-only">[\s\S]*?<\/p>/,'<p class="intro">看物品、记位置，需要时直接问我。</p>');
template=template.replace('<section class="answer-card"','<div class="place-control"><label for="place-mode">当前场景</label><select id="place-mode"><option value="explore">普通场景</option><option value="home">家</option></select><p class="muted small">也可以说“我在家”或“我出门了”。只有在家中场景才使用已确认的物品位置记录。</p></div><section class="answer-card"');
template=template.replace('<details class="disclosure memory-only"><summary>我的物品记忆','<details id="home-memory-section" class="disclosure memory-only" hidden><summary>我的物品记忆');
template=template.replace(/<nav class="bottom-nav"[\s\S]*?<\/nav>/,'');
template=template.replace('<title>{{title}} · 空间记忆</title>','<title>{{title}}</title>');
template=template.replace(/\b(memory-only|video-only)\b/g,'');
template=template.replace('点击开始后，可以边看边说。','').replace('点击开始后，直接说话就可以。','');
template=template.replace(/<p id="session-privacy"[\s\S]*?<\/p>/,'<p id="session-privacy" class="muted small">开始后开启语音和摄像头，先简短介绍，等待你提问后才识别画面。摄像头默认 2 分钟后关闭，随后语音继续；说“停止观察”可提前关闭摄像头。</p>');
template=template.replace(/<select id="video-duration">[\s\S]*?<\/select>/,'<select id="video-duration"><option value="60">1 分钟</option><option value="120" selected>2 分钟</option><option value="300">5 分钟</option></select>');
template=template.replace('<p id="camera-state"','<p id="scene-time" class="muted small" aria-live="off"></p><p id="camera-state"');
template=template.replace('<div class="more-content">','<div class="more-content"><details class="disclosure"><summary>语音唤醒入口</summary><button id="wake-toggle" class="full-width" type="button">启用语音唤醒（前台）</button><p id="wake-state" role="status">先启用，再说“小忆”开始对话，或直接说“小忆，找水杯”。</p><p class="muted small">仅在网页保持打开时工作。浏览器语音识别可能使用系统或在线服务；待机不连接千问。结束对话后回到唤醒待机，关闭唤醒才停止待机监听。锁屏或离开页面会关闭唤醒。不支持时可直接点击“开始对话”。</p></details>');
template=template.replace('观察画面时优先口头提问；文字交流需要先连接助手。','不开启摄像头也可用文字记录和查询位置。识别画面或自由对话请先点击“开始对话”。');
template=template.replace('删除全部记录','删除记录');
const values={page:'assistant',title:'空间记忆助手',welcome:'点击开始后，先听简短介绍。\n你可以先调整手机方向，再问：“眼前有什么？”\n或告诉我你想找什么。',placeholder:'例如：眼前有什么，或找水杯'};
// Keep the complete camera field above a compact, scrollable answer and two controls.
const answerCard=template.match(/<section class="answer-card"[\s\S]*?<\/section>/)?.[0];
if(!answerCard)throw Error('Assistant answer panel missing');
template=template.replace(answerCard,'').replace(/<p class="intro">[\s\S]*?<\/p>/,'');
template=template.replace('<div id="main-action"',answerCard+'\n<div id="main-action"');
template=template.replace('id="camera-state"','id="camera-state" class="sr-only"').replace('id="voice-state" class=""','id="voice-state" class="sr-only"');
template=template.replace('id="scene-time" class="muted small"','id="scene-time" class="sr-only"').replace('id="session-privacy" class="muted small"','id="session-privacy" class="sr-only"');
template=template.replace(/<div class="">\s*(<p id="scene-time"[\s\S]*?<\/p>\s*<p id="camera-state"[\s\S]*?<\/p>)\s*<\/div>/,'<div class="sr-only">$1</div>');
template=template.replace('<p>摄像头未开启</p>','<p>点击开始，先听介绍</p>');
// Show an idle placeholder in the same large camera area.
js=js.replace("$('camera-preview').hidden=!cameraStream;","$('camera-preview').hidden=false;");
await fs.writeFile(path.join(dist,'static/app.js'),js);
let html=template;
for(const [key,value]of Object.entries(values))html=html.replaceAll(`{{${key}}}`,value);
await fs.writeFile(path.join(dist,'index.html'),html);
for(const alias of ['video','memory']){
  await fs.mkdir(path.join(dist,alias),{recursive:true});await fs.writeFile(path.join(dist,alias,'index.html'),html);
}
// Include routing rules in the published directory as well as project config.
await fs.writeFile(path.join(dist,'_redirects'),'/memory /video/ 301!\n/ /video/ 302!\n');
await fs.appendFile(path.join(dist,'static/style.css'),'\nbody[data-page=assistant] main{padding-bottom:calc(32px + env(safe-area-inset-bottom))}body[data-page=assistant] .notice{bottom:calc(20px + env(safe-area-inset-bottom))}body[data-page=assistant] .session p[role=status]:empty{display:none}\n');
await fs.appendFile(path.join(dist,'static/style.css'),'.place-control{margin:12px 0 18px}.place-control label{display:block;font-weight:700;margin-bottom:6px}.place-control select{width:100%;min-height:48px}.place-control p{margin:6px 0 0}\n');
console.log('Netlify build ready: one assistant page with vision, voice and explicit memory commands.');

