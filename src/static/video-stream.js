// Timer ownership is separate from camera permissions and cloud acknowledgements.
class FrameStream {
 constructor({now=()=>performance.now(),interval=(fn,ms)=>setInterval(fn,ms),clearIntervalFn=id=>clearInterval(id),timeout=(fn,ms)=>setTimeout(fn,ms),clearTimeoutFn=id=>clearTimeout(id)}={}){
  Object.assign(this,{now,interval,clearIntervalFn,timeout,clearTimeoutFn});this.running=false;this.generation=0;
 }
 start(seconds,capture,onStop){
  if(![10,30,60,120,300].includes(seconds))throw Error('观察时长无效。');
  this.stop();const generation=++this.generation;this.running=true;this.sent=0;this.deadline=this.now()+seconds*1000;
  const finish=reason=>{if(generation!==this.generation)return;this.stop();onStop(reason);};
  const tick=()=>{
   if(!this.running||generation!==this.generation)return;
   if(this.now()>=this.deadline||this.sent>=seconds){finish('已到观察时长，摄像头已关闭。');return;}
   try{if(capture())this.sent++;}catch{finish('画面发送未完成，摄像头已关闭。请重新开启。');}
  };
  this.timer=this.interval(tick,1000);this.limit=this.timeout(()=>finish('已到观察时长，摄像头已关闭。'),seconds*1000);tick();
 }
 stop(){this.running=false;this.generation++;this.clearIntervalFn(this.timer);this.clearTimeoutFn(this.limit);this.timer=null;this.limit=null;}
}
if(typeof module!=='undefined')module.exports={FrameStream};
