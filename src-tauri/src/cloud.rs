//! 每篇笔记同步到哪里：默认跟着笔记库同步到 Google Drive；标成「仅本机」的不上传，云端已有的副本下次同步时移除。
//! 这个设置只存在本机（应用数据目录），不随笔记同步。

use std::{collections::BTreeSet, fs, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager};

static CACHE: Mutex<Option<BTreeSet<String>>> = Mutex::new(None);

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("local-only.json"))
}

pub fn local_only(app: &AppHandle) -> BTreeSet<String> {
    let mut c = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if c.is_none() {
        *c = Some(file(app).and_then(|f| fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default());
    }
    c.clone().unwrap_or_default()
}

fn save(app: &AppHandle, set: BTreeSet<String>) -> Result<(), String> {
    let f = file(app).ok_or("找不到应用数据目录")?;
    if let Some(d) = f.parent() {
        let _ = fs::create_dir_all(d);
    }
    fs::write(&f, serde_json::to_vec(&set).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some(set);
    Ok(())
}

/// 路径本身或它所在的文件夹被标成仅本机
pub fn is_local_only(set: &BTreeSet<String>, path: &str) -> bool {
    set.iter().any(|p| path == p || path.starts_with(&format!("{p}/")))
}

/// 笔记或文件夹改名时，仅本机标记跟着走
pub fn renamed(app: &AppHandle, from: &str, to: &str) {
    let set = local_only(app);
    if !set.iter().any(|p| p == from || p.starts_with(&format!("{from}/"))) {
        return;
    }
    let next = set
        .into_iter()
        .map(|p| if p == from { to.to_string() } else if let Some(rest) = p.strip_prefix(&format!("{from}/")) { format!("{to}/{rest}") } else { p })
        .collect();
    let _ = save(app, next);
}

#[tauri::command]
pub async fn cloud_local_only(app: AppHandle) -> Vec<String> {
    local_only(&app).into_iter().collect()
}

#[tauri::command]
pub async fn cloud_set_local_only(app: AppHandle, path: String, local: bool) -> Result<(), String> {
    let mut set = local_only(&app);
    if local {
        set.insert(path);
    } else {
        set.remove(&path);
    }
    save(&app, set)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn folder_covers_children() {
        let s: BTreeSet<String> = ["私密".to_string(), "a.md".to_string()].into();
        assert!(is_local_only(&s, "私密/x.md"));
        assert!(is_local_only(&s, "a.md"));
        assert!(!is_local_only(&s, "私密2/x.md"));
        assert!(!is_local_only(&s, "b.md"));
    }
}

#[derive(serde::Serialize)]
pub struct RootInfo {
    pub path: String,
    /// 笔记库在 iCloud Drive 里（包括开启了「桌面与文稿」同步的 Documents / Desktop）
    pub icloud: bool,
}

#[tauri::command]
pub async fn cloud_root_info(app: AppHandle) -> Result<RootInfo, String> {
    let root = crate::vault::root(&app)?;
    let path = root.to_string_lossy().to_string();
    let home = std::env::var("HOME").unwrap_or_default();
    let cloud_docs = format!("{home}/Library/Mobile Documents/com~apple~CloudDocs");
    let in_mobile = path.starts_with(&format!("{home}/Library/Mobile Documents/"));
    // 「桌面与文稿」开了 iCloud 同步时，云盘里会有 Documents / Desktop 目录
    let synced_home_dir = ["Documents", "Desktop"].iter().any(|d| {
        path.starts_with(&format!("{home}/{d}")) && std::path::Path::new(&format!("{cloud_docs}/{d}")).exists()
    });
    Ok(RootInfo { path, icloud: in_mobile || synced_home_dir })
}
