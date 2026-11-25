//! 项目文档：把 AI 编程时散落在各个仓库里的 Markdown 文档收进笔记库。
//!
//! - 状态写在文件头部（front matter）：`status` / `supersedes` / `superseded_by` / `source` 等，
//!   文件仍是普通 Markdown。
//! - 每次覆盖前把旧内容存一份快照到 `<笔记库>/.history/<笔记路径>/<毫秒时间>.md`，只留在本机。
//! - 项目和本地目录的对应关系存在应用配置目录的 `projects.json`。
//!
//! 这里的函数只依赖路径，不依赖 Tauri，应用和命令行（MCP 服务）共用。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const IDENTIFIER: &str = "com.qxsclass.cloudnotebook";
pub const STATUSES: [&str; 4] = ["current", "draft", "superseded", "archived"];
/// 没绑定过的仓库第一次导入时，文档放在这个文件夹下（跟界面语言走）
fn default_parent(config: &Path) -> &'static str {
    match crate::i18n::saved(config) {
        crate::i18n::Lang::Zh => "项目文档",
        crate::i18n::Lang::En => "Project Docs",
    }
}
const KEEP_SNAPSHOTS: usize = 50;
/// 应用里连续编辑时，两份快照至少间隔这么久
pub const SNAPSHOT_GAP_MS: u128 = 10 * 60 * 1000;

type Res<T> = Result<T, String>;
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------- 路径 ----------

pub fn config_dir() -> Res<PathBuf> {
    // 开发构建里可以用环境变量指到别的目录，方便测试。正式版不认：否则谁能设置环境变量，谁就能替用户换一个笔记库
    #[cfg(debug_assertions)]
    if let Some(d) = std::env::var_os("CLOUD_NOTEBOOK_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(d));
    }
    Ok(dirs::config_dir().ok_or("找不到配置目录")?.join(IDENTIFIER))
}

/// 笔记库根目录，和应用里 `vault::root` 的规则一致
pub fn vault_root(config: &Path) -> Res<PathBuf> {
    let saved = fs::read_to_string(config.join("vault.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["root"].as_str().map(PathBuf::from));
    match saved {
        Some(p) => Ok(p),
        None => Ok(dirs::document_dir().ok_or("找不到文稿目录")?.join("Cloud Notebook")),
    }
}

fn safe_rel(rel: &str) -> Res<&Path> {
    let p = Path::new(rel);
    if rel.is_empty() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("非法路径：{rel}"));
    }
    Ok(p)
}

/// 笔记库里从根到 `rel` 这一路上不能有符号链接：链接可能指到库外面，读写就越界了
pub fn no_symlinks(root: &Path, rel: &str) -> Res<PathBuf> {
    let mut p = root.to_path_buf();
    for c in safe_rel(rel)?.components() {
        p.push(c);
        if fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!("路径里有符号链接，不能访问：{rel}"));
        }
    }
    Ok(p)
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis())
}

/// 本地日期 `YYYY-MM-DD`
pub fn date_of(ms: u128) -> String {
    let secs = (ms / 1000) as i64;
    #[cfg(unix)]
    {
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        let t = secs as libc::time_t;
        if !unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
            return format!("{:04}-{:02}-{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday);
        }
    }
    // 取不到本地时区时按 UTC 算
    let days = secs.div_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    format!("{:04}-{:02}-{:02}", yoe + era * 400 + i64::from(m <= 2), m, d)
}

// ---------- 文件头部 ----------

fn is_key_line(l: &str) -> bool {
    let Some((k, _)) = l.split_once(':') else { return false };
    !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 拆出头部和正文。只有 `---` 包着、且每行都是 `key: value` 才算头部，
/// 以分隔线开头的普通笔记不受影响。
pub fn split(md: &str) -> (Option<&str>, &str) {
    let Some(rest) = md.strip_prefix("---\n").or_else(|| md.strip_prefix("---\r\n")) else {
        return (None, md);
    };
    let mut pos = 0;
    for line in rest.split_inclusive('\n') {
        let t = line.trim_end_matches(['\n', '\r']);
        if t == "---" {
            if pos == 0 {
                return (None, md);
            }
            let body = &rest[pos + line.len()..];
            return (Some(&rest[..pos]), body.strip_prefix('\n').unwrap_or(body));
        }
        // 第一行必须是 `key: value`；后面允许 YAML 的续行（缩进）、列表项和注释，这样别的工具写的头部也认得
        let continuation = pos > 0 && (t.starts_with([' ', '\t', '#']) || t.starts_with("- ") || t == "-");
        if !t.trim().is_empty() && !is_key_line(t) && !continuation {
            return (None, md);
        }
        pos += line.len();
    }
    (None, md)
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    let quoted = v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')));
    if quoted { v[1..v.len() - 1].replace("\\\"", "\"") } else { v.to_string() }
}

pub fn get(md: &str, key: &str) -> Option<String> {
    let front = split(md).0?;
    // 只认顶格的键，缩进的是别的键下面的内容
    front.lines().filter(|l| is_key_line(l)).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k == key).then(|| unquote(v)).filter(|v| !v.is_empty())
    })
}

/// 读列表值：`[a, b]` 或单个值
pub fn get_list(md: &str, key: &str) -> Vec<String> {
    let Some(v) = get(md, key) else { return vec![] };
    match v.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
        Some(inner) => split_items(inner),
        None => vec![v],
    }
}

/// 按逗号拆列表，引号里的逗号不算
fn split_items(inner: &str) -> Vec<String> {
    let (mut out, mut cur, mut open) = (vec![], String::new(), None);
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        match (open, c) {
            (Some('"'), '\\') if chars.peek() == Some(&'"') => {
                cur.push('\\');
                cur.push(chars.next().unwrap());
            }
            (Some(q), c) if c == q => {
                open = None;
                cur.push(c);
            }
            (None, '"' | '\'') if cur.trim().is_empty() => {
                open = Some(c);
                cur.push(c);
            }
            (None, ',') => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out.iter().map(|s| unquote(s)).filter(|s| !s.is_empty()).collect()
}

fn quote(v: &str) -> String {
    let cleaned: String = v.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let v = cleaned.as_str();
    let plain = !v.is_empty()
        && !v.starts_with(['[', '{', '"', '\'', '#', '&', '*', '!', '|', '>', '%', '@', '`', '-', ' '])
        && !v.ends_with(' ')
        && !v.contains(": ")
        && !v.contains(" #")
        && !v.contains(['\n', ',', ']']);
    if plain { v.to_string() } else { format!("\"{}\"", v.replace('"', "\\\"")) }
}

pub fn list_value(items: &[String]) -> String {
    format!("[{}]", items.iter().map(|s| quote(s)).collect::<Vec<_>>().join(", "))
}

/// 改头部里的若干个键：`Some` 写入（值按原样写，列表用 `list_value`），`None` 删除。
/// 其他键和正文原样保留；原来没有头部就新建。
pub fn set(md: &str, pairs: &[(&str, Option<String>)]) -> String {
    let (front, body) = split(md);
    let mut lines: Vec<String> = front.map(|f| f.lines().map(String::from).collect()).unwrap_or_default();
    for (key, value) in pairs {
        let at = lines.iter().position(|l| is_key_line(l) && l.split_once(':').is_some_and(|(k, _)| k == *key));
        match (at, value) {
            (Some(i), Some(v)) => lines[i] = format!("{key}: {v}"),
            (Some(i), None) => {
                lines.remove(i);
            }
            (None, Some(v)) => lines.push(format!("{key}: {v}")),
            (None, None) => {}
        }
    }
    lines.retain(|l| !l.trim().is_empty());
    if lines.is_empty() {
        return body.to_string();
    }
    format!("---\n{}\n---\n\n{}", lines.join("\n"), body)
}

pub fn scalar(v: &str) -> Option<String> {
    Some(quote(v))
}

/// 标题：正文第一个标题行，没有就用第一行文字
pub fn title_of(md: &str) -> Option<String> {
    let body = split(md).1;
    let first = body.lines().map(str::trim).find(|l| !l.is_empty())?;
    let t = first.trim_start_matches('#').trim();
    (!t.is_empty()).then(|| t.chars().take(120).collect())
}

// ---------- 版本快照 ----------

fn history_dir(root: &Path, rel: &str) -> Res<PathBuf> {
    safe_rel(rel)?;
    no_symlinks(root, &format!(".history/{rel}"))
}

fn snapshot_ids(dir: &Path) -> Vec<u128> {
    let mut ids: Vec<u128> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".md")?.parse().ok())
        .collect();
    ids.sort_unstable();
    ids
}

/// 存一份快照。和最近一份内容相同就不存；`min_gap_ms` 内已经存过也不存。
pub fn snapshot(root: &Path, rel: &str, content: &str, min_gap_ms: u128) -> Res<bool> {
    if content.trim().is_empty() {
        return Ok(false);
    }
    let dir = history_dir(root, rel)?;
    let ids = snapshot_ids(&dir);
    let now = now_ms();
    if let Some(last) = ids.last() {
        if *last <= now && now - *last < min_gap_ms {
            return Ok(false);
        }
        if fs::read_to_string(dir.join(format!("{last}.md"))).is_ok_and(|s| s == content) {
            return Ok(false);
        }
    }
    fs::create_dir_all(&dir).map_err(err)?;
    fs::write(dir.join(format!("{now}.md")), content).map_err(err)?;
    if ids.len() >= KEEP_SNAPSHOTS {
        for old in &ids[..=ids.len() - KEEP_SNAPSHOTS] {
            let _ = fs::remove_file(dir.join(format!("{old}.md")));
        }
    }
    Ok(true)
}

#[derive(Serialize)]
pub struct Version {
    /// 快照时间（毫秒），也是它的编号
    pub id: String,
    pub size: u64,
}

/// 从新到旧
pub fn history_list(root: &Path, rel: &str) -> Res<Vec<Version>> {
    let dir = history_dir(root, rel)?;
    Ok(snapshot_ids(&dir)
        .into_iter()
        .rev()
        .map(|id| Version { size: fs::metadata(dir.join(format!("{id}.md"))).map_or(0, |m| m.len()), id: id.to_string() })
        .collect())
}

pub fn history_read(root: &Path, rel: &str, id: &str) -> Res<String> {
    let n: u128 = id.parse().map_err(|_| "版本编号不对")?;
    fs::read_to_string(history_dir(root, rel)?.join(format!("{n}.md"))).map_err(|_| "这个版本不存在".into())
}

/// 恢复到某个版本：当前内容先存成快照，再写回旧内容
pub fn history_restore(root: &Path, rel: &str, id: &str) -> Res<String> {
    let old = history_read(root, rel, id)?;
    let file = root.join(safe_rel(rel)?);
    if let Ok(cur) = fs::read_to_string(&file) {
        snapshot(root, rel, &cur, 0)?;
    }
    fs::write(&file, &old).map_err(err)?;
    Ok(old)
}

/// 笔记或文件夹改名时，快照跟着走
pub fn history_moved(root: &Path, from: &str, to: &str) {
    let (Ok(a), Ok(b)) = (history_dir(root, from), history_dir(root, to)) else { return };
    if !a.exists() {
        return;
    }
    // 目标位置留着别的笔记的旧历史：那不是这篇的，清掉，免得张冠李戴
    if b.exists() {
        let _ = fs::remove_dir_all(&b);
    }
    if let Some(p) = b.parent() {
        let _ = fs::create_dir_all(p);
    }
    let _ = fs::rename(a, b);
}

/// 删掉一篇笔记（或一个文件夹）的全部历史：永久删除、加密时用
pub fn history_purge(root: &Path, rel: &str) {
    if let Ok(d) = history_dir(root, rel) {
        let _ = fs::remove_dir_all(d);
    }
}

/// 笔记进回收站时历史跟着走，放在回收站条目里的 `.history`；恢复时再放回去
pub fn history_to_trash(root: &Path, rel: &str, trash_entry: &Path) {
    if let Ok(d) = history_dir(root, rel) {
        if d.exists() {
            let _ = fs::rename(d, trash_entry.join(".history"));
        }
    }
}

pub fn history_from_trash(root: &Path, trash_entry: &Path, rel: &str) {
    let kept = trash_entry.join(".history");
    let Ok(d) = history_dir(root, rel) else { return };
    if kept.exists() {
        let _ = fs::remove_dir_all(&d);
        if let Some(p) = d.parent() {
            let _ = fs::create_dir_all(p);
        }
        let _ = fs::rename(kept, d);
    }
}

// ---------- 项目绑定 ----------

#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub struct Project {
    pub name: String,
    /// 笔记库里的文件夹（相对路径）
    pub folder: String,
    /// 绑定的本地目录
    #[serde(default)]
    pub dirs: Vec<String>,
    /// 绑定的 git 远程地址（规范化后的 `host/owner/repo`），换一台电脑也认得
    #[serde(default)]
    pub remotes: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Config {
    /// 是否允许 AI 写入（保存文档、改状态、导入）
    #[serde(default = "yes")]
    pub write: bool,
    #[serde(default)]
    pub projects: Vec<Project>,
    /// 配置文件在但读不懂：这时一律按「不允许写入」处理，也不去覆盖它
    #[serde(skip)]
    pub broken: bool,
}
fn yes() -> bool {
    true
}
impl Default for Config {
    fn default() -> Self {
        Config { write: true, projects: vec![], broken: false }
    }
}

pub fn load_config(config: &Path) -> Config {
    match fs::read(config.join("projects.json")) {
        // 还没有配置文件：全新状态
        Err(_) => Config::default(),
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or(Config { write: false, projects: vec![], broken: true }),
    }
}

pub fn save_config(config: &Path, c: &Config) -> Res<()> {
    if c.broken {
        return Err("projects.json 损坏，读不出原来的设置。请在 Cloud Notebook 的「设置 → 项目文档」里检查，或删除这个文件后重新绑定。".into());
    }
    fs::create_dir_all(config).map_err(err)?;
    // 先写临时文件再改名，写到一半退出不会留下半截的配置
    let tmp = config.join("projects.json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(c).map_err(err)?).map_err(err)?;
    fs::rename(tmp, config.join("projects.json")).map_err(err)
}

/// `git@github.com:a/b.git`、`https://github.com/a/b` 都变成 `github.com/a/b`
pub fn normalize_remote(url: &str) -> String {
    let u = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let u = u.split_once("://").map_or(u, |(_, r)| r);
    let u = u.rsplit_once('@').map_or(u, |(_, r)| r);
    u.replacen(':', "/", 1).to_lowercase()
}

/// 往上找 git 仓库根目录；不在仓库里就返回 `dir` 自己
pub fn repo_root(dir: &Path) -> PathBuf {
    let mut p = dir;
    loop {
        if p.join(".git").exists() {
            return p.to_path_buf();
        }
        match p.parent() {
            Some(up) => p = up,
            None => return dir.to_path_buf(),
        }
    }
}

pub fn repo_remote(repo: &Path) -> Option<String> {
    let cfg = fs::read_to_string(repo.join(".git/config")).ok()?;
    let mut in_origin = false;
    let mut first = None;
    for l in cfg.lines().map(str::trim) {
        if l.starts_with('[') {
            in_origin = l == "[remote \"origin\"]";
        } else if let Some(v) = l.strip_prefix("url").map(str::trim_start).and_then(|x| x.strip_prefix('=')) {
            if in_origin {
                return Some(normalize_remote(v));
            }
            first.get_or_insert_with(|| normalize_remote(v));
        }
    }
    first
}

fn folder_name(s: &str) -> String {
    let t: String = s.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '\0') || c.is_control() { '-' } else { c }).collect();
    let t = t.trim().trim_start_matches('.').trim();
    if t.is_empty() { "未命名".into() } else { t.chars().take(80).collect() }
}

/// 解析掉 `..` 和符号链接后的真实路径；目录不存在就原样返回
pub fn real(dir: &Path) -> PathBuf {
    // 目录还不存在时，解析到最近的已存在的上级，再把剩下的部分接回去
    let mut rest = vec![];
    let mut p = dir;
    loop {
        if let Ok(c) = p.canonicalize() {
            return rest.iter().rev().fold(c, |acc, part| acc.join(part));
        }
        match (p.parent(), p.file_name()) {
            (Some(up), Some(name)) => {
                rest.push(name.to_os_string());
                p = up;
            }
            _ => return dir.to_path_buf(),
        }
    }
}

/// 这个目录属于哪个项目。只按绑定的目录认：
/// - 在 git 仓库里：仓库根目录必须正好是绑定的目录（绑定了上级目录不算，免得一个绑定吞掉下面所有仓库）；
/// - 不在仓库里：目录在绑定的目录之下。
///
/// 不按 git 远程地址认。远程地址写在仓库自己的 `.git/config` 里，别人的仓库可以照抄，抄了就能读写你的项目文档。
pub fn find_project<'a>(c: &'a Config, dir: &Path) -> Option<&'a Project> {
    let dir = real(dir);
    let repo = repo_root(&dir);
    if repo.join(".git").exists() {
        return c.projects.iter().find(|p| p.dirs.iter().any(|d| real(Path::new(d)) == repo));
    }
    c.projects
        .iter()
        .filter(|p| p.dirs.iter().any(|d| dir.starts_with(real(Path::new(d)))))
        .max_by_key(|p| p.dirs.iter().filter(|d| dir.starts_with(real(Path::new(d)))).map(|d| d.len()).max().unwrap_or(0))
}

/// 能不能把这个目录当成项目目录。笔记库、应用配置目录本身，以及包着它们的上级目录（主目录、根目录）都不行：
/// 否则「导入这个仓库里的文档」就成了「把所有笔记读一遍」。
pub fn check_project_dir(config: &Path, root: &Path, dir: &Path) -> Res<()> {
    let repo = repo_root(&real(dir));
    let home = dirs::home_dir().map(|h| real(&h));
    if repo.parent().is_none() || Some(&repo) == home.as_ref() {
        return Err(format!("不能把 {} 当作项目目录，请在具体的项目文件夹里使用。", repo.display()));
    }
    for (what, protected) in [("笔记库", real(root)), ("应用配置目录", real(config))] {
        if repo.starts_with(&protected) || protected.starts_with(&repo) {
            return Err(format!("{} 和{what}重叠，不能当作项目目录。", repo.display()));
        }
    }
    Ok(())
}

/// 找到这个目录对应的项目；没有就按仓库名新建一个并记下来
pub fn ensure_project(config: &Path, root: &Path, dir: &Path) -> Res<Project> {
    let mut c = load_config(config);
    if let Some(p) = find_project(&c, dir) {
        return Ok(p.clone());
    }
    if c.broken {
        return save_config(config, &c).map(|_| Project::default());
    }
    check_project_dir(config, root, dir)?;
    let repo = repo_root(&real(dir));
    let name = folder_name(&repo.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    let parent = default_parent(config);
    let mut folder = format!("{parent}/{name}");
    let mut n = 2;
    // 文件系统不分大小写：`App` 和 `app` 是同一个文件夹。磁盘上已经有的文件夹也不占用，那可能是别的项目解绑后留下的
    let taken = |f: &str| c.projects.iter().any(|p| p.folder.to_lowercase() == f.to_lowercase()) || root.join(f).exists();
    while taken(&folder) {
        folder = format!("{parent}/{name} {n}");
        n += 1;
    }
    let p = Project { name, folder, dirs: vec![repo.to_string_lossy().to_string()], remotes: repo_remote(&repo).into_iter().collect() };
    c.projects.push(p.clone());
    save_config(config, &c)?;
    Ok(p)
}

/// 把笔记库里的一个文件夹和本地目录绑在一起（应用里手动绑定用）
pub fn bind(config: &Path, root: &Path, folder: &str, dir: &Path) -> Res<Project> {
    safe_rel(folder)?;
    if folder.split('/').any(|c| c.starts_with('.')) {
        return Err("不能绑定隐藏文件夹".into());
    }
    check_project_dir(config, root, dir)?;
    let mut c = load_config(config);
    let repo = repo_root(&real(dir));
    let d = repo.to_string_lossy().to_string();
    for p in &mut c.projects {
        p.dirs.retain(|x| *x != d);
    }
    let remote = repo_remote(&repo);
    let i = match c.projects.iter().position(|p| p.folder == folder) {
        Some(i) => i,
        None => {
            c.projects.push(Project { name: folder.rsplit('/').next().unwrap_or(folder).to_string(), folder: folder.to_string(), ..Default::default() });
            c.projects.len() - 1
        }
    };
    c.projects[i].dirs.push(d);
    if let Some(r) = remote {
        if !c.projects[i].remotes.contains(&r) {
            c.projects[i].remotes.push(r);
        }
    }
    let out = c.projects[i].clone();
    c.projects.retain(|p| !p.dirs.is_empty() || !p.remotes.is_empty());
    save_config(config, &c)?;
    Ok(out)
}

pub fn unbind(config: &Path, folder: &str) -> Res<()> {
    let mut c = load_config(config);
    c.projects.retain(|p| p.folder != folder);
    save_config(config, &c)
}

/// 文件夹改名或移动后，绑定跟着改
pub fn folder_moved(config: &Path, from: &str, to: &str) {
    let mut c = load_config(config);
    let mut changed = false;
    for p in &mut c.projects {
        if p.folder == from {
            p.folder = to.to_string();
            changed = true;
        } else if let Some(rest) = p.folder.strip_prefix(&format!("{from}/")) {
            p.folder = format!("{to}/{rest}");
            changed = true;
        }
    }
    if changed {
        let _ = save_config(config, &c);
    }
}

// ---------- 文档 ----------

#[derive(Serialize, Clone, Debug)]
pub struct Doc {
    pub path: String,
    pub title: String,
    pub status: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub kind: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub supersedes: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub superseded_by: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub source: String,
    pub updated: String,
    pub versions: usize,
}

fn doc_of(root: &Path, rel: &str) -> Option<Doc> {
    let file = root.join(rel);
    let md = fs::read_to_string(&file).ok()?;
    let modified = fs::metadata(&file).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis());
    Some(Doc {
        title: title_of(&md).unwrap_or_else(|| rel.rsplit('/').next().unwrap_or(rel).trim_end_matches(".md").to_string()),
        status: get(&md, "status").filter(|s| STATUSES.contains(&s.as_str())).unwrap_or_else(|| "current".into()),
        kind: get(&md, "type").unwrap_or_default(),
        supersedes: get_list(&md, "supersedes"),
        superseded_by: get(&md, "superseded_by").unwrap_or_default(),
        source: get(&md, "source").unwrap_or_default(),
        updated: date_of(modified),
        versions: history_dir(root, rel).map_or(0, |d| snapshot_ids(&d).len()) + 1,
        path: rel.to_string(),
    })
}

fn md_files(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let p = e.path();
        if name.starts_with('.') || name == "assets" || p.is_symlink() {
            continue;
        }
        if p.is_dir() {
            md_files(base, &p, out);
        } else if name.ends_with(".md") {
            if let Ok(r) = p.strip_prefix(base) {
                out.push(r.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

pub fn list_docs(root: &Path, project: &Project) -> Vec<Doc> {
    let mut rels = vec![];
    md_files(root, &root.join(&project.folder), &mut rels);
    let mut docs: Vec<Doc> = rels.iter().filter_map(|r| doc_of(root, r)).collect();
    docs.sort_by(|a, b| b.updated.cmp(&a.updated).then(a.path.cmp(&b.path)));
    docs
}

fn in_project(project: &Project, rel: &str) -> Res<()> {
    safe_rel(rel)?;
    if rel.starts_with(&format!("{}/", project.folder)) && rel.ends_with(".md") {
        Ok(())
    } else {
        Err(format!("{rel} 不在项目「{}」的文件夹里", project.name))
    }
}

pub fn read_doc(root: &Path, project: &Project, rel: &str) -> Res<String> {
    in_project(project, rel)?;
    fs::read_to_string(no_symlinks(root, rel)?).map_err(|_| format!("找不到文档：{rel}"))
}

/// 覆盖已有文件前存快照
fn write_doc(root: &Path, rel: &str, content: &str) -> Res<()> {
    let file = no_symlinks(root, rel)?;
    if let Ok(old) = fs::read_to_string(&file) {
        if old == content {
            return Ok(());
        }
        // 只改了头部（比如状态）不算一个新版本
        if split(&old).1 != split(content).1 {
            snapshot(root, rel, &old, 0)?;
        }
    }
    if let Some(p) = file.parent() {
        fs::create_dir_all(p).map_err(err)?;
    }
    fs::write(&file, content).map_err(err)
}

pub fn set_status(root: &Path, project: &Project, rel: &str, status: &str, superseded_by: Option<&str>) -> Res<Doc> {
    in_project(project, rel)?;
    if !STATUSES.contains(&status) {
        return Err(format!("状态只能是 {}", STATUSES.join(" / ")));
    }
    let md = read_doc(root, project, rel)?;
    let by = if status == "superseded" { superseded_by.map(|s| quote(s)) } else { None };
    write_doc(root, rel, &set(&md, &[("status", scalar(status)), ("superseded_by", by)]))?;
    doc_of(root, rel).ok_or_else(|| "写入后读取失败".into())
}

#[derive(Deserialize, Default, Debug)]
pub struct NewDoc {
    pub title: String,
    pub content: String,
    /// plan / design / spec / notes / report …
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    /// 被这份取代的文档（笔记库里的相对路径）
    #[serde(default)]
    pub supersedes: Vec<String>,
    /// 来源文件（相对仓库根目录）
    #[serde(default)]
    pub source: Option<String>,
}

fn file_name(title: &str) -> String {
    folder_name(title.trim_end_matches(".md"))
}

/// 保存一份文档。同一个来源文件、或同名文档已经在项目里：存成它的新版本（旧内容进快照）；否则新建。
pub fn save_doc(root: &Path, project: &Project, new: &NewDoc) -> Res<Doc> {
    let status = new.status.as_deref().unwrap_or("current");
    if !STATUSES.contains(&status) {
        return Err(format!("状态只能是 {}", STATUSES.join(" / ")));
    }
    for s in &new.supersedes {
        in_project(project, s)?;
        if !root.join(s).exists() {
            return Err(format!("要取代的文档不存在：{s}"));
        }
    }
    if new.content.len() as u64 > MAX_DOC_BYTES {
        return Err(format!("文档太大（超过 {} MB）", MAX_DOC_BYTES / 1024 / 1024));
    }
    let existing = list_docs(root, project);
    let source = new.source.as_deref().filter(|s| !s.is_empty());
    let same_source = source.and_then(|s| existing.iter().find(|d| d.source == s));
    let rel = match same_source {
        Some(d) => d.path.clone(),
        None => {
            // 同名文件已经在了，但不是同一份文档（来源不同，或者是用户自己写的、没有文档状态的笔记）：另起一个名字，不覆盖
            let base = file_name(&new.title);
            let other = |rel: &str| {
                let Ok(old) = fs::read_to_string(root.join(rel)) else { return false };
                let old_source = get(&old, "source").unwrap_or_default();
                get(&old, "status").is_none() || (!old_source.is_empty() && source.is_some_and(|s| s != old_source))
            };
            let mut rel = format!("{}/{base}.md", project.folder);
            let mut n = 2;
            while other(&rel) {
                rel = format!("{}/{base} {n}.md", project.folder);
                n += 1;
            }
            rel
        }
    };
    if new.supersedes.contains(&rel) {
        return Err("文档不能取代它自己；内容更新直接再保存一次，旧内容会自动留作历史版本".into());
    }
    let mut body = new.content.replace("\r\n", "\n");
    if title_of(&body).is_none() || !split(&body).1.trim_start().starts_with('#') {
        let (front, text) = split(&body);
        let head = front.map(|f| format!("---\n{f}---\n\n")).unwrap_or_default();
        body = format!("{head}# {}\n\n{}", new.title.trim(), text.trim_start());
    }
    // 重新导入时正文来自仓库文件，不带头部：类型和取代关系沿用已有文档的
    let prev = fs::read_to_string(root.join(&rel)).unwrap_or_default();
    let keep = |key: &str| get(&body, key).or_else(|| get(&prev, key));
    let mut supersedes = get_list(&body, "supersedes");
    for s in get_list(&prev, "supersedes") {
        if !supersedes.contains(&s) {
            supersedes.push(s);
        }
    }
    for s in &new.supersedes {
        if !supersedes.contains(s) {
            supersedes.push(s.clone());
        }
    }
    let content = set(
        &body,
        &[
            ("status", scalar(status)),
            ("type", new.kind.as_deref().filter(|k| !k.is_empty()).map(|k| quote(k)).or_else(|| keep("type").map(|k| quote(&k)))),
            ("supersedes", (!supersedes.is_empty()).then(|| list_value(&supersedes))),
            ("superseded_by", None),
            ("source", new.source.as_deref().filter(|s| !s.is_empty()).map(|s| quote(s)).or_else(|| keep("source").map(|s| quote(&s)))),
            ("updated", scalar(&date_of(now_ms()))),
        ],
    );
    write_doc(root, &rel, &content)?;
    for s in &new.supersedes {
        let old = fs::read_to_string(root.join(s)).map_err(err)?;
        write_doc(root, s, &set(&old, &[("status", scalar("superseded")), ("superseded_by", Some(quote(&rel)))]))?;
    }
    doc_of(root, &rel).ok_or_else(|| "写入后读取失败".into())
}

// ---------- 扫描仓库 ----------

#[derive(Serialize, Debug)]
pub struct Found {
    /// 相对仓库根目录
    pub path: String,
    pub title: String,
    pub modified: String,
    pub size: u64,
    /// `new` 没导入过 / `same` 已导入且内容一样 / `changed` 已导入但两边内容不一样了（哪边新要看内容）
    pub state: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub doc: String,
}

const SKIP_DIRS: [&str; 12] = ["node_modules", "target", "dist", "build", "vendor", "out", "coverage", "venv", "__pycache__", "Pods", "DerivedData", "gen"];
const MAX_FOUND: usize = 400;
const MAX_DOC_BYTES: u64 = 2 * 1024 * 1024;

fn scan_walk(base: &Path, dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 8 || out.len() >= MAX_FOUND {
        return;
    }
    let Ok(read) = fs::read_dir(dir) else { return };
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let p = e.path();
        if p.is_dir() {
            // .claude 里常有计划文档，其他隐藏目录跳过
            if (name.starts_with('.') && name != ".claude") || SKIP_DIRS.contains(&name.as_str()) || p.is_symlink() {
                continue;
            }
            scan_walk(base, &p, depth + 1, out);
        } else if name.to_lowercase().ends_with(".md") && out.len() < MAX_FOUND && fs::symlink_metadata(&p).is_ok_and(|m| m.is_file()) {
            out.push(p);
        }
    }
}

/// 导入时去掉头部再比较，头部是我们自己加的
fn same_body(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let body = split(s).1.replace("\r\n", "\n");
        let body = body.trim();
        // 导入时可能补了一行标题
        body.strip_prefix('#').map_or(body.to_string(), |r| r.split_once('\n').map_or(String::new(), |(_, rest)| rest.trim().to_string()))
    };
    let (x, y) = (split(a).1.replace("\r\n", "\n"), split(b).1.replace("\r\n", "\n"));
    x.trim() == y.trim() || norm(a) == norm(b)
}

pub fn scan_repo(root: &Path, project: Option<&Project>, dir: &Path) -> Vec<Found> {
    let repo = repo_root(&real(dir));
    let mut files = vec![];
    scan_walk(&repo, &repo, 0, &mut files);
    let docs = project.map(|p| list_docs(root, p)).unwrap_or_default();
    let mut found: Vec<Found> = files
        .iter()
        .filter_map(|f| {
            let meta = fs::metadata(f).ok()?;
            if meta.len() == 0 || meta.len() > MAX_DOC_BYTES {
                return None;
            }
            let rel = f.strip_prefix(&repo).ok()?.to_string_lossy().replace('\\', "/");
            let md = fs::read_to_string(f).ok()?;
            let imported = docs.iter().find(|d| d.source == rel);
            let state = match imported {
                None => "new",
                Some(d) if fs::read_to_string(root.join(&d.path)).is_ok_and(|cur| same_body(&cur, &md)) => "same",
                Some(_) => "changed",
            };
            Some(Found {
                title: title_of(&md).unwrap_or_default(),
                modified: date_of(meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis()),
                size: meta.len(),
                state,
                doc: imported.map(|d| d.path.clone()).unwrap_or_default(),
                path: rel,
            })
        })
        .collect();
    found.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.path.cmp(&b.path)));
    found
}

#[derive(Deserialize, Debug)]
pub struct ImportItem {
    /// 相对仓库根目录
    pub path: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    /// 被它取代的文件：可以写仓库里的相对路径（同一批导入的），也可以写笔记库里的文档路径
    #[serde(default)]
    pub supersedes: Vec<String>,
}

/// 把仓库里的文件复制进项目；仓库里的原文件不动。
/// 被取代的排在前面先导入，这样「取代」关系里引用的文档已经存在。
pub fn import_files(root: &Path, project: &Project, dir: &Path, items: &[ImportItem]) -> Res<Vec<Doc>> {
    let repo = repo_root(&real(dir));
    let mut order: Vec<&ImportItem> = items.iter().collect();
    order.sort_by_key(|i| i.supersedes.len());
    let mut by_source = std::collections::HashMap::new();
    let mut out = vec![];
    for it in order {
        let rel = safe_rel(&it.path)?;
        if !it.path.to_lowercase().ends_with(".md") {
            return Err(format!("只能导入 .md 文件：{}", it.path));
        }
        // 隐藏目录里的不导入（.claude 里的计划文档除外）：.git、.trash、.history 之类不是项目文档
        if rel.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.') && c.as_os_str() != ".claude") {
            return Err(format!("不能导入隐藏目录里的文件：{}", it.path));
        }
        let file = repo.join(rel);
        let real = file.canonicalize().map_err(|_| format!("找不到文件：{}", it.path))?;
        if !real.starts_with(repo.canonicalize().map_err(err)?) {
            return Err(format!("文件不在仓库目录里：{}", it.path));
        }
        // 只读普通文件（管道、设备文件会让读取一直卡住），并且边读边限制大小
        let meta = fs::symlink_metadata(&file).map_err(err)?;
        if !meta.is_file() {
            return Err(format!("不是普通文件：{}", it.path));
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        fs::File::open(&real).map_err(err)?.take(MAX_DOC_BYTES + 1).read_to_end(&mut bytes).map_err(err)?;
        if bytes.len() as u64 > MAX_DOC_BYTES {
            return Err(format!("文件太大：{}", it.path));
        }
        let md = String::from_utf8(bytes).map_err(|_| format!("读不了（不是文本？）：{}", it.path))?;
        let title = it.title.clone().filter(|t| !t.trim().is_empty()).or_else(|| title_of(&md)).unwrap_or_else(|| it.path.rsplit('/').next().unwrap_or(&it.path).trim_end_matches(".md").to_string());
        let supersedes = it
            .supersedes
            .iter()
            .map(|s| by_source.get(s).cloned().or_else(|| list_docs(root, project).into_iter().find(|d| d.source == *s).map(|d| d.path)).unwrap_or_else(|| s.clone()))
            .collect();
        let doc = save_doc(root, project, &NewDoc { title, content: md, kind: it.kind.clone(), status: it.status.clone(), supersedes, source: Some(it.path.clone()) })?;
        by_source.insert(it.path.clone(), doc.path.clone());
        out.push(doc);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cn-docs-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn front_matter_round_trip() {
        let md = "---\nstatus: draft\nauthor: me\n---\n\n# 标题\n\n正文\n";
        assert_eq!(get(md, "status").as_deref(), Some("draft"));
        assert_eq!(split(md).1, "# 标题\n\n正文\n");
        let out = set(md, &[("status", scalar("current")), ("supersedes", Some(list_value(&["a/b.md".into(), "c, d.md".into()])))]);
        assert_eq!(get(&out, "status").as_deref(), Some("current"));
        assert_eq!(get(&out, "author").as_deref(), Some("me"));
        assert_eq!(get_list(&out, "supersedes"), vec!["a/b.md", "c, d.md"]);
        assert_eq!(split(&out).1, "# 标题\n\n正文\n");
        // 全部删掉后不留空头部
        assert_eq!(set(&out, &[("status", None), ("author", None), ("supersedes", None)]), "# 标题\n\n正文\n");
    }

    #[test]
    fn divider_at_top_is_not_front_matter() {
        for md in ["---\n\n正文\n", "---\n这是一段话\n---\n", "---\n---\n正文", "没有头部"] {
            assert_eq!(split(md), (None, md), "{md:?}");
            assert_eq!(split(&set(md, &[("status", scalar("draft"))])).1, md);
        }
    }

    #[test]
    fn remotes_normalize_to_the_same_key() {
        for u in ["git@github.com:Acme/App.git", "https://github.com/acme/app", "ssh://git@github.com/acme/app.git/", "https://token@github.com/acme/app.git"] {
            assert_eq!(normalize_remote(u), "github.com/acme/app", "{u}");
        }
    }

    #[test]
    fn snapshots_keep_old_content_and_restore() {
        let root = tmp("hist");
        fs::write(root.join("a.md"), "v1").unwrap();
        assert!(snapshot(&root, "a.md", "v1", 0).unwrap());
        assert!(!snapshot(&root, "a.md", "v1", 0).unwrap(), "same content is not stored twice");
        std::thread::sleep(std::time::Duration::from_millis(3));
        assert!(!snapshot(&root, "a.md", "v2", 60_000).unwrap(), "too soon after the last one");
        assert!(snapshot(&root, "a.md", "v2", 0).unwrap());
        fs::write(root.join("a.md"), "v3").unwrap();
        let list = history_list(&root, "a.md").unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(history_read(&root, "a.md", &list[1].id).unwrap(), "v1");
        std::thread::sleep(std::time::Duration::from_millis(3));
        assert_eq!(history_restore(&root, "a.md", &list[1].id).unwrap(), "v1");
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "v1");
        assert_eq!(history_read(&root, "a.md", &history_list(&root, "a.md").unwrap()[0].id).unwrap(), "v3");
        history_moved(&root, "a.md", "dir/b.md");
        assert_eq!(history_list(&root, "dir/b.md").unwrap().len(), 3);
        assert!(history_list(&root, "../x.md").is_err());
    }

    #[test]
    fn project_is_found_by_directory_then_remote() {
        let cfg = tmp("cfg");
        let repo = tmp("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join("src/deep")).unwrap();
        fs::write(repo.join(".git/config"), "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = git@github.com:acme/app.git\n").unwrap();
        fs::write(cfg.join("lang"), "zh").unwrap();
        let p = ensure_project(&cfg, &tmp("v"), &repo.join("src/deep")).unwrap();
        assert_eq!(p.remotes, vec!["github.com/acme/app"]);
        assert!(p.folder.starts_with("项目文档/"));
        assert_eq!(ensure_project(&cfg, &tmp("v"), &repo).unwrap(), p, "second call reuses the binding");
        // 别的目录里的仓库照抄了同一个远程地址：不能因此进到这个项目里
        let clone = tmp("clone");
        fs::create_dir_all(clone.join(".git")).unwrap();
        fs::write(clone.join(".git/config"), "[remote \"origin\"]\n  url = https://github.com/acme/app.git\n").unwrap();
        assert!(find_project(&load_config(&cfg), &clone).is_none());
        assert_ne!(ensure_project(&cfg, &tmp("v"), &clone).unwrap().folder, p.folder);
        folder_moved(&cfg, "项目文档", "文档");
        assert!(load_config(&cfg).projects[0].folder.starts_with("文档/"));
    }

    #[test]
    fn save_supersede_and_reimport() {
        let (root, cfg, repo) = (tmp("vault"), tmp("cfg2"), tmp("repo2"));
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join("docs")).unwrap();
        fs::create_dir_all(repo.join("node_modules/x")).unwrap();
        fs::write(repo.join("docs/plan.md"), "# 计划\n\n第一版\n").unwrap();
        fs::write(repo.join("docs/plan-v2.md"), "# 计划 v2\n\n第二版\n").unwrap();
        fs::write(repo.join("node_modules/x/README.md"), "# x\n").unwrap();
        let p = ensure_project(&cfg, &root, &repo).unwrap();

        let found = scan_repo(&root, Some(&p), &repo);
        assert_eq!(found.iter().map(|f| f.path.as_str()).collect::<Vec<_>>().len(), 2, "{found:?}");
        assert!(found.iter().all(|f| f.state == "new"));

        let items = vec![
            ImportItem { path: "docs/plan-v2.md".into(), title: None, kind: Some("plan".into()), status: None, supersedes: vec!["docs/plan.md".into()] },
            ImportItem { path: "docs/plan.md".into(), title: None, kind: None, status: None, supersedes: vec![] },
        ];
        let docs = import_files(&root, &p, &repo, &items).unwrap();
        assert_eq!(docs.len(), 2);
        let all = list_docs(&root, &p);
        let old = all.iter().find(|d| d.source == "docs/plan.md").unwrap();
        let new = all.iter().find(|d| d.source == "docs/plan-v2.md").unwrap();
        assert_eq!((old.status.as_str(), old.superseded_by.as_str()), ("superseded", new.path.as_str()));
        assert_eq!((new.status.as_str(), new.kind.as_str()), ("current", "plan"));
        assert_eq!(new.supersedes, vec![old.path.clone()]);
        assert!(fs::read_to_string(repo.join("docs/plan.md")).unwrap().starts_with("# 计划"), "repo file untouched");
        assert!(scan_repo(&root, Some(&p), &repo).iter().all(|f| f.state == "same"));

        // 仓库里的文件更新后重新导入：还是同一份文档，旧内容进历史
        fs::write(repo.join("docs/plan-v2.md"), "# 计划 v2\n\n第二版，改过\n").unwrap();
        assert_eq!(scan_repo(&root, Some(&p), &repo).iter().find(|f| f.path == "docs/plan-v2.md").unwrap().state, "changed");
        let again = import_files(&root, &p, &repo, &[ImportItem { path: "docs/plan-v2.md".into(), title: None, kind: None, status: None, supersedes: vec![] }]).unwrap();
        assert_eq!(again[0].path, new.path);
        assert!(again[0].versions >= 2);
        assert_eq!(again[0].kind, "plan", "type survives a re-import");
        assert_eq!(list_docs(&root, &p).len(), 2);

        // 越界的路径一律拒绝
        assert!(import_files(&root, &p, &repo, &[ImportItem { path: "../secret.md".into(), title: None, kind: None, status: None, supersedes: vec![] }]).is_err());
        assert!(read_doc(&root, &p, "别的文件夹/a.md").is_err());
        assert!(set_status(&root, &p, &new.path, "done", None).is_err());
        let d = set_status(&root, &p, &new.path, "archived", None).unwrap();
        assert_eq!(d.status, "archived");
    }

    #[test]
    fn title_is_added_when_content_has_none() {
        let (root, cfg, repo) = (tmp("vault3"), tmp("cfg3"), tmp("repo3"));
        let p = ensure_project(&cfg, &root, &repo).unwrap();
        let d = save_doc(&root, &p, &NewDoc { title: "接口方案".into(), content: "没有标题的正文".into(), ..Default::default() }).unwrap();
        assert_eq!(d.title, "接口方案");
        assert!(d.path.ends_with("/接口方案.md"));
        assert!(save_doc(&root, &p, &NewDoc { title: "接口方案".into(), content: "x".into(), supersedes: vec![d.path.clone()], ..Default::default() }).is_err());
    }

    #[test]
    fn the_library_and_its_parents_cannot_be_a_project() {
        let base = tmp("guard");
        let (root, cfg) = (base.join("home/Documents/Notes"), base.join("home/cfg"));
        fs::create_dir_all(root.join("日记")).unwrap();
        fs::create_dir_all(&cfg).unwrap();
        for dir in [root.clone(), root.join("日记"), base.join("home"), cfg.clone(), PathBuf::from("/")] {
            assert!(check_project_dir(&cfg, &root, &dir).is_err(), "{}", dir.display());
            assert!(ensure_project(&cfg, &root, &dir).is_err(), "{}", dir.display());
        }
        if let Some(home) = dirs::home_dir() {
            assert!(check_project_dir(&cfg, &root, &home).is_err());
        }
        assert!(load_config(&cfg).projects.is_empty(), "nothing was bound");
        let repo = base.join("code/app");
        fs::create_dir_all(&repo).unwrap();
        assert!(check_project_dir(&cfg, &root, &repo).is_ok());
        // `..` 绕回笔记库也不行
        assert!(check_project_dir(&cfg, &root, &repo.join("../../home/Documents/Notes")).is_err());
    }

    #[test]
    fn a_bound_parent_does_not_swallow_repositories_below_it() {
        let (base, cfg, root) = (tmp("nest"), tmp("nestcfg"), tmp("nestvault"));
        let (parent, child) = (base.join("work"), base.join("work/app"));
        fs::create_dir_all(child.join(".git")).unwrap();
        let a = ensure_project(&cfg, &root, &parent).unwrap();
        let b = ensure_project(&cfg, &root, &child).unwrap();
        assert_ne!(a.folder, b.folder);
        assert_eq!(find_project(&load_config(&cfg), &child.join("src")).unwrap().folder, b.folder);
        assert_eq!(find_project(&load_config(&cfg), &parent.join("notes")).unwrap().folder, a.folder);
    }

    #[test]
    fn folder_names_differing_only_by_case_get_separate_folders() {
        let (base, cfg, root) = (tmp("case"), tmp("casecfg"), tmp("casevault"));
        fs::write(cfg.join("lang"), "zh").unwrap();
        fs::create_dir_all(base.join("one/App")).unwrap();
        fs::create_dir_all(base.join("two/app")).unwrap();
        let a = ensure_project(&cfg, &root, &base.join("one/App")).unwrap();
        save_doc(&root, &a, &NewDoc { title: "机密".into(), content: "x".into(), ..Default::default() }).unwrap();
        let b = ensure_project(&cfg, &root, &base.join("two/app")).unwrap();
        assert_ne!(a.folder.to_lowercase(), b.folder.to_lowercase());
        assert!(list_docs(&root, &b).is_empty());
        // 磁盘上已有同名文件夹（别的项目解绑后留下的）也不占用
        unbind(&cfg, &a.folder).unwrap();
        fs::create_dir_all(base.join("three/App")).unwrap();
        let c = ensure_project(&cfg, &root, &base.join("three/App")).unwrap();
        assert!(list_docs(&root, &c).is_empty(), "{}", c.folder);
    }

    #[test]
    fn broken_config_means_no_writes_and_is_not_overwritten() {
        let (cfg, root, repo) = (tmp("brokencfg"), tmp("brokenvault"), tmp("brokenrepo"));
        for bad in ["{\"write\": false, \"projects\": [", "[{\"name\":\"x\"}]", "not json"] {
            fs::write(cfg.join("projects.json"), bad).unwrap();
            let c = load_config(&cfg);
            assert!(!c.write && c.broken, "{bad}");
            assert!(ensure_project(&cfg, &root, &repo).is_err());
            assert_eq!(fs::read_to_string(cfg.join("projects.json")).unwrap(), bad, "left as it was");
        }
        fs::remove_file(cfg.join("projects.json")).unwrap();
        assert!(load_config(&cfg).write, "no file yet is the normal first-run state");
    }

    #[test]
    fn symlinks_are_not_followed() {
        let (root, cfg, repo, outside) = (tmp("symvault"), tmp("symcfg"), tmp("symrepo"), tmp("symout"));
        fs::write(outside.join("secret.md"), "# secret\n").unwrap();
        fs::write(outside.join("env"), "API_KEY=sk-live-1\n").unwrap();
        let p = ensure_project(&cfg, &root, &repo).unwrap();
        let dir = root.join(&p.folder);
        fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.md"), dir.join("link.md")).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("linkdir")).unwrap();
        assert!(list_docs(&root, &p).is_empty(), "links are not listed");
        assert!(read_doc(&root, &p, &format!("{}/link.md", p.folder)).is_err());
        assert!(read_doc(&root, &p, &format!("{}/linkdir/secret.md", p.folder)).is_err());
        assert!(set_status(&root, &p, &format!("{}/link.md", p.folder), "archived", None).is_err());
        assert_eq!(fs::read_to_string(outside.join("secret.md")).unwrap(), "# secret\n", "target untouched");
        // 仓库里的链接：扫描不读，导入拒绝
        std::os::unix::fs::symlink(outside.join("env"), repo.join("env.md")).unwrap();
        assert!(scan_repo(&root, Some(&p), &repo).is_empty());
        assert!(import_files(&root, &p, &repo, &[ImportItem { path: "env.md".into(), title: None, kind: None, status: None, supersedes: vec![] }]).is_err());
    }

    #[test]
    fn import_refuses_hidden_folders_special_files_and_oversized_content() {
        let (root, cfg, repo) = (tmp("limvault"), tmp("limcfg"), tmp("limrepo"));
        let p = ensure_project(&cfg, &root, &repo).unwrap();
        let item = |path: &str| ImportItem { path: path.into(), title: None, kind: None, status: None, supersedes: vec![] };
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join(".trash/1")).unwrap();
        fs::create_dir_all(repo.join(".claude/plans")).unwrap();
        fs::write(repo.join(".trash/1/deleted.md"), "# x").unwrap();
        fs::write(repo.join(".claude/plans/p.md"), "# plan").unwrap();
        assert!(import_files(&root, &p, &repo, &[item(".trash/1/deleted.md")]).is_err());
        assert!(import_files(&root, &p, &repo, &[item(".claude/plans/p.md")]).is_ok());
        // 命名管道：以前会一直卡住
        let fifo = std::ffi::CString::new(repo.join("pipe.md").to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(import_files(&root, &p, &repo, &[item("pipe.md")]).is_err());
        assert!(save_doc(&root, &p, &NewDoc { title: "大".into(), content: "x".repeat(MAX_DOC_BYTES as usize + 1), ..Default::default() }).is_err());
    }

    #[test]
    fn a_handwritten_note_with_the_same_name_is_not_overwritten() {
        let (root, cfg, repo) = (tmp("samevault"), tmp("samecfg"), tmp("samerepo"));
        let p = ensure_project(&cfg, &root, &repo).unwrap();
        fs::create_dir_all(root.join(&p.folder)).unwrap();
        fs::write(root.join(&p.folder).join("方案.md"), "# 方案\n\n我自己写的\n").unwrap();
        let d = save_doc(&root, &p, &NewDoc { title: "方案".into(), content: "# 方案\n\nAI 写的".into(), ..Default::default() }).unwrap();
        assert!(d.path.ends_with("/方案 2.md"), "{}", d.path);
        assert!(fs::read_to_string(root.join(&p.folder).join("方案.md")).unwrap().contains("我自己写的"));
        // 再存一次同样的标题：更新的是它自己那份
        let again = save_doc(&root, &p, &NewDoc { title: "方案".into(), content: "# 方案\n\nAI 改过".into(), ..Default::default() }).unwrap();
        assert_eq!(again.path, d.path);
        // 两个不同来源、标题相同的文件各存各的
        let a = save_doc(&root, &p, &NewDoc { title: "计划".into(), content: "a".into(), source: Some("docs/a.md".into()), ..Default::default() }).unwrap();
        let b = save_doc(&root, &p, &NewDoc { title: "计划".into(), content: "b".into(), source: Some("docs/b.md".into()), ..Default::default() }).unwrap();
        assert_ne!(a.path, b.path);
    }

    #[test]
    fn values_cannot_inject_front_matter_and_foreign_yaml_is_kept() {
        let (root, cfg, repo) = (tmp("injvault"), tmp("injcfg"), tmp("injrepo"));
        let p = ensure_project(&cfg, &root, &repo).unwrap();
        let d = save_doc(&root, &p, &NewDoc { title: "t".into(), content: "正文".into(), kind: Some("plan\nstatus: archived\n---\n# injected".into()), ..Default::default() }).unwrap();
        assert_eq!(d.status, "current");
        let md = fs::read_to_string(root.join(&d.path)).unwrap();
        assert_eq!(md.matches("\n---\n").count(), 1, "{md}");
        // 别的工具写的多行头部：改状态时原样保留，不会再叠一层
        let rel = format!("{}/yaml.md", p.folder);
        fs::write(root.join(&rel), "---\ntitle: x\ntags:\n  - a\n  - b\n# note\n---\n\n正文\n").unwrap();
        set_status(&root, &p, &rel, "archived", None).unwrap();
        let md = fs::read_to_string(root.join(&rel)).unwrap();
        assert!(md.starts_with("---\ntitle: x\ntags:\n  - a\n  - b\n# note\nstatus: archived\n---\n\n正文"), "{md}");
        assert_eq!(get(&md, "status").as_deref(), Some("archived"));
    }

    #[test]
    fn history_follows_rename_and_trash() {
        let root = tmp("histmove");
        fs::write(root.join("a.md"), "a1").unwrap();
        fs::write(root.join("b.md"), "b1").unwrap();
        snapshot(&root, "a.md", "a0", 0).unwrap();
        snapshot(&root, "b.md", "b0", 0).unwrap();
        // b 被删后 a 改名成 b：a 的历史跟过去，b 留下的旧历史不混进来
        history_moved(&root, "a.md", "b.md");
        let h = history_list(&root, "b.md").unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(history_read(&root, "b.md", &h[0].id).unwrap(), "a0");
        let entry = root.join(".trash/1");
        fs::create_dir_all(&entry).unwrap();
        history_to_trash(&root, "b.md", &entry);
        assert!(history_list(&root, "b.md").unwrap().is_empty(), "a new note at this path starts clean");
        history_from_trash(&root, &entry, "c.md");
        assert_eq!(history_list(&root, "c.md").unwrap().len(), 1);
        history_purge(&root, "c.md");
        assert!(history_list(&root, "c.md").unwrap().is_empty());
        // 时间被调到过去：以前会让节流一直挡着
        fs::create_dir_all(root.join(".history/d.md")).unwrap();
        fs::write(root.join(".history/d.md/99999999999999999.md"), "future").unwrap();
        assert!(snapshot(&root, "d.md", "now", SNAPSHOT_GAP_MS).unwrap());
    }
}
