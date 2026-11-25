#!/usr/bin/env python3
"""生成自动更新用的 latest.json（打印到标准输出）。

用法：latest-json.py <版本> <架构> <owner/repo> <签名文件> <更新包文件名>

更新说明取自更新日志里这个版本的一节：英文在前，中文在后，中间用一行 <!--zh--> 隔开，
应用按界面语言显示其中一份。
"""
import datetime
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


def notes_of(path, version):
    try:
        lines = open(os.path.join(ROOT, path), encoding='utf-8').read().split('\n')
    except OSError:
        return ''
    head = re.compile(r'^##\s+\[?v?' + re.escape(version) + r'\]?(\s|$)')
    start = next((i for i, l in enumerate(lines) if head.match(l)), None)
    if start is None:
        return ''
    rest = lines[start + 1:]
    end = next((i for i, l in enumerate(rest) if re.match(r'^##\s', l)), len(rest))
    return '\n'.join(rest[:end]).strip()


def notes(version):
    en, zh = notes_of('CHANGELOG.md', version), notes_of('CHANGELOG.zh-CN.md', version)
    if not en:
        sys.exit(f'CHANGELOG.md 里没有 {version} 这一节，先写更新日志再发版。')
    return en + ('\n\n<!--zh-->\n\n' + zh if zh else '')


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--notes':
        print(notes(sys.argv[2]))
        return
    version, arch, repo, sig, name = sys.argv[1:6]
    print(json.dumps({
        'version': version,
        'notes': notes(version),
        'pub_date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'platforms': {
            f'darwin-{arch}': {
                'signature': open(sig, encoding='utf-8').read().strip(),
                'url': f'https://github.com/{repo}/releases/download/v{version}/{name}',
            },
        },
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
