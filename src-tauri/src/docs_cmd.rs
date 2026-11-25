//! 项目文档和版本历史给界面用的命令，逻辑在 `docs` 里。

use crate::docs::{self, Project, Version};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn config(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct DocsInfo {
    write: bool,
    projects: Vec<Project>,
    /// 启动 MCP 服务的可执行文件路径
    exe: String,
}

#[tauri::command]
pub fn docs_info(app: AppHandle) -> Result<DocsInfo, String> {
    let c = docs::load_config(&config(&app)?);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(DocsInfo { write: c.write, projects: c.projects, exe: exe.to_string_lossy().to_string() })
}

#[tauri::command]
pub fn docs_bind(app: AppHandle, folder: String, dir: String) -> Result<Project, String> {
    let d = Path::new(&dir);
    if !d.is_dir() {
        return Err("目录不存在".into());
    }
    docs::bind(&config(&app)?, &crate::vault::root(&app)?, &folder, d)
}

#[tauri::command]
pub fn docs_unbind(app: AppHandle, folder: String) -> Result<(), String> {
    docs::unbind(&config(&app)?, &folder)
}

#[tauri::command]
pub fn docs_set_write(app: AppHandle, allow: bool) -> Result<(), String> {
    let dir = config(&app)?;
    let mut c = docs::load_config(&dir);
    c.write = allow;
    docs::save_config(&dir, &c)
}

#[tauri::command]
pub async fn history_list(app: AppHandle, path: String) -> Result<Vec<Version>, String> {
    docs::history_list(&crate::vault::root(&app)?, &path)
}

#[tauri::command]
pub async fn history_read(app: AppHandle, path: String, id: String) -> Result<String, String> {
    docs::history_read(&crate::vault::root(&app)?, &path, &id)
}

/// 恢复到某个版本，返回恢复后的内容
#[tauri::command]
pub async fn history_restore(app: AppHandle, path: String, id: String) -> Result<String, String> {
    let root = crate::vault::root(&app)?;
    let content = docs::history_restore(&root, &path, &id)?;
    crate::index::save_notes(&root.to_string_lossy(), &[(path.clone(), crate::vault::mtime(&root.join(&path)), content.clone())]);
    Ok(content)
}

/// 笔记或文件夹改了路径：快照和项目绑定跟着改
pub fn moved(app: &AppHandle, from: &str, to: &str) {
    if let Ok(root) = crate::vault::root(app) {
        docs::history_moved(&root, from, to);
    }
    if let Ok(c) = config(app) {
        docs::folder_moved(&c, from, to);
    }
}
