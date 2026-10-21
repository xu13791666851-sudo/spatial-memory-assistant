import {fingerprint,motionChanged} from './target-overlay.mjs';

// Transport adapter for the same pixel page and command contract as Android.
// Actual media stays in the browser; detection/samples/tasks run on the server.
window.WebDemoBridge=true;
const $=id=>document.getElementById(id);
let csrf='',state={},cursor=0,rev=-1,stream=null,voice=null,voiceReady=false,context=null,source=null,worklet=null,gain=null,active=false,timer=null,pollTimer=null,generation=0,controller=null,nextAudio=0,lastBox=null;
const sounds=new Set(),capture=document.createElement('canvas'),motion=document.createElement('canvas');motion.width=24;motion.height=18;
const video=$('preview');
const bootstrap=fetch('/api/demo/bootstrap',{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('演示后台暂时未连接，请刷新重试。');const data=await r.json();csrf=data.csrf;return data;});
function emit(type,data){window.nativeEvent?.({type,data});}
function message(text){emit('state',{...state,error:text});}
function stopPlayback(){for(const sound of sounds){try{sound.stop();}catch{}}sounds.clear();nextAudio=0;window.speechSynthesis?.cancel();}
function unlock(){if(!context){const Audio=window.AudioContext||window.webkitAudioContext;if(Audio)context=new Audio();}context?.resume().catch(()=>{});}
function localSpeak(text){if(!window.speechSynthesis)return;const speech=new SpeechSynthesisUtterance(text);speech.lang='zh-CN';speech.rate=1;window.speechSynthesis.cancel();window.speechSynthesis.speak(speech);}
function speak(text,cloud=false){
 if(localStorage.getItem('native-reader')==='true'||(!cloud&&localStorage.getItem('native-read-local')==='false'))return;
 if(voiceReady&&voice?.readyState===1)voice.send(JSON.stringify({type:'speak',text}));else localSpeak(text);
}
function play(audio){
 if(!context||localStorage.getItem('native-reader')==='true')return;
 const binary=atob(audio),pcm=new Int16Array(Uint8Array.from(binary,c=>c.charCodeAt(0)).buffer),buffer=context.createBuffer(1,pcm.length,24000),samples=buffer.getChannelData(0);
 for(let i=0;i<pcm.length;i++)samples[i]=pcm[i]/32768;
 const sound=context.createBufferSource();sound.buffer=buffer;sound.connect(context.destination);const at=Math.max(context.currentTime+.025,nextAudio);sound.start(at);nextAudio=at+buffer.duration;sounds.add(sound);sound.onended=()=>sounds.delete(sound);
}
function apply(data){
 if(data.rev>=rev){rev=data.rev;state=data.state;emit('state',state);emit('memories',{items:data.memories});}
 for(const event of data.events||[]){if(event.id<=cursor)continue;cursor=event.id;emit(event.type,event.data);if(event.type==='answer')speak(event.data.text,!!event.data.cloud);}
 if(data.frame&&active&&data.state.epoch===state.epoch){emit('frame',data.frame);const box=state.verifiedBox;if(box){try{lastBox={mark:fingerprint(video,box,motion),box};}catch{lastBox=null;}}}
}
async function api(path,body,signal){
 const response=await fetch('/api/demo/'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-Demo-CSRF':csrf},...(body===undefined?{}:{body:JSON.stringify({...body,since:cursor})}),signal,cache:'no-store'});
 const data=await response.json();if(!response.ok)throw Error(data.detail||'这次请求没有完成，请重试。');apply(data);return data;
}
function stopLocal(){
 active=false;generation++;clearTimeout(timer);clearTimeout(pollTimer);controller?.abort();controller=null;lastBox=null;
 if(voice){try{voice.send(JSON.stringify({type:'stop'}));}catch{}voice.close();voice=null;}voiceReady=false;
 worklet?.disconnect();source?.disconnect();gain?.disconnect();worklet=source=gain=null;
 stream?.getTracks().forEach(track=>track.stop());stream=null;video.srcObject=null;video.style.display='none';
 stopPlayback();if(context){context.close().catch(()=>{});context=null;}
 emit('connection',{state:'DISCONNECTED'});
}
async function startMedia(){
 unlock();
 if(!navigator.mediaDevices?.getUserMedia)throw Error('请用 Safari 在 HTTPS 的独立网页中打开，才能使用相机和麦克风。');
 stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:960},height:{ideal:720}},audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
 video.srcObject=stream;video.muted=true;video.playsInline=true;video.style.display='block';await video.play();
}
async function startVoice(token){
 const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/demo/voice`);voice=ws;
 ws.onopen=()=>ws.send(JSON.stringify({csrf}));
 ws.onmessage=async({data})=>{
  if(token!==generation||!active)return;
  const event=JSON.parse(data);
  if(event.type==='ready'){
   voiceReady=true;emit('connection',{state:'CONNECTED'});
   try{
    await context.audioWorklet.addModule('/static/demo-mic.js');if(token!==generation)return;
    source=context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));worklet=new AudioWorkletNode(context,'demo-mic');gain=context.createGain();gain.gain.value=0;
    worklet.port.onmessage=({data:input})=>{if(!active||ws.readyState!==1||ws.bufferedAmount>64000)return;const step=context.sampleRate/16000,size=Math.floor(input.length/step),out=new Int16Array(size);for(let i=0;i<size;i++)out[i]=Math.max(-1,Math.min(1,input[Math.floor(i*step)]))*32767;ws.send(out.buffer);};
    source.connect(worklet);worklet.connect(gain);gain.connect(context.destination);
   }catch{message('麦克风声音尚未接通，请重新开始；也可以使用记录页里的文字输入。');}
  }
  if(event.type==='transcript')emit('transcript',{role:'user',text:event.text});
  if(event.type==='audio')play(event.audio);
  if(event.type==='interrupt')stopPlayback();
  if(event.type==='error'){voiceReady=false;emit('connection',{state:'FAILED'});message(event.message);}
 };
 ws.onclose=()=>{if(token===generation&&active){voiceReady=false;emit('connection',{state:'FAILED'});message('语音连接已断开，文字输入仍可使用；可结束后重新开始连接。');}};
 ws.onerror=()=>{};
}
async function nextFrame(token){
 if(!active||token!==generation||document.hidden)return;
 try{
  if(video.readyState>=2){
   const scale=Math.min(1,960/video.videoWidth);capture.width=Math.round(video.videoWidth*scale);capture.height=Math.round(video.videoHeight*scale);
   capture.getContext('2d').drawImage(video,0,0,capture.width,capture.height);
   const capturedAt=Date.now();controller=new AbortController();const timeout=setTimeout(()=>controller?.abort(),15000);
   try{await api('frame',{id:capturedAt,capturedAt,epoch:state.epoch,image:capture.toDataURL('image/jpeg',.8).split(',')[1]},controller.signal);}finally{clearTimeout(timeout);controller=null;}
  }
 }catch(error){if(token===generation&&error.name!=='AbortError')message(error.message);}
 if(active&&token===generation)timer=setTimeout(()=>nextFrame(token),500);
}
async function poll(token){
 if(!active||token!==generation)return;
 try{await api('state?since='+cursor);}catch(error){if(token===generation)message(error.message);}
 if(active&&token===generation)pollTimer=setTimeout(()=>poll(token),900);
}
async function invoke(method,params){
 if(['start','resume'].includes(method))unlock();
 const initial=await bootstrap;
 if(method==='ready'){
  if(initial.state.running)await api('command',{method:'stop',params:{}});
  const data=await api('state?since=0');return {state:data.state,memories:data.memories};
 }
 if(method==='audioSettings'){if(params.reader)stopPlayback();return true;}
 if(method==='replay'){speak(String(params.text||''),true);return true;}
 if(['start','resume'].includes(method)){
  stopLocal();unlock();
  try{await startMedia();const data=await api('command',{method,params});active=true;const token=generation;void startVoice(token);void nextFrame(token);void poll(token);setTimeout(()=>{if(active&&generation===token)void invoke('stop',{});},10*60*1000);return data.result;}
  catch(error){stopLocal();await api('command',{method:'stop',params:{}}).catch(()=>{});throw error;}
 }
 if(['stop','pause'].includes(method))stopLocal();
 const data=await api('command',{method,params});return data.result;
}
window.NativeAssistant={postMessage:raw=>{const request=JSON.parse(raw);invoke(request.method,request.params||{}).then(result=>window.NativeAssistant.onmessage?.({data:JSON.stringify({id:request.id,result})}),error=>window.NativeAssistant.onmessage?.({data:JSON.stringify({id:request.id,error:error.message})}));}};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&active){stopLocal();fetch('/api/demo/command',{method:'POST',headers:{'Content-Type':'application/json','X-Demo-CSRF':csrf},body:JSON.stringify({method:'stop',params:{},since:cursor}),keepalive:true}).catch(()=>{});emit('state',{...state,running:false,paused:false,target:null,searchState:'IDLE'});}});
window.addEventListener('pagehide',()=>{if(active){stopLocal();fetch('/api/demo/command',{method:'POST',headers:{'Content-Type':'application/json','X-Demo-CSRF':csrf},body:JSON.stringify({method:'stop',params:{}}),keepalive:true}).catch(()=>{});}});
setInterval(()=>{if(!lastBox||!active)return;try{if(motionChanged(lastBox.mark,fingerprint(video,lastBox.box,motion))){document.querySelectorAll('.memory-target-overlay').forEach(node=>node.hidden=true);lastBox=null;}}catch{lastBox=null;}},160);
// The web demonstration deliberately uses the phone camera only.
$('native-scan').closest('details').hidden=true;
$('open-accessibility').textContent='声音与设置';
if(window.top!==window.self){const hint=document.createElement('p');hint.className='demo-standalone';const link=document.createElement('a');link.href=location.href;link.target='_blank';link.rel='noopener';link.textContent='在独立窗口打开，使用摄像头和麦克风';hint.append(link);document.body.prepend(hint);}
