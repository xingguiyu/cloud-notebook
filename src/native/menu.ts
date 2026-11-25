import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu'

/** `checked` 有值时生成系统原生的勾选菜单项；`items` 有值时是子菜单 */
export type MenuSpec = { text: string; action?: () => void; enabled?: boolean; checked?: boolean; items?: MenuSpec[] } | '-'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const build = (items: MenuSpec[]): Promise<any[]> =>
  Promise.all(
    items.map(async (it) =>
      it === '-'
        ? PredefinedMenuItem.new({ item: 'Separator' })
        : it.items
          ? Submenu.new({ text: it.text, enabled: (it.enabled ?? true) && it.items.length > 0, items: await build(it.items) })
          : it.checked !== undefined
            ? CheckMenuItem.new({ text: it.text, enabled: it.enabled ?? true, checked: it.checked, action: it.action })
            : MenuItem.new({ text: it.text, enabled: it.enabled ?? true, action: it.action }),
    ),
  )

/** 弹出原生右键菜单 */
export async function popupMenu(items: MenuSpec[]) {
  const menu = await Menu.new({ items: await build(items) })
  await menu.popup()
}
