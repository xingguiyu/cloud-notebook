import { defineConfig } from 'vitest/config'

// 单元测试只测纯逻辑，在 Node 里跑；Tauri 的接口在 src/__tests__/setup.ts 里统一替换掉
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
  },
})
