/**
 * Shared test setup: the modules under test run in Node, so everything that talks to the
 * Tauri shell or the browser is replaced here.
 *
 * - `@tauri-apps/api/*` and the clipboard plugin are mocked (no window.__TAURI_INTERNALS__ in Node).
 * - `navigator.language` is pinned to zh-CN so `t()` returns the Chinese source text by default;
 *   i18n.test.ts re-imports the module with other languages.
 * - `localStorage` is an in-memory map.
 */
import { vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: (path: string, protocol = 'asset') => `${protocol}://localhost/${encodeURIComponent(path)}`,
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => undefined),
}))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn(async () => ''),
  writeText: vi.fn(async () => undefined),
}))

export function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  }
}

vi.stubGlobal('navigator', { language: 'zh-CN' })
vi.stubGlobal('localStorage', memoryStorage())
