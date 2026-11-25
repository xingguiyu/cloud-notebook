//! 直接导出 PDF（不弹打印面板）。
//!
//! 后台开一个隐藏的 WebView 加载排版好的 HTML，再用 macOS 的 NSPrintOperation
//! 以「存储为文件」方式输出。得到的是分页的矢量 PDF：文字可选中、可搜索，CSS 的 @page 和分页规则生效。

use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 正在导出的文档，由 `cnexport://` 协议提供给隐藏 WebView
#[derive(Default)]
pub struct PdfState {
    pub html: Mutex<String>,
}

pub fn serve(app: &AppHandle) -> tauri::http::Response<Vec<u8>> {
    let html = app.state::<PdfState>().html.lock().unwrap().clone();
    tauri::http::Response::builder()
        .header("Content-Type", "text/html; charset=utf-8")
        // 导出用的页面只有文字、样式和图片，不需要脚本
        .header("Content-Security-Policy", "default-src 'none'; img-src data: blob: https: http: vault: http://vault.localhost; style-src 'unsafe-inline'; font-src data:")
        .body(html.into_bytes())
        .unwrap()
}

/// 纸张尺寸（pt）
fn paper(size: &str) -> (f64, f64) {
    match size {
        "letter" => (612.0, 792.0),
        "a5" => (419.53, 595.28),
        _ => (595.28, 841.89), // A4
    }
}

/// 加载排版页面到一个隐藏 WebView，返回窗口
async fn load_hidden(
    app: &AppHandle,
    html: String,
    label: &str,
    paper_size: &str,
) -> Result<tauri::WebviewWindow, String> {
    *app.state::<PdfState>().html.lock().unwrap() = html;
    if let Some(old) = app.get_webview_window(label) {
        let _ = old.close();
    }
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let tx = Mutex::new(Some(tx));
    let url = "cnexport://localhost/doc"
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;
    let win = WebviewWindowBuilder::new(app, label, WebviewUrl::CustomProtocol(url))
        .visible(false)
        .inner_size(paper(paper_size).0, paper(paper_size).1)
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        })
        .build()
        .map_err(|e| e.to_string())?;

    let loaded =
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(20)))
            .await
            .map_err(|e| e.to_string())?;
    if loaded.is_err() {
        let _ = win.close();
        return Err("排版页面加载超时".into());
    }
    // 给字体和内嵌图片一点解码时间
    tokio_sleep(Duration::from_millis(400)).await;
    Ok(win)
}

#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    html: String,
    path: String,
    paper_size: String,
    margin: f64,
) -> Result<(), String> {
    let label = format!("pdf-export-{}", rand::random::<u32>());
    let win = load_hidden(&app, html, &label, &paper_size).await?;

    let (done_tx, done_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let out = path.clone();
    win.with_webview(move |wv| {
        let _ = done_tx.send(print_to_pdf(wv, &out, paper(&paper_size), margin));
    })
    .map_err(|e| e.to_string())?;
    let started =
        tauri::async_runtime::spawn_blocking(move || done_rx.recv_timeout(Duration::from_secs(10)))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|_| "启动 PDF 导出超时".to_string());
    if let Err(e) = started.and_then(|r| r) {
        let _ = win.close();
        return Err(e);
    }
    // 打印是异步写文件的：等文件出现且大小稳定下来
    let p = path.clone();
    let waited = tauri::async_runtime::spawn_blocking(move || wait_for_file(&p))
        .await
        .map_err(|e| e.to_string())?;
    let _ = win.close();
    waited
}

/// 文件大小连续 1 秒不变视为写完；超过 60 秒或异常增大视为失败
fn wait_for_file(path: &str) -> Result<(), String> {
    let start = std::time::Instant::now();
    let mut last = 0u64;
    let mut stable_since = std::time::Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(200));
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if size > 200 * 1024 * 1024 {
            let _ = std::fs::remove_file(path);
            return Err("PDF 生成异常（文件过大），已中止".into());
        }
        if size != last {
            last = size;
            stable_since = std::time::Instant::now();
        } else if size > 0 && stable_since.elapsed() > Duration::from_secs(1) {
            return Ok(());
        }
        if start.elapsed() > Duration::from_secs(60) {
            return Err("生成 PDF 超时".into());
        }
    }
}

/// 打印：弹出系统打印面板（作为主窗口的表单），内容是导出模板排好的版。
/// 隐藏 WebView 要活到打印结束；下次打印时再关掉旧的。
#[tauri::command]
pub async fn print_document(
    app: AppHandle,
    html: String,
    paper_size: String,
    margin: f64,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, html, paper_size, margin);
        return Err("这个平台暂不支持打印".into());
    }
    #[cfg(target_os = "macos")]
    {
        let win = load_hidden(&app, html, "print-job", &paper_size).await?;
        let main = app.get_webview_window("main").ok_or("找不到主窗口")?;
        let main_ns = main.ns_window().map_err(|e| e.to_string())? as usize;
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        win.with_webview(move |wv| {
            let _ = tx.send(show_print_panel(wv, main_ns, paper(&paper_size), margin));
        })
        .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(10)))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|_| "打开打印面板超时".to_string())?
    }
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

#[cfg(target_os = "macos")]
fn print_to_pdf(
    wv: tauri::webview::PlatformWebview,
    path: &str,
    (w, h): (f64, f64),
    margin: f64,
) -> Result<(), String> {
    use objc2_app_kit::{
        NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob, NSPrintingPaginationMode,
    };
    use objc2_foundation::{NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;

    unsafe {
        let webview: &WKWebView = &*(wv.inner() as *const WKWebView);
        let info = NSPrintInfo::new();
        info.setPaperSize(NSSize::new(w, h));
        info.setTopMargin(margin);
        info.setBottomMargin(margin);
        info.setLeftMargin(margin);
        info.setRightMargin(margin);
        info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
        info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
        info.setHorizontallyCentered(false);
        info.setVerticallyCentered(false);
        info.setJobDisposition(NSPrintSaveJob);
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        info.dictionary().insert(NSPrintJobSavingURL, &*url);

        let op = webview.printOperationWithPrintInfo(&info);
        op.setShowsPrintPanel(false);
        op.setShowsProgressPanel(false);
        // 同步的 runOperation 在 WKWebView 上会无限分页，必须用挂在窗口上的异步方式
        let window: &objc2_app_kit::NSWindow = &*(wv.ns_window() as *const objc2_app_kit::NSWindow);
        op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            window,
            None,
            None,
            std::ptr::null_mut(),
        );
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn show_print_panel(
    wv: tauri::webview::PlatformWebview,
    main_window: usize,
    (w, h): (f64, f64),
    margin: f64,
) -> Result<(), String> {
    use objc2_app_kit::{NSPrintInfo, NSPrintingPaginationMode, NSWindow};
    use objc2_foundation::NSSize;
    use objc2_web_kit::WKWebView;

    unsafe {
        let webview: &WKWebView = &*(wv.inner() as *const WKWebView);
        let info = NSPrintInfo::new();
        info.setPaperSize(NSSize::new(w, h));
        info.setTopMargin(margin);
        info.setBottomMargin(margin);
        info.setLeftMargin(margin);
        info.setRightMargin(margin);
        info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
        info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
        info.setHorizontallyCentered(false);
        info.setVerticallyCentered(false);
        let op = webview.printOperationWithPrintInfo(&info);
        op.setShowsPrintPanel(true);
        op.setShowsProgressPanel(true);
        let window: &NSWindow = &*(main_window as *const NSWindow);
        op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            window,
            None,
            None,
            std::ptr::null_mut(),
        );
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
fn show_print_panel(
    _: tauri::webview::PlatformWebview,
    _: usize,
    _: (f64, f64),
    _: f64,
) -> Result<(), String> {
    Err("当前平台暂不支持打印".into())
}

#[cfg(not(target_os = "macos"))]
fn print_to_pdf(
    _: tauri::webview::PlatformWebview,
    _: &str,
    _: (f64, f64),
    _: f64,
) -> Result<(), String> {
    Err("当前平台暂不支持直接导出 PDF，请使用打印并选择「另存为 PDF」".into())
}
