//! 使用指南：随应用附带的几篇笔记，第一次运行时放进笔记库，之后可以从「帮助」菜单找回。
//! 原文在 `src-tauri/guide/`，编译时打进程序里。

use std::fs;
use std::path::Path;

use crate::i18n::Lang;

/// 一种语言的指南：文件夹名、先显示的那一篇、全部文件
pub struct Guide {
    pub folder: &'static str,
    pub start: &'static str,
    files: &'static [(&'static str, &'static [u8])],
}

macro_rules! note {
    ($name:literal) => {
        ($name, include_str!(concat!("../guide/", $name)).as_bytes())
    };
    (en $name:literal) => {
        ($name, include_str!(concat!("../guide/en/", $name)).as_bytes())
    };
}
macro_rules! image {
    ($name:literal) => {
        (concat!("assets/", $name), include_bytes!(concat!("../guide/assets/", $name)).as_slice())
    };
}

const ZH: Guide = Guide {
    folder: "Cloud Notebook 指南",
    start: "欢迎使用 Cloud Notebook.md",
    files: &[
        note!("欢迎使用 Cloud Notebook.md"),
        note!("写作与格式.md"),
        note!("整理与搜索.md"),
        note!("证件夹与项目密钥.md"),
        note!("AI 助手与项目文档.md"),
        note!("同步、导出与隐私.md"),
        image!("guide-welcome.png"),
        image!("guide-writing.png"),
        image!("guide-organize.png"),
        image!("guide-vault.png"),
        image!("guide-ai.png"),
        image!("guide-sync.png"),
    ],
};

const EN: Guide = Guide {
    folder: "Cloud Notebook Guide",
    start: "Welcome to Cloud Notebook.md",
    files: &[
        note!(en "Welcome to Cloud Notebook.md"),
        note!(en "Writing and Formatting.md"),
        note!(en "Organizing and Searching.md"),
        note!(en "Vault and Project Keys.md"),
        note!(en "AI Assistant and Project Docs.md"),
        note!(en "Sync, Export and Privacy.md"),
        image!("guide-welcome.png"),
        image!("guide-writing.png"),
        image!("guide-organize.png"),
        image!("guide-vault.png"),
        image!("guide-ai.png"),
        image!("guide-sync.png"),
    ],
};

pub fn guide(lang: Lang) -> &'static Guide {
    match lang {
        Lang::Zh => &ZH,
        Lang::En => &EN,
    }
}

/// 把指南写进笔记库。已有的同名文件换成当前版本；改过的笔记先留一份历史版本，改动不会丢。
/// 返回写入或更新了几个文件。
pub fn install(root: &Path, lang: Lang) -> Result<usize, String> {
    let g = guide(lang);
    #[allow(non_snake_case)]
    let (FOLDER, FILES) = (g.folder, g.files);
    let dir = root.join(FOLDER);
    fs::create_dir_all(dir.join("assets")).map_err(|e| e.to_string())?;
    let mut written = 0;
    let now = std::time::SystemTime::now();
    for (i, (name, data)) in FILES.iter().enumerate() {
        let file = dir.join(name);
        if fs::read(&file).is_ok_and(|old| old == *data) {
            continue;
        }
        if name.ends_with(".md") {
            if let Ok(old) = fs::read_to_string(&file) {
                let _ = crate::docs::snapshot(root, &format!("{FOLDER}/{name}"), &old, 0);
            }
        }
        fs::write(&file, data).map_err(|e| e.to_string())?;
        // 列表按修改时间从新到旧排：让几篇笔记按阅读顺序排列，欢迎那篇在最上面
        if let Ok(f) = fs::File::options().write(true).open(&file) {
            let _ = f.set_modified(now - std::time::Duration::from_secs(i as u64));
        }
        written += 1;
    }
    // 记下这次装进去的每个文件的哈希
    let manifest: std::collections::BTreeMap<&str, String> = FILES.iter().map(|(name, data)| (*name, sha(data))).collect();
    let _ = fs::write(dir.join(MANIFEST), serde_json::to_vec(&manifest).unwrap_or_default());
    Ok(written)
}

/// 以前各个版本附带过的指南文件的哈希（一行一个），由 `scripts/guide-hashes.py` 维护
const KNOWN: &str = include_str!("../guide/known-hashes.txt");
/// 安装时在指南文件夹里记一份「装进去的是什么」，下次据此判断用户有没有改过
const MANIFEST: &str = ".installed.json";

fn sha(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// 这份指南是不是应用装进去之后就没被动过：每个文件都是某个版本附带的原样（当前版本、安装时记下的、
/// 或历史版本清单里的），而且没多出别的文件（隐藏的也算，只忽略 Finder 的 .DS_Store 和我们自己的记录）。
/// 只有这样才会在切换语言时自动替换它；用户改过或放了自己笔记的，一律不动。
fn untouched(root: &Path, g: &Guide) -> bool {
    let dir = root.join(g.folder);
    let installed: std::collections::HashMap<String, String> =
        fs::read(dir.join(MANIFEST)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let original = |name: &str, bundled: &[u8]| {
        fs::read(dir.join(name)).is_ok_and(|d| {
            let h = sha(&d);
            d == bundled || installed.get(name) == Some(&h) || KNOWN.lines().any(|k| k == h)
        })
    };
    let same = g.files.iter().all(|(name, data)| original(name, data));
    let count = |d: &Path| fs::read_dir(d).map_or(0, |r| r.flatten().filter(|e| e.file_name() != ".DS_Store" && e.file_name() != MANIFEST).count());
    // 六篇笔记加 assets 文件夹；assets 里是六张图
    same && count(&dir) == g.files.iter().filter(|(n, _)| !n.contains('/')).count() + 1 && count(&dir.join("assets")) == g.files.iter().filter(|(n, _)| n.contains('/')).count()
}

/// 换成 `lang` 的指南：其他语言的指南如果原封未动，移到回收站（改过的留着不动）。
/// `only_replace` 为真时，只有确实换掉了旧指南才安装新的，用在切换语言时：用户早就删掉指南的话，不再放回来。
pub fn switch_to(root: &Path, lang: Lang, only_replace: bool) -> Result<usize, String> {
    let mut replaced = false;
    for other in [Lang::Zh, Lang::En].into_iter().filter(|l| *l != lang) {
        let g = guide(other);
        if root.join(g.folder).is_dir() && untouched(root, g) {
            crate::vault::move_to_trash(root, g.folder)?;
            replaced = true;
        }
    }
    if only_replace && !replaced {
        return Ok(0);
    }
    install(root, lang)
}

#[derive(serde::Serialize)]
pub struct Installed {
    folder: &'static str,
    start: String,
    written: usize,
}

#[tauri::command]
pub async fn guide_install(app: tauri::AppHandle) -> Result<Installed, String> {
    let root = crate::vault::root(&app)?;
    let lang = crate::i18n::current();
    let g = guide(lang);
    Ok(Installed { folder: g.folder, start: format!("{}/{}", g.folder, g.start), written: switch_to(&root, lang, false)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_and_keeps_user_edits_in_history() {
        for lang in [Lang::Zh, Lang::En] {
            let g = guide(lang);
            let root = std::env::temp_dir().join(format!("cn-guide-{lang:?}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            assert_eq!(install(&root, lang).unwrap(), g.files.len());
            assert_eq!(install(&root, lang).unwrap(), 0, "second run changes nothing");
            let mtime = |n: &str| fs::metadata(root.join(g.folder).join(n)).unwrap().modified().unwrap();
            assert!(mtime(g.files[0].0) > mtime(g.files[1].0) && mtime(g.files[1].0) > mtime(g.files[5].0), "reading order");
            let start = root.join(g.folder).join(g.start);
            fs::write(&start, "我改过了").unwrap();
            assert_eq!(install(&root, lang).unwrap(), 1);
            assert!(fs::read_to_string(&start).unwrap().starts_with("# "));
            let rel = format!("{}/{}", g.folder, g.start);
            let h = crate::docs::history_list(&root, &rel).unwrap();
            assert_eq!(crate::docs::history_read(&root, &rel, &h[0].id).unwrap(), "我改过了");
        }
    }

    #[test]
    fn switching_language_swaps_an_untouched_guide_only() {
        let root = std::env::temp_dir().join(format!("cn-guide-switch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        // 没装过指南：切换语言不会凭空放一份
        fs::create_dir_all(&root).unwrap();
        assert_eq!(switch_to(&root, Lang::En, true).unwrap(), 0);
        assert!(!root.join(EN.folder).exists());
        // 原封未动的中文指南换成英文的，旧的进回收站
        install(&root, Lang::Zh).unwrap();
        assert_eq!(switch_to(&root, Lang::En, true).unwrap(), EN.files.len());
        assert!(!root.join(ZH.folder).exists() && root.join(EN.folder).join(EN.start).exists());
        assert!(root.join(".trash").exists());
        // 改过的不动；从帮助菜单打开时两份并存
        fs::write(root.join(EN.folder).join(EN.start), "# my notes").unwrap();
        assert_eq!(switch_to(&root, Lang::Zh, true).unwrap(), 0);
        assert!(root.join(EN.folder).exists() && !root.join(ZH.folder).exists());
        assert_eq!(switch_to(&root, Lang::Zh, false).unwrap(), ZH.files.len());
        assert!(root.join(EN.folder).exists() && root.join(ZH.folder).exists());
        // 多放了一篇自己的笔记也算改过
        let root2 = root.with_extension("b");
        let _ = fs::remove_dir_all(&root2);
        install(&root2, Lang::Zh).unwrap();
        fs::write(root2.join(ZH.folder).join("我的笔记.md"), "x").unwrap();
        assert_eq!(switch_to(&root2, Lang::En, true).unwrap(), 0);
        assert!(root2.join(ZH.folder).join("我的笔记.md").exists());
    }

    /// 改了指南却没更新历史版本清单的话，换了设备（没有安装记录）的旧指南就认不出来了
    #[test]
    fn shipped_files_are_in_the_known_list() {
        for g in [&ZH, &EN] {
            for (name, data) in g.files {
                assert!(KNOWN.lines().any(|k| k == sha(data)), "{name} 不在 known-hashes.txt 里，运行 python3 scripts/guide-hashes.py");
            }
        }
    }

    #[test]
    fn a_guide_from_an_older_version_is_still_recognized_and_swapped() {
        let root = std::env::temp_dir().join(format!("cn-guide-old-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        install(&root, Lang::Zh).unwrap();
        // 模拟旧版本装的指南：内容和现在内置的不一样，但和安装记录对得上
        let dir = root.join(ZH.folder);
        let old = "# 欢迎使用 Cloud Notebook\n\n旧版本的文字。\n";
        fs::write(dir.join(ZH.start), old).unwrap();
        let mut manifest: std::collections::BTreeMap<String, String> = serde_json::from_slice(&fs::read(dir.join(MANIFEST)).unwrap()).unwrap();
        manifest.insert(ZH.start.to_string(), sha(old.as_bytes()));
        fs::write(dir.join(MANIFEST), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(untouched(&root, &ZH));
        assert_eq!(switch_to(&root, Lang::En, true).unwrap(), EN.files.len());
        assert!(!dir.exists() && root.join(EN.folder).join(EN.start).exists());
        // 同样的旧内容但没有记录、也不在历史清单里：算用户改过，不动
        install(&root, Lang::Zh).unwrap();
        fs::write(dir.join(ZH.start), "# 欢迎使用 Cloud Notebook\n\n我自己加了一段。\n").unwrap();
        assert!(!untouched(&root, &ZH));
    }

    /// 指南里的站内链接和图片都要指向真实存在的文件；两种语言的篇数和结构要一致
    #[test]
    fn links_and_images_resolve() {
        for g in [&ZH, &EN] {
            let names: Vec<&str> = g.files.iter().map(|(n, _)| *n).collect();
            assert_eq!(names[0], g.start);
            for (name, data) in g.files.iter().filter(|(n, _)| n.ends_with(".md")) {
                let md = std::str::from_utf8(data).unwrap();
                assert_eq!(md.lines().next().unwrap().strip_prefix("# ").unwrap().to_string() + ".md", *name, "title matches file name");
                for link in md.split("[[").skip(1).filter_map(|s| s.split_once("]]")).map(|(t, _)| t).filter(|t| !t.contains('\n') && *t != "笔记标题" && *t != "Note title") {
                    assert!(names.contains(&format!("{link}.md").as_str()), "{name}: [[{link}]]");
                }
                for img in md.split("![](").skip(1).filter_map(|s| s.split_once(')')).map(|(t, _)| t) {
                    assert!(names.contains(&img), "{name}: {img}");
                }
            }
        }
        let headings = |g: &Guide, i: usize| std::str::from_utf8(g.files[i].1).unwrap().lines().filter(|l| l.starts_with('#') && l.contains("# ")).map(|l| l.split(' ').next().unwrap().len()).collect::<Vec<_>>();
        for i in 0..6 {
            assert_eq!(headings(&ZH, i), headings(&EN, i), "same heading structure in note {i}");
        }
    }
}
