#!/usr/bin/env python3
"""把当前使用指南每个文件的哈希记进 src-tauri/guide/known-hashes.txt（只增不减）。

应用靠这份清单认出「这是以前某个版本装进去、之后没被动过的指南」，切换语言或更新指南时才敢替换它。
改了指南的文字或图片之后运行一次；忘了的话，Rust 测试 `shipped_files_are_in_the_known_list` 会失败。
"""
import glob
import hashlib
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src-tauri', 'guide')
LIST = os.path.join(ROOT, 'known-hashes.txt')

known = set(open(LIST).read().split()) if os.path.exists(LIST) else set()
before = len(known)
for f in glob.glob(os.path.join(ROOT, '**', '*'), recursive=True):
    if f.endswith(('.md', '.png')):
        known.add(hashlib.sha256(open(f, 'rb').read()).hexdigest())
open(LIST, 'w').write('\n'.join(sorted(known)) + '\n')
print(f'{len(known)} 个版本（新增 {len(known) - before} 个）')
