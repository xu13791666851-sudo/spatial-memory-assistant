import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {check,uuid} from './util.mjs';
export class Yolo {
 constructor({python=process.env.ISEEYOU_PYTHON||'python',env=process.env}={}){
  this.ready=false;this.pending=null;
  this.child=spawn(python,[fileURLToPath(new URL('../python/yolo-worker.py',import.meta.url))],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  this.started=new Promise((resolve,reject)=>{this.resolveStart=resolve;this.rejectStart=reject;});this.started.catch(()=>{});
  this.startTimer=setTimeout(()=>this.fail(Error('yolo_start_timeout')),90000);
  this.child.on('error',()=>this.fail(Error('yolo_process_unavailable')));this.child.on('exit',()=>this.fail(Error('yolo_process_stopped')));this.child.stdin.on('error',()=>this.fail(Error('yolo_pipe_closed')));this.child.stderr.on('data',()=>{});
  createInterface({input:this.child.stdout}).on('line',line=>{try{check(line.length<=8*1024*1024,'yolo_output_limit');const r=JSON.parse(line);if(r.ready){this.ready=true;clearTimeout(this.startTimer);this.resolveStart(r);return;}if(!this.pending||r.requestId!==this.pending.id)return;const p=this.pending;this.pending=null;clearTimeout(p.timer);if(r.error)p.reject(Error('yolo_failed'));else p.resolve(r);}catch{this.fail(Error('yolo_output_invalid'));}});
 }
 get busy(){return !!this.pending;}
 fail(error){this.ready=false;clearTimeout(this.startTimer);this.rejectStart(error);if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}this.child.kill();}
 async run(frame,{target=null,targets=null,box=null}={}){await this.started;check(!this.pending&&this.ready,'yolo_busy');const requestId=uuid();return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>this.fail(Error('yolo_timeout')),15000);this.pending={id:requestId,resolve,reject,timer};this.child.stdin.write(JSON.stringify({requestId,operation:box?'crop':'detect',frameId:frame.frameId,sourceGeneration:frame.sourceGeneration,fullJpeg:frame.jpeg.toString('base64'),target,targets,box})+'\n');});}
 close(){this.fail(Error('yolo_closed'));}
}
