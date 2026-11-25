#!/usr/bin/env python3
"""检查界面翻译：
1. 源码里每个 t('…') / $t('…') 的中文原文，在每份词表里都有译文；
2. 同一个原文在不同词表文件里的译文一致；
3. 译文里的 {变量} 都出现在原文里。
用法：python3 scripts/i18n-check.py   （有问题时退出码为 1）
"""
import glob, os, re, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src')
STR = r"'((?:[^'\\\n]|\\.)*)'|\"((?:[^\"\\\n]|\\.)*)\"|`((?:[^`\\$]|\\.)*)`"
CALL = re.compile(r"(?<![\w.])\$?t\(\s*(?:" + STR + ")")
PAIR = re.compile(r"(?:" + STR + r")\s*:\s*(?:" + STR + r")\s*,")
HAN = re.compile(r'[一-鿿]')

def unesc(s):
    return re.sub(r'\\(.)', lambda m: {'n': '\n', 't': '\t'}.get(m.group(1), m.group(1)), s)

def pick(groups):
    return unesc(next(g for g in groups if g is not None))

used = {}
for f in glob.glob(os.path.join(ROOT, '**', '*'), recursive=True):
    if not f.endswith(('.ts', '.vue')) or os.sep + 'locales' + os.sep in f or f.endswith('i18n.ts'):
        continue
    for m in CALL.finditer(open(f, encoding='utf-8').read()):
        key = pick(m.groups())
        if HAN.search(key):
            used.setdefault(key, os.path.relpath(f, ROOT))

problems = 0
for lang_dir in sorted(glob.glob(os.path.join(ROOT, 'locales', '*'))):
    if not os.path.isdir(lang_dir):
        continue
    lang = os.path.basename(lang_dir)
    merged, where = {}, {}
    for f in sorted(glob.glob(os.path.join(lang_dir, '*.ts'))):
        if f.endswith('index.ts'):
            continue
        for m in PAIR.finditer(open(f, encoding='utf-8').read()):
            g = m.groups()
            k, v = pick(g[:3]), pick(g[3:])
            if k in merged and merged[k] != v:
                print(f'[{lang}] 译文不一致：{k!r} = {merged[k]!r}（{where[k]}） / {v!r}（{os.path.basename(f)}）')
                problems += 1
            merged.setdefault(k, v)
            where.setdefault(k, os.path.basename(f))
            extra = set(re.findall(r'\{(?:s:)?(\w+)\}', v)) - set(re.findall(r'\{(\w+)\}', k))
            if extra:
                print(f'[{lang}] 译文用了原文没有的变量 {sorted(extra)}：{k!r}')
                problems += 1
    missing = sorted(k for k in used if k not in merged)
    for k in missing:
        print(f'[{lang}] 缺少译文：{k!r}（{used[k]}）')
    problems += len(missing)
    print(f'[{lang}] 源码里 {len(used)} 条，词表 {len(merged)} 条，缺 {len(missing)} 条')

sys.exit(1 if problems else 0)
