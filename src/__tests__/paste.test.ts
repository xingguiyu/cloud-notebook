import { describe, expect, it } from 'vitest'
import { looksLikeMarkdown, mapImages, paragraphBreaks, preferMarkdownText } from '../editor/paste'

describe('looksLikeMarkdown', () => {
  it('recognises headings, fences, images and links', () => {
    expect(looksLikeMarkdown('# Title')).toBe(true)
    expect(looksLikeMarkdown('text\n###### deep')).toBe(true)
    expect(looksLikeMarkdown('before\n```js\ncode\n```')).toBe(true)
    expect(looksLikeMarkdown('~~~\ncode\n~~~')).toBe(true)
    expect(looksLikeMarkdown('see ![](image%204.png)')).toBe(true)
    expect(looksLikeMarkdown('see [docs](https://x.y)')).toBe(true)
  })

  it('does not fire on ordinary text', () => {
    expect(looksLikeMarkdown('just a sentence.')).toBe(false)
    expect(looksLikeMarkdown('#hashtag and C# and issue #12')).toBe(false)
    expect(looksLikeMarkdown('####### seven is not a heading')).toBe(false)
    expect(looksLikeMarkdown('#\n')).toBe(false)
    expect(looksLikeMarkdown('inline ``` fence')).toBe(false)
    expect(looksLikeMarkdown('array[0](call) x')).toBe(true) // link syntax wins: documented limitation
    expect(looksLikeMarkdown('[text](has space)')).toBe(false)
    expect(looksLikeMarkdown('- list\n- only\n**bold**')).toBe(false)
    expect(looksLikeMarkdown('')).toBe(false)
  })
})

describe('preferMarkdownText', () => {
  it('prefers the plain text when it is Markdown and the HTML has no heading tags (Bear)', () => {
    expect(preferMarkdownText('# T\n\nbody', '<p><b>T</b></p><p>body</p>')).toBe(true)
    expect(preferMarkdownText('![](a.png)', '')).toBe(true)
  })
  it('keeps the HTML when it carries real headings (web pages)', () => {
    expect(preferMarkdownText('# T\n\nbody', '<h1>T</h1><p>body</p>')).toBe(false)
    expect(preferMarkdownText('# T', '<H2 class="x">T</H2>')).toBe(false)
  })
  it('keeps the HTML when the text is not Markdown', () => {
    expect(preferMarkdownText('plain words', '<p>plain words</p>')).toBe(false)
  })
  it('is not fooled by tags that merely start with h', () => {
    expect(preferMarkdownText('# T', '<hr><header>x</header><html>')).toBe(true)
  })
})

describe('paragraphBreaks', () => {
  it('puts a blank line between adjacent text lines', () => {
    expect(paragraphBreaks('one\ntwo\nthree')).toBe('one\n\ntwo\n\nthree')
  })

  it('does not add a second blank line', () => {
    expect(paragraphBreaks('one\n\ntwo')).toBe('one\n\ntwo')
    expect(paragraphBreaks('')).toBe('')
    expect(paragraphBreaks('single')).toBe('single')
  })

  it('separates headings from text', () => {
    expect(paragraphBreaks('# T\nbody\n## S\nmore')).toBe('# T\n\nbody\n\n## S\n\nmore')
  })

  it('keeps list items and their indented content together', () => {
    const md = '- a\n- b\n  continued\n  - nested\n1. one\n2) two'
    expect(paragraphBreaks(md)).toBe(md)
  })

  it('separates a list from the text around it', () => {
    expect(paragraphBreaks('intro\n- a\n- b\noutro')).toBe('intro\n\n- a\n- b\n\noutro')
  })

  it('keeps table rows together and quote lines together', () => {
    expect(paragraphBreaks('| a | b |\n| - | - |\n| 1 | 2 |')).toBe('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(paragraphBreaks('> q1\n> q2\nafter')).toBe('> q1\n> q2\n\nafter')
    expect(paragraphBreaks('before\n| a |\n| - |')).toBe('before\n\n| a |\n| - |')
  })

  it('leaves fenced code untouched, including after the fence closes and unterminated fences', () => {
    expect(paragraphBreaks('```js\na\nb\n```')).toBe('```js\na\nb\n```')
    expect(paragraphBreaks('text\n```\na\nb\n```\nafter\nmore')).toBe('text\n\n```\na\nb\n```\nafter\n\nmore')
    expect(paragraphBreaks('~~~\na\nb')).toBe('~~~\na\nb')
    expect(paragraphBreaks('- item\n```\ncode\n```')).toBe('- item\n```\ncode\n```')
  })

  it('normalises CRLF and CR line endings', () => {
    expect(paragraphBreaks('one\r\ntwo\rthree')).toBe('one\n\ntwo\n\nthree')
  })

  it('is idempotent', () => {
    const md = '# T\nline one\nline two\n- a\n- b\n> q\n```\nx\ny\n```\nend'
    expect(paragraphBreaks(paragraphBreaks(md))).toBe(paragraphBreaks(md))
  })
})

describe('mapImages', () => {
  it('matches local images to clipboard images by decoded file name', () => {
    const md = '![](image%204.png)\n\n![x](other.png)'
    const out = mapImages(md, [
      { src: 'blob:2', name: 'other.png' },
      { src: 'blob:1', name: 'image 4.png' },
    ])
    expect(out).toBe('![](blob:1)\n\n![x](blob:2)')
  })

  it('falls back to order of appearance for images whose name is unknown', () => {
    const md = '![](a.png) ![](b.png) ![](c.png)'
    const out = mapImages(md, [
      { src: 'S1', name: '' },
      { src: 'S-b', name: 'b.png' },
      { src: 'S2', name: '' },
    ])
    expect(out).toBe('![](S1) ![](S-b) ![](S2)')
  })

  it('compares only the last path segment', () => {
    expect(mapImages('![](sub/dir/pic.png)', [{ src: 'S', name: 'pic.png' }])).toBe('![](S)')
  })

  it('leaves remote, data and blob images alone and does not spend clipboard images on them', () => {
    const md = '![](https://x.y/a.png) ![](data:image/png;base64,AA) ![](local.png)'
    expect(mapImages(md, [{ src: 'S', name: '' }])).toBe('![](https://x.y/a.png) ![](data:image/png;base64,AA) ![](S)')
  })

  it('keeps alt text and title, and leaves extra references untouched when images run out', () => {
    expect(mapImages('![alt](a.png "the title") ![](b.png)', [{ src: 'S', name: 'a.png' }])).toBe('![alt](S "the title") ![](b.png)')
  })

  it('uses each clipboard image once, even when two references share a name', () => {
    const out = mapImages('![](a.png) ![](a.png)', [
      { src: 'S1', name: 'a.png' },
      { src: 'S2', name: 'a.png' },
    ])
    expect(out).toBe('![](S1) ![](S2)')
  })

  it('returns the text unchanged when there is nothing to map', () => {
    expect(mapImages('no images here', [{ src: 'S', name: 'a.png' }])).toBe('no images here')
    expect(mapImages('![](a.png)', [])).toBe('![](a.png)')
  })

  it('tolerates a malformed percent-escape in the file name', () => {
    expect(mapImages('![](100%.png)', [{ src: 'S', name: '100%.png' }])).toBe('![](S)')
  })
})
