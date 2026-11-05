"""Bounded ZIP interchange with the Android v1/v2 immutable backup format."""
import base64,io,json,sys,zipfile,hashlib
from PIL import Image
MAX=40*1024*1024
def run(data):
    if data['operation']=='pack':
        output=io.BytesIO();total=len(data['manifest'].encode('utf-8'))
        if total>4*1024*1024:raise ValueError('manifest_limit')
        with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr('manifest.json',data['manifest'].encode('utf-8'))
            for name,encoded in data['files'].items():
                raw=base64.b64decode(encoded,validate=True);total+=len(raw)
                if total>MAX:raise ValueError('archive_limit')
                z.writestr(name,raw)
        if output.tell()>MAX:raise ValueError('archive_limit')
        return {'zip':base64.b64encode(output.getvalue()).decode()}
    raw=base64.b64decode(data['zip'],validate=True)
    if len(raw)>MAX:raise ValueError('archive_limit')
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        entries=z.infolist();names=[e.filename for e in entries]
        if len(names)>13501 or len(set(names))!=len(names) or 'manifest.json' not in names:raise ValueError('invalid_directory')
        if sum(e.file_size for e in entries)>MAX:raise ValueError('archive_limit')
        files={};manifest=None
        for entry in entries:
            if entry.flag_bits&1 or entry.is_dir():raise ValueError('invalid_entry')
            cap=4*1024*1024 if entry.filename=='manifest.json' else 2_000_000
            if entry.file_size>cap:raise ValueError('entry_limit')
            with z.open(entry) as source:content=source.read(cap+1)
            if len(content)>cap:raise ValueError('entry_limit')
            if entry.filename=='manifest.json':manifest=content.decode('utf-8')
            else:
                with Image.open(io.BytesIO(content)) as image:
                    if image.format!='JPEG' or image.width*image.height>12_000_000:raise ValueError('invalid_image')
                    image.verify()
                files[entry.filename]=base64.b64encode(content).decode()
        return {'manifest':manifest,'files':files}
if __name__=='__main__':
    try:print(json.dumps(run(json.load(sys.stdin)),ensure_ascii=False,separators=(',',':')))
    except Exception:sys.exit(1)
