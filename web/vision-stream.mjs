export class VisionStream{
  constructor({url,WebSocket:Socket=globalThis.WebSocket,timeoutMs=30000}){Object.assign(this,{url,Socket,timeoutMs});}
  open(signal){
    if(signal?.aborted)return Promise.reject(Error('observation_cancelled'));
    if(this.opening)return this.opening;
    this.closed=false;
    this.opening=new Promise((resolve,reject)=>{
      this.openReject=reject;const socket=this.socket=new this.Socket(this.url);
      this.openTimer=setTimeout(()=>this.close('持续观察连接超时，请稍后重新寻找。'),12000);
      const abort=()=>this.close('observation_cancelled');signal?.addEventListener('abort',abort,{once:true});
      this.openCleanup=()=>signal?.removeEventListener('abort',abort);
      socket.onmessage=event=>{
        if(this.closed||socket!==this.socket)return;
        try{
          if(typeof event.data!=='string'||event.data.length>100000)throw Error('bad_message');const data=JSON.parse(event.data);
          if(data.type==='ready'&&data.protocol===1){clearTimeout(this.openTimer);this.openCleanup();resolve();return;}
          if(data.type==='error')throw Error('stream_failed');
          if(data.type==='observation'){
            const pending=this.pending;if(!pending||data.request_id!==pending.request_id)throw Error('stale_result');
            this.pending=null;clearTimeout(pending.timer);pending.cleanup();pending.resolve(data);
          }
        }catch{this.close('持续观察连接已中断，请说“继续找”重新开始。');}
      };
      socket.onerror=socket.onclose=()=>this.close('持续观察连接已中断，请说“继续找”重新开始。');
    });
    // Cancellation may occur before an awaiting caller is installed.
    this.opening.catch(()=>{});return this.opening;
  }
  async observe(frame,signal){
    await this.open(signal);
    if(this.closed||signal?.aborted)throw Error('observation_cancelled');
    if(this.pending)throw Error('已有画面正在识别。');
    return new Promise((resolve,reject)=>{
      const abort=()=>this.close('observation_cancelled');
      const pending={request_id:frame.request_id,resolve,reject,cleanup:()=>signal?.removeEventListener('abort',abort)};
      this.pending=pending;signal?.addEventListener('abort',abort,{once:true});
      pending.timer=setTimeout(()=>this.close('这次画面识别超时，请说“继续找”重新开始。'),this.timeoutMs);
      try{this.socket.send(JSON.stringify({type:'observe',...frame}));}catch{this.close('持续观察发送失败，请重新寻找。');}
    });
  }
  close(message='observation_cancelled'){
    if(this.closed)return;this.closed=true;clearTimeout(this.openTimer);this.openCleanup?.();this.openReject?.(Error(message));
    const pending=this.pending;this.pending=null;
    if(pending){clearTimeout(pending.timer);pending.cleanup();pending.reject(Error(message));}
    try{this.socket?.close();}catch{}
  }
}
