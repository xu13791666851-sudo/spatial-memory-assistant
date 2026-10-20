import {requestText} from './memory.mjs';
import {asksHistory} from './interaction.mjs';
import {searchTarget} from './find-dialogue.mjs';

export function continuousTarget(text,focus=''){
  if(asksHistory(text)||/找不到|找到了|找不着/.test(text))return '';
  const value=requestText(text).replace(/^(?:开始|持续)(?=找|寻找)/,'');
  return /^(?:找|寻找)/.test(value)?searchTarget(value,focus):'';
}

// The transport owns frame capture. Only schedule another capture after the
// previous result was consumed; never queue images taken during an old request.
export class ContinuousSearch{
  constructor({observe,onState=()=>{},onExpire=()=>{},clock=()=>Date.now(),setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id)}={}){
    Object.assign(this,{observe,onState,onExpire,clock,setTimer,clearTimer});
    this.state='idle';this.intervalMs=8000;this.serial=0;this.lastRequest=-Infinity;
  }
  snapshot(){return {state:this.state,target:this.task?.target||null};}
  publish(){this.onState(this.snapshot());}
  start(plan){
    this.stop();this.id=++this.serial;this.task={...plan.task,saveToken:null,scanId:this.id};this.goal=plan.goal;
    this.state='searching';this.hits=0;this.publish();
    this.expiry=this.setTimer(()=>{if(!this.running)return;this.pause();this.onExpire();},120000);
    this.schedule(1000);
  }
  get running(){return this.state==='searching'||this.state==='confirming';}
  schedule(delay=0){
    this.clearTimer(this.timer);const id=this.id;
    this.timer=this.setTimer(()=>{
      if(!this.running||id!==this.id)return;
      if(this.observe(this.goal,this.task)===false)this.schedule(1000);
    },Math.max(delay,this.intervalMs-(this.clock()-this.lastRequest)));
  }
  requested(){this.lastRequest=this.clock();}
  accept(result,frameStatus){
    const match=frameStatus==='clear'&&result.target_visible===true&&
      (!this.task.reference_appearance||result.appearance_match?.status==='match');
    this.hits=match?this.hits+1:0;
    if(this.hits>=2){this.clearTimer(this.expiry);this.state='found';this.publish();return true;}
    this.state=match?'confirming':'searching';this.publish();this.schedule();return false;
  }
  pause(){if(!this.running)return;this.clearTimer(this.timer);this.clearTimer(this.expiry);this.hits=0;this.state='paused';this.publish();}
  stop(){this.clearTimer(this.timer);this.clearTimer(this.expiry);this.id=++this.serial;this.hits=0;this.state='idle';this.task=null;this.publish();}
}
