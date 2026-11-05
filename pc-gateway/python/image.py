import base64,io,json,sys,math,struct
from PIL import Image
def run(data):
    raw=base64.b64decode(data['jpeg'],validate=True)
    if len(raw)>2_000_000:raise ValueError()
    image=Image.open(io.BytesIO(raw)).convert('RGB')
    if image.width*image.height>2_000_000:raise ValueError()
    b=data['box']
    if len(b)!=4 or not all(isinstance(x,(int,float)) and math.isfinite(x) and 0<=x<=1 for x in b) or not b[0]<b[2] or not b[1]<b[3]:raise ValueError()
    part=image.crop((math.floor(b[0]*image.width),math.floor(b[1]*image.height),math.ceil(b[2]*image.width),math.ceil(b[3]*image.height)))
    out=io.BytesIO();part.save(out,format='JPEG',quality=92)
    values=[];hist=part.resize((64,64)).histogram()
    for channel in range(3):
        for n in range(16):values.append(float(sum(hist[channel*256+n*16:channel*256+(n+1)*16])))
    norm=max(math.sqrt(sum(x*x for x in values)),1e-10)
    embedding=struct.pack('<48f',*[x/norm for x in values])
    return {'jpeg':base64.b64encode(out.getvalue()).decode(),'embedding':base64.b64encode(embedding).decode()}
if __name__=='__main__':
    try:print(json.dumps(run(json.load(sys.stdin)),separators=(',',':')))
    except Exception:sys.exit(1)
