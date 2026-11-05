"""Create a complete portable development handoff without local data or secrets."""
import argparse
import datetime
import hashlib
import json
import os
import re
import zipfile
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1]
ROOT = SOURCE.parent
SKIP_DIRS = {
    '.git', '.venv', 'venv', 'node_modules', '__pycache__', '.gradle', '.kotlin',
    '.demo-data', '.wrangler', '.netlify', '.cache', '.pytest_cache', '.mypy_cache',
    '.ruff_cache', '.tox', '.playwright-cli', '.build', 'DerivedData', 'xcuserdata',
    'build', 'dist', 'output', 'outputs', 'tmp', '.idea', '.vscode',
}
SKIP_SUFFIXES = {
    '.pyc', '.pyo', '.log', '.db', '.sqlite', '.sqlite3', '.key', '.pem', '.p12',
    '.pfx', '.jks', '.keystore', '.mobileprovision', '.mobileconfig', '.zip',
}
TEXT_SUFFIXES = {
    '.py', '.mjs', '.cjs', '.js', '.ts', '.json', '.jsonc', '.md', '.txt', '.xml',
    '.plist', '.pbxproj', '.kts', '.kt', '.swift', '.sh', '.ps1', '.toml', '.yml',
    '.yaml', '.html', '.css', '.properties', '.ino', '.h', '.cpp', '.c',
}
TOKEN_PATTERN = re.compile(
    rb'sk-[A-Za-z0-9_-]{24,}|sb_secret_[A-Za-z0-9_-]{16,}|'
    rb'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|'
    rb'AKIA[0-9A-Z]{16}|-----BEGIN (?:(?:RSA|EC|OPENSSH|DSA) )?PRIVATE KEY-----'
)
# Reviewed static offline-test sentinel, shared by legacy and browser tests.
# Limit the exception to this exact digest and these exact fixture files.
OFFLINE_FIXTURE_DIGEST = '276ba285d6cb75e94ddd08c68a95960dcc905b3acb96bf321aa1e331482b35e4'
OFFLINE_FIXTURE_FILES = {
    '05_项目源码/src/test_video.py', '05_项目源码/tests/web.test.mjs',
    '08_iOS测试版/backend/tests/web.test.mjs',
}


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def exclude_file(path):
    name = path.name.lower()
    return (
        name.startswith(('.env', '.dev.vars'))
        or name in {'local.properties', 'session-secret', '.ds_store', 'thumbs.db', '.npmrc', '.pypirc'}
        or path.suffix.lower() in SKIP_SUFFIXES
        or re.search(r'\.(?:db|sqlite3?)(?:-(?:wal|shm|journal))?$', name) is not None
    )


def collect():
    selected = [ROOT / '00_换电脑继续开发.md']
    excluded = []
    numbered = sorted(p for p in ROOT.iterdir() if p.is_dir() and re.match(r'^0[1-9]_', p.name))
    for folder in numbered:
        for base, dirs, files in os.walk(folder, followlinks=False):
            base = Path(base)
            keep = []
            for name in dirs:
                path = base / name
                rel = path.relative_to(ROOT)
                generated_android = rel.as_posix().endswith('android/app/src/main/assets/site')
                if name in SKIP_DIRS or path.is_symlink() or generated_android:
                    excluded.append(rel.as_posix() + '/')
                else:
                    keep.append(name)
            dirs[:] = keep
            for name in files:
                path = base / name
                rel = path.relative_to(ROOT)
                generated_model = rel.as_posix().endswith('android/app/src/main/assets/exp.tflite')
                demo_public = '.demo-site' not in rel.parts or path.suffix.lower() in {'.html', '.mjs', '.js', '.css', '.svg'}
                if path.is_symlink() or exclude_file(path) or generated_model or not demo_public:
                    excluded.append(rel.as_posix())
                    continue
                selected.append(path)
    return sorted(selected), sorted(excluded)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', required=True, help='User-facing handoff date, YYYY-MM-DD')
    args = parser.parse_args()
    datetime.date.fromisoformat(args.date)
    title = 'I-SEE-YOU-开发交接包-' + args.date
    archive = ROOT / (title + '.zip')
    temporary = ROOT / (title + '.zip.partial')
    selected, excluded = collect()
    entries = {}
    offline_fixture_matches = 0
    for path in selected:
        rel = path.relative_to(ROOT).as_posix()
        if not path.is_file():
            raise SystemExit('Missing required file: ' + rel)
        if path.suffix.lower() in TEXT_SUFFIXES:
            for match in TOKEN_PATTERN.finditer(path.read_bytes()):
                if rel in OFFLINE_FIXTURE_FILES and hashlib.sha256(match.group()).hexdigest() == OFFLINE_FIXTURE_DIGEST:
                    offline_fixture_matches += 1
                else:
                    raise SystemExit('Credential-like content requires review in: ' + rel)
        entries[rel] = {'path': rel, 'bytes': path.stat().st_size, 'sha256': digest(path)}

    required = [
        '00_换电脑继续开发.md', '09_开发交接/继续开发提示词.md', '09_开发交接/verify-package.py',
        '07_AI实践与验证/开发进度与后续实施清单.md',
        '07_AI实践与验证/记忆分层与意图_第一阶段验证.json',
        '05_项目源码/demo/intents.py', '05_项目源码/demo/working_memory.py',
        '05_项目源码/demo/engine.py', '05_项目源码/demo/requirements.txt',
        '05_项目源码/package-lock.json', '05_项目源码/.gitignore',
        '05_项目源码/.github/workflows/android-test.yml',
        '05_项目源码/tests/memory_intent_test.py', '05_项目源码/tests/demo-bridge.test.mjs',
        '05_项目源码/.demo-site/index.html',
        '08_iOS测试版/ISeeYouIOS.xcodeproj/project.pbxproj',
        '08_iOS测试版/ISeeYouIOS/ISeeYouApp.swift',
    ]
    for rel in required:
        if rel not in entries:
            raise SystemExit('Required handoff file excluded or missing: ' + rel)

    manifest = json.loads((SOURCE / 'models/yolo/manifest.json').read_text(encoding='utf-8'))
    model_digest = hashlib.sha256()
    for part in manifest['parts']:
        path = SOURCE / 'models/yolo' / part['file']
        if digest(path) != part['sha256']:
            raise SystemExit('Model part checksum mismatch: ' + part['file'])
        model_digest.update(path.read_bytes())
    if model_digest.hexdigest() != manifest['sha256']:
        raise SystemExit('Assembled model checksum mismatch.')

    snapshot_files = 0
    for path in selected:
        rel = path.relative_to(ROOT)
        if rel.parts[:2] == ('08_iOS测试版', 'backend'):
            original = SOURCE.joinpath(*rel.parts[2:])
            if not original.is_file() or digest(original) != entries[rel.as_posix()]['sha256']:
                raise SystemExit('iOS backend snapshot is out of sync: ' + rel.as_posix())
            snapshot_files += 1

    package_manifest = {
        'format_version': 1,
        'handoff_date': args.date,
        'canonical_source': '05_项目源码',
        'ios_version': '0.1.1',
        'business_baseline': '2026-10-29 memory/intent phase one; not deployed or device-accepted',
        'runtime_data_and_secrets_included': False,
        'git_history_included': False,
        'dependency_installation_required': True,
        'files': list(entries.values()),
        'excluded_paths': excluded,
    }
    prefix = title + '/'
    with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for path in selected:
            rel = path.relative_to(ROOT).as_posix()
            info = zipfile.ZipInfo.from_file(path, arcname=prefix + rel)
            info.create_system = 3
            executable = path.suffix.lower() == '.sh' or path.name == 'gradlew'
            info.external_attr = (0o100755 if executable else 0o100644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with path.open('rb') as stream, bundle.open(info, 'w') as target:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    target.write(chunk)
        bundle.writestr(prefix + '交接包文件清单.json', json.dumps(package_manifest, ensure_ascii=False, indent=2).encode('utf-8'))

    verified = 0
    with zipfile.ZipFile(temporary) as bundle:
        if len(bundle.namelist()) != len(entries) + 1 or len(set(bundle.namelist())) != len(bundle.namelist()):
            raise SystemExit('Unexpected or duplicate ZIP entries.')
        for rel, metadata in entries.items():
            archived_digest = hashlib.sha256()
            archived_size = 0
            with bundle.open(prefix + rel) as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    archived_digest.update(chunk)
                    archived_size += len(chunk)
            if archived_size != metadata['bytes'] or archived_digest.hexdigest() != metadata['sha256']:
                raise SystemExit('ZIP integrity mismatch: ' + rel)
            verified += 1
        if json.loads(bundle.read(prefix + '交接包文件清单.json')) != package_manifest:
            raise SystemExit('ZIP manifest mismatch.')
    temporary.replace(archive)
    archive_hash = digest(archive)
    checksum_file = ROOT / (title + '.sha256')
    checksum_file.write_text(archive_hash + '  ' + archive.name + '\n', encoding='utf-8')
    report = {
        'handoff_date': args.date,
        'archive': archive.name,
        'archive_bytes': archive.stat().st_size,
        'archive_sha256': archive_hash,
        'files_verified': verified,
        'zip_entries': verified + 1,
        'source_bytes': sum(entry['bytes'] for entry in entries.values()),
        'model_sha256_verified': manifest['sha256'],
        'ios_backend_snapshot_files_verified': snapshot_files,
        'excluded_paths': excluded,
        'credential_pattern_scan': 'passed for selected text files, except reviewed exact offline fixture; binary assets not audited',
        'reviewed_offline_fixture_matches': offline_fixture_matches,
        'business_tests_rerun_for_packaging': False,
        'xcode_compiled': False,
        'deployed': False,
    }
    report_path = ROOT / (title + '-打包验证.json')
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
