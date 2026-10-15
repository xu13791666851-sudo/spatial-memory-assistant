export const asksHistory=text=>/(之前|以前|上次|昨天|前天|记忆|记录|记得|曾经|放哪了|放到哪了|记过)/.test(String(text||''));
export function observationCommand(text){
  text=String(text||'').trim().replace(/[，,。.!！?？\s]/g,'');
  if(/^(?:小忆|小意|小易)(?:你好)?$/.test(text))return {goal:''};
  text=text.replace(/^(?:你好)?(?:小忆|小意|小易)[，,]?/,'');
  if(/^(?:请|帮我)?(?:再看(?:一)?下|再看看|再观察(?:一下|一次)?|重新观察|看(?:一)?下(?:周围)?|看看周围|描述(?:一下)?(?:环境|周围)|开启摄像头|打开摄像头|开始观察)$/.test(text))return {goal:''};
  if(/^(?:请|帮我)?(?:(?:看看|看一下|描述一下))?(?:我(?:的)?)?(?:眼前|面前|周围|当前画面|这个场景)(?:有(?:些|点)?什么|是什么样(?:的)?|是什么环境)$/.test(text))return {goal:''};
  const match=text.match(/^(?:请|帮我)?(?:找(?:一下)?|寻找|看看)(.{1,40})$/);
  if(match&&!asksHistory(text))return {goal:text};
  return null;
}
export function currentViewIntent(text){
  text=String(text||'').trim();if(asksHistory(text))return null;
  const command=observationCommand(text);if(command)return command;
  if(/(在哪里|在哪儿|在哪|哪边|哪一边|什么位置|相对位置|具体位置|这是什么|这.{0,12}是什么|旁边是什么|有什么|看到了什么|描述.{0,5}(环境|画面)|手里.{0,8}什么|穿.{0,8}什么|什么颜色)/.test(text))return {goal:text};
  return null;
}

// Called after track attachment. Preview readiness alone is not a cloud acknowledgement.
export class ObservationGate{
  constructor({schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id),now=()=>Date.now(),settleMs=1200,timeoutMs=8000,requireTransmission=true,pollMs=250}={}){
    Object.assign(this,{schedule,cancel,now,settleMs,timeoutMs,requireTransmission,pollMs});this.generation=0;this.timer=null;
  }
  stop(){this.generation++;this.cancel(this.timer);this.timer=null;}
  start({preview,sender,baseline,stillCurrent,onReady,onError}){
    this.stop();const generation=this.generation,started=this.now();
    const tick=async()=>{
      if(generation!==this.generation||!stillCurrent())return;
      const track=preview.srcObject?.getVideoTracks?.()[0];
      const visible=!!track&&track.readyState!=='ended'&&!track.muted&&preview.videoWidth>0&&preview.videoHeight>0&&preview.readyState>=2&&!preview.paused;
      let transmitted=false;
      if(visible){
        try{
          if(!this.requireTransmission)transmitted=true;
          else if(sender?.getStats){
            const stats=await sender.getStats();
            stats.forEach(r=>{if(r.type==='outbound-rtp'&&(r.kind==='video'||r.mediaType==='video')&&(r.bytesSent||0)>(baseline?.bytes||0))transmitted=true;});
          }else transmitted=true;
        }catch{transmitted=false;}
      }
      if(generation!==this.generation||!stillCurrent())return;
      if(visible&&transmitted&&this.now()-started>=this.settleMs){this.timer=null;onReady();return;}
      if(this.now()-started>=this.timeoutMs){this.timer=null;onError('还没有收到可用的摄像头画面，请调整镜头后重新观察。');return;}
      this.timer=this.schedule(tick,this.pollMs);
    };
    this.timer=this.schedule(tick,this.pollMs);
  }
}
