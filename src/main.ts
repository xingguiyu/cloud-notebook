import { invoke } from '@tauri-apps/api/core'
import { createApp } from 'vue'
import './native/native.css'
import { installNativeBehavior } from './native/native'
import './prefs'
import App from './App.vue'
import { lang, t } from './i18n'

installNativeBehavior()

// 运行时错误转发到终端，白屏时能看到原因
const report = (msg: string) => invoke('js_error', { message: msg }).catch(() => {})
window.addEventListener('error', (e) => report(`${e.message} @ ${e.filename}:${e.lineno}`))
window.addEventListener('unhandledrejection', (e) => report(`未处理的 Promise 异常：${e.reason?.stack ?? e.reason}`))

const app = createApp(App)
app.config.globalProperties.$t = t
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
app.config.errorHandler = (err, _vm, info) => report(`Vue ${info}: ${(err as Error)?.stack ?? err}`)
app.mount('#app')
