"""One request-bound JPEG. Historical imagery is visibly labelled, never a live frame."""
import base64,io,json,sys
from PIL import Image,ImageOps,ImageDraw
Image.MAX_IMAGE_PIXELS=12_000_000

def decode(raw):
    data=base64.b64decode(raw,validate=True)
    if len(data)>2_000_000:raise ValueError('image_limit')
    return ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert('RGB')

def prepare(data):
    current=decode(data['current']);reference=decode(data['reference']) if data.get('reference') else None
    if reference is not None:
        out=Image.new('RGB',(1280,720),'white');draw=ImageDraw.Draw(out)
        for x,label,image in [(0,'CURRENT',current),(640,'HISTORICAL REFERENCE',reference)]:
            draw.text((x+16,12),label,fill='black',font_size=24)
            image.thumbnail((624,664),Image.Resampling.LANCZOS)
            out.paste(image,(x+8+(624-image.width)//2,48+(664-image.height)//2))
    else:
        out=current;out.thumbnail((960,720),Image.Resampling.LANCZOS)
    for quality in [85,75,65,50,35]:
        buf=io.BytesIO();out.save(buf,format='JPEG',quality=quality)
        if len(buf.getvalue())<=190*1024:return {'jpeg':base64.b64encode(buf.getvalue()).decode()}
    raise ValueError('image_limit')
if __name__=='__main__':
    try:print(json.dumps(prepare(json.load(sys.stdin))))
    except Exception:sys.exit(1)
