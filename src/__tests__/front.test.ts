import { describe, expect, it } from 'vitest'
import { bodyOf, diffLines, docStatus, frontGet, frontSet, isRetired, splitFront, withFront } from '../front'

// ---------------------------------------------------------------------------------------------
// Reference port of the Rust implementation in src-tauri/src/docs.rs (`split`, `get`, `quote`,
// `set`). It is a line-by-line transliteration, kept here so the two implementations can be
// compared over a corpus. If docs.rs changes, update this port.
// ---------------------------------------------------------------------------------------------
const rsIsKeyLine = (l: string) => {
  const i = l.indexOf(':')
  return i > 0 && /^[A-Za-z0-9_-]+$/.test(l.slice(0, i))
}
/** `str::split_inclusive('\n')` */
function rsSplitInclusive(s: string) {
  const out: string[] = []
  let p = 0
  while (p < s.length) {
    const nl = s.indexOf('\n', p)
    const e = nl < 0 ? s.length : nl + 1
    out.push(s.slice(p, e))
    p = e
  }
  return out
}
/** `str::lines()`: split on \n, drop one trailing \r per line, no trailing empty line */
function rsLines(s: string) {
  const parts = s.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
}
function rsSplit(md: string): { front: string | null; body: string } {
  const none = { front: null, body: md }
  let rest: string
  if (md.startsWith('---\n')) rest = md.slice(4)
  else if (md.startsWith('---\r\n')) rest = md.slice(5)
  else return none
  let pos = 0
  for (const line of rsSplitInclusive(rest)) {
    const t = line.replace(/[\r\n]+$/, '')
    if (t === '---') {
      if (pos === 0) return none
      const body = rest.slice(pos + line.length)
      return { front: rest.slice(0, pos), body: body.startsWith('\n') ? body.slice(1) : body }
    }
    // docs.rs: after the first key line, indented continuations, list items and comments are allowed
    const continuation = pos > 0 && (/^[ \t#]/.test(t) || t.startsWith('- ') || t === '-')
    if (t.trim() !== '' && !rsIsKeyLine(t) && !continuation) return none
    pos += line.length
  }
  return none
}
function rsUnquote(raw: string) {
  const v = raw.trim()
  const quoted = v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  return quoted ? v.slice(1, -1).split('\\"').join('"') : v
}
function rsGet(md: string, key: string): string | undefined {
  const { front } = rsSplit(md)
  if (front === null) return undefined
  for (const l of rsLines(front)) {
    const i = l.indexOf(':')
    if (i < 0 || !rsIsKeyLine(l)) continue
    if (l.slice(0, i) !== key) continue
    const v = rsUnquote(l.slice(i + 1))
    if (v) return v
  }
  return undefined
}
function rsQuote(raw: string) {
  // docs.rs replaces control characters with spaces and trims before deciding how to quote
  // eslint-disable-next-line no-control-regex
  const v = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  const plain =
    v !== '' &&
    !['[', '{', '"', "'", '#', '&', '*', '!', '|', '>', '%', '@', '`', '-', ' '].some((c) => v.startsWith(c)) &&
    !v.endsWith(' ') &&
    !v.includes(': ') &&
    !v.includes(' #') &&
    !['\n', ',', ']'].some((c) => v.includes(c))
  return plain ? v : `"${v.split('"').join('\\"')}"`
}
/** `docs::set` with every value passed through `scalar` (= `quote`), which is what the app side does */
function rsSet(md: string, pairs: Record<string, string | undefined>) {
  const { front, body } = rsSplit(md)
  let lines = front === null ? [] : rsLines(front)
  for (const [key, value] of Object.entries(pairs)) {
    const at = lines.findIndex((l) => rsIsKeyLine(l) && l.slice(0, l.indexOf(':')) === key)
    if (at >= 0 && value !== undefined) lines[at] = `${key}: ${rsQuote(value)}`
    else if (at >= 0) lines.splice(at, 1)
    else if (value !== undefined) lines.push(`${key}: ${rsQuote(value)}`)
  }
  lines = lines.filter((l) => l.trim() !== '')
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n${body}` : body
}

const DOC = '---\nstatus: draft\nauthor: me\n---\n\n# 标题\n\n正文\n'

describe('splitFront', () => {
  it('splits a head wrapped in --- whose lines are all key: value', () => {
    expect(splitFront(DOC)).toEqual({ front: 'status: draft\nauthor: me\n', body: '# 标题\n\n正文\n' })
  })

  it('drops exactly one blank line after the closing ---', () => {
    expect(splitFront('---\na: b\n---\ntext').body).toBe('text')
    expect(splitFront('---\na: b\n---\n\ntext').body).toBe('text')
    expect(splitFront('---\na: b\n---\n\n\ntext').body).toBe('\ntext')
  })

  it('accepts a closing --- at the very end of the file', () => {
    expect(splitFront('---\na: b\n---')).toEqual({ front: 'a: b\n', body: '' })
    expect(splitFront('---\na: b\n---\n')).toEqual({ front: 'a: b\n', body: '' })
  })

  it('allows blank lines and keys without a space after the colon', () => {
    expect(splitFront('---\na: b\n\nurl:http://x/y\n---\nz')).toEqual({ front: 'a: b\n\nurl:http://x/y\n', body: 'z' })
  })

  it('accepts multi-line YAML written by other tools and keeps it when a key is set', () => {
    const md = '---\ntitle: x\ntags:\n  - a\n  - b\n# note\n---\n\n正文\n'
    expect(splitFront(md)).toEqual({ front: 'title: x\ntags:\n  - a\n  - b\n# note\n', body: '正文\n' })
    expect(frontGet(md, 'title')).toBe('x')
    expect(frontSet(md, { status: 'archived' })).toBe('---\ntitle: x\ntags:\n  - a\n  - b\n# note\nstatus: archived\n---\n\n正文\n')
    // 缩进的 status 是别的键下面的内容，不当成文档状态
    expect(frontGet('---\nmeta:\n  status: draft\n---\n\nx', 'status')).toBeUndefined()
  })

  it('leaves a note that merely starts with a divider alone', () => {
    // same list as the Rust test `front_matter_ignores_plain_divider` plus a few more
    for (const md of [
      '---\n\n正文在分隔线后面\n',
      '---\n这不是头部\n---\n正文\n',
      '---\n---\n正文\n',
      '---',
      '---\n',
      '----\na: b\n---\n',
      ' ---\na: b\n---\n',
      '--- \na: b\n---\n',
      '---\na: b\n', // never closed
      '---\na: b\n--- \n', // closing line has a trailing space
      '---\na.b: c\n---\n',
      '---\n标题: c\n---\n',
      '---\n: c\n---\n',
      '# T\n\n---\na: b\n---\n', // not at the top
      '',
    ]) {
      expect(splitFront(md), JSON.stringify(md)).toEqual({ front: null, body: md })
      expect(bodyOf(md), JSON.stringify(md)).toBe(md)
    }
  })

  it('handles CRLF line endings the way docs.rs does', () => {
    const md = '---\r\nstatus: draft\r\n---\r\n\r\nbody\r\n'
    // Rust only strips a bare \n after the closing line, so the \r\n blank line stays in the body
    expect(splitFront(md)).toEqual({ front: 'status: draft\r\n', body: '\r\nbody\r\n' })
    expect(frontGet(md, 'status')).toBe('draft')
    expect(docStatus(md)).toBe('draft')
  })

  it('stops at the first closing ---, so later --- lines belong to the body', () => {
    const md = '---\na: b\n---\n\nintro\n\n---\n\nmore\n\n---\nk: v\n---\n'
    expect(splitFront(md)).toEqual({ front: 'a: b\n', body: 'intro\n\n---\n\nmore\n\n---\nk: v\n---\n' })
    const md2 = '---\na: b\n---\n\n---\nk: v\n---\ntext'
    expect(splitFront(md2)).toEqual({ front: 'a: b\n', body: '---\nk: v\n---\ntext' })
  })
})

describe('bodyOf / withFront', () => {
  it('bodyOf returns the text itself when there is no head', () => {
    expect(bodyOf('# T\n\nx')).toBe('# T\n\nx')
    expect(bodyOf(DOC)).toBe('# 标题\n\n正文\n')
  })

  it('withFront returns the new body unchanged when the original has no head', () => {
    expect(withFront('# old', '# new')).toBe('# new')
    expect(withFront('---\n\nold', 'new')).toBe('new')
  })

  it('withFront keeps the original head and swaps the body', () => {
    expect(withFront(DOC, 'new body\n')).toBe('---\nstatus: draft\nauthor: me\n---\n\nnew body\n')
    expect(withFront(DOC, '')).toBe('---\nstatus: draft\nauthor: me\n---\n\n')
  })

  it('round-trips withFront(md, bodyOf(md)) for documents in canonical form', () => {
    for (const md of [
      DOC,
      '---\na: b\n---\n\n',
      '---\na: b\n\nc: "x, y"\n---\n\n\n\nleading blank lines\n',
      '---\na: b\n---\n\nintro\n\n---\n\nmore\n---\nk: v\n---\n',
      '---\na: b\n---\n\n---\nk: v\n---\ntext',
      '# no head\n',
      '---\n\ndivider note\n',
      '',
    ]) {
      expect(withFront(md, bodyOf(md)), JSON.stringify(md)).toBe(md)
    }
  })

  it('normalises a head without the blank line once, then is stable', () => {
    const md = '---\na: b\n---\ntext\n'
    const once = withFront(md, bodyOf(md))
    expect(once).toBe('---\na: b\n---\n\ntext\n')
    expect(withFront(once, bodyOf(once))).toBe(once)
  })

  it('keeps body and keys of a CRLF document stable across a round trip', () => {
    const md = '---\r\nstatus: draft\r\nauthor: me\r\n---\r\n\r\nbody\r\n'
    const once = withFront(md, bodyOf(md))
    expect(bodyOf(once)).toBe(bodyOf(md))
    expect(frontGet(once, 'status')).toBe('draft')
    expect(frontGet(once, 'author')).toBe('me')
    expect(withFront(once, bodyOf(once))).toBe(once)
  })

  it('a body containing --- lines survives an edit', () => {
    const md = '---\nstatus: current\n---\n\n# T\n\n---\n\nnote: this is body text\n\n---\n'
    const edited = bodyOf(md) + 'appended\n'
    const next = withFront(md, edited)
    expect(bodyOf(next)).toBe(edited)
    expect(frontGet(next, 'status')).toBe('current')
    expect(frontGet(next, 'note')).toBeUndefined()
  })
})

describe('frontGet', () => {
  it('reads plain, quoted and colon-containing values', () => {
    const md = '---\nstatus: draft\ntitle: "a: b, \\"c\\""\nsingle: \'x y\'\nsource: https://example.com/a#b\nempty:\npadded:    v  \n---\n\nbody'
    expect(frontGet(md, 'status')).toBe('draft')
    expect(frontGet(md, 'title')).toBe('a: b, "c"')
    expect(frontGet(md, 'single')).toBe('x y')
    expect(frontGet(md, 'source')).toBe('https://example.com/a#b')
    expect(frontGet(md, 'padded')).toBe('v')
    expect(frontGet(md, 'empty')).toBeUndefined()
    expect(frontGet(md, 'missing')).toBeUndefined()
    expect(frontGet(md, 'stat')).toBeUndefined()
  })

  it('returns undefined when there is no head, even if the body has key: value lines', () => {
    expect(frontGet('status: draft\n', 'status')).toBeUndefined()
    expect(frontGet('---\n\nstatus: draft\n', 'status')).toBeUndefined()
    expect(frontGet('# T\n\n---\nstatus: draft\n---\n', 'status')).toBeUndefined()
  })

  it('a lone quote character is not treated as a quoted value', () => {
    expect(frontGet('---\nk: "\n---\n', 'k')).toBe('"')
  })

  // docs.rs `get` uses find_map + filter: an empty first occurrence is skipped and the next
  // occurrence of the key wins. front.ts returns at the first matching line.
  // BUG CANDIDATE (low): the two sides disagree on duplicate keys when the first one is empty.
  it('agrees with docs.rs when a key appears twice and the first occurrence is empty', () => {
    const md = '---\nstatus:\nstatus: draft\n---\n\nbody'
    expect(rsGet(md, 'status')).toBe('draft')
    expect(frontGet(md, 'status')).toBe(rsGet(md, 'status'))
  })
})

describe('frontSet', () => {
  it('creates a head on a note that has none', () => {
    expect(frontSet('# T\n', { status: 'draft' })).toBe('---\nstatus: draft\n---\n\n# T\n')
  })

  it('creates a head in front of a note that starts with a divider, keeping the note as body', () => {
    for (const md of ['---\n\n正文在分隔线后面\n', '---\n这不是头部\n---\n正文\n', '---\n---\n正文\n']) {
      const out = frontSet(md, { status: 'draft' })
      expect(splitFront(out).body).toBe(md)
      expect(frontGet(out, 'status')).toBe('draft')
    }
  })

  it('updates a key in place and keeps the other keys, their order and the body', () => {
    const out = frontSet('---\na: 1\nstatus: draft\nz: 9\n---\n\nbody\n', { status: 'current' })
    expect(out).toBe('---\na: 1\nstatus: current\nz: 9\n---\n\nbody\n')
  })

  it('removes a key with undefined, and removes the head when it becomes empty', () => {
    expect(frontSet(DOC, { status: undefined })).toBe('---\nauthor: me\n---\n\n# 标题\n\n正文\n')
    expect(frontSet(DOC, { status: undefined, author: undefined })).toBe('# 标题\n\n正文\n')
    expect(frontSet(DOC, { nothere: undefined })).toBe(DOC)
    expect(frontSet('plain', { nothere: undefined })).toBe('plain')
  })

  it('does what setDocStatus needs: set status and clear superseded_by in one call', () => {
    const md = '---\nstatus: superseded\nsuperseded_by: b.md\n---\n\nx'
    expect(frontSet(md, { status: 'current', superseded_by: undefined })).toBe('---\nstatus: current\n---\n\nx')
    expect(frontSet(md, { status: 'superseded' })).toBe(md)
  })

  it('does not confuse a key with another key that has it as a prefix', () => {
    const md = '---\nstatus_note: x\nstatus: draft\n---\n\nb'
    expect(frontSet(md, { status: 'current' })).toBe('---\nstatus_note: x\nstatus: current\n---\n\nb')
  })

  const NEEDS_QUOTES = ['', '[x]', '{x}', '"x', "'x", '#x', '&x', '*x', '!x', '|x', '>x', '%x', '@x', '`x', '-x', ' x', 'x ', 'a: b', 'a #b', 'a,b', 'a]b', 'say "hi", ok']
  const PLAIN = ['draft', 'a/b.md', 'x:y', 'a#b', 'say "hi"', "it's", 'https://example.com/a?b=c', '中文 值', 'a - b', 'a[b']

  it('quotes exactly the values docs.rs `quote` quotes', () => {
    for (const v of NEEDS_QUOTES) {
      expect(frontSet('b', { k: v }), JSON.stringify(v)).toBe(`---\nk: "${v.replace(/"/g, '\\"')}"\n---\n\nb`)
      expect(rsQuote(v), JSON.stringify(v)).toBe(`"${v.replace(/"/g, '\\"')}"`)
    }
    for (const v of PLAIN) {
      expect(frontSet('b', { k: v }), JSON.stringify(v)).toBe(`---\nk: ${v}\n---\n\nb`)
      expect(rsQuote(v), JSON.stringify(v)).toBe(v)
    }
  })

  it('values survive a write and a read, on both implementations', () => {
    for (const v of [...NEEDS_QUOTES, ...PLAIN, 'a\\"b, c', '"quoted"', "'single'", 'x: "y"']) {
      if (v === '') continue // an empty value reads back as "missing" on both sides
      const out = frontSet('body', { k: v })
      // leading/trailing spaces are kept by the quotes
      expect(frontGet(out, 'k'), JSON.stringify(v)).toBe(v)
      expect(rsGet(out, 'k'), JSON.stringify(v)).toBe(v)
      expect(bodyOf(out)).toBe('body')
    }
  })
})

describe('front matter agrees with docs.rs (reference port)', () => {
  const FRONTS = [
    '',
    '---\nstatus: draft\n---\n',
    '---\nstatus: draft\n---\n\n',
    '---\nstatus: "superseded"\nsuperseded_by: [a.md, "b, c.md"]\nsource: /Users/x/repo/docs/a.md\n---\n\n',
    '---\n\nstatus: archived\n\n---\n',
    '---\nstatus: current\n---',
    '---\n---\n',
    '---\n\n',
    '---\nnot a key line\n---\n',
    '---\nstatus: draft\n',
    '---\nstatus: draft\n--- \n',
    '---\nk:v\nk2:\n---\n',
    '---\n  indented: x\n---\n',
    '---\nstatus : spaced\n---\n',
  ]
  const BODIES = ['', '# T\n\nbody\n', '\n\nleading blanks', '---\n\nafter divider\n', '---\nk: v\n---\nlooks like a head\n', 'status: draft\n']
  const KEYS = ['status', 'superseded_by', 'source', 'k', 'k2', 'indented', 'missing']

  it('split / get agree on LF documents', () => {
    for (const f of FRONTS)
      for (const b of BODIES) {
        const md = f + b
        expect(splitFront(md), JSON.stringify(md)).toEqual(rsSplit(md))
        for (const k of KEYS) expect(frontGet(md, k), `${k} in ${JSON.stringify(md)}`).toBe(rsGet(md, k))
      }
  })

  it('split / get agree on CRLF documents', () => {
    for (const f of FRONTS)
      for (const b of BODIES) {
        const md = (f + b).replace(/\n/g, '\r\n')
        expect(splitFront(md), JSON.stringify(md)).toEqual(rsSplit(md))
        for (const k of KEYS) expect(frontGet(md, k), `${k} in ${JSON.stringify(md)}`).toBe(rsGet(md, k))
      }
  })

  it('set produces the same bytes on LF documents', () => {
    const changes: Record<string, string | undefined>[] = [
      { status: 'current' },
      { status: 'superseded', superseded_by: 'b, c.md' },
      { status: undefined },
      { status: 'archived', superseded_by: undefined },
      { k2: 'x: y', missing: undefined },
    ]
    for (const f of FRONTS)
      for (const b of BODIES)
        for (const c of changes) {
          const md = f + b
          expect(frontSet(md, c), `${JSON.stringify(c)} on ${JSON.stringify(md)}`).toBe(rsSet(md, c))
        }
  })

  it('set on a CRLF document keeps every key readable and the body intact', () => {
    const md = '---\r\nauthor: me\r\nstatus: draft\r\n---\r\n\r\nbody\r\n'
    const out = frontSet(md, { status: 'current', extra: 'v' })
    expect(frontGet(out, 'author')).toBe('me')
    expect(frontGet(out, 'status')).toBe('current')
    expect(frontGet(out, 'extra')).toBe('v')
    expect(bodyOf(out)).toBe(bodyOf(md))
    expect(rsGet(out, 'author')).toBe('me')
  })

  // docs.rs `set` reads the head with `lines()`, which drops the \r, and writes LF. front.ts splits
  // on \n only, so untouched lines keep their \r and the head ends up with mixed line endings.
  // BUG CANDIDATE (cosmetic): the app and the MCP server write different bytes for the same change.
  it.fails('set produces the same bytes as docs.rs on a CRLF document', () => {
    const md = '---\r\nauthor: me\r\nstatus: draft\r\n---\r\n\r\nbody\r\n'
    expect(frontSet(md, { status: 'current' })).toBe(rsSet(md, { status: 'current' }))
  })

  it('split / get agree on generated documents', () => {
    // small deterministic generator: random line soup around the interesting tokens
    let seed = 20261125
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const LINES = ['---', '---', '---', 'status: draft', 'status:', 'k: "v"', "k: 'v'", 'k:v', '', '', 'plain text', '--- ', '# T', 'a-b_c: 1', 'x y: z', ': v', '  k: v', 'status: archived']
    const EOLS = ['\n', '\n', '\n', '\r\n', '']
    for (let n = 0; n < 3000; n++) {
      let md = ''
      const count = rnd(7)
      for (let i = 0; i < count; i++) md += LINES[rnd(LINES.length)] + EOLS[rnd(EOLS.length)]
      expect(splitFront(md), JSON.stringify(md)).toEqual(rsSplit(md))
      // duplicate keys with an empty first occurrence are a known divergence, covered above
      if (!/status:\s*(\r?\n|$)/.test(md)) expect(frontGet(md, 'status'), JSON.stringify(md)).toBe(rsGet(md, 'status'))
      expect(bodyOf(md), JSON.stringify(md)).toBe(rsSplit(md).body)
    }
  })
})

describe('docStatus / isRetired', () => {
  it('reads the four known statuses and nothing else', () => {
    for (const s of ['current', 'draft', 'superseded', 'archived'] as const) expect(docStatus(`---\nstatus: ${s}\n---\n\nx`)).toBe(s)
    expect(docStatus('---\nstatus: "archived"\n---\n\nx')).toBe('archived')
    expect(docStatus('---\nstatus: done\n---\n\nx')).toBeUndefined()
    expect(docStatus('---\nstatus: Draft\n---\n\nx')).toBeUndefined()
    expect(docStatus('---\nauthor: me\n---\n\nx')).toBeUndefined()
    expect(docStatus('status: draft\n')).toBeUndefined()
    expect(docStatus('')).toBeUndefined()
  })

  it('only superseded and archived are retired', () => {
    expect(isRetired('superseded')).toBe(true)
    expect(isRetired('archived')).toBe(true)
    expect(isRetired('current')).toBe(false)
    expect(isRetired('draft')).toBe(false)
    expect(isRetired(undefined)).toBe(false)
  })
})

describe('diffLines', () => {
  const show = (rows: { t: string; k: string }[]) => rows.map((r) => r.k + r.t)
  /** applying the diff must reproduce both sides */
  const check = (a: string, b: string) => {
    const rows = diffLines(a, b)
    expect(rows.filter((r) => r.k !== '+').map((r) => r.t).join('\n')).toBe(a)
    expect(rows.filter((r) => r.k !== '-').map((r) => r.t).join('\n')).toBe(b)
    return rows
  }

  it('marks identical text as unchanged', () => {
    expect(show(diffLines('a\nb', 'a\nb'))).toEqual([' a', ' b'])
    expect(show(diffLines('', ''))).toEqual([' '])
  })

  it('marks added, removed and changed lines', () => {
    expect(show(diffLines('a\nc', 'a\nb\nc'))).toEqual([' a', '+b', ' c'])
    expect(show(diffLines('a\nb\nc', 'a\nc'))).toEqual([' a', '-b', ' c'])
    expect(show(diffLines('a\nb\nc', 'a\nx\nc'))).toEqual([' a', '-b', '+x', ' c'])
    expect(show(diffLines('a', 'b'))).toEqual(['-a', '+b'])
  })

  it('handles additions at both ends and empty sides', () => {
    expect(show(diffLines('b', 'a\nb\nc'))).toEqual(['+a', ' b', '+c'])
    expect(show(diffLines('', 'a\nb'))).toEqual(['-', '+a', '+b'])
    expect(show(diffLines('a\nb', ''))).toEqual(['-a', '-b', '+'])
  })

  it('uses the longest common subsequence in the middle', () => {
    const rows = check('1\na\nb\nc\nd\n9', '1\nb\nx\nd\ne\n9')
    expect(rows.filter((r) => r.k === ' ').map((r) => r.t)).toEqual(['1', 'b', 'd', '9'])
  })

  it('always reproduces both inputs, including repeated lines', () => {
    const cases: [string, string][] = [
      ['a\na\na', 'a\na'],
      ['a\nb\na\nb', 'b\na\nb\na'],
      ['x\n\n\ny', '\nx\n\ny\n'],
      ['same\nA\nsame', 'same\nsame'],
      ['one', 'one\n'],
    ]
    for (const [a, b] of cases) check(a, b)
  })

  it('falls back to remove-all / add-all when the middle is too large for the table', () => {
    const a = Array.from({ length: 2100 }, (_, i) => `a${i}`)
    const b = Array.from({ length: 2100 }, (_, i) => `b${i}`)
    const rows = check(['head', ...a, 'tail'].join('\n'), ['head', ...b, 'tail'].join('\n'))
    expect(rows[0]).toEqual({ t: 'head', k: ' ' })
    expect(rows.at(-1)).toEqual({ t: 'tail', k: ' ' })
    expect(rows.slice(1, 2101).every((r) => r.k === '-')).toBe(true)
    expect(rows.slice(2101, 4201).every((r) => r.k === '+')).toBe(true)
  })
})
