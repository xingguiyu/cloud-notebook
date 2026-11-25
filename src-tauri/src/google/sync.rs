//! 笔记库 ⇄ Google Drive 双向同步。
//!
//! 以上次同步时的 md5 作为共同基准，分别判断本地和云端是否改过：
//! 只有一边改了就同步过去；两边都改了且内容不同，云端版本另存为冲突副本，不覆盖任何一方。
//! 删除一律进回收站（本地 `.trash`、Drive 回收站），不做永久删除。

use super::drive::{DOC_MIME, Drive, FOLDER_MIME, RemoteFile};
use super::{GoogleState, Result, auth, err};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

pub const ROOT_FOLDER: &str = "Cloud Notebook";
const SYNC_EXT: &[&str] = &["md", "png", "jpg", "jpeg", "gif", "webp", "svg"];

#[derive(Serialize, Deserialize, Clone)]
pub struct FileState {
    pub id: String,
    pub md5: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DocState {
    pub doc_id: String,
    /// 最近一次推到文档或从文档拉回时，本地笔记的 md5
    pub pushed_md5: String,
    pub remote_modified: String,
    pub two_way: bool,
    pub link: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct SyncState {
    /// 状态对应的笔记库目录；换了笔记库就从头同步
    pub vault: String,
    pub root_id: Option<String>,
    pub docs_root_id: Option<String>,
    pub files: BTreeMap<String, FileState>,
    pub docs: BTreeMap<String, DocState>,
    pub last_sync: Option<u64>,
}

fn state_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(err)?
        .join("gdrive-state.json"))
}

pub fn load_state(app: &AppHandle) -> Result<SyncState> {
    let vault = crate::vault::root(app)?.to_string_lossy().to_string();
    let st: SyncState = fs::read_to_string(state_path(app)?)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if st.vault != vault {
        return Ok(SyncState {
            vault,
            ..Default::default()
        });
    }
    Ok(st)
}

pub fn save_state(app: &AppHandle, st: &SyncState) -> Result<()> {
    let p = state_path(app)?;
    fs::create_dir_all(p.parent().unwrap()).map_err(err)?;
    // 先写临时文件再改名：写到一半退出也不会留下半截的状态文件
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(st).map_err(err)?).map_err(err)?;
    fs::rename(tmp, p).map_err(err)
}

pub fn reset_state(app: &AppHandle) -> Result<()> {
    let p = state_path(app)?;
    if p.exists() {
        fs::remove_file(p).map_err(err)?;
    }
    Ok(())
}

pub fn md5_hex(bytes: &[u8]) -> String {
    Md5::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// 应用数据目录：加密密码配置、置顶等，必须跟着笔记一起同步，否则换台设备解不开加密笔记
const META_DIR: &str = ".cloudnotebook";

/// 本地参与同步的文件：笔记、图片和 .cloudnotebook 里的配置；其他隐藏目录（含 .trash）跳过
/// 目录读不了要报错而不是当成空的：否则里面的文件会被当成「本地删了」，连带把云端的也删掉。
fn walk_local(root: &Path, dir: &Path, out: &mut BTreeMap<String, PathBuf>) -> Result<()> {
    let rd = fs::read_dir(dir).map_err(|e| format!("读不了文件夹 {}：{e}", dir.display()))?;
    let in_meta = dir
        .strip_prefix(root)
        .is_ok_and(|r| r.starts_with(META_DIR));
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let p = e.path();
        // iCloud 把没下载到本机的文件换成 `.名字.icloud` 占位：这时不能把它当成已删除
        if name.starts_with('.') && name.ends_with(".icloud") {
            return Err(format!("「{}」里有文件还在 iCloud 上没有下载到本机，这次先不同步。", dir.display()));
        }
        let is_meta_dir = dir == root && name == META_DIR && p.is_dir();
        // 符号链接不跟：可能指到笔记库外面，也可能成环
        if (name.starts_with('.') && !is_meta_dir) || p.is_symlink() {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|x| x.to_str())
            .map(|x| x.to_ascii_lowercase())
            .unwrap_or_default();
        if p.is_dir() {
            walk_local(root, &p, out)?;
        } else if SYNC_EXT.contains(&ext.as_str()) || (in_meta && (ext == "json" || ext == "enc")) {
            out.insert(
                p.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
                p,
            );
        }
    }
    Ok(())
}

/// 云端的名字能不能当本地路径里的一段。Drive 上的名字可以带 `/`、可以叫 `..`，原样拿来拼路径会写到笔记库外面。
fn safe_name(name: &str, at_root: bool) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0'])
        && !name.chars().any(char::is_control)
        && (!name.starts_with('.') || (at_root && name == META_DIR))
}

/// 和本地一样只同步笔记、图片，以及 .cloudnotebook 里的配置
fn wanted(path: &str) -> bool {
    let ext = path.rsplit('/').next().and_then(|n| n.rsplit_once('.')).map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    SYNC_EXT.contains(&ext.as_str()) || (path.starts_with(&format!("{META_DIR}/")) && (ext == "json" || ext == "enc"))
}

/// 比较路径用的规范形式：macOS 默认的文件系统不分大小写，也不分 Unicode 的两种写法（NFC / NFD）
fn canon_key(path: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    path.nfc().collect::<String>().to_lowercase()
}

/// 只差大小写或 Unicode 写法的几个路径：在这台电脑上它们是同一个文件，按普通规则处理会互相覆盖
fn collisions<'a>(paths: impl Iterator<Item = &'a String>) -> BTreeSet<String> {
    let mut by_key: HashMap<String, BTreeSet<&String>> = HashMap::new();
    for p in paths {
        by_key.entry(canon_key(p)).or_default().insert(p);
    }
    by_key.into_values().filter(|v| v.len() > 1).flatten().cloned().collect()
}

/// 加密用的密钥文件：两边不一样时不能自动选一边，选错了另一台设备的内容就解不开
const KEY_FILES: [&str; 2] = [".cloudnotebook/lock.json", ".cloudnotebook/safe/keys.json"];

/// 一次同步要删掉很多文件时先停下：多半是某一边「看起来空了」（文件夹被改名、网盘没挂上、云端文件夹进了回收站）
fn check_mass_delete(tracked: usize, deletions: usize) -> Result<()> {
    if deletions > 10 && deletions * 2 > tracked {
        return Err(format!(
            "这次同步会删除 {deletions} 个文件（一共 {tracked} 个），已暂停。请检查笔记库文件夹和 Google Drive 里的「{ROOT_FOLDER}」文件夹是否完整；确认是你自己删的，可以在设置里退出 Google 账号后重新登录，重新建立同步。"
        ));
    }
    Ok(())
}

/// 递归列出云端同步文件夹；Google 文档等在线格式不参与文件同步
async fn walk_remote(
    drive: &Drive,
    folder_id: &str,
    prefix: &str,
    files: &mut BTreeMap<String, RemoteFile>,
    folders: &mut HashMap<String, String>,
    skip: &mut BTreeSet<String>,
) -> Result<()> {
    for f in drive.list_children(folder_id).await? {
        if !safe_name(&f.name, prefix.is_empty()) {
            continue;
        }
        let path = if prefix.is_empty() {
            f.name.clone()
        } else {
            format!("{prefix}/{}", f.name)
        };
        if f.mime_type == FOLDER_MIME {
            // 同一个位置有两个同名文件夹：哪个算数说不准，里面的东西这次都不动
            if folders.insert(path.clone(), f.id.clone()).is_some() {
                skip.insert(format!("{path}/"));
            }
            Box::pin(walk_remote(drive, &f.id, &path, files, folders, skip)).await?;
        } else if f.md5_checksum.is_some() && wanted(&path) {
            if files.insert(path.clone(), f).is_some() {
                skip.insert(path);
            }
        }
    }
    Ok(())
}

/// 确保云端存在 `dir` 这条文件夹路径，返回最内层文件夹 id
async fn ensure_dir(
    drive: &Drive,
    root_id: &str,
    dir: &str,
    folders: &mut HashMap<String, String>,
) -> Result<String> {
    if dir.is_empty() {
        return Ok(root_id.into());
    }
    if let Some(id) = folders.get(dir) {
        return Ok(id.clone());
    }
    let (parent, name) = dir.rsplit_once('/').unwrap_or(("", dir));
    let parent_id = Box::pin(ensure_dir(drive, root_id, parent, folders)).await?;
    let id = drive.ensure_folder(name, Some(&parent_id)).await?;
    folders.insert(dir.into(), id.clone());
    Ok(id)
}

fn mime_of(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("md") => "text/markdown",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

/// 冲突副本的文件名：`笔记 (Google Drive 冲突).md`，重名时加序号
fn conflict_path(root: &Path, path: &str, label: &str) -> String {
    let (stem, ext) = path.rsplit_once('.').unwrap_or((path, ""));
    let mut n = 1;
    loop {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!(" {n}")
        };
        let candidate = format!("{stem} ({label}冲突{suffix}).{ext}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

/// 把云端内容写到本地。路径必须落在笔记库里面；覆盖已有笔记前把旧内容留一份历史版本。
fn write_local(root: &Path, path: &str, bytes: &[u8]) -> Result<()> {
    let rel = Path::new(path);
    if path.is_empty() || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err(format!("云端的文件路径不合法，已跳过：{path}"));
    }
    let p = root.join(rel);
    let parent = p.parent().unwrap();
    fs::create_dir_all(parent).map_err(err)?;
    // 路径中间有符号链接时，实际位置可能在笔记库外面
    let (real_root, real_parent) = (root.canonicalize().map_err(err)?, parent.canonicalize().map_err(err)?);
    if !real_parent.starts_with(&real_root) || p.is_symlink() {
        return Err(format!("这个路径指到了笔记库外面，已跳过：{path}"));
    }
    if path.ends_with(".md") && !path.starts_with(META_DIR) {
        if let Ok(old) = fs::read_to_string(&p) {
            if old.as_bytes() != bytes {
                let _ = crate::docs::snapshot(root, path, &old, 0);
            }
        }
    }
    fs::write(p, bytes).map_err(err)
}

/// 这篇笔记已有的冲突副本里，有没有内容和 `bytes` 一样的（上次同步写过了，这次不用再写一份）
fn has_conflict_copy(root: &Path, path: &str, label: &str, bytes: &[u8]) -> bool {
    let p = Path::new(path);
    let (Some(stem), Some(dir)) = (p.file_stem().map(|s| s.to_string_lossy().to_string()), root.join(p).parent().map(Path::to_path_buf)) else {
        return false;
    };
    let prefix = format!("{stem} ({label}冲突");
    let want = md5_hex(bytes);
    fs::read_dir(dir).into_iter().flatten().flatten().any(|e| e.file_name().to_string_lossy().starts_with(&prefix) && fs::read(e.path()).is_ok_and(|b| md5_hex(&b) == want))
}

fn trash_local(root: &Path, path: &str) -> Result<()> {
    crate::vault::move_to_trash(root, path)
}

#[derive(Serialize, Clone, Default)]
pub struct SyncReport {
    pub uploaded: u32,
    pub downloaded: u32,
    pub deleted: u32,
    pub conflicts: Vec<String>,
    /// 这次没有处理、需要用户看一下的文件（重名、密钥文件两边不一致等）
    pub skipped: Vec<String>,
    pub docs_pulled: u32,
    pub last_sync: u64,
}

async fn sync_files(
    app: &AppHandle,
    drive: &Drive,
    st: &mut SyncState,
    report: &mut SyncReport,
) -> Result<()> {
    let root = crate::vault::root(app)?;
    let root_id = match &st.root_id {
        Some(id) => id.clone(),
        None => {
            let id = drive.ensure_folder(ROOT_FOLDER, None).await?;
            st.root_id = Some(id.clone());
            id
        }
    };

    // 云端的同步文件夹被移进了回收站：列出来是空的，不能据此把本地文件都删掉
    if drive.get(&root_id).await.is_ok_and(|f| f.trashed == Some(true)) {
        return Err(format!("Google Drive 里的「{ROOT_FOLDER}」文件夹在回收站里。请先在 Drive 里把它恢复；如果是有意删除，在设置里退出 Google 账号后重新登录。"));
    }

    let mut local = BTreeMap::new();
    walk_local(&root, &root, &mut local)?;
    let mut remote = BTreeMap::new();
    let mut folders = HashMap::new();
    let mut skip = BTreeSet::new();
    walk_remote(drive, &root_id, "", &mut remote, &mut folders, &mut skip).await?;

    let paths: BTreeSet<String> = local
        .keys()
        .chain(remote.keys())
        .chain(st.files.keys())
        .cloned()
        .collect();

    // 只差大小写或 Unicode 写法的路径、云端重名的文件：这次不动，交给用户处理
    skip.extend(collisions(paths.iter()));
    let skipped = |path: &str| skip.contains(path) || skip.iter().any(|s| s.ends_with('/') && path.starts_with(s.as_str()));

    let local_only = crate::cloud::local_only(app);
    let mut hashes: HashMap<String, String> = HashMap::new();
    for (path, file) in &local {
        hashes.insert(path.clone(), md5_hex(&fs::read(file).map_err(err)?));
    }
    // 动手之前先数一数这次要删多少
    let deletions = st
        .files
        .iter()
        .filter(|(path, _)| !skipped(path) && !crate::cloud::is_local_only(&local_only, path))
        .filter(|(path, b)| match (hashes.get(*path), remote.get(*path).and_then(|f| f.md5_checksum.as_ref())) {
            (None, Some(rm)) => *rm == b.md5,
            (Some(l), None) => *l == b.md5,
            _ => false,
        })
        .count();
    check_mass_delete(st.files.len(), deletions)?;

    for path in paths {
        if skipped(&path) {
            report.skipped.push(path);
            continue;
        }
        // 仅本机：不上传；云端已有的副本移除（本地文件不动）
        if crate::cloud::is_local_only(&local_only, &path) {
            if let Some(f) = remote.get(&path) {
                drive.trash(&f.id).await?;
                report.deleted += 1;
            }
            st.files.remove(&path);
            continue;
        }
        let local_md5 = hashes.get(&path).cloned();
        let r = remote.get(&path);
        let remote_md5 = r.and_then(|f| f.md5_checksum.clone());
        let base = st.files.get(&path).map(|b| b.md5.clone());
        let dir = path.rsplit_once('/').map_or("", |(d, _)| d).to_string();
        let name = path.rsplit('/').next().unwrap().to_string();

        // 上传本地版本（新建或覆盖云端）
        // 覆盖或删除云端文件前再看一眼：列完目录之后别的设备可能刚传了新版本，这时留到下次同步按冲突处理
        macro_rules! remote_unchanged {
            () => {
                match r {
                    Some(f) => drive.get(&f.id).await.is_ok_and(|now| now.md5_checksum == f.md5_checksum && now.trashed != Some(true)),
                    None => true,
                }
            };
        }
        macro_rules! upload {
            () => {{
                if !remote_unchanged!() {
                    report.skipped.push(path.clone());
                    continue;
                }
                let bytes = fs::read(&local[&path]).map_err(err)?;
                let parent = ensure_dir(drive, &root_id, &dir, &mut folders).await?;
                let f = drive
                    .upload(
                        r.map(|f| f.id.as_str()),
                        Some(&parent),
                        &name,
                        bytes,
                        mime_of(&path),
                        None,
                    )
                    .await?;
                st.files.insert(
                    path.clone(),
                    FileState {
                        id: f.id,
                        md5: local_md5.clone().unwrap(),
                    },
                );
                report.uploaded += 1;
            }};
        }
        macro_rules! download {
            () => {{
                let f = r.unwrap();
                write_local(&root, &path, &drive.download(&f.id).await?)?;
                st.files.insert(
                    path.clone(),
                    FileState {
                        id: f.id.clone(),
                        md5: remote_md5.clone().unwrap(),
                    },
                );
                report.downloaded += 1;
            }};
        }
        // 两边都改了：云端版本另存为冲突副本，本地版本上传
        macro_rules! conflict {
            () => {{
                // 密钥文件两边不一样：不自动选，两边都保持原样
                if KEY_FILES.contains(&path.as_str()) {
                    report.skipped.push(path.clone());
                    continue;
                }
                let f = r.unwrap();
                let theirs = drive.download(&f.id).await?;
                // 上次同步已经存过这份冲突副本（之后上传失败了）：不再重复存
                if !has_conflict_copy(&root, &path, "Google Drive ", &theirs) {
                    let copy = conflict_path(&root, &path, "Google Drive ");
                    write_local(&root, &copy, &theirs)?;
                    report.conflicts.push(copy);
                }
                upload!();
            }};
        }

        match (&local_md5, &remote_md5, &base) {
            (Some(_), None, None) => upload!(),
            (None, Some(_), None) => download!(),
            (Some(l), Some(rm), None) => {
                if l == rm {
                    st.files.insert(
                        path.clone(),
                        FileState {
                            id: r.unwrap().id.clone(),
                            md5: l.clone(),
                        },
                    );
                } else {
                    conflict!()
                }
            }
            // 云端删了：本地没改就跟着删，改过就重新上传
            (Some(l), None, Some(b)) => {
                if l == b {
                    trash_local(&root, &path)?;
                    st.files.remove(&path);
                    report.deleted += 1;
                } else {
                    upload!()
                }
            }
            // 本地删了：云端没改就跟着删，改过就重新下载
            (None, Some(rm), Some(b)) => {
                if rm == b {
                    if !remote_unchanged!() {
                        report.skipped.push(path.clone());
                        continue;
                    }
                    drive.trash(&r.unwrap().id).await?;
                    st.files.remove(&path);
                    report.deleted += 1;
                } else {
                    download!()
                }
            }
            (None, None, _) => {
                st.files.remove(&path);
            }
            (Some(l), Some(rm), Some(b)) => match (l != b, rm != b) {
                (false, false) => {}
                (true, false) => upload!(),
                (false, true) => download!(),
                (true, true) if l == rm => {
                    st.files.insert(
                        path.clone(),
                        FileState {
                            id: r.unwrap().id.clone(),
                            md5: l.clone(),
                        },
                    );
                }
                (true, true) => conflict!(),
            },
        }
    }
    Ok(())
}

/// Google 文档导出的 Markdown 里图片是内嵌的 data URI，拆出来存进 assets/
fn extract_images(root: &Path, note: &str, md: &str) -> Result<String> {
    use base64::Engine;
    let mut out = String::with_capacity(md.len());
    let mut rest = md;
    let note_dir = note.rsplit_once('/').map_or("", |(d, _)| d);
    let mut n = 0;
    while let Some(i) = rest.find("data:image/") {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(comma) = tail.find(";base64,") else {
            out.push_str(tail);
            return Ok(out);
        };
        let ext = match &tail["data:image/".len()..comma] {
            "jpeg" => "jpg",
            "png" => "png",
            "gif" => "gif",
            "webp" => "webp",
            _ => "png",
        };
        let data_start = comma + ";base64,".len();
        let data_len = tail[data_start..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='))
            .unwrap_or(tail.len() - data_start);
        let data = &tail[data_start..data_start + data_len];
        match base64::engine::general_purpose::STANDARD.decode(data) {
            Ok(bytes) => {
                n += 1;
                let name = format!("assets/{}-{n}.{ext}", now_secs());
                let abs = if note_dir.is_empty() {
                    name.clone()
                } else {
                    format!("{note_dir}/{name}")
                };
                write_local(root, &abs, &bytes)?;
                out.push_str(&name);
            }
            Err(_) => out.push_str(&tail[..data_start + data_len]),
        }
        rest = &tail[data_start + data_len..];
    }
    out.push_str(rest);
    Ok(out)
}

/// 开启了双向同步的 Google 文档：文档在网页里被改过，就拉回笔记
async fn pull_docs(
    app: &AppHandle,
    drive: &Drive,
    st: &mut SyncState,
    report: &mut SyncReport,
) -> Result<()> {
    let root = crate::vault::root(app)?;
    let entries: Vec<(String, DocState)> = st
        .docs
        .iter()
        .filter(|(_, d)| d.two_way)
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for (note, doc) in entries {
        let Ok(meta) = drive.get(&doc.doc_id).await else {
            continue;
        };
        let modified = meta.modified_time.unwrap_or_default();
        if modified == doc.remote_modified || !root.join(&note).exists() {
            continue;
        }
        let local_md5 = md5_hex(&fs::read(root.join(&note)).map_err(err)?);
        let md =
            String::from_utf8_lossy(&drive.export(&doc.doc_id, "text/markdown").await?).to_string();
        let md = extract_images(&root, &note, &md)?;
        // 发布到文档时不带文件头部（文档状态等），拉回来要接回去，否则每次都会丢
        let md = match fs::read_to_string(root.join(&note)).ok().as_deref().map(crate::docs::split) {
            Some((Some(front), _)) => format!("---\n{front}---\n\n{md}"),
            _ => md,
        };
        if local_md5 == doc.pushed_md5 {
            write_local(&root, &note, md.as_bytes())?;
            let e = st.docs.get_mut(&note).unwrap();
            e.pushed_md5 = md5_hex(md.as_bytes());
            e.remote_modified = modified;
            report.docs_pulled += 1;
        } else {
            // 笔记和文档都改了：文档内容另存，等用户自己合并
            let copy = conflict_path(&root, &note, "Google 文档");
            write_local(&root, &copy, md.as_bytes())?;
            report.conflicts.push(copy);
            st.docs.get_mut(&note).unwrap().remote_modified = modified;
        }
    }
    Ok(())
}

/// 执行一次完整同步。已有同步在跑时直接返回 None。
pub async fn run(app: &AppHandle) -> Result<Option<SyncReport>> {
    let state = app.state::<GoogleState>();
    let Ok(_guard) = state.lock.try_lock() else {
        return Ok(None);
    };
    let _ = app.emit("google-sync", serde_json::json!({ "state": "syncing" }));
    let result = async {
        let drive = Drive::new(auth::access_token(app).await?);
        let mut st = load_state(app)?;
        let mut report = SyncReport::default();
        let files = sync_files(app, &drive, &mut st, &mut report).await;
        // 文件同步出错也先保存已完成部分的状态，避免下次重复处理
        let docs = if files.is_ok() {
            pull_docs(app, &drive, &mut st, &mut report).await
        } else {
            Ok(())
        };
        report.last_sync = now_secs();
        st.last_sync = Some(report.last_sync);
        save_state(app, &st)?;
        files.and(docs).map(|_| report)
    }
    .await;
    let _ = app.emit(
        "google-sync",
        match &result {
            Ok(r) => serde_json::json!({ "state": "idle", "report": r }),
            Err(e) => serde_json::json!({ "state": "error", "error": e }),
        },
    );
    result.map(Some)
}

#[tauri::command]
pub async fn google_sync(app: AppHandle) -> Result<Option<SyncReport>> {
    run(&app).await
}

#[tauri::command]
pub async fn google_last_sync(app: AppHandle) -> Option<u64> {
    load_state(&app).ok().and_then(|s| s.last_sync)
}

/// 共享给 docs 模块用的文档类型常量
pub const GOOGLE_DOC_MIME: &str = DOC_MIME;

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "cn-test-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn remote_names_cannot_escape_the_library() {
        for bad in ["", ".", "..", "a/b.md", "/etc/x.md", "a\\b.md", "x\0.md", "line\nbreak.md", ".hidden.md", ".trash", ".history"] {
            assert!(!safe_name(bad, true), "{bad:?}");
            assert!(!safe_name(bad, false), "{bad:?}");
        }
        assert!(safe_name("周会 记录.md", false));
        assert!(safe_name(META_DIR, true), "the config folder syncs at the top level");
        assert!(!safe_name(META_DIR, false), "but not when nested");

        let root = tmp();
        for bad in ["../x.md", "/tmp/x.md", "a/../../x.md", ""] {
            assert!(write_local(&root, bad, b"x").is_err(), "{bad:?}");
        }
        assert!(!root.parent().unwrap().join("x.md").exists());
        // 路径中间是指到外面的符号链接
        let outside = tmp().with_extension("outside");
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(write_local(&root, "link/x.md", b"x").is_err());
        assert!(!outside.join("x.md").exists());
    }

    #[test]
    fn only_notes_images_and_config_are_taken_from_the_cloud() {
        assert!(wanted("工作/周会.md") && wanted("a/assets/1.PNG") && wanted(".cloudnotebook/lock.json") && wanted(".cloudnotebook/safe/x.enc"));
        assert!(!wanted("x.plist") && !wanted("a/run.sh") && !wanted("config.json") && !wanted("noext"));
    }

    #[test]
    fn names_differing_by_case_or_unicode_form_are_flagged() {
        let nfc = "caf\u{e9}.md".to_string();
        let nfd = "cafe\u{301}.md".to_string();
        let paths = ["Todo.md".to_string(), "todo.md".to_string(), "其他.md".to_string(), nfc.clone(), nfd.clone()];
        let hit = collisions(paths.iter());
        assert_eq!(hit.len(), 4);
        assert!(hit.contains("Todo.md") && hit.contains("todo.md") && hit.contains(&nfc) && hit.contains(&nfd));
        assert!(collisions(["a.md".to_string(), "b.md".to_string()].iter()).is_empty());
    }

    #[test]
    fn mass_deletion_stops_the_sync() {
        assert!(check_mass_delete(100, 5).is_ok());
        assert!(check_mass_delete(12, 10).is_ok(), "ten or fewer is always allowed");
        assert!(check_mass_delete(100, 40).is_ok(), "a big cleanup under half the library is allowed");
        let e = check_mass_delete(100, 100).unwrap_err();
        assert!(e.contains("100") && e.contains("已暂停"));
        assert!(check_mass_delete(30, 16).is_err());
    }

    #[test]
    fn local_listing_fails_loudly_and_ignores_symlinks() {
        let root = tmp();
        fs::write(root.join("a.md"), "x").unwrap();
        let outside = tmp().with_extension("out2");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), "s").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let mut out = BTreeMap::new();
        walk_local(&root, &root, &mut out).unwrap();
        assert_eq!(out.keys().collect::<Vec<_>>(), ["a.md"]);
        // 文件夹不存在要报错，而不是当成空的
        assert!(walk_local(&root, &root.join("missing"), &mut BTreeMap::new()).is_err());
        // iCloud 占位文件：内容没下载，不能同步
        fs::write(root.join(".b.md.icloud"), "").unwrap();
        assert!(walk_local(&root, &root, &mut BTreeMap::new()).unwrap_err().contains("iCloud"));
    }

    #[test]
    fn overwriting_a_note_keeps_the_old_text_and_conflict_copies_are_not_repeated() {
        let root = tmp();
        write_local(&root, "n.md", b"old").unwrap();
        write_local(&root, "n.md", b"new").unwrap();
        let h = crate::docs::history_list(&root, "n.md").unwrap();
        assert_eq!(crate::docs::history_read(&root, "n.md", &h[0].id).unwrap(), "old");

        assert!(!has_conflict_copy(&root, "n.md", "Google Drive ", b"theirs"));
        let copy = conflict_path(&root, "n.md", "Google Drive ");
        write_local(&root, &copy, b"theirs").unwrap();
        assert!(has_conflict_copy(&root, "n.md", "Google Drive ", b"theirs"));
        assert!(!has_conflict_copy(&root, "n.md", "Google Drive ", b"something else"));
    }

    #[test]
    fn md5_matches_drive_format() {
        assert_eq!(md5_hex(b"hello"), "5d41402abc4b2a76b9719d911017c592");
    }

    #[test]
    fn conflict_copy_gets_unique_name() {
        let root = tmp();
        assert_eq!(
            conflict_path(&root, "工作/周会.md", "Google Drive "),
            "工作/周会 (Google Drive 冲突).md"
        );
        fs::create_dir_all(root.join("工作")).unwrap();
        fs::write(root.join("工作/周会 (Google Drive 冲突).md"), "").unwrap();
        assert_eq!(
            conflict_path(&root, "工作/周会.md", "Google Drive "),
            "工作/周会 (Google Drive 冲突 2).md"
        );
    }

    #[test]
    fn extracts_data_uri_images_into_assets() {
        let root = tmp();
        // 1x1 png
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        let md = format!("# T\n\n![][image1]\n\n[image1]: <data:image/png;base64,{png}>\n");
        let out = extract_images(&root, "工作/a.md", &md).unwrap();
        assert!(!out.contains("base64"));
        let rel = out.split("<").nth(1).unwrap().trim_end_matches(">\n");
        assert!(rel.starts_with("assets/") && rel.ends_with(".png"), "{rel}");
        assert!(root.join("工作").join(rel).exists());
    }

    #[test]
    fn walk_local_skips_hidden_and_non_notes() {
        let root = tmp();
        fs::create_dir_all(root.join(".trash")).unwrap();
        fs::create_dir_all(root.join("a/assets")).unwrap();
        fs::write(root.join("a/n.md"), "x").unwrap();
        fs::write(root.join("a/assets/i.png"), "x").unwrap();
        fs::write(root.join("a/x.txt"), "x").unwrap();
        fs::write(root.join(".trash/old.md"), "x").unwrap();
        fs::create_dir_all(root.join(".cloudnotebook")).unwrap();
        fs::write(root.join(".cloudnotebook/lock.json"), "{}").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config.json"), "{}").unwrap();
        let mut out = BTreeMap::new();
        walk_local(&root, &root, &mut out);
        assert_eq!(
            out.keys().cloned().collect::<Vec<_>>(),
            vec![".cloudnotebook/lock.json", "a/assets/i.png", "a/n.md"]
        );
    }
}
