//! 导出：Markdown / HTML 由前端生成内容后写盘，PDF 走系统打印面板，Word 交给 Pandoc。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;

/// 写到用户在保存对话框里选的位置
#[tauri::command]
pub async fn export_write(path: String, content: String) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())
}

/// Pandoc 常见安装位置；从 Dock 启动的应用拿不到 shell 的 PATH
fn pandoc() -> Option<PathBuf> {
    [
        "/opt/homebrew/bin/pandoc",
        "/usr/local/bin/pandoc",
        "/usr/bin/pandoc",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.exists())
    .or_else(|| {
        Command::new("which")
            .arg("pandoc")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
    })
}

/// 用 Pandoc 转 Word；图片按笔记所在目录解析相对路径
#[tauri::command]
pub async fn export_docx(
    app: AppHandle,
    note: String,
    markdown: String,
    path: String,
) -> Result<(), String> {
    let bin = pandoc().ok_or("没有找到 Pandoc，请先安装：brew install pandoc")?;
    let note_dir = crate::vault::root(&app)?.join(note.rsplit_once('/').map_or("", |(d, _)| d));
    let tmp = std::env::temp_dir().join(format!("cloud-notebook-export-{}.md", std::process::id()));
    fs::write(&tmp, markdown).map_err(|e| e.to_string())?;
    let out = Command::new(bin)
        .arg(&tmp)
        .args(["-f", "gfm", "-o", &path, "--resource-path"])
        .arg(&note_dir)
        .output()
        .map_err(|e| e.to_string());
    let _ = fs::remove_file(&tmp);
    let out = out?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into());
    }
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct BundleFile {
    /// 笔记库里的相对路径
    src: String,
    /// 导出包里的文件名（放在 assets/ 下）
    name: String,
}

/// 导出 Markdown 和它引用的本地图片。
/// `zip` 为假时 `out` 是要创建的文件夹，为真时是 .zip 文件；里面都是 `<名称>.md` + `assets/`。
#[tauri::command]
pub async fn export_bundle(
    app: AppHandle,
    markdown: String,
    md_name: String,
    files: Vec<BundleFile>,
    out: String,
    zip: bool,
) -> Result<(), String> {
    write_bundle(
        &crate::vault::root(&app)?,
        &markdown,
        &md_name,
        &files,
        &out,
        zip,
    )
}

fn write_bundle(
    root: &std::path::Path,
    markdown: &str,
    md_name: &str,
    files: &[BundleFile],
    out: &str,
    zip: bool,
) -> Result<(), String> {
    let read = |f: &BundleFile| -> Result<Vec<u8>, String> {
        let p = root.join(&f.src);
        // 只允许读笔记库里的文件
        let canon = p.canonicalize().map_err(|e| format!("{}：{e}", f.src))?;
        if !canon.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
            return Err("非法图片路径".into());
        }
        fs::read(canon).map_err(|e| e.to_string())
    };
    if zip {
        use std::io::Write;
        let file = fs::File::create(&out).map_err(|e| e.to_string())?;
        let mut w = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        w.start_file(format!("{md_name}.md"), opts)
            .map_err(|e| e.to_string())?;
        w.write_all(markdown.as_bytes())
            .map_err(|e| e.to_string())?;
        for f in files {
            // 图片本身已是压缩格式，存储即可
            let stored = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            w.start_file(format!("assets/{}", f.name), stored)
                .map_err(|e| e.to_string())?;
            w.write_all(&read(f)?).map_err(|e| e.to_string())?;
        }
        w.finish().map_err(|e| e.to_string())?;
    } else {
        let dir = PathBuf::from(&out);
        if dir.exists() {
            return Err(format!("{} 已存在", dir.display()));
        }
        fs::create_dir_all(dir.join("assets")).map_err(|e| e.to_string())?;
        // 文件名只取最后一段：带 `../` 或绝对路径的名字不能写到导出文件夹外面
        let leaf = |n: &str| Path::new(n).file_name().map(|x| x.to_string_lossy().to_string()).filter(|x| !x.is_empty() && x != "..").unwrap_or_else(|| "file".into());
        fs::write(dir.join(format!("{}.md", leaf(md_name))), markdown).map_err(|e| e.to_string())?;
        for f in files {
            fs::write(dir.join("assets").join(leaf(&f.name)), read(f)?).map_err(|e| e.to_string())?;
        }
        if files.is_empty() {
            let _ = fs::remove_dir(dir.join("assets"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "cn-export-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        let root = base.join("vault");
        fs::create_dir_all(root.join("工作/assets")).unwrap();
        fs::write(root.join("工作/assets/1.png"), b"PNGDATA").unwrap();
        (base, root)
    }

    #[test]
    fn exports_folder_with_assets() {
        let (base, root) = setup();
        let out = base.join("周会");
        let files = vec![BundleFile {
            src: "工作/assets/1.png".into(),
            name: "1.png".into(),
        }];
        write_bundle(
            &root,
            "![a](assets/1.png)",
            "周会",
            &files,
            out.to_str().unwrap(),
            false,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(out.join("周会.md")).unwrap(),
            "![a](assets/1.png)"
        );
        assert_eq!(fs::read(out.join("assets/1.png")).unwrap(), b"PNGDATA");
    }

    #[test]
    fn exports_zip_with_assets() {
        let (base, root) = setup();
        let out = base.join("周会.zip");
        let files = vec![BundleFile {
            src: "工作/assets/1.png".into(),
            name: "1.png".into(),
        }];
        write_bundle(&root, "x", "周会", &files, out.to_str().unwrap(), true).unwrap();
        let mut z = zip::ZipArchive::new(fs::File::open(&out).unwrap()).unwrap();
        let names: Vec<String> = (0..z.len())
            .map(|i| z.by_index(i).unwrap().name().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["周会.md", "assets/1.png"]);
    }

    #[test]
    fn refuses_files_outside_vault() {
        let (base, root) = setup();
        fs::write(base.join("secret.txt"), "x").unwrap();
        let files = vec![BundleFile {
            src: "../secret.txt".into(),
            name: "s.txt".into(),
        }];
        assert!(
            write_bundle(
                &root,
                "x",
                "n",
                &files,
                base.join("o").to_str().unwrap(),
                false
            )
            .is_err()
        );
    }
}
