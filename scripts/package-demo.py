"""Build a reviewable source+ready-UI submission, with an explicit file allowlist."""
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path

root=Path(__file__).resolve().parents[1]
out=root/'output/hackathon';out.mkdir(parents=True,exist_ok=True)
archive=out/'I-SEE-YOU-complete-web-demo.zip'
allowed_dirs=['demo/','web/','scripts/','src/static/','netlify/','models/yolo/','android/app/src/main/assets/']
allowed_files=['package.json','package-lock.json','Dockerfile','.dockerignore','docs/hackathon-web-demo.md','tests/demo_test.py','tests/demo-browser.cjs','designs/desk-reference.jpg']
tracked=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0')
files=sorted(p for p in tracked if p and (p in allowed_files or any(p.startswith(d) for d in allowed_dirs)))
assert (root/'.demo-site/index.html').is_file(),'Run npm run build:demo before packaging'
for path in files:
    name=Path(path).name
    assert not name.startswith('.env') and not name.endswith(('.db','.sqlite3','.key','.pem','.keystore','.apk'))
    assert '__pycache__' not in path and '/build/' not in path and '/site/' not in path
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for path in files:z.write(root/path,path)
    z.write(root/'docs/hackathon-web-demo.md','README.md')
    for path in sorted((root/'.demo-site').rglob('*')):
        if path.is_file():z.write(path,path.relative_to(root).as_posix())
    z.writestr('demo/config.example.env','QWEN_API_KEY=replace-in-server-secret-settings\nDEMO_DATA_DIR=/mnt/workspace/iseeyou\n')
    z.writestr('BUILD.json',json.dumps({'commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root).decode().strip(),'scope':'phone camera full workflow; hardware demonstrated separately'},indent=2))
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
(out/'package-verification.json').write_text(json.dumps({'file':str(archive),'sha256':digest,'bytes':archive.stat().st_size,'source_files':len(files)},ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({'file':str(archive),'sha256':digest,'bytes':archive.stat().st_size,'source_files':len(files)}))
