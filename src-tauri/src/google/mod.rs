//! Google 集成：OAuth 登录、Drive 双向同步、发布为 Google 文档。
//!
//! 只申请 `drive.file` 权限：应用只能看到自己创建的文件，属于非敏感权限，
//! 外部应用也不需要 Google 审核。代价是用户在 Drive 网页里手动放进同步文件夹的文件看不到。

pub mod auth;
pub mod docs;
pub mod drive;
pub mod sync;

use std::sync::Mutex;
use std::time::Instant;

#[derive(Default)]
pub struct GoogleState {
    /// 内存里的 access token 和过期时间；refresh token 存在系统钥匙串
    pub token: Mutex<Option<(String, Instant)>>,
    /// 同步和发布都会读写同步状态文件，串行执行
    pub lock: tauri::async_runtime::Mutex<()>,
    /// 手机上登录时，等系统把回调链接（自定义 URL scheme）交回应用
    pub pending_callback: Mutex<Option<std::sync::mpsc::Sender<String>>>,
}

pub type Result<T> = std::result::Result<T, String>;

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// 网络层错误（连不上、超时）统一加上前缀，前端据此显示为「暂时离线」而不是红色报错
pub const NETWORK_PREFIX: &str = "[网络] ";

/// 带超时的 HTTP 客户端：连不上或对方不再发数据时会报错返回，不会一直挂着
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .read_timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_default()
}

pub fn net_err(e: reqwest::Error) -> String {
    if e.is_connect() || e.is_timeout() || e.is_request() {
        format!("{NETWORK_PREFIX}无法连接 Google 服务器，请检查网络或代理设置（{e}）")
    } else {
        e.to_string()
    }
}
