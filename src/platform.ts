/** 运行在手机 / 平板上（iPadOS 的 WebView 会自称 Macintosh，用触摸点判断） */
export const isMobile =
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))
