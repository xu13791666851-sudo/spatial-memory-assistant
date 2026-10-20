import {installRetroSkin} from './retro-design.mjs';
import {UnifiedHome} from './unified-home.mjs';
import {ConversationView} from './conversation.mjs';
import {installTextComposer} from './text-composer.mjs';
import {interfaceCommand} from './interface-commands.mjs';
import {containedBox} from './target-overlay.mjs';
import {targetClasses} from './yolo-core.mjs';

// This UI never opens a browser camera, loads WASM, or calls the cloud itself.
const $=id=>document.getElementById(id),bridge=window.NativeAssistant,pending=new Map();
let serial=0,items=[],native={running:false,target:null,searchState:'IDLE'},paused=false,lastAnswer='',place=localStorage.getItem('native-place')||'home',connection='DISCONNECTED',frame=null,frameTimer;
function call(method,params={}){
 if(!bridge)return Promise.reject(Error('请在安卓测试应用中打开此界面。'));
 return new Promise((resolve,reject)=>{const id=String(++serial),timer=setTimeout(()=>{pending.delete(id);reject(Error('操作等待超时，请重试。'));},method==='provision'?45000:25000);pending.set(id,{resolve,reject,timer});bridge.postMessage(JSON.stringify({id,method,params}));});
}
if(bridge)bridge.onmessage=e=>{let message;try{message=JSON.parse(e.data);}catch{return;}const request=pending.get(message.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(Error(message.error)):request.resolve(message.result);};
function notice(text){$('notice').textContent=text;$('notice').hidden=false;setTimeout(()=>$('notice').hidden=true,5000);}
function answer(text,meta={}){if(!text||text===lastAnswer)return;lastAnswer=text;$('latest-answer').textContent=text;if($('screen-reader-mode').checked)$('answer-live').textContent=text;conversation.add(text,false,meta);}
const runtime={
 memory:{all:()=>items,answer:name=>{const r=items.find(x=>x.name===name);return r?`${r.name}上次记录：${r.location}。`:'没有读到这条记录。';}},
 targetOverlayState:()=>null,
 taskState:()=>({target:native.target,awaiting_save_clarification:native.searchState==='LEARNING',search:{target:native.target,state:paused?'paused':native.searchState==='GUIDING'?'found':['SEARCHING','VERIFYING'].includes(native.searchState)?'searching':'idle',notice:native.message||''}}),
 perceptionState:()=>null
};
const conversation=new ConversationView({document,storage:localStorage,onReplay:text=>call('replay',{text}).catch(e=>notice(e.message)),onError:notice,place:()=>place});
const home=new UnifiedHome({document,runtime,conversation,state:()=>({active:native.running,ready:native.running,paused,lastAnswer}),notice,
 actions:{send:text=>send(text),stop:()=>perform('stop'),pause:()=>perform('pause'),resume:()=>perform('resume'),replay:text=>call('replay',{text}),settings:()=>{$('settings-dialog').showModal();},confirm:()=>notice('当前没有待确认操作。')}
});
const renderMemory=home.renderMemories.bind(home);home.renderMemories=()=>{renderMemory();for(const [i,record]of items.entries()){const node=$('memories').querySelectorAll('.memory-item')[i];if(node&&record.sample_count&&!record.appearance)node.querySelector('.memory-appearance').textContent=`已保存 ${record.sample_count} 个本机外观样本。`;}};
async function editMemory(){const r=home.editing;if(!r)return;const p={id:r.id,recorded_at:r.recorded_at,name:$('memory-name').value,appearance:$('memory-appearance').value,location:$('memory-location').value};try{const result=await call('editMemory',p);items=result.items;home.renderMemories();$('memory-editor').close();answer(result.answer,{saved:true});}catch(e){$('memory-edit-error').hidden=false;$('memory-edit-error').textContent=e.message;}}
$('memory-edit-form').onsubmit=e=>{e.preventDefault();editMemory();};
$('memory-delete-confirm').onclick=async()=>{try{const result=await call('deleteMemory',home.deleting);items=result.items;home.renderMemories();$('memory-delete-dialog').close();$('memory-editor').close();answer(result.answer);}catch(e){$('memory-delete-error').hidden=false;$('memory-delete-error').textContent=e.message;}};

async function perform(method){try{await call(method);if(method==='pause')paused=true;if(['start','resume'].includes(method)){paused=false;conversation.begin();}if(method==='stop'){paused=false;conversation.end();}sync();return true;}catch(e){notice(e.message);return false;}}
async function send(text){
 text=text.trim();if(!text)return false;
 const action=interfaceCommand(text);if(action){conversation.add(text,true);home.command(action);return true;}
 if(/^(?:暂停寻找|暂停找物)$/.test(text))return perform('pause');
 if(/^(?:继续找|继续寻找)$/.test(text)&&paused){if(!await perform('resume'))return false;if(native.target)await call('search',{target:native.target});return true;}
 if(!native.running){if(!await perform('start'))return false;}
 if(paused)return false;
 await call('text',{text});conversation.add(text,true);return true;
}
function clearFrame(){frame=null;clearTimeout(frameTimer);photo.hidden=true;box.hidden=true;$('camera-empty').hidden=false;}
function sync(){
 $('end-conversation').hidden=false;$('end-conversation').disabled=!native.running&&!paused;$('replay').disabled=!lastAnswer;
 $('voice-state').textContent=paused?'已暂停':native.running?(connection==='CONNECTED'?'本机 YOLO · 千问已连接':'本机 YOLO · 千问连接中'):'手机摄像头 · 尚未开始';
 $('connection').textContent=native.error||native.message||'安卓本机识别已就绪';$('place-mode').value=place;
 if(!native.running||paused)clearFrame();home.syncState();
}
const preview=$('camera-preview'),photo=document.createElement('img');photo.id='native-preview';photo.alt='手机或硬件的当前摄像头画面';photo.hidden=true;preview.hidden=false;preview.append(photo);
const box=document.createElement('div');box.className='memory-target-overlay';box.hidden=true;box.setAttribute('aria-hidden','true');const label=document.createElement('span');label.className='memory-target-label';box.append(label);preview.append(box);
let aliases={},labels=[];
function drawBox(){
 box.hidden=true;if(!frame||!native.running||paused||Date.now()-frame.capturedAt>3000||!native.rememberedObjectId||!items.some(r=>r.id===native.rememberedObjectId)||!['SEARCHING','VERIFYING','GUIDING'].includes(native.searchState))return;
 const classes=targetClasses(native.target,labels,aliases),candidates=frame.detections.filter(d=>classes.includes(d.label)&&d.confidence>=.5);
 if(candidates.length!==1)return;
 const rect=preview.getBoundingClientRect(),geometry=containedBox(candidates[0].box,rect.width,rect.height,frame.width,frame.height);if(!geometry)return;
 // The native core publishes a confirmed box tied to its verification frame.
 const confirmed=native.searchState==='GUIDING'&&native.verifiedBox&&Date.now()-native.verifiedAt<3000&&overlap(candidates[0].box,native.verifiedBox)>.5;
 box.dataset.status=confirmed?'confirmed':'pending';for(const [k,v]of Object.entries(geometry))box.style[k]=v+'px';label.textContent=native.target+' · '+(confirmed?'外观已核对':'待核对');label.style.transform=geometry.top>35?'translateY(-100%)':'none';box.hidden=false;
}
function overlap(a,b){const intersection=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));return intersection/((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection||1);}
window.nativeEvent=({type,data})=>{
 if(type==='state'){native=data;paused=data.paused||paused;sync();if(data.error)notice(data.error);if(data.searchState==='LEARNING')$('latest-answer').textContent=data.message;}
 if(type==='connection'){connection=data.state;sync();}
 if(type==='answer')answer(data.text,{saved:/已经记住/.test(data.text)});
 if(type==='memories'){items=data.items;home.renderMemories();}
 if(type==='transcript'){
  if(data.role==='user'){conversation.add(data.text,true);const action=interfaceCommand(data.text);if(action)home.command(action);}
  else answer(data.text);
 }
 if(type==='frame'){
  if(!native.running||paused||Date.now()-data.capturedAt>3000)return;frame=data;photo.src='data:image/jpeg;base64,'+data.image;photo.hidden=false;$('camera-empty').hidden=true;drawBox();clearTimeout(frameTimer);frameTimer=setTimeout(()=>{box.hidden=true;photo.hidden=true;},3000);
 }
};
photo.onload=drawBox;new ResizeObserver(drawBox).observe(preview);
$('main-toggle').onclick=()=>perform(native.running?'pause':paused?'resume':'start');$('camera-start-target').onclick=$('video-again').onclick=$('camera-open').onclick=()=>perform('start');$('camera-send').onclick=()=>send('帮我看看眼前有什么');$('camera-close').onclick=$('video-stop').onclick=()=>perform('stop');$('end-conversation').onclick=()=>perform('stop');$('pause').onclick=()=>perform(paused?'resume':'pause');
$('replay').onclick=()=>call('replay',{text:lastAnswer}).catch(e=>notice(e.message));$('settings-close').onclick=()=>$('settings-dialog').close();
$('place-mode').onchange=()=>{place=$('place-mode').value;localStorage.setItem('native-place',place);};
$('answer-size').onchange=()=>{document.documentElement.style.setProperty('--answer-size',$('answer-size').value+'px');localStorage.setItem('native-answer-size',$('answer-size').value);};
document.documentElement.style.setProperty('--answer-size',(localStorage.getItem('native-answer-size')||'18')+'px');

$('screen-reader-mode').checked=localStorage.getItem('native-reader')==='true';
$('read-aloud').checked=localStorage.getItem('native-read-local')!=='false';
$('fast-describe').checked=true;$('fast-describe').disabled=true;
$('fast-describe').closest('label').lastChild.textContent='找物提示使用手机声音（安卓核心）';
const audioSettings=()=>{localStorage.setItem('native-reader',String($('screen-reader-mode').checked));localStorage.setItem('native-read-local',String($('read-aloud').checked));return call('audioSettings',{reader:$('screen-reader-mode').checked,readLocal:$('read-aloud').checked}).catch(e=>notice(e.message));};
$('screen-reader-mode').onchange=$('read-aloud').onchange=audioSettings;
$('settings-form').onsubmit=async e=>{e.preventDefault();try{const s=await call('status');$('config-state').textContent=`安卓本机 YOLO 已就绪，支持 ${s.labels} 类；千问状态：${s.connection}。`;}catch(e){$('config-state').textContent=e.message;}};
$('search-cancel').onclick=()=>call('cancel');$('search-pause').onclick=()=>perform(paused?'resume':'pause');
installTextComposer({document,window,send,state:()=>({paused})});
$('pixel-records-home').onclick=()=>home.close();
installRetroSkin({document,state:()=>({active:native.running||paused,ready:native.running||paused,paused,source:native.source==='ESP32'?'硬件摄像头':'手机摄像头'})});
window.nativeBack=()=>{for(const id of ['text-composer','memory-delete-dialog','memory-editor','records-dialog','settings-dialog']){if($(id).open){$(id).close();return true;}}if(native.running){perform('stop');return true;}return false;};
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearFrame();});

// Hardware controls live inside the existing settings entrance; the homepage is unchanged.
$('native-scan').onclick=async()=>{try{$('native-hardware-status').textContent='正在扫描…';const devices=await call('scan');$('native-devices').replaceChildren(...devices.map(d=>{const o=document.createElement('option');o.value=d.id;o.textContent=d.name+' · '+d.signal;return o;}));$('native-hardware-status').textContent=devices.length?'请选择设备，再填写 Wi-Fi。':'没有发现配网设备。';}catch(e){$('native-hardware-status').textContent=e.message;}};
$('native-provision').onclick=async()=>{try{await call('provision',{deviceId:$('native-devices').value,ssid:$('native-ssid').value,password:$('native-password').value});$('native-password').value='';$('native-hardware-status').textContent='硬件配网完成。';}catch(e){$('native-hardware-status').textContent=e.message;}};
$('native-connect').onclick=async()=>{try{await call('hardware',{baseUrl:$('native-device-url').value,streamUrl:$('native-stream-url').value,token:$('native-device-token').value,legacy:$('native-legacy').checked});$('native-device-token').value='';$('native-hardware-status').textContent='硬件已连接。';}catch(e){$('native-hardware-status').textContent=e.message;}};
$('native-source').onchange=async()=>{try{await call('source',{source:$('native-source').value});notice('视频来源已切换，点击开始即可使用。');}catch(e){notice(e.message);}};
try{const ready=await call('ready');native=ready.state;items=ready.memories;const assets=await import('./native-labels.mjs');labels=assets.labels;aliases=assets.aliases;sync();drawBox();$('config-state').textContent='安卓本机识别已就绪，点击开始即可使用。';}catch(e){notice(e.message);}
// Exposed for the packaged-UI contract test; never substitutes for the native core.
export {call,runtime,home};
