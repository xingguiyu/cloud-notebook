import app from './app'
import safe from './safe'
import templates from './templates'
import settings from './settings'

/** 英文词表：键是源码里的中文原文，值是译文。各部分分开放，方便维护 */
const en: Record<string, string> = { ...app, ...safe, ...templates, ...settings }
export default en
