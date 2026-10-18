export class SceneSpeech{
  constructor({synth,Utterance,onStart=()=>{},onDone=()=>{},schedule=(fn,ms)=>setTimeout(fn,ms),cancelTimer=id=>clearTimeout(id)}={}){
    Object.assign(this,{synth,Utterance,onStart,onDone,schedule,cancelTimer});this.generation=0;this.active=null;
  }
  begin(token){this.cancel();this.token=token;this.text='';this.spoken=0;this.queue=[];this.final=false;this.finished=false;}
  append(text){
    if(!this.token||this.finished)return;this.text+=text;
    let end=this.spoken;for(let i=this.spoken;i<this.text.length;i++)if(/[。！？!?；;]/.test(this.text[i]))end=i+1;
    if(end>this.spoken){const sentence=this.text.slice(this.spoken,end).trim();if(sentence)this.queue.push(sentence);this.spoken=end;}this.next();
  }
  finish(answer){
    if(!this.token||this.finished)return;
    if(answer.startsWith(this.text))this.append(answer.slice(this.text.length));
    else if(!this.spoken)this.text=answer;
    if(this.spoken<this.text.length){const tail=this.text.slice(this.spoken).trim();if(tail)this.queue.push(tail);this.spoken=this.text.length;}
    this.final=true;this.next();
  }
  reply(event){
    if(!['response.text.delta','response.text.done'].includes(event.type))return;
    const id=event.item_id||event.response_id;
    if(!id||this.ignoredReplies?.has(id))return;
    if(this.replyId!==id){this.begin('reply:'+id);this.replyId=id;}
    if(event.type==='response.text.delta')this.append(event.delta||'');
    else this.finish(event.text||this.text);
  }
  next(){
    if(this.active||this.finished||!this.token)return;
    if(!this.queue.length){if(this.final)this.complete(false);return;}
    const generation=this.generation,token=this.token,utterance=new this.Utterance(this.queue.shift());this.active=utterance;utterance.lang='zh-CN';utterance.rate=1;
    const voices=this.synth.getVoices?.()||[];
    const chinese=voices.filter(v=>/^zh(-|_)/i.test(v.lang));
    const voice=chinese.find(v=>v.localService&&/^zh[-_]CN$/i.test(v.lang))||chinese.find(v=>/^zh[-_]CN$/i.test(v.lang))||chinese[0];
    if(voice)utterance.voice=voice;
    let timer=this.schedule(()=>{if(this.active===utterance&&generation===this.generation){this.complete(true);this.synth.cancel();}},2000);
    utterance.onstart=()=>{this.cancelTimer(timer);if(generation===this.generation&&this.token===token&&!this.finished)this.onStart(token);};
    utterance.onend=()=>{this.cancelTimer(timer);if(generation!==this.generation)return;this.active=null;this.next();};
    utterance.onerror=e=>{this.cancelTimer(timer);if(generation!==this.generation)return;this.active=null;this.complete(!['canceled','interrupted'].includes(e.error));};
    try{this.synth.speak(utterance);}catch{this.cancelTimer(timer);this.active=null;this.complete(true);}
  }
  complete(failed){if(this.finished||!this.token)return;this.finished=true;const token=this.token;this.token=null;this.queue=[];this.onDone(token,failed);}
  cancel(){
    if(this.replyId){this.ignoredReplies||=new Set();this.ignoredReplies.add(this.replyId);if(this.ignoredReplies.size>64)this.ignoredReplies.delete(this.ignoredReplies.values().next().value);this.replyId=null;}
    this.generation++;const token=this.token;this.token=null;this.active=null;this.queue=[];this.finished=true;this.synth?.cancel();if(token)this.onDone(token,false);
  }
}
