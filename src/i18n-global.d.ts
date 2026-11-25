import type { t } from './i18n'

declare module 'vue' {
  interface ComponentCustomProperties {
    /** 模板里翻译界面文字，等同于 `t` */
    $t: typeof t
  }
}
