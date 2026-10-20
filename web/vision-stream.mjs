const retryableCodes=new Set(['gateway_connect_timeout','model_ready_timeout','frame_timeout','network_error','observation_timeout','observation_connect_timeout','observation_network_error','observation_disconnected','stream_unavailable','stream_failed','session_expired']);
export class VisionStreamError extends Error{
  constructor(code,message){super(message);this.code=code;this.retryable=retryableCodes.has(code);}
}
export class VisionStream{
  constructor({url,WebSocket:Socket=globalThis.WebSocket,timeoutMs=30000,openTimeoutMs=25000}){Object.assign(this,{url,Socket,timeoutMs,openTimeoutMs});}
  open(signal){
    if(signal?.aborted)return Promise.reject(new VisionStreamError('observation_cancelled','observation_cancelled'));
    if(this.closed)return Promise.reject(this.closeError);
    if(this.opening)return this.opening;
    this.opening=new Promise((resolve,reject)=>{
      this.openReject=reject;
      let socket;try{socket=this.socket=new this.Socket(this.url);}catch{this.close('持续观察连接未建立。','network_error');return;}
      this.openTimer=setTimeout(()=>this.close(this.gatewayConnected?'视觉服务准备超时。':'持续观察连接超时。',this.gatewayConnected?'model_ready_timeout':'gateway_connect_timeout'),this.openTimeoutMs);
      const abort=()=>this.close('observation_cancelled');signal?.addEventListener('abort',abort,{once:true});
      this.openCleanup=()=>signal?.removeEventListener('abort',abort);
      socket.onopen=()=>{this.gatewayConnected=true;};
      socket.onmessage=event=>{
        if(this.closed||socket!==this.socket)return;
        try{
          if(typeof event.data!=='string'||event.data.length>100000)throw Error('bad_message');const data=JSON.parse(event.data);
          if(data.type==='ready'&&data.protocol===1){clearTimeout(this.openTimer);this.openCleanup();resolve();return;}
          if(data.type==='error'){
            const code=typeof data.code==='string'?data.code:'protocol_error';
            this.close(code==='rate_limited'?'观察请求较频繁，请稍等片刻再继续寻找。':'持续观察服务暂时不可用。',code);return;
          }
          if(data.type==='observation'){
            const pending=this.pending;if(!pending||data.request_id!==pending.request_id)throw Error('stale_result');
            this.pending=null;clearTimeout(pending.timer);pending.cleanup();pending.resolve(data);
          }
        }catch{this.close('画面结果未能对应，连接已中断。','protocol_error');}
      };
      socket.onerror=socket.onclose=()=>this.close('持续观察连接已中断。','network_error');
    });
    this.opening.catch(()=>{});return this.opening;
  }
  async observe(frame,signal){
    await this.open(signal);
    if(this.closed||signal?.aborted)throw new VisionStreamError('observation_cancelled','observation_cancelled');
    if(this.pending)throw new VisionStreamError('observation_busy','已有画面正在识别。');
    return new Promise((resolve,reject)=>{
      const abort=()=>this.close('observation_cancelled');
      const pending={request_id:frame.request_id,resolve,reject,cleanup:()=>signal?.removeEventListener('abort',abort)};
      this.pending=pending;signal?.addEventListener('abort',abort,{once:true});
      pending.timer=setTimeout(()=>this.close('这张画面识别超时。','frame_timeout'),this.timeoutMs);
      try{this.socket.send(JSON.stringify({type:'observe',...frame}));}catch{this.close('持续观察发送失败。','network_error');}
    });
  }
  close(message='observation_cancelled',code='observation_cancelled'){
    if(this.closed)return;this.closed=true;clearTimeout(this.openTimer);this.openCleanup?.();const error=this.closeError=new VisionStreamError(code,message);this.openReject?.(error);
    const pending=this.pending;this.pending=null;
    if(pending){clearTimeout(pending.timer);pending.cleanup();pending.reject(error);}
    try{this.socket?.close();}catch{}
  }
}
