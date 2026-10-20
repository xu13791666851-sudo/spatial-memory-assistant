import {observationInstructions,REALTIME_MODEL} from './realtime-vision.mjs';
import {validateObservation,observationTool} from '../../web/realtime-observation.mjs';

// One provider connection per search. No next frame is accepted until every
// item from this turn has been deleted and the provider acknowledged deletion.
export class PersistentVision{
  constructor({connect,env,timeoutMs=22000}){
    Object.assign(this,{connect,env,timeoutMs});this.closed=false;this.queue=[];
    this.ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
    this.ready.catch(()=>{});
    this.connectTimer=setTimeout(()=>this.close('observation_connect_timeout'),18000);
    const host=env.DASHSCOPE_REGION==='singapore'?'ap-southeast-1':'cn-beijing';
    const url=env.DASHSCOPE_WORKSPACE_ID?`wss://${env.DASHSCOPE_WORKSPACE_ID}.${host}.maas.aliyuncs.com/api-ws/v1/realtime?model=${REALTIME_MODEL}`:`wss://${env.DASHSCOPE_REGION==='singapore'?'dashscope-intl.aliyuncs.com':'dashscope.aliyuncs.com'}/api-ws/v1/realtime?model=${REALTIME_MODEL}`;
    Promise.resolve().then(()=>connect(url,{headers:{Authorization:'Bearer '+env.DASHSCOPE_API_KEY},onMessage:raw=>this.event(raw),onError:()=>this.close('observation_network_error'),onClose:()=>this.close('observation_disconnected')})).then(socket=>{
      this.socket=socket;if(this.closed){socket.close();return;}for(const raw of this.queue)socket.send(raw);this.queue=[];
    }).catch(()=>this.close('observation_network_error'));
  }
  send(event){
    if(this.closed)return;const raw=JSON.stringify({...event,event_id:crypto.randomUUID()});
    if(this.socket)this.socket.send(raw);else this.queue.push(raw);
  }
  async observe({image,goal,task,signal}){
    if(signal?.aborted)throw Error('observation_cancelled');
    if(this.current)throw Error('observation_busy');
    await this.ready;
    if(this.closed||signal?.aborted)throw Error('observation_cancelled');
    if(this.current)throw Error('observation_busy');
    return new Promise((resolve,reject)=>{
      const run={id:crypto.randomUUID(),task,image,resolve,reject,stage:'configuring',items:new Set(),deletions:new Set(),signal};this.current=run;
      run.abort=()=>this.close('observation_cancelled');signal?.addEventListener('abort',run.abort,{once:true});
      run.timer=setTimeout(()=>this.close('observation_timeout'),this.timeoutMs);
      this.send({type:'session.update',session:{voice:'Tina',modalities:['text'],turn_detection:null,input_audio_transcription:null,input_audio_format:'pcm',max_tokens:1000,tools:[observationTool],video:{input:{representation_compact:'none'}},instructions:observationInstructions(run.id,goal,task)}});
    });
  }
  event(raw){
    if(this.closed)return;
    try{
      if(typeof raw!=='string'||raw.length>100000)throw Error('observation_invalid_result');
      const e=JSON.parse(raw),run=this.current;
      if(e.type==='error')throw Error('observation_provider_error');
      if(e.type==='session.created'){clearTimeout(this.connectTimer);this.readyResolve();return;}
      if(!run)return;
      if(['conversation.item.created','response.output_item.added','response.output_item.done'].includes(e.type)&&e.item?.id)run.items.add(e.item.id);
      if(e.type==='session.updated'&&run.stage==='configuring'){
        run.stage='clearing';this.send({type:'input_audio_buffer.clear'});
      }else if(e.type==='input_audio_buffer.cleared'&&run.stage==='clearing'){
        run.stage='committing';this.send({type:'input_audio_buffer.append',audio:btoa('\0'.repeat(3200))});this.send({type:'input_image_buffer.append',image:run.image});run.image=null;this.send({type:'input_audio_buffer.commit'});
      }else if(e.type==='input_audio_buffer.committed'&&run.stage==='committing'){
        if(typeof e.item_id!=='string'||!e.item_id)throw Error('observation_missing_item');
        run.items.add(e.item_id);run.stage='waiting';this.send({type:'response.create'});
      }else if(e.type==='response.created'&&run.stage==='waiting'){
        if(!e.response?.id)throw Error('observation_invalid_result');run.responseId=e.response.id;run.stage='responding';
      }else if(e.type==='response.done'&&run.stage==='responding'&&e.response?.id===run.responseId){
        const response=e.response,usage=response.usage?.input_tokens_details;
        if(response.status!=='completed')throw Error('observation_incomplete');
        if(!usage||!((usage.image_tokens||0)+(usage.video_tokens||0)>0))throw Error('observation_no_image');
        const output=response.output||[],calls=output.filter(o=>o.type==='function_call'&&o.name==='report_observation');
        if(calls.length!==1||output.some(o=>!o.id))throw Error('observation_invalid_result');
        for(const item of output)run.items.add(item.id);
        const args=JSON.parse(calls[0].arguments);
        if(args.observation_id!==run.id||!['clear','uncertain'].includes(args.frame_status))throw Error('observation_invalid_result');
        const result=args.frame_status==='uncertain'?{answer:'这次画面看不清，请保持镜头稳定。',objects:[],target_visible:null,appearance_match:null}:validateObservation(args,run.task);
        run.result={...result,frame_status:args.frame_status,frame_received:true,model:REALTIME_MODEL,source:'current_camera_frame'};
        run.stage='deleting';run.deletions=new Set(run.items);
        for(const item_id of run.items)this.send({type:'conversation.item.delete',item_id});
      }else if(e.type==='conversation.item.deleted'&&run.stage==='deleting'){
        run.deletions.delete(e.item_id);
        if(!run.deletions.size){this.current=null;clearTimeout(run.timer);run.signal?.removeEventListener('abort',run.abort);run.resolve(run.result);}
      }
    }catch(error){this.close(error instanceof SyntaxError?'observation_invalid_result':error.message);}
  }
  close(code='observation_cancelled'){
    if(this.closed)return;this.closed=true;clearTimeout(this.connectTimer);this.readyReject(Error(code));
    const run=this.current;this.current=null;
    if(run){if(code==='observation_timeout')console.warn('vision_observation_timeout',run.stage);clearTimeout(run.timer);run.image=null;run.signal?.removeEventListener('abort',run.abort);run.reject(Error(code));}
    this.queue=[];try{this.socket?.close();}catch{}
  }
}
