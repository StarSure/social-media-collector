#!/usr/bin/env python3
"""Build a skill ZIP from an explicit file list after runtime validation."""
import argparse
import hashlib
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TOP_FILES = ['SKILL.md', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
             'package.json', 'package-lock.json', '.gitignore']
DIRECTORIES = ['agents', 'assets', 'references', 'scripts', 'tests', 'examples', '.github']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    subprocess.run(['node', str(ROOT / 'scripts/check-package.mjs')], cwd=ROOT, check=True)
    files = [ROOT / name for name in TOP_FILES]
    for directory in DIRECTORIES:
        for file in (ROOT / directory).rglob('*'):
            if file.is_symlink():
                raise ValueError(f'Symlinks are not distributable: {file.relative_to(ROOT)}')
            if file.is_file() and '__pycache__' not in file.parts and file.suffix != '.pyc' and file.name != '.DS_Store':
                files.append(file)
    output = args.output.resolve()
    if output in files:
        raise ValueError('Output must be outside the packaged file list (use dist/)')
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(files):
            name = 'social-media-collector/' + file.relative_to(ROOT).as_posix()
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 20, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, file.read_bytes())
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + '.sha256').write_text(f'{digest}  {output.name}\n')
    print(f'Created {output.name}: {len(files)} files; SHA-256 {digest}')


if __name__ == '__main__':
    main()
