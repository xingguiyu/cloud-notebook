//! 钥匙串读写，带进程内缓存。
//!
//! 未签名的开发版每次重新编译，macOS 都会把它当成新应用，读钥匙串时弹窗确认；
//! 正式签名后不会弹。无论哪种，都尽量少读：状态检查不碰钥匙串，真正要用时每次运行最多读一次。

use std::collections::HashMap;
use std::sync::Mutex;

const SERVICE: &str = "com.qxsclass.cloudnotebook";

static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

/// 开发版（debug）把密钥存在本机一个只有当前用户可读的文件里，避免每次重新编译都弹钥匙串授权。
/// 正式版（release）只用钥匙串。
#[cfg(debug_assertions)]
mod dev_store {
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home)
            .join("Library/Application Support/com.qxsclass.cloudnotebook/dev-secrets.json")
    }
    fn load() -> HashMap<String, String> {
        std::fs::read(path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }
    fn save(map: &HashMap<String, String>) {
        let p = path();
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if std::fs::write(&p, serde_json::to_vec(map).unwrap_or_default()).is_ok() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
        }
    }
    pub fn get(name: &str) -> Option<String> {
        load().remove(name)
    }
    pub fn set(name: &str, value: Option<&str>) {
        let mut m = load();
        match value {
            Some(v) => m.insert(name.into(), v.into()),
            None => m.remove(name),
        };
        save(&m);
    }
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

/// 读取；没有这一项返回 Ok(None)，用户在系统弹窗里拒绝等情况返回 Err
pub fn get(name: &str) -> Result<Option<String>, String> {
    if let Some(v) = CACHE.lock().unwrap().as_ref().and_then(|c| c.get(name)) {
        return Ok(v.clone());
    }
    #[cfg(debug_assertions)]
    if let Some(v) = dev_store::get(name) {
        CACHE
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(name.into(), Some(v.clone()));
        return Ok(Some(v));
    }
    // 开发版只用自己的开发文件，不去读正式版存在钥匙串里的密钥：
    // 否则在装了正式版的机器上跑一次开发版，真实的密钥就会被抄进一个明文文件
    #[cfg(debug_assertions)]
    if true {
        CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(name.into(), None);
        return Ok(None);
    }
    let value = match entry(name)?.get_password() {
        Ok(v) => Some(v),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            return Err(format!(
                "无法读取钥匙串（{e}）。如果刚才弹出了钥匙串授权窗口，请点「允许」或「始终允许」后重试。"
            ));
        }
    };
    #[cfg(debug_assertions)]
    if let Some(v) = &value {
        dev_store::set(name, Some(v));
    }
    CACHE
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(name.into(), value.clone());
    Ok(value)
}

/// 本机修改：写入并记下修改时间（参与密钥同步）
pub fn set(name: &str, value: &str) -> Result<(), String> {
    set_raw(name, value)?;
    crate::keysync::touched(name);
    Ok(())
}

pub fn delete(name: &str) {
    delete_raw(name);
    crate::keysync::touched(name);
}

/// 只写入，不记修改时间（同步收到的值用这个）
pub fn set_raw(name: &str, value: &str) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        dev_store::set(name, Some(value));
        CACHE
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(name.into(), Some(value.into()));
        return Ok(());
    }
    #[allow(unreachable_code)]
    entry(name)?
        .set_password(value)
        .map_err(|e| e.to_string())?;
    CACHE
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(name.into(), Some(value.into()));
    Ok(())
}

pub fn delete_raw(name: &str) {
    #[cfg(debug_assertions)]
    dev_store::set(name, None);
    if let Ok(e) = entry(name) {
        let _ = e.delete_credential();
    }
    CACHE
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(name.into(), None);
}
