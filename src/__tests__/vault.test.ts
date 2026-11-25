import { describe, expect, it } from 'vitest'
import { isRemote, noteExcerpt, noteImages, noteTitle, parseTags, plainInline, resolveAsset, resolveVaultPath } from '../vault'

describe('parseTags', () => {
  it('finds #tags at line start, after whitespace and after CJK punctuation', () => {
    expect(parseTags('#work\n\ntext #idea and（#括号）\n标签：#入门')).toEqual(['work', 'idea', '括号', '入门'])
  })

  it('supports nested tags and de-duplicates', () => {
    expect(parseTags('#a/b #a/b #a')).toEqual(['a/b', 'a'])
  })

  it('does not treat headings as tags', () => {
    expect(parseTags('# Title\n\n## Sub\n\n### #real')).toEqual(['real'])
  })

  it('strips trailing punctuation', () => {
    expect(parseTags('see #todo, then #done. and #ask? (#paren)')).toEqual(['todo', 'done', 'ask', 'paren'])
    expect(parseTags('版本 #v1.2 发布')).toEqual(['v1.2'])
  })

  it('ignores # inside URLs, words and code', () => {
    expect(parseTags('https://example.com/page#anchor C#sharp a#b')).toEqual([])
    expect(parseTags('```\n#not-a-tag\n```\n\n`#nor-this` #yes')).toEqual(['yes'])
  })

  it('accepts the escaped form the editor writes (\\#tag)', () => {
    expect(parseTags('text \\#escaped')).toEqual(['escaped'])
  })

  it('ignores the front matter', () => {
    expect(parseTags('---\nsource: a #b\n---\n\n#real')).toEqual(['real'])
  })

  // "(#)" or " #." match the tag pattern, then the trailing-punctuation strip leaves nothing.
  // BUG CANDIDATE (low): an empty tag ends up in the tag list.
  it('never returns an empty tag', () => {
    expect(parseTags('see issue (#) and #.')).toEqual([])
  })

  // "(" is an allowed character in front of a tag so that "(#tag)" works, which also makes the
  // target of an in-page link a tag.
  // BUG CANDIDATE (low): [text](#heading) adds a tag named "heading".
  it('does not treat the target of an anchor link as a tag', () => {
    expect(parseTags('[jump](#section-two)')).toEqual([])
  })
})

describe('plainInline', () => {
  it('removes emphasis, strike, highlight and code marks', () => {
    expect(plainInline('**bold** __b2__ ~~gone~~ ==hl== `code`')).toBe('bold b2 gone hl code')
    expect(plainInline('*it* and _it2_')).toBe('it and it2')
  })

  it('keeps underscores and asterisks inside words', () => {
    expect(plainInline('snake_case_name')).toBe('snake_case_name')
    expect(plainInline('2*3*4')).toBe('2*3*4')
  })

  it('keeps link and image text, drops the target', () => {
    expect(plainInline('[text](https://x.y) ![alt](a.png)')).toBe('text alt')
  })

  it('unwraps autolinks and e-mail addresses', () => {
    expect(plainInline('<https://x.y/z> <me@example.com>')).toBe('https://x.y/z me@example.com')
  })

  it('removes backslash escapes and trims', () => {
    expect(plainInline('  1\\. First \\#tag \\[x\\] a\\_b \\\\ end  ')).toBe('1. First #tag [x] a_b \\ end')
  })

  // The emphasis pattern runs before the escapes are removed, so an escaped pair `\*…\*` or
  // `\_…\_` (which is how the editor writes literal asterisks / underscores) is taken for emphasis:
  // the markers are removed and the backslashes stay.
  // BUG CANDIDATE: a title "2 * 3 * 4" (saved as `2 \* 3 \* 4`) is shown, and the file renamed, as "2 \ 3 \ 4".
  it('keeps escaped asterisks and underscores as literal characters', () => {
    expect(plainInline('2 \\* 3 \\* 4')).toBe('2 * 3 * 4')
    expect(plainInline('\\_\\_init\\_\\_ method')).toBe('__init__ method')
  })
})

describe('noteTitle', () => {
  it('uses the first level-1 heading, as plain text', () => {
    expect(noteTitle('a/b/file.md', 'intro\n\n# The **Title**\n\n# Second')).toBe('The Title')
  })

  it('falls back to the file name without .md', () => {
    expect(noteTitle('a/b/file.md', 'no heading\n\n## only h2')).toBe('file')
    expect(noteTitle('file.md', '')).toBe('file')
    expect(noteTitle('dir/名字.v2.md', '#tag only')).toBe('名字.v2')
  })

  it('looks at the body, not at the front matter', () => {
    expect(noteTitle('x.md', '---\nstatus: draft\n---\n\n# Real')).toBe('Real')
    expect(noteTitle('x.md', '---\nstatus: draft\n---\n\ntext')).toBe('x')
  })

  it('falls back to the file name when the heading has no text left after removing markup', () => {
    expect(noteTitle('x.md', '# ` `')).toBe('x')
    expect(noteTitle('x.md', '# [](https://x.y)')).toBe('x')
  })

  // `^#\s+(.+)$` lets \s+ run across line breaks, so an empty heading ("#" on its own line, which is
  // what the editor writes for an empty H1) takes the next non-empty line as the title.
  // BUG CANDIDATE: the first paragraph becomes the title (and, through rename-by-title, the file name).
  it('an empty heading does not swallow the following paragraph', () => {
    expect(noteTitle('untitled.md', '#\n\nfirst paragraph of the body\n')).toBe('untitled')
  })
})

describe('noteExcerpt', () => {
  it('drops the title, markup, images, code blocks, tags and table rules', () => {
    const md = [
      '---\nstatus: draft\n---\n',
      '# Title',
      '',
      'First **bold** line with `code` and [link](https://x.y).',
      '',
      '![shot](assets/1.png)',
      '',
      '```js\nconst hidden = 1\n```',
      '',
      '- [ ] todo item',
      '- [x] done item',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '#tag1 \\#tag2 tail<br>end',
    ].join('\n')
    expect(noteExcerpt(md)).toBe('First bold line with code and linkhttps://x.y. todo item done item a b 1 2 tail end')
  })

  it('is capped at 240 characters and collapses whitespace', () => {
    expect(noteExcerpt('# T\n\n' + 'word '.repeat(200))).toHaveLength(240)
    expect(noteExcerpt('a\n\n\n   b\t\tc')).toBe('a b c')
  })

  it('is empty for an empty or title-only note', () => {
    expect(noteExcerpt('')).toBe('')
    expect(noteExcerpt('# Only title\n')).toBe('')
  })
})

describe('noteImages', () => {
  it('returns image targets in order, up to the limit', () => {
    const md = '![a](assets/1.png) text ![b](<assets/2.png>) ![c](https://x.y/3.jpg "title") ![d](4.png)'
    expect(noteImages(md)).toEqual(['assets/1.png', 'assets/2.png', 'https://x.y/3.jpg'])
    expect(noteImages(md, 10)).toEqual(['assets/1.png', 'assets/2.png', 'https://x.y/3.jpg', '4.png'])
    expect(noteImages(md, 1)).toEqual(['assets/1.png'])
  })

  it('skips temporary blob: and data: addresses without counting them', () => {
    expect(noteImages('![](blob:tauri://x/1) ![](data:image/png;base64,AAAA) ![](ok.png)')).toEqual(['ok.png'])
  })

  it('ignores plain links and returns [] when there are none', () => {
    expect(noteImages('[link](a.png) no images')).toEqual([])
  })
})

describe('isRemote', () => {
  it('is true for anything with a URL scheme', () => {
    for (const s of ['https://x.y/a.png', 'http://x', 'data:image/png;base64,AA', 'blob:abc', 'vault://localhost/a', 'FILE:///x']) expect(isRemote(s), s).toBe(true)
  })
  it('is false for relative and absolute paths', () => {
    for (const s of ['assets/a.png', './a.png', '../a.png', '/abs/a.png', 'a b.png', '', '1x:not-a-scheme', 'dir/with:colon.png']) expect(isRemote(s), s).toBe(false)
  })
})

describe('resolveVaultPath', () => {
  it('resolves relative to the folder of the note', () => {
    expect(resolveVaultPath('a/b/note.md', 'assets/x.png')).toBe('a/b/assets/x.png')
    expect(resolveVaultPath('note.md', 'assets/x.png')).toBe('assets/x.png')
    expect(resolveVaultPath('a/b/note.md', './x.png')).toBe('a/b/x.png')
    expect(resolveVaultPath('a/b/note.md', '../x.png')).toBe('a/x.png')
    expect(resolveVaultPath('a/b/note.md', '../../x.png')).toBe('x.png')
  })

  it('cannot climb out of the vault', () => {
    expect(resolveVaultPath('a/note.md', '../../../etc/passwd')).toBe('etc/passwd')
    expect(resolveVaultPath('note.md', '..')).toBe('')
  })

  it('decodes percent-escapes and tolerates malformed ones', () => {
    expect(resolveVaultPath('n.md', 'assets/image%204.png')).toBe('assets/image 4.png')
    expect(resolveVaultPath('n.md', 'assets/%E5%9B%BE.png')).toBe('assets/图.png')
    expect(resolveVaultPath('n.md', 'assets/100%.png')).toBe('assets/100%.png')
  })

  it('collapses empty segments', () => {
    expect(resolveVaultPath('a/n.md', 'assets//x.png')).toBe('a/assets/x.png')
    expect(resolveVaultPath('a/n.md', '/x.png')).toBe('a/x.png')
  })
})

describe('resolveAsset', () => {
  it('leaves remote and empty sources alone and maps local ones to the vault protocol', () => {
    expect(resolveAsset('a/n.md', 'https://x.y/a.png')).toBe('https://x.y/a.png')
    expect(resolveAsset('a/n.md', '')).toBe('')
    expect(resolveAsset('a/n.md', 'assets/x.png')).toBe(`vault://localhost/${encodeURIComponent('a/assets/x.png')}`)
  })
})
