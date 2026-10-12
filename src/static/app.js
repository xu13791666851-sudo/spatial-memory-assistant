const $=id=>document.getElementById(id);
const PAGE=document.body.dataset.page;
let token='',configured=false,socket=null,ready=false,paused=false,audioContext=null,micStream=null,micNode=null,micSource=null,cameraStream=null,pending=null,lastAnswer='',nextAudio=0,sources=new Set(),assistantMessages=new Map(),cloudTokens=0,noticeTimer;
let micGeneration=0,cameraGeneration=0;
let videoId=null,videoOpening=false,videoRequestTimer=null;
const frameStream=new FrameStream();
let voiceGeneration=0,voiceStartPromise=null,voiceResolve=null,voiceTimer=null;
let sid=sessionStorage.getItem('spatial-sid-'+PAGE);if(!sid){sid=crypto.randomUUID();sessionStorage.setItem('spatial-sid-'+PAGE,sid);}
document.querySelectorAll('[data-page-link]').forEach(link=>{if(link.dataset.pageLink===PAGE)link.setAttribute('aria-current','page');link.addEventListener('click',async e=>{if(e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;e.preventDefault();await navigateToPage(link.getAttribute('href'));});});
let settingsTrigger=null;
function openSettings(trigger=$('open-settings')){if(!$('settings-dialog').open){settingsTrigger=trigger;$('settings-dialog').showModal();}}
$('open-settings').onclick=()=>openSettings();
$('settings-dialog').addEventListener('close',()=>settingsTrigger?.focus());
$('settings-close').onclick=()=>$('settings-dialog').close();
for(const [id,key] of [['read-aloud','spatial-read-aloud'],['screen-reader-mode','spatial-screen-reader']]){try{$(id).checked=localStorage.getItem(key)==='true';}catch{}$(id).onchange=()=>{try{localStorage.setItem(key,String($(id).checked));}catch{}if(id==='screen-reader-mode'&&$(id).checked)stopPlayback();};}
async function navigateToPage(url){await stop();location.assign(url);}
function showAnswer(text,cloud=false){$('latest-answer').textContent=text;$('replay').disabled=!text;if($('screen-reader-mode').checked||(!cloud&&!$('read-aloud').checked))$('answer-live').textContent=text;}
function notify(text,duration=10000){$('notice').textContent=text;$('notice').hidden=false;clearTimeout(noticeTimer);if(duration>0)noticeTimer=setTimeout(()=>$('notice').hidden=true,duration);}
async function api(path,body,method='POST'){
 const res=await fetch(path,{method,headers:{'Content-Type':'application/json','X-Local-Token':token},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await res.json();if(!res.ok)throw Error(data.detail||'操作没有完成。');return data;
}
function bubble(text,user=false){const box=document.createElement('div');box.className='bubble'+(user?' user':'');const label=document.createElement('span');label.className='speaker';label.textContent=user?'你':'空间记忆';const content=document.createElement('p');content.textContent=text;box.append(label,content);$('chat').append(box);$('chat').scrollTop=$('chat').scrollHeight;return content;}
function speak(text){if(!window.speechSynthesis){notify('当前浏览器没有可用的本地朗读。');return;}speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text);utterance.lang='zh-CN';utterance.rate=1;utterance.onerror=()=>notify('本地朗读不可用，文字回答仍可查看。');speechSynthesis.speak(utterance);}
function localAnswer(text){lastAnswer=text;bubble(text);showAnswer(text);if($('read-aloud').checked&&!$('screen-reader-mode').checked)speak(text);}
function renderMemories(items){$('count').textContent=`${items.length} 件`;$('memories').replaceChildren();if(!items.length){const p=document.createElement('p');p.className='empty';p.textContent='还没有记录。先告诉我一件物品放在哪里。';$('memories').append(p);return;}
 for(const item of items){const box=document.createElement('div');box.className='memory-item';const title=document.createElement('strong');title.textContent=item.name;const badge=document.createElement('span');badge.className='source';badge.textContent='用户历史记录';title.append(badge);const position=document.createElement('p');position.textContent=item.location;const stamp=document.createElement('time');stamp.textContent=`记录于 ${item.recorded_at.replace('T',' ').slice(0,16)} · 放置时间：${item.event_time}`;box.append(title,position,stamp);$('memories').append(box);}}
function renderPending(value){pending=value;$('pending').hidden=!value||value.action==='ambiguous';if(value){$('pending-text').textContent=`待确认：${{delete:'删除全部记录',correct:'更正原记录',move:'记录新位置',record:'记录'}[value.action]||'说明更正方式'} · ${value.name}${value.location?' → '+value.location:''}`;}}
function applyResult(data){renderMemories(data.items);renderPending(data.pending);localAnswer(data.answer);}
async function refresh(){const data=await api('/api/memories',undefined,'GET');renderMemories(data.items);}
function wsSend(data){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(data));}
async function sendText(text){text=text.trim();if(!text)return;if(PAGE==='video'&&!ready){if(!await startVoice())return;}bubble(text,true);if(ready){if(paused){notify('对话已暂停，请先恢复。');return;}wsSend({type:'text',text});}else{applyResult(await api('/api/command',{sid,text}));}}
$('chat-form').addEventListener('submit',async e=>{e.preventDefault();const text=$('message').value;$('message').value='';try{await sendText(text);}catch(err){notify(err.message);}});
document.querySelectorAll('[data-example]').forEach(button=>button.addEventListener('click',()=>{$('message').value=button.dataset.example;$('message').focus();}));
async function confirmPending(cancel){if(!pending)return;try{const result=await api('/api/confirm',{sid,token:pending.token,cancel});applyResult(result);$('latest-answer').focus();if(ready&&!paused)wsSend({type:'text',text:'应用本地程序已执行用户点击的确认/取消，回执：'+result.answer+'。请据此继续，不要再次执行同一个操作。'});}catch(err){notify(err.message);}}
$('confirm').onclick=()=>confirmPending(false);$('cancel').onclick=()=>confirmPending(true);$('replay').onclick=()=>lastAnswer?speak(lastAnswer):notify('还没有可重播的回答。');
$('settings-form').addEventListener('submit',async e=>{e.preventDefault();if(socket||voiceStartPromise){notify('请先结束当前对话，再更改配置。');return;}try{const result=await api('/api/config',{key:$('key').value,workspace:$('workspace').value.trim(),region:$('region').value});configured=true;$('key').value='';$('config-state').textContent=result.message;$('connection').textContent='连接已设置';$('settings-dialog').close();notify('连接设置已保存，现在可以开始。');}catch(err){$('key').value='';notify(err.message);}});
$('clear-config').onclick=async()=>{await stop();try{await api('/api/config',undefined,'DELETE');configured=false;$('key').value='';$('config-state').textContent='已清除本次配置。';notify('已清除配置并停止采集。');}catch(err){notify(err.message);}};
function stopPlayback(){for(const source of sources){try{source.stop();}catch{}}sources.clear();nextAudio=0;window.speechSynthesis?.cancel();}
function playPCM(encoded){if(!audioContext||paused||$('screen-reader-mode').checked)return;const raw=atob(encoded);if(raw.length%2)return;const data=new DataView(new ArrayBuffer(raw.length));for(let i=0;i<raw.length;i++)data.setUint8(i,raw.charCodeAt(i));const buffer=audioContext.createBuffer(1,raw.length/2,24000);const channel=buffer.getChannelData(0);for(let i=0;i<channel.length;i++)channel[i]=data.getInt16(i*2,true)/32768;const source=audioContext.createBufferSource();source.buffer=buffer;source.connect(audioContext.destination);sources.add(source);source.onended=()=>sources.delete(source);nextAudio=Math.max(nextAudio,audioContext.currentTime+0.04);source.start(nextAudio);nextAudio+=buffer.duration;}
async function stopMic(){micGeneration++;if(micNode){micNode.port.onmessage=null;micNode.disconnect();micNode=null;}if(micSource){micSource.disconnect();micSource=null;}if(micStream){micStream.getTracks().forEach(track=>track.stop());micStream=null;}}
async function startMic(){const generation=++micGeneration;const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});if(generation!==micGeneration||!socket||!ready||!audioContext){stream.getTracks().forEach(t=>t.stop());return false;}micStream=stream;micSource=audioContext.createMediaStreamSource(micStream);micNode=new AudioWorkletNode(audioContext,'mic-recorder');micNode.port.onmessage=e=>{if(ready&&!paused&&socket?.readyState===WebSocket.OPEN&&socket.bufferedAmount<256000)socket.send(e.data);};micSource.connect(micNode);micNode.connect(audioContext.destination);return true;}
function cameraUI(){
 $('video-stop').hidden=!videoId&&!videoOpening;
 $('video-stop').disabled=!videoId&&!videoOpening;
 $('video-duration').disabled=!!videoId||videoOpening;
 $('camera-open').disabled=!!cameraStream||videoOpening;
 $('camera-close').disabled=!cameraStream&&!videoOpening;
 $('camera-send').disabled=!cameraStream||!ready||paused||!!videoId;
 $('camera-preview').hidden=!cameraStream;
 $('video-again').hidden=!ready||!!videoId||videoOpening;
 $('video-again').disabled=paused;
 actionUI();
}
function sessionActive(){return !!(socket||ready||voiceStartPromise||videoId||videoOpening||cameraStream);}
function actionUI(){const active=sessionActive();$('main-toggle').disabled=false;$('main-toggle').textContent=active?(ready?'结束对话':'取消开启'):(PAGE==='video'?'开始观察':'开始对话');$('main-toggle').classList.toggle('active',active);}
function stateUI(text){$('voice-state').textContent=text;$('session-controls').hidden=!socket&&!voiceStartPromise;$('pause').disabled=!ready;$('interrupt').disabled=!ready||paused;cameraUI();document.body.classList.toggle('listening',ready&&!paused);}
async function stopCamera(message='摄像头已关闭，不再采集。'){
 cameraGeneration++;clearTimeout(videoRequestTimer);videoRequestTimer=null;frameStream.stop();
 const oldId=videoId;videoId=null;videoOpening=false;if(oldId)wsSend({type:'video_stop',id:oldId});
 if(cameraStream)cameraStream.getTracks().forEach(t=>t.stop());cameraStream=null;
 $('preview').srcObject=null;$('preview').style.display='none';$('camera-empty').hidden=false;
 $('camera-state').textContent=message;cameraUI();
}
async function openCamera(){
 if(cameraStream)return true;
 const generation=++cameraGeneration;
 $('camera-open').disabled=true;
 try{
  const stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:{ideal:'environment'}},audio:false});
  if(generation!==cameraGeneration){stream.getTracks().forEach(t=>t.stop());return false;}
  cameraStream=stream;$('preview').srcObject=stream;$('preview').style.display='block';$('camera-empty').hidden=true;
  stream.getTracks().forEach(track=>track.onended=()=>{if(cameraStream===stream)stopCamera('摄像头已断开，请重新开启。');});
  cameraUI();return true;
 }catch{
  if(generation===cameraGeneration){await stopCamera('无法打开摄像头，请检查设备和浏览器权限。');notify('无法打开摄像头，请检查设备和浏览器权限。');}
  return false;
 }
}
function captureFrame(){
 const video=$('preview');if(!cameraStream||!video.videoWidth||video.readyState<2)return null;
 const canvas=document.createElement('canvas');const scale=Math.min(1,640/Math.max(video.videoWidth,video.videoHeight));
 canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));
 canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
 let encoded=canvas.toDataURL('image/jpeg',0.65).split(',')[1];
 if(encoded.length>250000){encoded=canvas.toDataURL('image/jpeg',0.4).split(',')[1];}
 if(encoded.length>250000)throw Error('这一张图片过大，请调整画面后重试。');return encoded;
}
async function startVideo(){
 if(paused||videoId||videoOpening)return;
 if(PAGE!=='video')return;
 if(!ready){const generation=cameraGeneration;videoOpening=true;cameraUI();$('camera-state').textContent='正在连接助手，尚未发送画面。';if(!await startVoice()||generation!==cameraGeneration){videoOpening=false;cameraUI();$('camera-state').textContent='视频未开启，可以完成连接设置后再开始。';return;}videoOpening=false;}
 const duration=Number($('video-duration').value);const id=crypto.randomUUID();
 videoId=id;videoOpening=true;cameraUI();$('camera-state').textContent='正在打开摄像头，尚未发送画面。';
 if(!await openCamera()||videoId!==id||!ready||paused)return;
 videoOpening=false;cameraUI();$('camera-state').textContent='正在准备视频观察，尚未发送画面。';
 wsSend({type:'video_start',id,duration});
 videoRequestTimer=setTimeout(()=>{if(videoId===id&&!frameStream.running)stopCamera('视频连接没有准备好，摄像头已关闭。请重新开启。');},8000);
}
function finishVoice(success){clearTimeout(voiceTimer);voiceTimer=null;const resolve=voiceResolve;voiceResolve=null;voiceStartPromise=null;resolve?.(success);}
async function stop(){voiceGeneration++;finishVoice(false);const old=socket;socket=null;ready=false;paused=false;if(old){try{old.send(JSON.stringify({type:'stop'}));}catch{}old.close();}await stopMic();await stopCamera();stopPlayback();if(audioContext){try{await audioContext.close();}catch{}audioContext=null;}$('connection').textContent=configured?'连接已设置':(PAGE==='memory'?'文字记忆可用':'连接尚未设置');$('pause').textContent='暂停对话';stateUI('对话已结束，麦克风已关闭。');}
async function handleCloud(event){switch(event.type){
 case 'app.ready':if(!ready){ready=true;if(!await startMic())return;finishVoice(true);$('connection').textContent='助手已连接';stateUI('正在听你说话');}break;
 case 'app.error':notify(event.message,0);if(voiceStartPromise)await stop();break;
 case 'input_audio_buffer.speech_started':stopPlayback();$('voice-state').textContent='听你说话中…';break;
 case 'input_audio_buffer.speech_stopped':$('voice-state').textContent='正在理解…';break;
 case 'response.audio.delta':playPCM(event.delta);$('voice-state').textContent='正在回答 · 可以打断';break;
 case 'conversation.item.input_audio_transcription.completed':if(event.transcript){bubble(event.transcript,true);if(/^(停止视频|关闭摄像头|停止观察|结束视频)[。！!\s]*$/.test(event.transcript.trim()))await stopCamera('已按你的要求停止视频观察，摄像头已关闭。');}break;
 case 'response.audio_transcript.delta':case 'response.text.delta':{let part=assistantMessages.get(event.item_id);if(!part){part=bubble('');assistantMessages.set(event.item_id,part);}part.textContent+=event.delta;$('chat').scrollTop=$('chat').scrollHeight;break;}
 case 'response.audio_transcript.done':case 'response.text.done':{const text=event.transcript||event.text||'';let part=assistantMessages.get(event.item_id);if(!part)part=bubble(text);else part.textContent=text;lastAnswer=text;showAnswer(text,true);break;}
 case 'app.memory':renderMemories(event.items);renderPending(event.pending);break;
 case 'app.usage':cloudTokens+=Number(event.usage.total_tokens||0);$('usage').textContent=`本轮总用量：${cloudTokens.toLocaleString()} Token（费用以百炼账单为准）`;break;
 case 'app.image_sent':$('camera-state').textContent=event.message;notify(event.message);break;
 case 'app.video_started':{
  if(event.id!==videoId||!ready||paused||!cameraStream)break;
  clearTimeout(videoRequestTimer);videoRequestTimer=null;
  $('camera-state').textContent=`视频观察已开启，${event.duration} 秒后自动关闭摄像头。可以边看边说。`;
  $('video-progress').textContent='已发送 0 张画面。';
  frameStream.start(event.duration,()=>{
   if(!ready||paused||event.id!==videoId||!cameraStream||document.hidden)return false;
   if(socket?.readyState!==WebSocket.OPEN)throw Error('连接已结束。');
   if(socket.bufferedAmount>128000)return false;
   const image=captureFrame();if(!image)return false;wsSend({type:'video_frame',id:videoId,image});return true;
  },message=>stopCamera(message+' 语音对话可以继续。'));
  cameraUI();break;
 }
 case 'app.video_frame':if(event.id===videoId)$('video-progress').textContent=`已发送 ${event.frames} 张画面。`;break;
 case 'app.video_stopped':if(event.id===videoId){await stopCamera(event.message);$('video-progress').textContent=`本次已发送 ${event.frames} 张画面。`;}break;
 case 'app.camera_close':await stopCamera('已按你的要求关闭摄像头。');break;
 case 'app.video_error':await stopCamera(event.message+' 摄像头已关闭。');notify(event.message);break;
}}
function startVoice(){
 if(ready)return Promise.resolve(true);if(voiceStartPromise)return voiceStartPromise;
 if(!configured){openSettings($('main-toggle'));$('key').focus();notify('请先在设置里填写密钥并保存连接。');return Promise.resolve(false);}
 clearTimeout(noticeTimer);$('notice').hidden=true;
 const attempt=++voiceGeneration;const promise=new Promise(resolve=>voiceResolve=resolve);voiceStartPromise=promise;
 stateUI('正在连接助手');
 voiceTimer=setTimeout(()=>{if(attempt===voiceGeneration){notify('连接等待超时，请重新开始。');stop();}},30000);
 (async()=>{try{
  if(!navigator.mediaDevices)throw Error('当前环境不能访问麦克风，请使用支持麦克风的浏览器打开。');
  audioContext=new AudioContext();await audioContext.resume();if(attempt!==voiceGeneration)return;
  await audioContext.audioWorklet.addModule('/static/recorder.js');if(attempt!==voiceGeneration)return;
  cloudTokens=0;assistantMessages.clear();socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/realtime`);
  stateUI('正在连接助手');const current=socket;
  current.onopen=()=>{if(socket===current)wsSend({token,sid,mode:PAGE});};
  current.onmessage=async e=>{if(socket!==current)return;try{await handleCloud(JSON.parse(e.data));}catch(err){notify(err.message);await stop();}};
  current.onerror=()=>{if(socket===current)notify('连接失败，请检查网络和设置。');};
  current.onclose=async()=>{if(socket===current){await stop();notify('连接已结束，麦克风和摄像头已关闭。');}};
 }catch(err){if(attempt===voiceGeneration){notify(err.message);await stop();}}})();
 return promise;
}
$('main-toggle').onclick=async()=>{if(sessionActive())await stop();else if(PAGE==='video')await startVideo();else await startVoice();};
$('pause').onclick=async()=>{if(!ready)return;try{if(!paused){paused=true;wsSend({type:'pause'});await stopMic();await stopCamera();stopPlayback();$('pause').textContent='恢复监听';$('connection').textContent='千问连接保留 · 麦克风关闭';stateUI('监听已暂停 · 点击恢复');}else{if(!await startMic())return;paused=false;wsSend({type:'resume'});$('pause').textContent='暂停监听';$('connection').textContent='千问已连接 · 正在监听';stateUI('正在监听 · 可以连续说话');}}catch(err){notify(err.message);await stop();}};
$('interrupt').onclick=()=>{stopPlayback();wsSend({type:'interrupt'});$('voice-state').textContent='已打断 · 可以继续说话';};
$('camera-open').onclick=async()=>{if(await openCamera())$('camera-state').textContent='本地预览中，尚未发送图片。';};
$('camera-close').onclick=()=>stopCamera();
$('camera-send').onclick=()=>{if(!cameraStream||!ready||paused||videoId)return;try{const image=captureFrame();if(!image){notify('画面还没准备好，请稍等。');return;}wsSend({type:'image',image});}catch(err){notify(err.message);}};
$('video-stop').onclick=()=>videoOpening&&!ready?stop():stopCamera('视频观察已停止，摄像头已关闭。语音对话可以继续。');
$('video-again').onclick=startVideo;
document.addEventListener('visibilitychange',async()=>{if(document.hidden){await stop();}});
window.addEventListener('pagehide',()=>{frameStream.stop();socket?.close();micStream?.getTracks().forEach(t=>t.stop());cameraStream?.getTracks().forEach(t=>t.stop());});
(async()=>{try{const status=await (await fetch('/api/status')).json();token=status.token;configured=status.configured;$('workspace').value=status.workspace;$('region').value=status.region;$('config-state').textContent=configured?'连接已设置。':'连接尚未设置，填写密钥后保存。';$('connection').textContent=configured?'连接已设置':(PAGE==='memory'?'文字记忆可用':'连接尚未设置');if(PAGE==='memory')await refresh();cameraUI();}catch(err){notify('本地程序没有准备好，请刷新或重新启动。');}})();
