import { describe, expect, it, vi } from 'vitest'

// highlight.ts wires its pieces into Milkdown at import time. The pure parts are `wrapHighlights`
// and the regular expression given to `markRule`; the factories are replaced with pass-throughs so
// the expression can be read back without an editor.
vi.mock('@milkdown/kit/utils', () => ({
  $inputRule: (factory: unknown) => factory,
  $markSchema: (_name: string, factory: unknown) => ({ type: () => 'highlight-mark', factory }),
  $remark: (_name: string, factory: unknown) => factory,
}))
vi.mock('@milkdown/kit/prose', () => ({ markRule: (re: RegExp) => re }))

import { highlightInputRule, wrapHighlights } from '../editor/highlight'

type N = { type: string; value?: string; children?: N[] }
const text = (value: string): N => ({ type: 'text', value })
const hl = (...children: N[]): N => ({ type: 'highlight', children })
const strong = (...children: N[]): N => ({ type: 'strong', children })
const wrap = (...children: N[]) => wrapHighlights(children) as N[]

describe('wrapHighlights', () => {
  it('wraps a ==pair== inside one text node', () => {
    expect(wrap(text('a ==b c== d'))).toEqual([text('a '), hl(text('b c')), text(' d')])
    expect(wrap(text('==all=='))).toEqual([hl(text('all'))])
  })

  it('wraps several pairs', () => {
    expect(wrap(text('==a== and ==b=='))).toEqual([hl(text('a')), text(' and '), hl(text('b'))])
  })

  it('leaves text without == untouched', () => {
    expect(wrap(text('plain = text'))).toEqual([text('plain = text')])
    expect(wrap()).toEqual([])
  })

  it('does not open on == followed by a space, nor close on == preceded by a space', () => {
    expect(wrap(text('a == b == c'))).toEqual([text('a == b == c')])
    expect(wrap(text('==a ==b=='))).toEqual([hl(text('a ==b'))])
    expect(wrap(text('if x == 1'))).toEqual([text('if x == 1')])
  })

  it('restores an unpaired opening == as text', () => {
    expect(wrap(text('a ==b c'))).toEqual([text('a ==b c')])
    expect(wrap(text('==a'), strong(text('b')), text('c'))).toEqual([text('==a'), strong(text('b')), text('c')])
  })

  it('treats runs of = signs as text', () => {
    expect(wrap(text('===='))).toEqual([text('====')])
    expect(wrap(text('a ====== b'))).toEqual([text('a ====== b')])
    expect(wrap(text('==='))).toEqual([text('===')])
  })

  it('wraps across inline nodes', () => {
    expect(wrap(text('x =='), strong(text('bold')), text('== y'))).toEqual([text('x '), hl(strong(text('bold'))), text(' y')])
    expect(wrap(text('==a '), strong(text('b')), text(' c=='))).toEqual([hl(text('a '), strong(text('b')), text(' c'))])
  })

  it('recurses into inline containers', () => {
    expect(wrap(strong(text('a ==b== c')))).toEqual([strong(text('a '), hl(text('b')), text(' c'))])
  })

  it('does not wrap an existing highlight node again', () => {
    const existing = hl(text('==x=='))
    expect(wrap(existing)).toEqual([hl(text('==x=='))])
  })

  it('does not lose or reorder any text', () => {
    const flat = (ns: N[]): string => ns.map((n) => (n.type === 'text' ? n.value! : n.type === 'highlight' ? `==${flat(n.children!)}==` : flat(n.children ?? []))).join('')
    for (const s of ['a==b', '==a== ==', '== ==a==', 'a==b==c==d==e', '=a==b=', '==a====b==', 'x ==a== y ==b', '1==1 and 2==2']) {
      expect(flat(wrap(text(s))), s).toBe(s)
    }
  })
})

describe('highlight input rule', () => {
  const re = (highlightInputRule as unknown as (ctx: unknown) => RegExp)({})

  it('is a regular expression anchored at the cursor', () => {
    expect(re).toBeInstanceOf(RegExp)
    expect(re.source.endsWith('$')).toBe(true)
  })

  it('fires when the closing == is typed and captures the inner text', () => {
    expect('==a=='.match(re)?.[1]).toBe('a')
    expect('say ==two words=='.match(re)?.[0]).toBe('==two words==')
    expect('say ==two words=='.match(re)?.[1]).toBe('two words')
    expect('x==ab=='.match(re)?.[1]).toBe('ab')
    expect('==中文=='.match(re)?.[1]).toBe('中文')
  })

  it('does not fire on spaces next to the markers, empty content or longer = runs', () => {
    for (const s of ['== a==', '==a ==', '== ==', '====', '===a==', '==a===', '==a=b==', '==a== ', '==a', 'a==', 'a == b == c']) {
      expect(re.test(s), s).toBe(false)
    }
  })

  it('only takes the last pair on the line', () => {
    expect('==a== then ==b=='.match(re)?.[1]).toBe('b')
  })
})
