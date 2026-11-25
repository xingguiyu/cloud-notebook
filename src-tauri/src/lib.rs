mod ai;
mod export;
mod google;
pub mod i18n;
mod guide;
mod imagehost;
mod kdf;
mod index;
mod keysync;
mod ocr;
mod certinfo;
mod cloud;
pub mod docs;
mod docs_cmd;
pub mod mcp;
mod pdf;
mod safe;
mod secrets;
mod vault;

#[cfg(desktop)]
use tauri::Emitter;
use tauri::Manager;
#[cfg(desktop)]
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

/// 原生菜单栏：菜单点击通过 `menu` 事件转给前端处理
#[cfg(desktop)]
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let new_note = MenuItem::with_id(app, "new-note", &i18n::tr("新建笔记"), true, Some("CmdOrCtrl+N"))?;
    let new_folder = MenuItem::with_id(
        app,
        "new-folder",
        &i18n::tr("新建文件夹"),
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let export_md = MenuItem::with_id(
        app,
        "export-md",
        &i18n::tr("Markdown 文件夹（含图片）…"),
        true,
        None::<&str>,
    )?;
    let export_zip = MenuItem::with_id(
        app,
        "export-zip",
        &i18n::tr("Markdown 压缩包（含图片）…"),
        true,
        None::<&str>,
    )?;
    let export_inline = MenuItem::with_id(
        app,
        "export-inline",
        &i18n::tr("Markdown 单文件（图片内嵌）…"),
        true,
        None::<&str>,
    )?;
    let export_html = MenuItem::with_id(app, "export-html", "HTML…", true, None::<&str>)?;
    let export_pdf = MenuItem::with_id(app, "export-pdf", "PDF…", true, None::<&str>)?;
    let export_sheet = MenuItem::with_id(
        app,
        "export-sheet",
        &i18n::tr("导出…"),
        true,
        Some("Shift+CmdOrCtrl+E"),
    )?;
    let print = MenuItem::with_id(app, "print", &i18n::tr("打印…"), true, Some("CmdOrCtrl+P"))?;
    let export_docx = MenuItem::with_id(app, "export-docx", "Word…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", &i18n::tr("设置…"), true, Some("CmdOrCtrl+,"))?;
    let copy_hosted = MenuItem::with_id(
        app,
        "copy-hosted",
        &i18n::tr("复制为 Markdown（图床链接）"),
        true,
        Some("Shift+CmdOrCtrl+C"),
    )?;
    let search = MenuItem::with_id(app, "search", &i18n::tr("搜索全部笔记"), true, Some("Shift+CmdOrCtrl+F"))?;
    let find = MenuItem::with_id(app, "find", &i18n::tr("在笔记中查找…"), true, Some("CmdOrCtrl+F"))?;
    let replace = MenuItem::with_id(app, "replace", &i18n::tr("查找并替换…"), true, Some("Alt+CmdOrCtrl+F"))?;
    let toggle_source = MenuItem::with_id(
        app,
        "toggle-source",
        &i18n::tr("切换源码模式"),
        true,
        Some("CmdOrCtrl+/"),
    )?;
    let toggle_sidebar = MenuItem::with_id(
        app,
        "toggle-sidebar",
        &i18n::tr("显示/隐藏侧边栏"),
        true,
        Some("CmdOrCtrl+\\"),
    )?;
    let toggle_list = MenuItem::with_id(
        app,
        "toggle-list",
        &i18n::tr("显示/隐藏笔记列表"),
        true,
        Some("Alt+CmdOrCtrl+\\"),
    )?;
    let lock_now = MenuItem::with_id(
        app,
        "lock-now",
        &i18n::tr("锁定加密笔记"),
        true,
        Some("Alt+CmdOrCtrl+L"),
    )?;
    let ask_ai = MenuItem::with_id(app, "ask-ai", &i18n::tr("问 AI"), true, Some("CmdOrCtrl+J"))?;
    let toggle_info = MenuItem::with_id(
        app,
        "toggle-info",
        &i18n::tr("笔记信息"),
        true,
        Some("Shift+CmdOrCtrl+I"),
    )?;
    let focus_mode = MenuItem::with_id(
        app,
        "focus-mode",
        &i18n::tr("专注模式"),
        true,
        Some("Shift+CmdOrCtrl+\\"),
    )?;
    // 编辑区缩放（⌘0 已经是「正文」，恢复用 ⌥⌘0）
    let zoom_in = MenuItem::with_id(app, "zoom-in", &i18n::tr("放大"), true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, "zoom-out", &i18n::tr("缩小"), true, Some("CmdOrCtrl+-"))?;
    let zoom_reset = MenuItem::with_id(app, "zoom-reset", &i18n::tr("实际大小"), true, Some("Alt+CmdOrCtrl+0"))?;
    // 格式：⌘1–⌘6 设标题级别，⌘0 转回正文
    let headings = (0..=6)
        .map(|l| {
            let text = if l == 0 { i18n::tr("正文") } else { i18n::heading(l) };
            MenuItem::with_id(
                app,
                format!("heading-{l}"),
                text,
                true,
                Some(format!("CmdOrCtrl+{l}").as_str()),
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let heading_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = headings
        .iter()
        .skip(1)
        .chain(headings.iter().take(1))
        .map(|m| m as _)
        .collect();

    Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "Cloud Notebook",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
                    &MenuItem::with_id(app, "check-update", &i18n::tr("检查更新…"), true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &settings,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                &i18n::tr("文件"),
                true,
                &[
                    &new_note,
                    &new_folder,
                    &PredefinedMenuItem::separator(app)?,
                    &lock_now,
                    &PredefinedMenuItem::separator(app)?,
                    &export_sheet,
                    &Submenu::with_items(
                        app,
                        &i18n::tr("导出为"),
                        true,
                        &[
                            &export_md,
                            &export_zip,
                            &export_inline,
                            &PredefinedMenuItem::separator(app)?,
                            &export_html,
                            &export_pdf,
                            &export_docx,
                        ],
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &print,
                ],
            )?,
            &Submenu::with_items(
                app,
                &i18n::tr("编辑"),
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &copy_hosted,
                    &PredefinedMenuItem::separator(app)?,
                    &find,
                    &replace,
                    &search,
                ],
            )?,
            &Submenu::with_items(app, &i18n::tr("格式"), true, &heading_refs)?,
            &Submenu::with_items(
                app,
                &i18n::tr("视图"),
                true,
                &[
                    &toggle_sidebar,
                    &toggle_list,
                    &focus_mode,
                    &PredefinedMenuItem::separator(app)?,
                    &zoom_in,
                    &zoom_out,
                    &zoom_reset,
                    &PredefinedMenuItem::separator(app)?,
                    &ask_ai,
                    &toggle_info,
                    &toggle_source,
                ],
            )?,
            &Submenu::with_items(
                app,
                &i18n::tr("窗口"),
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                &i18n::tr("帮助"),
                true,
                &[
                    &MenuItem::with_id(app, "guide", &i18n::tr("使用指南"), true, None::<&str>)?,
                    &MenuItem::with_id(app, "whats-new", &i18n::tr("这个版本的更新内容"), true, None::<&str>)?,
                ],
            )?,
        ],
    )
}

/// 前端告诉原生部分用哪种语言（`system` / `zh` / `en`）；语言变了就重建菜单栏
/// 这是个 async 命令：不带 async 的命令在主线程上跑，而换指南要读写十几个文件（笔记库在 iCloud 里时可能很慢），
/// 主线程一被占住，整个窗口就卡死了。菜单必须在主线程上改，单独派过去。
#[tauri::command]
async fn set_language(app: tauri::AppHandle, choice: String) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    if i18n::choose(&dir, &choice) {
        #[cfg(desktop)]
        {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Ok(menu) = build_menu(&handle) {
                    let _ = handle.set_menu(menu);
                }
            });
            // 没改过的使用指南跟着换成新语言的
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if let Ok(root) = vault::root(&app) {
                    let _ = guide::switch_to(&root, i18n::current(), true);
                }
            })
            .await;
        }
    }
    Ok(())
}

/// 复制密钥这类敏感内容：30 秒后如果剪贴板里还是它，就清掉。
/// 读剪贴板在这里做，界面那边没有读剪贴板的权限（也不该有）。
#[tauri::command]
fn copy_secret(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text.clone()).map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(30));
        if app.clipboard().read_text().is_ok_and(|now| now == text) {
            let _ = app.clipboard().clear();
        }
    });
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 前端运行时错误转发到终端（开发时排查白屏用）
#[tauri::command]
fn js_error(message: String) {
    eprintln!("[前端错误] {message}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(google::GoogleState::default())
        .manage(pdf::PdfState::default())
        .manage(ai::ChatState::default())
        .register_uri_scheme_protocol("cnexport", |ctx, _req| pdf::serve(ctx.app_handle()))
        // 笔记图片：在后台线程读（iCloud 只留在云端的图片要先下载），不能卡住主线程，否则所有请求都排队等它
        .register_asynchronous_uri_scheme_protocol("vault", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            let path = req.uri().path().to_string();
            std::thread::spawn(move || responder.respond(vault::serve(&app, &path)));
        })
        .setup(|app| {
            #[cfg(desktop)]
            app.on_menu_event(|app, event| {
                let _ = app.emit("menu", event.id().0.as_str());
            });
            if let Ok(dir) = app.path().app_config_dir() {
                i18n::init(&dir);
            }
            keysync::init(app.handle());
            index::init(app.handle());
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            #[cfg(desktop)]
            app.set_menu(build_menu(app.handle())?)?;
            if let Err(e) = vault::watch(app.handle()) {
                log::warn!("笔记库监听启动失败: {e}");
            }
            // 开发自测：CN_PDF_TEST=输出路径 时只导出一份样例 PDF 然后退出，不显示窗口
            #[cfg(debug_assertions)]
            if let Ok(out) = std::env::var("CN_PDF_TEST") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let html = std::env::var("CN_PDF_HTML")
                        .ok()
                        .and_then(|p| std::fs::read_to_string(p).ok())
                        .unwrap_or_else(|| "<h1>测试</h1><p>Hello PDF</p>".into());
                    let r = pdf::export_pdf(handle.clone(), html, out, "a4".into(), 48.0).await;
                    println!("CN_PDF_TEST_RESULT {r:?}");
                    handle.exit(0);
                });
                return Ok(());
            }
            // 窗口默认隐藏，由前端首帧渲染后显示；前端出错时这里兜底，保证窗口一定出来
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                show_main(&handle);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            js_error,
            keysync::keysync_run,
            keysync::keysync_exists,
            vault::vault_tree,
            vault::vault_read,
            vault::vault_read_many,
            index::index_snapshot,
            index::index_search,
            ocr::ocr_image,
            certinfo::cert_inspect,
            cloud::cloud_local_only,
            cloud::cloud_set_local_only,
            cloud::cloud_root_info,
            safe::safe_status,
            safe::safe_setup,
            safe::safe_unlock,
            safe::safe_recover,
            safe::safe_change_password,
            safe::safe_new_recovery,
            safe::safe_lock,
            safe::safe_set_biometric,
            safe::safe_unlock_biometric,
            safe::safe_list,
            safe::safe_save,
            safe::safe_delete,
            safe::safe_attach,
            safe::safe_file,
            safe::safe_export_file,
            safe::safe_remove_file,
            safe::safe_read_dropped,
            vault::vault_write,
            vault::vault_mkdir,
            vault::vault_rename,
            guide::guide_install,
            set_language,
            copy_secret,
            docs_cmd::docs_info,
            docs_cmd::docs_bind,
            docs_cmd::docs_unbind,
            docs_cmd::docs_set_write,
            docs_cmd::history_list,
            docs_cmd::history_read,
            docs_cmd::history_restore,
            vault::vault_trash,
            vault::vault_trash_list,
            vault::vault_restore,
            vault::vault_delete_forever,
            vault::vault_empty_trash,
            vault::vault_save_image,
            vault::vault_import_image,
            vault::vault_info,
            vault::vault_set_root,
            export::export_write,
            export::export_docx,
            export::export_bundle,
            pdf::export_pdf,
            kdf::kdf_argon2id,
            ai::ai_key_status,
            ai::ai_set_provider_key,
            ai::ai_clear_provider_key,
            ai::ai_get_key,
            ai::ai_list_models,
            ai::ai_chat_start,
            ai::ai_chat_cancel,
            ai::ai_read_attachment,
            pdf::print_document,
            imagehost::imagehost_status,
            imagehost::imagehost_save,
            imagehost::imagehost_clear,
            imagehost::imagehost_upload,
            imagehost::imagehost_test,
            google::auth::google_status,
            google::auth::google_set_config,
            google::auth::google_client_config,
            google::auth::google_ios_client,
            google::auth::google_set_ios_client,
            google::auth::google_oauth_callback,
            google::auth::google_set_auto_sync,
            google::auth::google_login,
            google::auth::google_logout,
            google::sync::google_sync,
            google::sync::google_last_sync,
            google::docs::google_publish_doc,
            google::docs::google_docs_list,
            google::docs::google_doc_set_two_way,
            google::docs::google_doc_move,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 点击 Dock 图标时重新显示窗口
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
            let _ = (app, event);
        });
}
