//! 本地文字识别：用系统自带的 Vision 框架（和「实况文本」同一个引擎），图片不出本机。

use serde::Serialize;

#[derive(Serialize, Debug)]
pub struct Line {
    pub text: String,
    /// 归一化坐标，原点在左上角（0~1）
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 识别图片里的文字，按从上到下、从左到右排好。原始图片字节走请求体。
#[tauri::command]
pub async fn ocr_image(request: tauri::ipc::Request<'_>) -> Result<Vec<Line>, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("需要原始图片数据".into());
    };
    let bytes = bytes.clone();
    // x-latin: 只认拉丁字母、不做语言校正——护照底部机读码（MRZ）这样识别更准
    let latin = request.headers().get("x-latin").is_some();
    tauri::async_runtime::spawn_blocking(move || recognize(&bytes, latin))
        .await
        .map_err(|e| e.to_string())?
}

/// 识别一次只跑一个：预热还在加载模型时来了真正的识别，排队等它，而不是两个同时冷启动互相卡住
static OCR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn recognize(bytes: &[u8], latin: bool) -> Result<Vec<Line>, String> {
    let _g = OCR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Vision 偶尔报 CRImageReaderError（引擎忙或模型刚加载），重试几次；最后一次换不做语言校正的方式
    let mut last = String::new();
    for attempt in 0..4 {
        match recognize_once(bytes, latin, attempt >= 2) {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = e;
                std::thread::sleep(std::time::Duration::from_millis(300 * (attempt + 1)));
            }
        }
    }
    Err(last)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn recognize_once(bytes: &[u8], latin: bool, plain: bool) -> Result<Vec<Line>, String> {
    use objc2::AllocAnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
    };

    let data = NSData::with_bytes(bytes);
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &NSDictionary::new(),
    );
    let req = VNRecognizeTextRequest::new();
    req.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    req.setUsesLanguageCorrection(!latin && !plain);
    let langs = if latin {
        NSArray::from_retained_slice(&[NSString::from_str("en-US")])
    } else {
        NSArray::from_retained_slice(&[NSString::from_str("zh-Hans"), NSString::from_str("en-US")])
    };
    req.setRecognitionLanguages(&langs);
    let as_req: &VNRequest = &req;
    handler
        .performRequests_error(&NSArray::from_slice(&[as_req]))
        .map_err(|e| format!("识别失败：{}", e.localizedDescription()))?;

    let mut out = vec![];
    if let Some(results) = req.results() {
        for obs in results.iter() {
            let Some(best) = obs.topCandidates(1).firstObject() else { continue };
            let r = unsafe { obs.boundingBox() };
            out.push(Line {
                text: best.string().to_string(),
                x: r.origin.x,
                // Vision 的原点在左下角，翻成左上角
                y: 1.0 - r.origin.y - r.size.height,
                w: r.size.width,
                h: r.size.height,
            });
        }
    }
    Ok(sort_lines(out))
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn recognize(_: &[u8], _: bool) -> Result<Vec<Line>, String> {
    Err("这台设备暂不支持文字识别".into())
}

/// 同一行（垂直中心相近）的从左到右，行与行从上到下
fn sort_lines(mut v: Vec<Line>) -> Vec<Line> {
    v.sort_by(|a, b| {
        let (ca, cb) = (a.y + a.h / 2.0, b.y + b.h / 2.0);
        if (ca - cb).abs() < a.h.min(b.h) * 0.5 {
            a.x.total_cmp(&b.x)
        } else {
            ca.total_cmp(&cb)
        }
    });
    v
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// 用系统自带的工具画一张有中文的图，确认 Vision 能读出来
    #[test]
    fn recognizes_chinese_text() {
        let dir = std::env::temp_dir().join("cn-ocr-test");
        let _ = std::fs::create_dir_all(&dir);
        let html = dir.join("t.html");
        std::fs::write(&html, "<html><head><meta charset='utf-8'></head><body style='font-size:64px;background:#fff'><p>公民身份号码 110101199003078515</p></body></html>").unwrap();
        let png = dir.join("t.png");
        let ok = std::process::Command::new("qlmanage")
            .args(["-t", "-s", "1200", "-o"])
            .arg(&dir)
            .arg(&html)
            .output()
            .is_ok();
        let thumb = dir.join("t.html.png");
        if !ok || !thumb.exists() {
            eprintln!("跳过：无法生成测试图片");
            return;
        }
        std::fs::rename(&thumb, &png).unwrap();
        let lines = recognize(&std::fs::read(&png).unwrap(), false).unwrap();
        let all: String = lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join(" ");
        assert!(all.contains("110101199003078515"), "{all}");
        assert!(all.contains("身份"), "{all}");
    }
}

/// 调试用：CN_OCR_IMG=图片路径 cargo test ocr_dump -- --ignored --nocapture，输出识别结果 JSON
#[cfg(all(test, target_os = "macos"))]
#[test]
#[ignore]
fn ocr_dump() {
    let path = std::env::var("CN_OCR_IMG").expect("CN_OCR_IMG");
    let latin = std::env::var("CN_OCR_LATIN").is_ok();
    let lines = recognize(&std::fs::read(path).unwrap(), latin).unwrap();
    println!("OCRJSON{}", serde_json::to_string(&lines).unwrap());
}
