"""Adapted from supplied Plan B b-yolo.py: persistent model and same-frame crops.
All matching candidates are returned, so rejection can advance to another object.
"""
import base64,io,json,sys,os,time,math,importlib.util,socket
from pathlib import Path
from contextlib import redirect_stdout
from PIL import Image
from tracking import ConservativeTracker
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('peer_yolo',ROOT/'vendor/plan-b/b-yolo.py')
peer=importlib.util.module_from_spec(spec);spec.loader.exec_module(peer)
Image.MAX_IMAGE_PIXELS=2_000_000
def crop(image,box):
    if len(box)!=4 or not all(isinstance(x,(int,float)) and math.isfinite(x) and 0<=x<=1 for x in box) or not box[0]<box[2] or not box[1]<box[3]:raise ValueError('invalid_box')
    coords=[math.floor(box[0]*image.width),math.floor(box[1]*image.height),math.ceil(box[2]*image.width),math.ceil(box[3]*image.height)]
    part=image.crop(coords);output=io.BytesIO();part.save(output,format='JPEG',quality=92)
    pixels=np.asarray(part.resize((64,64)),dtype=np.uint8)
    embedding=np.concatenate([np.histogram(pixels[:,:,i],bins=16,range=(0,256))[0] for i in range(3)]).astype('<f4')
    embedding/=max(float(np.linalg.norm(embedding)),1e-10)
    return {'box':box,'cropRect':coords,'cropJpeg':base64.b64encode(output.getvalue()).decode(),'embedding':base64.b64encode(embedding.tobytes()).decode()}
def process(model,data,device):
    raw=base64.b64decode(data['fullJpeg'],validate=True)
    if len(raw)>2_000_000:raise ValueError('image_limit')
    image=Image.open(io.BytesIO(raw)).convert('RGB')
    if image.width*image.height>2_000_000:raise ValueError('pixel_limit')
    if data.get('operation')=='crop':return crop(image,data['box'])
    start=time.perf_counter()
    with redirect_stdout(sys.stderr):result=model.predict(image,device=device,imgsz=640,conf=.35,verbose=False)[0]
    detections=[]
    for box in result.boxes:
        coords=[max(0,min(1,float(x))) for x in box.xyxyn[0].tolist()]
        if coords[0]<coords[2] and coords[1]<coords[3]:detections.append({'label':result.names[int(box.cls[0])],'score':float(box.conf[0]),'box':coords})
    detections.sort(key=lambda d:d['score'],reverse=True)
    if not hasattr(model,'_isee_tracker'):model._isee_tracker=ConservativeTracker()
    model._isee_tracker.update(detections,data.get('sourceGeneration'),time.monotonic())
    targets=data.get('targets') or [data.get('target')]
    candidates=[{**d,**crop(image,d['box'])} for d in detections if not any(targets) or d['label'] in targets][:8]
    return {'frameId':data['frameId'],'sourceGeneration':data['sourceGeneration'],'detections':detections[:80],'candidates':candidates,'quality':peer.inspect_image(image),'inferenceMs':(time.perf_counter()-start)*1000}
if __name__=='__main__':
    os.environ['YOLO_CONFIG_DIR']=str(ROOT/'runtime/yolo-settings')
    os.environ['YOLO_AUTOINSTALL']='false'
    def no_network(*args,**kwargs):raise OSError('Local detector has no network access')
    socket.socket.connect=no_network
    socket.socket.connect_ex=no_network
    with redirect_stdout(sys.stderr):
        from ultralytics import YOLO
        import torch
        device=os.environ.get('ISEEYOU_DEVICE','cpu')
        if device!='cpu' and not torch.cuda.is_available():raise RuntimeError('cuda_unavailable')
        path=Path(os.environ.get('ISEEYOU_MODEL',str(ROOT/'models/yolo11s.pt')))
        if not path.is_file():raise RuntimeError('local_model_required')
        model=YOLO(str(path));model.predict(Image.new('RGB',(640,640)),device=device,imgsz=640,verbose=False)
    print(json.dumps({'ready':True,'device':device}),flush=True)
    for line in sys.stdin:
        try:
            data=json.loads(line);reply={'requestId':data['requestId'],**process(model,data,device)}
        except Exception:reply={'requestId':data.get('requestId') if isinstance(data,dict) else None,'error':'worker_failed'}
        print(json.dumps(reply,separators=(',',':')),flush=True)
