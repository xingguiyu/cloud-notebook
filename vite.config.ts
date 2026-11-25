import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 手机调试时 Tauri 会给出电脑的局域网地址，让模拟器 / 真机能连上开发服务器
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5183 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
})
