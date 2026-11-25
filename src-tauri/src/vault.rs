//! 笔记库：一个普通文件夹，子文件夹即分组，每篇笔记是一个 .md 文件。
//! Markdown 原文是唯一真相，任何编辑器、Git、同步盘都能直接读。

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct Entry {
    /// 相对笔记库根目录的路径，统一用 `/` 分隔
    path: String,
    name: String,
    is_dir: bool,
    modified: u64,
    /// 创建时间（毫秒）；拿不到就是 0
    #[serde(default)]
    created: u64,
    children: Vec<Entry>,
}

fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("vault.json"))
}

fn default_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("Cloud Notebook"))
}

/// iCloud Drive 里的笔记库位置；放在这里由系统负责多台 Mac 之间同步
fn icloud_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join("Library/Mobile Documents/com~apple~CloudDocs/Cloud Notebook"))
}

/// 笔记库根目录：用户选过就用配置里的，否则是「文稿/Cloud Notebook」
pub fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = fs::read_to_string(config_file(app)?)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["root"].as_str().map(PathBuf::from))
        .map_or_else(|| default_root(app), Ok)?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // 手机上笔记一般从云端同步下来，不放使用指南（否则第一次同步会和电脑上的同名笔记冲突）
        #[cfg(desktop)]
        crate::guide::install(&dir, crate::i18n::current())?;
    }
    Ok(dir)
}

#[derive(Serialize)]
pub struct VaultInfo {
    root: String,
    icloud: String,
    icloud_available: bool,
}

#[tauri::command]
pub async fn vault_info(app: AppHandle) -> Result<VaultInfo, String> {
    let icloud = icloud_root(&app)?;
    Ok(VaultInfo {
        root: root(&app)?.to_string_lossy().into(),
        icloud_available: icloud.parent().is_some_and(|p| p.exists()),
        icloud: icloud.to_string_lossy().into(),
    })
}

/// 切换笔记库位置。`move_notes` 为真时把现有笔记一起搬过去。
/// 文件监听绑定在旧目录上，切换后重启应用。
#[tauri::command]
pub fn vault_set_root(app: AppHandle, path: String, move_notes: bool) -> Result<(), String> {
    let old = root(&app)?;
    let new = PathBuf::from(&path);
    if new == old {
        return Ok(());
    }
    if new.starts_with(&old) {
        return Err("新位置不能在当前笔记库里面".into());
    }
    fs::create_dir_all(&new).map_err(|e| e.to_string())?;
    if move_notes {
        copy_dir(&old, &new)?;
    }
    let cfg = config_file(&app)?;
    fs::create_dir_all(cfg.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(cfg, serde_json::json!({ "root": path }).to_string()).map_err(|e| e.to_string())?;
    app.restart()
}

/// 复制而不是移动：旧目录原样保留，避免跨卷移动失败时丢笔记；已存在的同名文件不覆盖
fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    for e in fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let src = e.path();
        let dst = to.join(e.file_name());
        if src.is_dir() {
            fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
            copy_dir(&src, &dst)?;
        } else if !dst.exists() {
            fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 把前端传来的相对路径解析到笔记库内，拒绝 `..` 和绝对路径
fn resolve(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("非法路径".into());
    }
    let root = root(app)?;
    if rel.as_os_str().is_empty() {
        return Ok(root);
    }
    // 路径上有符号链接就拒绝：它可能指到笔记库外面
    crate::docs::no_symlinks(&root, &rel.to_string_lossy())
}

fn walk(base: &Path, dir: &Path) -> Vec<Entry> {
    let Ok(read) = fs::read_dir(dir) else {
        return vec![];
    };
    let mut out: Vec<Entry> = read
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            // assets 是笔记图片目录，不当作分组显示
            // 符号链接不显示也不进入：可能指到库外面，也可能成环
            if name.starts_with('.') || (name == "assets" && p.is_dir()) || p.is_symlink() {
                return None;
            }
            let is_dir = p.is_dir();
            if !is_dir && p.extension().and_then(|x| x.to_str()) != Some("md") {
                return None;
            }
            let meta = e.metadata().ok();
            let ms = |t: Option<std::time::SystemTime>| t.and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
            let modified = ms(meta.as_ref().and_then(|m| m.modified().ok()));
            let created = ms(meta.as_ref().and_then(|m| m.created().ok()));
            Some(Entry {
                path: p
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
                children: if is_dir { walk(base, &p) } else { vec![] },
                name,
                is_dir,
                modified,
                created,
            })
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    out
}

#[tauri::command]
pub async fn vault_tree(app: AppHandle) -> Result<Vec<Entry>, String> {
    let r = root(&app)?;
    let tree = walk(&r, &r);
    fn files(es: &[Entry], out: &mut Vec<String>) {
        for e in es {
            if e.is_dir {
                files(&e.children, out)
            } else {
                out.push(e.path.clone())
            }
        }
    }
    let mut paths = vec![];
    files(&tree, &mut paths);
    if let Ok(json) = serde_json::to_string(&tree) {
        crate::index::save_tree(&r.to_string_lossy(), &json, &paths);
    }
    Ok(tree)
}

pub fn mtime(p: &Path) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

#[tauri::command]
pub async fn vault_read(app: AppHandle, path: String) -> Result<String, String> {
    let abs = resolve(&app, &path)?;
    let r = root(&app)?;
    let bytes = crate::index::read_cached(&r.to_string_lossy(), &path, &abs).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

/// 一次读多篇笔记：启动时用，避免每篇一次 IPC 往返。读不到的跳过。
#[tauri::command]
pub async fn vault_read_many(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let r = root(&app)?;
    // 并行读：iCloud 只在云端的文件要先下载，一篇慢不拖累其它篇
    let read: Vec<(String, u64, String)> = std::thread::scope(|s| {
        let handles: Vec<_> = paths
            .chunks(paths.len().div_ceil(8).max(1))
            .map(|chunk| {
                let app = &app;
                let root = r.to_string_lossy().to_string();
                s.spawn(move || {
                    let mut got = vec![];
                    for p in chunk {
                        let Ok(f) = resolve(app, p) else { continue };
                        let Ok(t) = fs::read_to_string(&f) else { continue };
                        // 读到一篇存一篇：哪怕别的文件卡在 iCloud 下载，已读到的下次启动也能秒开
                        let item = (p.clone(), mtime(&f), t);
                        crate::index::save_notes(&root, std::slice::from_ref(&item));
                        got.push(item);
                    }
                    got
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    });
    Ok(read.into_iter().map(|(p, _, t)| (p, t)).collect())
}

/// 加密笔记文件里的标记（和前端 `crypto.ts` 的信封格式一致）
const LOCKED_MARK: &str = "<!-- cloudnotebook:locked";

/// 每篇笔记上次由这个应用写入的内容的哈希，用来分辨「磁盘上的内容被别人改过」
static LAST_WRITTEN: std::sync::Mutex<std::collections::BTreeMap<String, u64>> = std::sync::Mutex::new(std::collections::BTreeMap::new());

fn hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

#[tauri::command]
pub async fn vault_write(app: AppHandle, path: String, content: String) -> Result<(), String> {
    let p = resolve(&app, &path)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let r = root(&app)?;
    if path.ends_with(".md") {
        let sealed = |s: &str| s.contains(LOCKED_MARK);
        if sealed(&content) {
            // 加密后的笔记不留历史：加密前的明文快照会让加密形同虚设。之前留下的历史一并清掉
            crate::docs::history_purge(&r, &path);
        } else if let Ok(old) = fs::read_to_string(&p) {
            if old != content && !sealed(&old) {
                // 磁盘上的内容不是这个应用上次写的（同步、别的编辑器、AI 工具改过）：一定留一份，不受十分钟间隔限制。
                // 自己连续编辑时才按间隔节流
                let ours = LAST_WRITTEN.lock().unwrap_or_else(|e| e.into_inner()).get(&path).is_some_and(|h| *h == hash(&old));
                let gap = if ours { crate::docs::SNAPSHOT_GAP_MS } else { 0 };
                let _ = crate::docs::snapshot(&r, &path, &old, gap);
            }
        }
        LAST_WRITTEN.lock().unwrap_or_else(|e| e.into_inner()).insert(path.clone(), hash(&content));
    }
    fs::write(&p, &content).map_err(|e| e.to_string())?;
    if path.ends_with(".md") {
        crate::index::save_notes(&r.to_string_lossy(), &[(path, mtime(&p), content)]);
    } else {
        crate::index::remember(&r.to_string_lossy(), &path, &p, content.as_bytes());
    }
    Ok(())
}

#[tauri::command]
pub async fn vault_mkdir(app: AppHandle, path: String) -> Result<(), String> {
    fs::create_dir_all(resolve(&app, &path)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vault_rename(app: AppHandle, from: String, to: String) -> Result<(), String> {
    let to_rel = to.clone();
    let to = resolve(&app, &to)?;
    if to.exists() {
        return Err("目标已存在".into());
    }
    fs::rename(resolve(&app, &from)?, to).map_err(|e| e.to_string())?;
    crate::cloud::renamed(&app, &from, &to_rel);
    crate::docs_cmd::moved(&app, &from, &to_rel);
    if let Ok(r) = root(&app) {
        carry_images(&r, &from, &to_rel);
    }
    Ok(())
}

/// 笔记换了文件夹：把它引用的图片复制到新文件夹的 assets 里，否则 `assets/xxx.png` 这样的相对路径就找不到图了。
/// 用复制而不是移动，因为同一个文件夹里别的笔记可能引用同一张图。
fn carry_images(root: &Path, from: &str, to: &str) {
    let dir_of = |p: &str| p.rsplit_once('/').map_or(String::new(), |(d, _)| d.to_string());
    let (old_dir, new_dir) = (dir_of(from), dir_of(to));
    if !to.ends_with(".md") || old_dir == new_dir {
        return;
    }
    let Ok(md) = fs::read_to_string(root.join(to)) else { return };
    let Ok(images) = fs::read_dir(root.join(&old_dir).join("assets")) else { return };
    for e in images.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let encoded = name.replace(' ', "%20");
        if !e.path().is_file() || !(md.contains(&format!("assets/{name}")) || md.contains(&format!("assets/{encoded}"))) {
            continue;
        }
        let dest = root.join(&new_dir).join("assets");
        if fs::create_dir_all(&dest).is_ok() && !dest.join(&name).exists() {
            let _ = fs::copy(e.path(), dest.join(&name));
        }
    }
}

/// 移到笔记库里的回收站：`.trash/<删除时间>/<文件名>`，
/// 原相对路径记在同目录的 `.origin` 里，用于恢复
pub fn move_to_trash(root: &Path, rel: &str) -> Result<(), String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let dir = root.join(".trash").join(stamp.to_string());
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = rel.rsplit('/').next().unwrap_or(rel);
    fs::rename(root.join(rel), dir.join(name)).map_err(|e| e.to_string())?;
    // 历史版本跟着进回收站：恢复时一起回来，永久删除时一起删掉，也不会被之后同名的新笔记继承
    crate::docs::history_to_trash(root, rel, &dir);
    fs::write(dir.join(".origin"), rel).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vault_trash(app: AppHandle, path: String) -> Result<(), String> {
    resolve(&app, &path)?;
    move_to_trash(&root(&app)?, &path)
}

#[derive(Serialize)]
pub struct TrashItem {
    /// 回收站内的相对路径，作为恢复/删除的标识
    id: String,
    /// 原来在笔记库里的位置
    path: String,
    /// 毫秒时间戳
    deleted_at: u64,
    is_dir: bool,
}

#[tauri::command]
pub async fn vault_trash_list(app: AppHandle) -> Result<Vec<TrashItem>, String> {
    let trash = root(&app)?.join(".trash");
    let mut out = vec![];
    let Ok(rd) = fs::read_dir(&trash) else {
        return Ok(out);
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let p = e.path();
        if p.is_dir() {
            let Ok(origin) = fs::read_to_string(p.join(".origin")) else {
                continue;
            };
            let base = origin.rsplit('/').next().unwrap_or(&origin).to_string();
            let item = p.join(&base);
            if !item.exists() {
                continue;
            }
            out.push(TrashItem {
                id: format!("{name}/{base}"),
                deleted_at: (name.parse::<u128>().unwrap_or(0) / 1_000_000) as u64,
                is_dir: item.is_dir(),
                path: origin,
            });
        } else if !name.starts_with('.') {
            // 早期版本的格式：`<秒>-<文件名>`，没有记录原目录，恢复到根目录
            let (stamp, orig) = name.split_once('-').unwrap_or(("0", &name));
            out.push(TrashItem {
                id: name.clone(),
                path: orig.to_string(),
                deleted_at: stamp.parse::<u64>().unwrap_or(0) * 1000,
                is_dir: false,
            });
        }
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(out)
}

fn trash_entry(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let p = resolve(app, &format!(".trash/{id}"))?;
    if !p.exists() {
        return Err("回收站里没有这一项".into());
    }
    Ok(p)
}

/// 放回原位置；原位置已被占用时加「(恢复)」后缀
#[tauri::command]
pub async fn vault_restore(app: AppHandle, id: String, path: String) -> Result<String, String> {
    let src = trash_entry(&app, &id)?;
    resolve(&app, &path)?;
    let r = root(&app)?;
    let mut target = path.clone();
    let mut n = 1;
    while r.join(&target).exists() {
        let (stem, ext) = match path.rsplit_once('.') {
            Some((s, e)) if !src.is_dir() => (s.to_string(), format!(".{e}")),
            _ => (path.clone(), String::new()),
        };
        target = if n == 1 {
            format!("{stem} (恢复){ext}")
        } else {
            format!("{stem} (恢复 {n}){ext}")
        };
        n += 1;
    }
    let dest = r.join(&target);
    fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::rename(&src, &dest).map_err(|e| e.to_string())?;
    if let Some(entry) = src.parent() {
        crate::docs::history_from_trash(&r, entry, &target);
    }
    cleanup_empty(&r.join(".trash"));
    Ok(target)
}

#[tauri::command]
pub async fn vault_delete_forever(app: AppHandle, id: String) -> Result<(), String> {
    let p = trash_entry(&app, &id)?;
    if p.is_dir() {
        fs::remove_dir_all(&p)
    } else {
        fs::remove_file(&p)
    }
    .map_err(|e| e.to_string())?;
    if let Some(entry) = p.parent() {
        let _ = fs::remove_dir_all(entry.join(".history"));
    }
    cleanup_empty(&root(&app)?.join(".trash"));
    Ok(())
}

#[tauri::command]
pub async fn vault_empty_trash(app: AppHandle) -> Result<(), String> {
    let trash = root(&app)?.join(".trash");
    if trash.exists() {
        fs::remove_dir_all(trash).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 恢复或删除后，清掉只剩 `.origin` 的时间目录
fn cleanup_empty(trash: &Path) {
    let Ok(rd) = fs::read_dir(trash) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let only_origin = p.is_dir()
            && fs::read_dir(&p)
                .map(|r| r.flatten().all(|k| k.file_name() == ".origin"))
                .unwrap_or(false);
        if only_origin {
            let _ = fs::remove_dir_all(&p);
        }
    }
}

fn asset_target(app: &AppHandle, note: &str, ext: &str) -> Result<(PathBuf, String), String> {
    let ext = ext.to_ascii_lowercase();
    if !matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg"
    ) {
        return Err("不支持的图片格式".into());
    }
    let note_dir = note.rsplit_once('/').map_or("", |(d, _)| d);
    let stamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let name = format!("{stamp}.{ext}");
    let rel = if note_dir.is_empty() {
        format!("assets/{name}")
    } else {
        format!("{note_dir}/assets/{name}")
    };
    let p = resolve(app, &rel)?;
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    Ok((p, format!("assets/{name}")))
}

/// 从访达拖入的图片：复制一份到笔记同级的 `assets/`，返回相对路径
#[tauri::command]
pub async fn vault_import_image(app: AppHandle, note: String, source: String) -> Result<String, String> {
    let src = PathBuf::from(&source);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .ok_or("不支持的图片格式")?;
    let (dest, rel) = asset_target(&app, &note, ext)?;
    fs::copy(&src, dest).map_err(|e| e.to_string())?;
    Ok(rel)
}

/// 保存粘贴的图片到笔记同级的 `assets/`，返回写进 Markdown 的相对路径。
/// 图片字节走原始请求体，笔记路径和扩展名放在请求头里。
#[tauri::command]
pub fn vault_save_image(app: AppHandle, request: tauri::ipc::Request) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("需要原始图片数据".into());
    };
    let header = |k: &str| {
        request
            .headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(|v| percent_decode(v))
            .ok_or(format!("缺少 {k}"))
    };
    let note = header("x-note")?;
    let ext = header("x-ext")?;
    let (p, rel) = asset_target(&app, &note, &ext)?;
    fs::write(p, bytes).map_err(|e| e.to_string())?;
    Ok(rel)
}

pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        // 按字节取后两位：按字符串切片的话，遇到多字节字符会切在字符中间而崩溃
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `vault://localhost/<相对路径>`：让编辑器里的相对图片路径能直接显示
pub fn serve(app: &AppHandle, uri_path: &str) -> tauri::http::Response<Vec<u8>> {
    let rel = percent_decode(uri_path.trim_start_matches('/'));
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap()
    };
    let Ok(p) = resolve(app, &rel) else {
        return not_found();
    };
    // 走本地副本：没变过的图片不用每次等 iCloud 下载
    let Ok(r) = root(app) else {
        return not_found();
    };
    let Ok(bytes) = crate::index::read_cached(&r.to_string_lossy(), &rel, &p) else {
        return not_found();
    };
    let mime = match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    };
    // 这里只供图片用。SVG 里可以带脚本：万一被当成页面直接打开，用沙盒和「什么都不许加载」的策略让它跑不起来
    tauri::http::Response::builder()
        .header("Content-Type", mime)
        .header("X-Content-Type-Options", "nosniff")
        // 图片文件可能被替换（同步、外部编辑、指南更新）：让界面每次都来问，不用内存里的旧图
        .header("Cache-Control", "no-cache")
        .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .body(bytes)
        .unwrap()
}

/// 这个路径相比上次看到时，内容有没有变（看修改时间和大小；新出现、消失也算变）。
/// 文件系统事件里混着大量只改元数据的通知，用它筛掉。
fn really_changed(seen: &mut std::collections::HashMap<PathBuf, (std::time::SystemTime, u64)>, path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(m) => {
            // 文件夹的修改时间只在里面增删条目时才变，同样适用
            let sig = (m.modified().unwrap_or(UNIX_EPOCH), m.len());
            seen.insert(path.to_path_buf(), sig) != Some(sig)
        }
        // 不在了：之前见过它才算一次变化
        Err(_) => seen.remove(path).is_some() || !seen.contains_key(path) && path.extension().is_some(),
    }
}

/// 监听笔记库目录，外部有改动（其他编辑器、同步盘、Git）时通知前端刷新。
/// 去抖 300ms，合并一次保存产生的多个文件系统事件。
pub fn watch(app: &AppHandle) -> Result<(), String> {
    use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode};
    use tauri::Emitter;

    let dir = root(app)?;
    let handle = app.clone();
    let mut seen = std::collections::HashMap::new();
    let mut debouncer = new_debouncer(std::time::Duration::from_millis(300), move |res| {
        if let Ok(events) = res {
            let events: Vec<notify_debouncer_mini::DebouncedEvent> = events;
            // 只改了元数据（iCloud、Spotlight、备份软件给文件打标记）的事件不算变化：
            // 否则每次同步读完文件又被通知「变了」，同步就一轮接一轮停不下来
            let events: Vec<_> = events.into_iter().filter(|e| really_changed(&mut seen, &e.path)).collect();
            // 废纸篓和历史版本里的变化不用刷新
            if events
                .iter()
                .any(|e| !e.path.components().any(|c| c.as_os_str() == ".trash" || c.as_os_str() == ".history"))
            {
                let _ = handle.emit("vault-changed", ());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer
        .watcher()
        .watch(&dir, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    // 监听要伴随整个应用生命周期
    std::mem::forget(debouncer);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_follow_a_note_to_another_folder() {
        let root = std::env::temp_dir().join(format!("cn-carry-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("a/assets")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        fs::write(root.join("a/assets/1.png"), "img1").unwrap();
        fs::write(root.join("a/assets/my pic.png"), "img2").unwrap();
        fs::write(root.join("a/assets/other.png"), "used elsewhere").unwrap();
        fs::write(root.join("b/n.md"), "![](assets/1.png) ![](assets/my%20pic.png)").unwrap();
        carry_images(&root, "a/n.md", "b/n.md");
        assert_eq!(fs::read_to_string(root.join("b/assets/1.png")).unwrap(), "img1");
        assert!(root.join("b/assets/my pic.png").exists());
        assert!(!root.join("b/assets/other.png").exists(), "only images the note uses");
        assert!(root.join("a/assets/1.png").exists(), "originals stay for other notes");
    }

    #[test]
    fn metadata_only_events_are_not_changes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("cn-watch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.md");
        fs::write(&f, "one").unwrap();
        let mut seen = std::collections::HashMap::new();
        assert!(really_changed(&mut seen, &f), "first sighting counts");
        assert!(!really_changed(&mut seen, &f), "same content again does not");
        // 只改权限：ctime 变了，内容和修改时间没变
        fs::set_permissions(&f, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!really_changed(&mut seen, &f));
        fs::write(&f, "three!").unwrap();
        assert!(really_changed(&mut seen, &f), "new content");
        fs::remove_file(&f).unwrap();
        assert!(really_changed(&mut seen, &f), "deleted");
        assert!(really_changed(&mut seen, &dir.join("never-seen.md")), "a deletion we had not tracked still counts for notes");
    }

    #[test]
    fn percent_decoding_never_panics() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("%E4%B8%AD"), "中");
        assert_eq!(percent_decode("%中文%"), "%中文%");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn trash_keeps_origin_for_restore() {
        let root = std::env::temp_dir().join(format!("cn-trash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("工作/项目A")).unwrap();
        fs::write(root.join("工作/项目A/n.md"), "x").unwrap();
        move_to_trash(&root, "工作/项目A/n.md").unwrap();
        assert!(!root.join("工作/项目A/n.md").exists());
        let dir = fs::read_dir(root.join(".trash"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            fs::read_to_string(dir.join(".origin")).unwrap(),
            "工作/项目A/n.md"
        );
        assert!(dir.join("n.md").exists());
        // 整个文件夹删除
        move_to_trash(&root, "工作/项目A").unwrap();
        assert!(!root.join("工作/项目A").exists());
        cleanup_empty(&root.join(".trash"));
        assert_eq!(fs::read_dir(root.join(".trash")).unwrap().count(), 2);
    }
}
