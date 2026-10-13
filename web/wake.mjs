const wakeText=text=>{
  const value=String(text||'').trim();
  const match=value.match(/^(?:你好[，,\s]*)?(?:小忆|小意|小易)[，,。！!\s]*(.*)$/);
  if(!match)return null;
  const goal=match[1].replace(/[。！!？?]+$/,'').trim();return {goal:/^(你好|您好)$/.test(goal)?'':goal};
};
export {wakeText};

// Uses the browser's speech service, not the Qwen connection. Foreground only.
export class ForegroundWake{
  constructor({Recognition,schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id),onState=()=>{},onWake=()=>{},isVisible=()=>true}={}){
    Object.assign(this,{Recognition,schedule,cancel,onState,onWake,isVisible});this.enabled=false;this.listening=false;this.generation=0;this.retry=null;
  }
  get supported(){return typeof this.Recognition==='function';}
  enable(){
    if(!this.supported){this.onState('当前浏览器不支持前台语音唤醒，请点击“开始对话”。');return false;}
    this.enabled=true;this.resume();return this.enabled;
  }
  resume(){
    if(!this.enabled||this.recognition||!this.isVisible())return;
    const generation=++this.generation;
    let recognition;try{recognition=new this.Recognition();}catch{this.disable();this.onState('当前浏览器无法使用语音唤醒，请点击“开始对话”。');return;}
    this.recognition=recognition;
    recognition.lang='zh-CN';recognition.continuous=true;recognition.interimResults=false;
    recognition.onstart=()=>{if(generation===this.generation){this.listening=true;this.onState('唤醒待机中，说“小忆”开始观察。');}};
    recognition.onresult=event=>{
      if(generation!==this.generation)return;
      for(let i=event.resultIndex||0;i<event.results.length;i++){
        if(!event.results[i].isFinal)continue;
        const intent=wakeText(event.results[i][0]?.transcript);
        if(intent){this.suspend();this.onState('已唤醒，正在开启助手。');this.onWake(intent);return;}
      }
    };
    recognition.onerror=event=>{
      if(generation!==this.generation)return;
      if(event.error==='no-speech')return;
      this.disable();this.onState(/not-allowed|service-not-allowed/.test(event.error)?'语音唤醒未获授权，请检查浏览器麦克风和语音识别权限，或点击“开始对话”。':'此浏览器的语音唤醒暂不可用，请点击“开始对话”。');
    };
    recognition.onend=()=>{
      if(generation!==this.generation)return;
      this.recognition=null;this.listening=false;
      if(this.enabled&&this.isVisible())this.retry=this.schedule(()=>this.resume(),800);
    };
    try{recognition.start();}catch{this.disable();this.onState('语音唤醒未能开启，请点击“开始对话”。');}
  }
  suspend(){
    this.generation++;this.cancel(this.retry);this.retry=null;this.listening=false;
    const recognition=this.recognition;this.recognition=null;
    if(recognition){recognition.onend=null;recognition.onresult=null;recognition.onerror=null;recognition.onstart=null;try{recognition.abort();}catch{}}
  }
  disable(){this.enabled=false;this.suspend();}
}
