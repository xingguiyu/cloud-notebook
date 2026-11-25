import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Schema, type Node } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection, type Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

// find.ts wraps its ProseMirror plugin with Milkdown's `$prose`, which needs an editor context.
// Unwrap it so the plugin can be put into a plain EditorState.
vi.mock('@milkdown/kit/utils', () => ({ $prose: (factory: (ctx: unknown) => unknown) => factory({}) }))

import { clearFind, findInfo, findMatches, findPlugin, replaceCurrent, replaceEvery, setFind, stepFind } from '../editor/find'

// A small schema with the node kinds that matter for position arithmetic: text blocks, a block
// container (list), and inline leaves (image, hard break) that take one position but have no text.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*' },
    bullet_list: { group: 'block', content: 'list_item+' },
    list_item: { content: 'paragraph+' },
    text: { group: 'inline' },
    image: { group: 'inline', inline: true, atom: true },
    hardbreak: { group: 'inline', inline: true },
  },
  marks: { strong: {} },
})
const txt = (s: string) => schema.text(s)
const p = (...c: (Node | string)[]) => schema.node('paragraph', null, c.map((x) => (typeof x === 'string' ? txt(x) : x)))
const doc = (...c: Node[]) => schema.node('doc', null, c)
/** what the reported range actually covers in the document */
const cover = (d: Node, m: { from: number; to: number }) => d.textBetween(m.from, m.to, '\n', '￼')

describe('findMatches', () => {
  it('returns document positions of every occurrence, case-insensitively', () => {
    const d = doc(p('Hello hello HELLO'))
    const ms = findMatches(d, ['hello'])
    expect(ms).toEqual([
      { from: 1, to: 6 },
      { from: 7, to: 12 },
      { from: 13, to: 18 },
    ])
    expect(ms.map((m) => cover(d, m))).toEqual(['Hello', 'hello', 'HELLO'])
    expect(findMatches(d, ['HeLLo'])).toEqual(ms)
  })

  it('returns nothing for no terms, empty terms or no match', () => {
    const d = doc(p('some text'))
    expect(findMatches(d, [])).toEqual([])
    expect(findMatches(d, [''])).toEqual([])
    expect(findMatches(d, ['absent'])).toEqual([])
  })

  it('gives correct positions in later blocks and nested blocks', () => {
    const d = doc(p('first'), schema.node('heading', null, [txt('second word')]), schema.node('bullet_list', null, [schema.node('list_item', null, [p('a word here')])]))
    const ms = findMatches(d, ['word'])
    expect(ms).toHaveLength(2)
    expect(ms.map((m) => cover(d, m))).toEqual(['word', 'word'])
  })

  it('does not match across paragraphs', () => {
    expect(findMatches(doc(p('foo'), p('bar')), ['foobar'])).toEqual([])
    expect(findMatches(doc(p('foo'), p('bar')), ['o\nb'])).toEqual([])
  })

  it('matches across marks inside one paragraph', () => {
    const d = doc(p(txt('foo'), schema.text('bar', [schema.marks.strong.create()]), txt(' baz')))
    const ms = findMatches(d, ['oobar b'])
    expect(ms).toEqual([{ from: 2, to: 9 }])
    expect(cover(d, ms[0])).toBe('oobar b')
  })

  it('keeps positions aligned after inline leaves (images, hard breaks)', () => {
    const d = doc(p('ab', schema.node('image'), 'cab', schema.node('hardbreak'), 'ab'))
    const ms = findMatches(d, ['ab'])
    expect(ms.map((m) => cover(d, m))).toEqual(['ab', 'ab', 'ab'])
    expect(ms.map((m) => m.from)).toEqual([1, 5, 8])
    // and a term cannot run across a leaf
    expect(findMatches(d, ['abc'])).toEqual([])
  })

  it('finds non-overlapping occurrences of one term', () => {
    expect(findMatches(doc(p('aaaa')), ['aa'])).toEqual([
      { from: 1, to: 3 },
      { from: 3, to: 5 },
    ])
  })

  it('handles several terms: de-duplicated, sorted by position, overlaps reported', () => {
    const d = doc(p('note notebook'))
    expect(findMatches(d, ['book', 'note', 'NOTE', 'notebook'])).toEqual([
      { from: 1, to: 5 },
      { from: 6, to: 10 },
      { from: 6, to: 14 },
      { from: 10, to: 14 },
    ])
  })

  it('works with CJK text', () => {
    const d = doc(p('云笔记：我的笔记本'))
    const ms = findMatches(d, ['笔记'])
    expect(ms.map((m) => cover(d, m))).toEqual(['笔记', '笔记'])
  })

  // The text is lower-cased before searching and offsets in the lower-cased string are used as
  // document positions. "İ" (U+0130) lower-cases to two code units, so everything after it in the
  // same paragraph is reported one position too far to the right.
  // BUG CANDIDATE (low): highlight and replace hit the wrong range after such a character.
  it.fails('reports correct positions after a character whose lower-case form is longer', () => {
    const d = doc(p('İstanbul notes'))
    const ms = findMatches(d, ['notes'])
    expect(ms.map((m) => cover(d, m))).toEqual(['notes'])
  })
})

// ---------------------------------------------------------------------------------------------
// The commands only use `view.state`, `view.dispatch` and (for scrolling) `view.dom` /
// `view.coordsAtPos`, so a minimal stand-in for EditorView is enough.
// ---------------------------------------------------------------------------------------------
function fakeView(d: Node, cursor = 1) {
  const base = EditorState.create({ doc: d, plugins: [findPlugin as unknown as Plugin] })
  const v = {
    state: base.apply(base.tr.setSelection(TextSelection.create(base.doc, cursor))),
    dispatch(tr: Parameters<EditorState['apply']>[0]) {
      v.state = v.state.apply(tr)
    },
    dom: { closest: () => null },
    coordsAtPos: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  }
  return v as unknown as EditorView
}
const textOf = (v: EditorView) => v.state.doc.textBetween(0, v.state.doc.content.size, '\n', '￼')

describe('find commands', () => {
  beforeAll(() => {
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => (fn(), 0))
  })

  it('setFind counts the matches and starts at the first one after the cursor', () => {
    const d = doc(p('cat one cat two cat end'))
    expect(setFind(fakeView(d, 1), ['cat'])).toEqual({ count: 3, index: 0 })
    expect(setFind(fakeView(d, 6), ['cat'])).toEqual({ count: 3, index: 1 })
    // cursor inside a match, or right at its end: that match is current
    expect(setFind(fakeView(d, 10), ['cat'])).toEqual({ count: 3, index: 1 })
    expect(setFind(fakeView(d, 20), ['cat'])).toEqual({ count: 3, index: 2 })
    // cursor after the last match: wrap to the first
    expect(setFind(fakeView(d, 23), ['cat'])).toEqual({ count: 3, index: 0 })
    // fromStart ignores the cursor
    expect(setFind(fakeView(d, 20), ['cat'], true)).toEqual({ count: 3, index: 0 })
  })

  it('reports no current match when nothing is found or the query is empty', () => {
    const v = fakeView(doc(p('cat')))
    expect(setFind(v, ['dog'])).toEqual({ count: 0, index: -1 })
    expect(setFind(v, [])).toEqual({ count: 0, index: -1 })
    expect(stepFind(v, 1)).toEqual({ count: 0, index: -1 })
    expect(replaceEvery(v, 'x')).toBe(0)
    expect(replaceCurrent(v, 'x')).toEqual({ count: 0, index: -1 })
    expect(textOf(v)).toBe('cat')
  })

  it('stepFind walks forwards and backwards with wrap-around', () => {
    const v = fakeView(doc(p('a a a')))
    setFind(v, ['a'])
    expect(stepFind(v, 1).index).toBe(1)
    expect(stepFind(v, 1).index).toBe(2)
    expect(stepFind(v, 1).index).toBe(0)
    expect(stepFind(v, -1).index).toBe(2)
  })

  it('keeps the matches up to date when the document changes', () => {
    const v = fakeView(doc(p('cat'), p('dog')))
    setFind(v, ['cat'])
    v.dispatch(v.state.tr.insertText(' cat', 9))
    expect(findInfo(v)).toEqual({ count: 2, index: 0 })
    v.dispatch(v.state.tr.delete(1, 4))
    expect(findInfo(v)).toEqual({ count: 1, index: 0 })
  })

  it('replaceCurrent replaces one occurrence and moves on to the next', () => {
    const v = fakeView(doc(p('cat one cat two cat')))
    setFind(v, ['cat'])
    expect(replaceCurrent(v, 'dog')).toEqual({ count: 2, index: 0 })
    expect(textOf(v)).toBe('dog one cat two cat')
    expect(replaceCurrent(v, 'dog')).toEqual({ count: 1, index: 0 })
    expect(replaceCurrent(v, '')).toEqual({ count: 0, index: -1 })
    expect(textOf(v)).toBe('dog one dog two ')
  })

  it('replaceCurrent on the last match stays inside the list', () => {
    const v = fakeView(doc(p('cat cat')))
    setFind(v, ['cat'])
    stepFind(v, 1)
    expect(replaceCurrent(v, 'dog')).toEqual({ count: 1, index: 0 })
    expect(textOf(v)).toBe('cat dog')
  })

  // After a replacement the same index is kept, on the assumption that the replaced occurrence is
  // gone from the match list. When the replacement itself matches the query (a change of case, or
  // "note" → "notes") the same place is matched again, so "Replace" never advances: clicking it
  // repeatedly rewrites the first occurrence over and over.
  // BUG CANDIDATE: fixing capitalisation one by one with Replace does not work.
  it('replaceCurrent moves on when the replacement still matches the query', () => {
    const v = fakeView(doc(p('todo one todo two todo')))
    setFind(v, ['todo'])
    replaceCurrent(v, 'TODO')
    replaceCurrent(v, 'TODO')
    expect(textOf(v)).toBe('TODO one TODO two todo')
  })

  it('replaceEvery replaces all occurrences in every block and returns the number', () => {
    const v = fakeView(doc(p('cat one cat'), schema.node('heading', null, [txt('Cat two')]), p('none')))
    setFind(v, ['cat'])
    expect(replaceEvery(v, 'lion')).toBe(3)
    expect(textOf(v)).toBe('lion one lion\nlion two\nnone')
    expect(findInfo(v).count).toBe(0)
  })

  it('replaceEvery can delete, can grow the text, and replaces each place once', () => {
    const a = fakeView(doc(p('a-b-c')))
    setFind(a, ['-'])
    expect(replaceEvery(a, '')).toBe(2)
    expect(textOf(a)).toBe('abc')

    const b = fakeView(doc(p('note and note')))
    setFind(b, ['note'])
    expect(replaceEvery(b, 'notes')).toBe(2)
    expect(textOf(b)).toBe('notes and notes')
  })

  it('replaceEvery skips overlapping matches of several terms', () => {
    const v = fakeView(doc(p('notebook')))
    setFind(v, ['note', 'notebook', 'book'])
    replaceEvery(v, 'X')
    // every character is replaced at most once and nothing outside a match is touched
    expect(textOf(v)).toMatch(/^(noteX|X|XX)$/)
  })

  it('clearFind removes the matches and can leave the current match selected', () => {
    const v = fakeView(doc(p('one cat two')))
    setFind(v, ['cat'])
    clearFind(v, true)
    expect(findInfo(v)).toEqual({ count: 0, index: -1 })
    expect([v.state.selection.from, v.state.selection.to]).toEqual([5, 8])
    const w = fakeView(doc(p('one cat two')), 2)
    setFind(w, ['cat'])
    clearFind(w)
    expect([w.state.selection.from, w.state.selection.to]).toEqual([2, 2])
  })
})
