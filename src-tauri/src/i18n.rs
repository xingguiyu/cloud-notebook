//! 原生部分（菜单栏、使用指南）用的语言。界面文字的词表在前端 `src/locales/`，这里只管原生菜单。
//!
//! 语言选择存在应用配置目录的 `lang` 文件里（`zh` / `en`，没有这个文件就跟随系统），
//! 这样启动时不用等前端就能用对语言建菜单。

use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Lang {
    Zh,
    En,
}

static CURRENT: AtomicU8 = AtomicU8::new(0);

pub fn current() -> Lang {
    if CURRENT.load(Ordering::Relaxed) == 1 { Lang::En } else { Lang::Zh }
}

fn set_current(l: Lang) {
    CURRENT.store(u8::from(l == Lang::En), Ordering::Relaxed);
}

/// 系统语言是中文就用中文，其他一律英文（和前端的规则一致）
fn system() -> Lang {
    match sys_locale::get_locale() {
        Some(l) if l.to_lowercase().starts_with("zh") => Lang::Zh,
        Some(_) => Lang::En,
        None => Lang::Zh,
    }
}

fn resolve(choice: &str) -> Lang {
    match choice.trim() {
        "zh" => Lang::Zh,
        "en" => Lang::En,
        _ => system(),
    }
}

/// 启动时读取上次的选择
pub fn init(config: &Path) {
    set_current(saved(config));
}

/// 记下选择（`system` / `zh` / `en`），返回语言是否变了
pub fn choose(config: &Path, choice: &str) -> bool {
    save_choice(config, choice);
    let next = resolve(choice);
    let changed = next != current();
    set_current(next);
    changed
}

fn save_choice(config: &Path, choice: &str) {
    let file = config.join("lang");
    if choice == "zh" || choice == "en" {
        let _ = std::fs::create_dir_all(config);
        let _ = std::fs::write(file, choice);
    } else {
        let _ = std::fs::remove_file(file);
    }
}

/// 配置目录里记的语言，不改全局状态（命令行工具用）
pub fn saved(config: &Path) -> Lang {
    resolve(&std::fs::read_to_string(config.join("lang")).unwrap_or_default())
}

/// 菜单文字：中文原文是键，查不到就用中文
pub fn tr(zh: &str) -> String {
    tr_for(current(), zh)
}

pub fn tr_for(lang: Lang, zh: &str) -> String {
    if lang == Lang::Zh {
        return zh.to_string();
    }
    let en = match zh {
        "文件" => "File",
        "编辑" => "Edit",
        "格式" => "Format",
        "视图" => "View",
        "窗口" => "Window",
        "帮助" => "Help",
        "新建笔记" => "New Note",
        "新建文件夹" => "New Folder",
        "锁定加密笔记" => "Lock Encrypted Notes",
        "导出…" => "Export…",
        "导出为" => "Export As",
        "Markdown 文件夹（含图片）…" => "Markdown Folder (with Images)…",
        "Markdown 压缩包（含图片）…" => "Markdown Zip (with Images)…",
        "Markdown 单文件（图片内嵌）…" => "Single Markdown File (Images Embedded)…",
        "打印…" => "Print…",
        "设置…" => "Settings…",
        "复制为 Markdown（图床链接）" => "Copy as Markdown (Hosted Images)",
        "搜索全部笔记" => "Search All Notes",
        "在笔记中查找…" => "Find in Note…",
        "查找并替换…" => "Find and Replace…",
        "切换源码模式" => "Toggle Source Mode",
        "显示/隐藏侧边栏" => "Show/Hide Sidebar",
        "显示/隐藏笔记列表" => "Show/Hide Note List",
        "问 AI" => "Ask AI",
        "笔记信息" => "Note Info",
        "专注模式" => "Focus Mode",
        "放大" => "Zoom In",
        "缩小" => "Zoom Out",
        "实际大小" => "Actual Size",
        "正文" => "Body",
        "使用指南" => "User Guide",
        "检查更新…" => "Check for Updates…",
        "这个版本的更新内容" => "What’s New in This Version",
        other => other,
    };
    en.to_string()
}

/// 「标题 1」到「标题 6」
pub fn heading(level: u8) -> String {
    heading_for(current(), level)
}

fn heading_for(lang: Lang, level: u8) -> String {
    if lang == Lang::Zh { format!("标题 {level}") } else { format!("Heading {level}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 不碰全局的当前语言：别的测试在并行跑
    #[test]
    fn choice_is_saved_and_read_back() {
        let dir = std::env::temp_dir().join(format!("cn-lang-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        save_choice(&dir, "en");
        assert_eq!(saved(&dir), Lang::En);
        save_choice(&dir, "zh");
        assert_eq!(saved(&dir), Lang::Zh);
        save_choice(&dir, "system");
        assert!(!dir.join("lang").exists());
        assert_eq!(resolve("en"), Lang::En);
    }

    #[test]
    fn menu_text_falls_back_to_chinese() {
        assert_eq!(tr_for(Lang::En, "新建笔记"), "New Note");
        assert_eq!(tr_for(Lang::Zh, "新建笔记"), "新建笔记");
        assert_eq!(tr_for(Lang::En, "没有译文的词"), "没有译文的词");
        assert_eq!(heading_for(Lang::En, 2), "Heading 2");
    }
}
