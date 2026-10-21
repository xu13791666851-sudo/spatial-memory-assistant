/* TensorFlow runs off the UI thread. Images and keys never go to third-party CDNs. */
let loading,model,labels,aliases,decode;
const base='/static/vendor/';
async function initialize(){
 if(loading)return loading;
 loading=(async()=>{
  importScripts(base+'tfjs-4.9.0/tf-core.min.js',base+'tfjs-4.9.0/tf-backend-cpu.min.js',base+'tflite-0.0.1-alpha.10/tf-tflite.min.js');
  await tf.setBackend('cpu');await tf.ready();tflite.setWasmPath(base+'tflite-0.0.1-alpha.10/');
  const get=async name=>{const response=await fetch('/static/yolo/'+name);if(!response.ok)throw Error('Missing YOLO resource');return response.json();};
  const manifest=await get('manifest.json');[labels,aliases]=await Promise.all([get('labels.json'),get('aliases.json')]);
  const chunks=await Promise.all(manifest.parts.map(async part=>{
   if(!/^model-\d+-[a-f0-9]{16}\.bin$/.test(part.file))throw Error('Invalid model part');
   const response=await fetch('/static/yolo/'+part.file);if(!response.ok)throw Error('Model download failed');
   const bytes=await response.arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes),hash=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
   if(bytes.byteLength!==part.bytes||hash!==part.sha256)throw Error('Model checksum mismatch');return new Uint8Array(bytes);
  }));
  const bytes=new Uint8Array(manifest.bytes);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  if(offset!==manifest.bytes)throw Error('Invalid model length');
  const threads=self.crossOriginIsolated?Math.min(4,navigator.hardwareConcurrency||1):1;
  model=await tflite.loadTFLiteModel(bytes.buffer,{numThreads:threads});
  // Start the WASM thread pool and compile kernels before the first user view.
  const warmInput=tf.zeros(model.inputs[0].shape),warmOutput=model.predict(warmInput);
  warmInput.dispose();if(Array.isArray(warmOutput))warmOutput.forEach(tensor=>tensor.dispose());else warmOutput.dispose();
  decode=(await import('./yolo-core.mjs')).decodeYolo;
  return {inputs:model.inputs,outputs:model.outputs,labels,aliases,bytes:manifest.bytes,threads};
 })();return loading;
}
async function detect(image){
 await initialize();const started=performance.now();
 const input=model.inputs[0],shape=input.shape,channelsFirst=shape[1]===3;
 if(input.dtype!=='float32'||shape.length!==4||shape[0]!==1)throw Error('Unsupported YOLO input');
 const inputWidth=shape[channelsFirst?3:2],inputHeight=shape[channelsFirst?2:1];
 const blob=new Blob([Uint8Array.from(atob(image),char=>char.charCodeAt(0))],{type:'image/jpeg'}),bitmap=await createImageBitmap(blob);
 let tensor,output;
 try{
  const width=bitmap.width,height=bitmap.height,scale=Math.min(inputWidth/width,inputHeight/height),scaledWidth=Math.round(width*scale),scaledHeight=Math.round(height*scale),padX=(inputWidth-scaledWidth)/2,padY=(inputHeight-scaledHeight)/2;
  const canvas=new OffscreenCanvas(inputWidth,inputHeight),context=canvas.getContext('2d',{willReadFrequently:true});
  context.fillStyle='rgb(114,114,114)';context.fillRect(0,0,inputWidth,inputHeight);context.drawImage(bitmap,padX,padY,scaledWidth,scaledHeight);
  const pixels=context.getImageData(0,0,inputWidth,inputHeight).data,size=inputWidth*inputHeight,data=new Float32Array(size*3);
  for(let i=0;i<size;i++)for(let channel=0;channel<3;channel++)data[channelsFirst?channel*size+i:i*3+channel]=pixels[i*4+channel]/255;
  tensor=tf.tensor(data,shape,'float32');output=model.predict(tensor);
  if(Array.isArray(output)||!output?.dataSync)throw Error('Unsupported YOLO output');
  const detections=decode(output.dataSync(),output.shape,labels,{width,height,inputWidth,inputHeight,scale,padX,padY});
  return {detections,latencyMs:performance.now()-started};
 }finally{bitmap.close();tensor?.dispose();if(Array.isArray(output))output.forEach(value=>value.dispose());else output?.dispose();}
}
self.onmessage=async({data})=>{
 try{const result=data.type==='init'?await initialize():await detect(data.image);postMessage({id:data.id,result});}
 catch(error){postMessage({id:data.id,error:'local_detector_unavailable',detail:String(error?.message||error).slice(0,300)});}
};
