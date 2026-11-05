"""Normalize Jev assets as the existing Android client does; return scene mapping."""
import base64,io,json,sys,math
from PIL import Image
Image.MAX_IMAGE_PIXELS=12_000_000
def prepare(value,index):
    raw=base64.b64decode(value,validate=True)
    if len(raw)>2_000_000:raise ValueError()
    im=Image.open(io.BytesIO(raw)).convert('RGB')
    if im.width*im.height>12_000_000:raise ValueError()
    longest=960 if index==0 else 768
    ratio=min(1,longest/max(im.size));w=max(1,round(im.width*ratio));h=max(1,round(im.height*ratio))
    scaled=im.resize((w,h),Image.Resampling.BILINEAR);pw=max(280,w);ph=max(280,h)
    left=(pw-w)//2;top=(ph-h)//2;canvas=Image.new('RGB',(pw,ph),(192,192,192));canvas.paste(scaled,(left,top))
    out=io.BytesIO();canvas.save(out,format='JPEG',quality=82)
    return {'jpeg':base64.b64encode(out.getvalue()).decode(),'scaledWidth':w,'scaledHeight':h,'paddedWidth':pw,'paddedHeight':ph,'left':left,'top':top}
if __name__=='__main__':
    try:
        images=json.load(sys.stdin)['images']
        if not 1<=len(images)<=5:raise ValueError()
        print(json.dumps({'images':[prepare(v,i) for i,v in enumerate(images)]},separators=(',',':')))
    except Exception:sys.exit(1)
