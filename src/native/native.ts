import { getCurrentWindow } from '@tauri-apps/api/window'

/**
 * 关掉 WebView 默认的网页行为。和 native.css 配套，应用启动时调用一次。
 */
export function installNativeBehavior() {
  // 浏览器右键菜单（重新加载、检查元素）一律屏蔽；需要右键菜单的地方用原生 Menu 自己弹
  window.addEventListener('contextmenu', (e) => e.preventDefault())

  // 除了显式声明 data-draggable 的元素，不允许拖拽（图片、链接、选中文字）
  window.addEventListener('dragstart', (e) => {
    const el = e.target as HTMLElement | null
    if (!el?.closest?.('[data-draggable], [contenteditable="true"]')) e.preventDefault()
  })

  // 外部文件拖进来时，阻止 WebView 直接打开文件把页面换掉
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => e.preventDefault())

  // 禁止 Cmd/Ctrl + 滚轮、触控板捏合缩放页面
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault()
    },
    { passive: false },
  )
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey
    // 只拦截网页缩放和刷新。注意不能拦截菜单用到的快捷键（⌘0、⌘P 等）：
    // macOS 上按键先交给 WebView，这里 preventDefault 了菜单就收不到
    // ⌘+ / ⌘- 是编辑区缩放，在 App.vue 里处理（那里也会 preventDefault，网页本身不会被缩放）
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r') e.preventDefault()
    if (e.key === 'F5') e.preventDefault()
  })

  // 标题栏区域：按下就交给系统拖动窗口，双击按系统习惯缩放
  // 按下后真的移动了才开始拖动：一按下就拖，系统会吞掉第二次点击，双击就失效了
  const inBar = (e: MouseEvent) => {
    const el = e.target as HTMLElement
    return e.button === 0 && !!el.closest?.('.drag-region') && !el.closest('button, input, select, textarea, .no-drag')
  }
  let pressed: { x: number; y: number } | null = null
  window.addEventListener('mousedown', (e) => {
    pressed = inBar(e) && e.detail === 1 ? { x: e.screenX, y: e.screenY } : null
  })
  window.addEventListener('mousemove', (e) => {
    if (!pressed || !(e.buttons & 1)) return (pressed = null)
    if (Math.abs(e.screenX - pressed.x) + Math.abs(e.screenY - pressed.y) < 3) return
    pressed = null
    getCurrentWindow().startDragging()
  })
  window.addEventListener('mouseup', () => (pressed = null))
  window.addEventListener('dblclick', (e) => {
    if (inBar(e)) getCurrentWindow().toggleMaximize()
  })
}

/**
 * 首屏内容进了页面就显示窗口。
 * 不能等 requestAnimationFrame：窗口隐藏时 WebKit 不出帧，回调要等到 Rust 的兜底（1.5 秒）才会跑。
 * 调用时 Vue 已经把内容放进页面，窗口一显示就是画好的界面，不会白屏。
 */
let shown = false
export function showWindowWhenReady() {
  if (shown) return
  shown = true
  setTimeout(() => getCurrentWindow().show(), 0)
}
