import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.8.0' }))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => null }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: async () => {} }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: async () => {} }))
// 偏好设置模块会碰主题和窗口，这里用不到
vi.mock('../prefs', () => ({ prefs: { autoUpdate: true } }))

const { notesOf, pickLanguage } = await import('../updater')

const LOG = `# Changelog

Intro.

## 0.9.0

### Notes

- New thing

## 0.8.0

First public release.

- A
- B

## 0.7.10

- Old
`

describe('release notes from the changelog', () => {
  it('returns the section of one version', () => {
    expect(notesOf(LOG, '0.8.0')).toBe('First public release.\n\n- A\n- B')
    expect(notesOf(LOG, '0.9.0')).toBe('### Notes\n\n- New thing')
    expect(notesOf(LOG, '0.7.10')).toBe('- Old')
  })

  it('does not confuse versions that share a prefix', () => {
    expect(notesOf(LOG, '0.7.1')).toBe('')
    expect(notesOf(LOG, '0.8')).toBe('')
    expect(notesOf('## 0x8y0\n\nnot a version\n', '0.8.0')).toBe('')
  })

  it('accepts bracketed and v-prefixed headings', () => {
    expect(notesOf('## [1.2.3] - 2026-12-01\n\n- x\n', '1.2.3')).toBe('- x')
    expect(notesOf('## v1.2.3\n\n- y\n', '1.2.3')).toBe('- y')
  })

  it('the bundled changelogs have notes for the current app version in both languages', async () => {
    const version = (await import('../../src-tauri/tauri.conf.json')).default.version
    const en = (await import('../../CHANGELOG.md?raw')).default
    const zh = (await import('../../CHANGELOG.zh-CN.md?raw')).default
    expect(notesOf(en, version), `CHANGELOG.md has no section for ${version}`).not.toBe('')
    expect(notesOf(zh, version), `CHANGELOG.zh-CN.md has no section for ${version}`).not.toBe('')
  })
})

describe('notes published with an update', () => {
  const body = 'English notes\n\n- a\n\n<!--zh-->\n\n中文说明\n\n- 甲'
  it('shows the part for the interface language', () => {
    expect(pickLanguage(body, false)).toBe('English notes\n\n- a')
    expect(pickLanguage(body, true)).toBe('中文说明\n\n- 甲')
  })
  it('falls back to the only part there is', () => {
    expect(pickLanguage('Only English', true)).toBe('Only English')
    expect(pickLanguage('', true)).toBe('')
  })
})
