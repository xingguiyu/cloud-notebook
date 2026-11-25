import { describe, expect, it } from 'vitest'
import { TAG_RE, WIKILINK_RE, rankSuggestions } from '../store'
import { buildIndex, chunkNote, search, tokenize } from '../ai/retrieve'
import { parseModelRef, providerById } from '../ai/providers'
import { parseTags } from '../vault'

describe('rankSuggestions', () => {
  const items = ['Project plan', 'apple', 'Pineapple', 'APPLICATION', 'banana', 'grape']
  it('puts prefix matches first, then substring matches, each in original order', () => {
    expect(rankSuggestions(items, 'app')).toEqual(['apple', 'APPLICATION', 'Pineapple'])
    expect(rankSuggestions(items, 'P')).toEqual(['Project plan', 'Pineapple', 'apple', 'APPLICATION', 'grape'])
  })
  it('returns everything (up to the limit) for an empty query and nothing for no match', () => {
    expect(rankSuggestions(items, '')).toEqual(items)
    expect(rankSuggestions(items, '', 2)).toEqual(['Project plan', 'apple'])
    expect(rankSuggestions(items, 'zzz')).toEqual([])
  })
  it('applies the limit after ranking', () => {
    expect(rankSuggestions(['xa', 'ax', 'a'], 'a', 2)).toEqual(['ax', 'a'])
  })
})

describe('editor patterns in store.ts', () => {
  const all = (re: RegExp, s: string, group: number) => [...s.matchAll(new RegExp(re.source, re.flags))].map((m) => m[group])

  it('WIKILINK_RE matches [[title]] on one line without nested brackets', () => {
    expect(all(WIKILINK_RE, 'see [[Note A]] and [[b/c]] but not [[]] or [[x\ny]] or [[a[b]]]', 1)).toEqual(['Note A', 'b/c'])
  })

  it('TAG_RE (editor decoration) finds the same tags as parseTags (index)', () => {
    for (const s of ['#work\ntext #idea and（#括号）\n标签：#入门', '# Title\n## Sub\nx #a/b', 'https://x.y/p#anchor C#sharp a#b', '#a #b#c #d，#e。']) {
      const viaEditor = all(TAG_RE, s, 2).map((t) => t.slice(1))
      expect(viaEditor, s).toEqual(parseTags(s))
    }
  })
})

describe('retrieve.tokenize', () => {
  it('lower-cases English words and drops single letters', () => {
    expect(tokenize('Hello World a I_am x2 README.md')).toEqual(['hello', 'world', 'i_am', 'x2', 'readme', 'md'])
  })
  it('cuts Chinese runs into bigrams and keeps a lone character', () => {
    expect(tokenize('云笔记')).toEqual(['云笔', '笔记'])
    expect(tokenize('我 和 notes笔记')).toEqual(['我', '和', 'notes', '笔记'])
  })
  it('returns [] for punctuation and empty input', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('，。！ -- ?')).toEqual([])
  })
})

describe('retrieve.chunkNote', () => {
  it('cuts at headings and records the heading path', () => {
    const md = 'intro\n\n# A\n\na text\n\n## A1\n\na1 text\n\n# B\n\nb text\n'
    const chunks = chunkNote('p.md', 'Title', md)
    expect(chunks.map((c) => c.heading)).toEqual(['Title', 'A', 'A › A1', 'B'])
    expect(chunks.map((c) => c.text)).toEqual(['intro', '# A\n\na text', '## A1\n\na1 text', '# B\n\nb text'])
    expect(chunks.every((c) => c.path === 'p.md' && c.title === 'Title')).toBe(true)
  })
  it('does not treat # lines inside code fences as headings', () => {
    const chunks = chunkNote('p.md', 'T', '# A\n\n```sh\n# comment\nls\n```\n\nafter\n')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain('# comment')
  })
  it('splits long sections at blank lines and keeps every paragraph', () => {
    const paras = Array.from({ length: 12 }, (_, i) => `para ${i} ` + 'x'.repeat(290))
    const chunks = chunkNote('p.md', 'T', '# Long\n\n' + paras.join('\n\n'))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.text.length <= 1300 && c.heading === 'Long')).toBe(true)
    for (const p of paras) expect(chunks.some((c) => c.text.includes(p))).toBe(true)
  })
  it('returns nothing for an empty note', () => {
    expect(chunkNote('p.md', 'T', '')).toEqual([])
    expect(chunkNote('p.md', 'T', '\n\n  \n')).toEqual([])
  })
})

describe('retrieve.search (BM25)', () => {
  const chunks = [
    ...chunkNote('cook.md', '菜谱', '# 红烧肉\n\n五花肉切块，加酱油和冰糖慢炖。\n\n# 番茄炒蛋\n\n番茄和鸡蛋，快手菜。\n'),
    ...chunkNote('rust.md', 'Rust notes', '# Ownership\n\nEach value has an owner. Borrowing rules apply.\n\n# Traits\n\nTraits describe shared behaviour.\n'),
    ...chunkNote('trip.md', '旅行', '成都三日游：宽窄巷子、熊猫基地。\n'),
  ]
  const index = buildIndex(chunks)

  it('finds the matching chunk in Chinese and in English', () => {
    expect(search(index, '酱油 冰糖')[0]).toMatchObject({ path: 'cook.md', heading: '红烧肉' })
    expect(search(index, 'who is the OWNER of a value?')[0]).toMatchObject({ path: 'rust.md', heading: 'Ownership' })
    expect(search(index, '熊猫')[0].path).toBe('trip.md')
  })
  it('matches on the note title and section heading too', () => {
    expect(search(index, 'traits')[0].heading).toBe('Traits')
    expect(search(index, '菜谱').map((c) => c.path)).toEqual(['cook.md', 'cook.md'])
  })
  it('returns [] when nothing matches or the query has no tokens', () => {
    expect(search(index, 'kubernetes')).toEqual([])
    expect(search(index, '？ !')).toEqual([])
    expect(search(buildIndex([]), 'anything')).toEqual([])
  })
  it('respects k and the per-note cap', () => {
    const many = buildIndex(Array.from({ length: 10 }, (_, i) => ({ path: i < 8 ? 'a.md' : 'b.md', title: 'T', heading: `h${i}`, text: `keyword item ${i}` })))
    expect(search(many, 'keyword', 8, 3).map((c) => c.path).sort()).toEqual(['a.md', 'a.md', 'a.md', 'b.md', 'b.md'])
    expect(search(many, 'keyword', 2, 3)).toHaveLength(2)
  })
})

describe('parseModelRef', () => {
  it('splits provider:model at the first colon and defaults to anthropic', () => {
    expect(parseModelRef('deepseek:deepseek-chat')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(parseModelRef('custom:llama3:8b')).toEqual({ provider: 'custom', model: 'llama3:8b' })
    expect(parseModelRef('claude-fable-5')).toEqual({ provider: 'anthropic', model: 'claude-fable-5' })
  })
  it('every provider id resolves through providerById', () => {
    expect(providerById('custom')?.editableBase).toBe(true)
    expect(providerById('nope')).toBeUndefined()
  })
})
