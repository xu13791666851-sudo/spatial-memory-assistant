"""Create a self-contained Mac handoff without credentials or build caches."""
import hashlib
import json
import plistlib
import re
import shutil
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1]
ROOT = SOURCE.parent
DELIVERY = ROOT / '08_iOS测试版'
BACKEND = DELIVERY / 'backend'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    version = plistlib.loads((DELIVERY / 'ISeeYouIOS/Info.plist').read_bytes())['CFBundleShortVersionString']
    archive = ROOT / ('I-SEE-YOU-iOS-Mac测试包-' + version + '.zip')
    if not (SOURCE / '.demo-site/index.html').is_file():
        raise SystemExit('Missing built frontend. Run npm ci and npm run build:demo first.')
    # Explicit allowlist: no .env, session keys, databases, logs, or user media.
    folders = ['demo', 'web', 'scripts', 'netlify', 'src/static', 'models/yolo', 'tests', 'docs',
               'android/app/src/main/assets']
    forbidden = {'__pycache__', '.demo-data', '.dev.vars', 'node_modules', '.wrangler', '.git'}
    for name in folders:
        for path in (SOURCE / name).rglob('*'):
            rel = path.relative_to(SOURCE)
            if not path.is_file() or any(p in forbidden or p.startswith('.env') for p in rel.parts) or path.suffix == '.pyc':
                continue
            target = BACKEND / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
    for name in ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json']:
        shutil.copy2(SOURCE / name, BACKEND / name)
    # Do not sweep the generated directory: take only the known public web assets.
    for path in (SOURCE / '.demo-site').rglob('*'):
        if path.is_file() and path.suffix in {'.html', '.mjs', '.js', '.css', '.svg'}:
            dest = BACKEND / '.demo-site' / path.relative_to(SOURCE / '.demo-site')
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dest)

    info = plistlib.loads((DELIVERY / 'ISeeYouIOS/Info.plist').read_bytes())
    assert info['NSCameraUsageDescription'] and info['NSMicrophoneUsageDescription']
    ET.parse(DELIVERY / 'ISeeYouIOS.xcodeproj/xcshareddata/xcschemes/ISeeYouIOS.xcscheme')
    project = (DELIVERY / 'ISeeYouIOS.xcodeproj/project.pbxproj').read_text(encoding='utf8')
    definitions = re.findall(r'^\s*([A-F0-9]{24}) = \{', project, re.M)
    assert len(definitions) == len(set(definitions))
    assert set(re.findall(r'\b[A-F0-9]{24}\b', project)) == set(definitions)
    for name in ['ISeeYouApp.swift', 'Info.plist']:
        assert (DELIVERY / 'ISeeYouIOS' / name).is_file() and name in project
    manifest = json.loads((BACKEND / 'models/yolo/manifest.json').read_text(encoding='utf8'))
    model = hashlib.sha256()
    for part in manifest['parts']:
        path = BACKEND / 'models/yolo' / part['file']
        assert digest(path) == part['sha256']
        model.update(path.read_bytes())
    assert model.hexdigest() == manifest['sha256']
    copied = {}
    for path in BACKEND.rglob('*'):
        if not path.is_file():
            continue
        rel = path.relative_to(BACKEND)
        assert digest(path) == digest(SOURCE / rel), str(rel)
        copied[rel.as_posix()] = digest(path)
    report = {
        'version': version,
        'checks': ['Info.plist parsed', 'shared scheme XML parsed', 'project reference IDs checked',
                   'source membership checked', 'YOLO original digest verified',
                   'backend files match original sources'],
        'xcode_build': 'NOT RUN: Windows host; run bash verify-on-mac.sh on Mac',
        'physical_iphone': 'NOT TESTED',
        'backend_deployed': False,
        'backend_files_sha256': copied,
    }
    (DELIVERY / '交付校验.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(DELIVERY.rglob('*')):
            if path.is_file():
                rel = path.relative_to(DELIVERY)
                if any(p in {'xcuserdata', '.build', '__pycache__'} for p in rel.parts):
                    continue
                assert path.name not in {'.env', '.dev.vars', 'session-secret'}
                entry = zipfile.ZipInfo.from_file(path, arcname='I-SEE-YOU-iOS/' + rel.as_posix())
                if path.suffix == '.sh':
                    entry.create_system = 3
                    entry.external_attr = 0o100755 << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                bundle.writestr(entry, path.read_bytes())
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.testzip() is None
    print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size,
                      'sha256': digest(archive), 'backend_files': len(copied),
                      'xcode_build': 'not run'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
