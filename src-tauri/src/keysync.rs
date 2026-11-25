//! 密钥同步：AI Key、图床 Secret 加密后存进笔记库 `.cloudnotebook/secrets.json`，随笔记同步到其它设备。
//!
//! - 用加密笔记的数据密钥（DEK）做 AES-256-GCM，云端和同步盘只看到密文；新设备输入一次加密密码即可解开。
//! - 每一项单独记修改时间，两台设备各改了不同的 Key 能合并；同一项以较新的为准，删除也会同步（墓碑）。
//! - Google 登录凭证不同步：每台设备自己登录（同步通道本身就靠它，而且凭证和设备绑定更安全）。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

const FILE: &str = ".cloudnotebook/secrets.json";

/// 本机记录每一项最后修改时间的文件（应用配置目录）
static META_PATH: OnceLock<PathBuf> = OnceLock::new();
static META_LOCK: Mutex<()> = Mutex::new(());

pub fn init(app: &AppHandle) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = META_PATH.set(dir.join("secrets-sync.json"));
    }
}

/// 哪些密钥参与同步
pub fn is_synced(name: &str) -> bool {
    name == "anthropic-api-key" || name.starts_with("ai-key-") || name == "imagehost-secret"
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_meta() -> BTreeMap<String, u64> {
    META_PATH
        .get()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_meta(m: &BTreeMap<String, u64>) {
    if let Some(p) = META_PATH.get() {
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(p, serde_json::to_vec(m).unwrap_or_default());
    }
}

/// secrets.rs 在本机修改了一项时调用
pub fn touched(name: &str) {
    if !is_synced(name) {
        return;
    }
    let _g = META_LOCK.lock().unwrap();
    let mut m = load_meta();
    m.insert(name.into(), now_ms());
    save_meta(&m);
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Entry {
    /// None 表示已删除
    v: Option<String>,
    t: u64,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    version: u32,
    iv: String,
    data: String,
}

fn cipher(dek: &[u8]) -> Result<Aes256Gcm, String> {
    Aes256Gcm::new_from_slice(dek).map_err(|_| "数据密钥长度不对".to_string())
}

fn seal(dek: &[u8], entries: &BTreeMap<String, Entry>) -> Result<String, String> {
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let plain = serde_json::to_vec(&serde_json::json!({ "entries": entries }))
        .map_err(|e| e.to_string())?;
    let data = cipher(dek)?
        .encrypt(Nonce::from_slice(&iv), plain.as_ref())
        .map_err(|_| "加密失败".to_string())?;
    let env = Envelope {
        version: 1,
        iv: B64.encode(iv),
        data: B64.encode(data),
    };
    serde_json::to_string_pretty(&env).map_err(|e| e.to_string())
}

fn open(dek: &[u8], text: &str) -> Result<BTreeMap<String, Entry>, String> {
    let env: Envelope =
        serde_json::from_str(text).map_err(|_| "同步的密钥文件格式不对".to_string())?;
    let iv = B64.decode(env.iv).map_err(|e| e.to_string())?;
    let data = B64.decode(env.data).map_err(|e| e.to_string())?;
    if iv.len() != 12 {
        return Err("同步的密钥文件格式不对".into());
    }
    let plain = cipher(dek)?
        .decrypt(Nonce::from_slice(&iv), data.as_ref())
        .map_err(|_| "解不开同步的密钥（可能是在别的设备上重置过加密密码）".to_string())?;
    #[derive(Deserialize)]
    struct Body {
        entries: BTreeMap<String, Entry>,
    }
    Ok(serde_json::from_slice::<Body>(&plain)
        .map_err(|e| e.to_string())?
        .entries)
}

/// 合并：每一项取较新的。返回（合并结果，需要写进本机的项）
fn merge(
    local: &BTreeMap<String, Entry>,
    remote: &BTreeMap<String, Entry>,
) -> (BTreeMap<String, Entry>, Vec<(String, Entry)>) {
    let mut out = local.clone();
    let mut apply = vec![];
    for (k, r) in remote {
        match local.get(k) {
            Some(l) if l.t >= r.t => {}
            _ => {
                out.insert(k.clone(), r.clone());
                apply.push((k.clone(), r.clone()));
            }
        }
    }
    (out, apply)
}

#[derive(Serialize)]
pub struct KeySyncReport {
    /// 从其它设备收到的项（显示用）
    received: Vec<String>,
    /// 是否更新了同步文件
    uploaded: bool,
}

/// 用数据密钥合并本机和笔记库里的密钥。需要加密笔记已解锁（前端传入 DEK）。
#[tauri::command]
pub async fn keysync_run(app: AppHandle, dek: String) -> Result<KeySyncReport, String> {
    let dek = B64.decode(dek).map_err(|e| e.to_string())?;
    let path = crate::vault::root(&app)?.join(FILE);
    let remote = match std::fs::read_to_string(&path) {
        Ok(t) => open(&dek, &t)?,
        Err(_) => BTreeMap::new(),
    };

    // 本机：有修改记录的项读出当前值（只读这些，避免无谓的钥匙串访问）
    let meta = {
        let _g = META_LOCK.lock().unwrap();
        let mut m = load_meta();
        // 这个功能上线前就存好的 Key 没有修改记录：按最早的时间登记，其它设备上更新的值仍然优先
        let mut added = false;
        for name in existing_secret_names(&app) {
            if !m.contains_key(&name) {
                m.insert(name, 1);
                added = true;
            }
        }
        if added {
            save_meta(&m);
        }
        m
    };
    let mut local = BTreeMap::new();
    for (name, t) in &meta {
        // 只有约定好的那几类密钥参与同步。名单存在本机文件里，不能因为文件被改就把别的钥匙串条目（登录凭据、证件夹密钥）也导出去
        if !is_synced(name) {
            continue;
        }
        // 远端同一项不比本机旧时，本机值用不上，不必读钥匙串
        if remote.get(name).is_some_and(|r| r.t >= *t) {
            local.insert(name.clone(), remote[name].clone());
            continue;
        }
        let v = crate::secrets::get(name)?;
        local.insert(name.clone(), Entry { v, t: *t });
    }

    let (merged, apply) = merge(&local, &remote);
    let mut received = vec![];
    {
        let _g = META_LOCK.lock().unwrap();
        let mut m = load_meta();
        for (name, e) in &apply {
            // 同步文件里出现名单之外的条目：不写进钥匙串
            if !is_synced(name) {
                continue;
            }
            match &e.v {
                Some(v) => crate::secrets::set_raw(name, v)?,
                None => crate::secrets::delete_raw(name),
            }
            m.insert(name.clone(), e.t);
            received.push(name.clone());
        }
        save_meta(&m);
    }
    for (name, e) in &apply {
        refresh_flags(&app, name, e.v.is_some());
    }

    let uploaded = merged != remote;
    if uploaded {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, seal(&dek, &merged)?).map_err(|e| e.to_string())?;
    }
    Ok(KeySyncReport { received, uploaded })
}

/// 笔记库里是否有同步过来的密钥文件
#[tauri::command]
pub async fn keysync_exists(app: AppHandle) -> bool {
    crate::vault::root(&app)
        .map(|r| r.join(FILE).exists())
        .unwrap_or(false)
}

/// 按「已配置」标记列出本机已有的密钥（不读钥匙串）
fn existing_secret_names(app: &AppHandle) -> Vec<String> {
    let mut out: Vec<String> = crate::ai::ai_key_status(app.clone())
        .into_iter()
        .filter(|(_, has)| *has)
        .filter_map(|(p, _)| crate::ai::secret_name(&p).ok())
        .collect();
    if crate::imagehost::imagehost_status(app.clone()).has_secret() {
        out.push("imagehost-secret".into());
    }
    out
}

/// 收到其它设备的 Key 后，更新本机「是否已配置」的标记
fn refresh_flags(app: &AppHandle, name: &str, present: bool) {
    if name == "imagehost-secret" {
        crate::imagehost::set_has_secret(app, present);
    } else if let Some(p) = crate::ai::provider_of_secret(name) {
        let _ = crate::ai::write_flag(app, &p, present);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(v: Option<&str>, t: u64) -> Entry {
        Entry {
            v: v.map(String::from),
            t,
        }
    }

    #[test]
    fn seal_roundtrip_and_wrong_key() {
        let dek = [7u8; 32];
        let mut m = BTreeMap::new();
        m.insert("ai-key-openai".to_string(), e(Some("sk-1"), 5));
        let text = seal(&dek, &m).unwrap();
        assert!(!text.contains("sk-1"));
        assert_eq!(open(&dek, &text).unwrap(), m);
        assert!(open(&[8u8; 32], &text).is_err());
    }

    #[test]
    fn merge_takes_newer_per_entry() {
        let mut local = BTreeMap::new();
        local.insert("a".to_string(), e(Some("local-a"), 10));
        local.insert("b".to_string(), e(Some("local-b"), 1));
        let mut remote = BTreeMap::new();
        remote.insert("b".to_string(), e(None, 5)); // 别的设备删了 b
        remote.insert("c".to_string(), e(Some("remote-c"), 3));
        remote.insert("a".to_string(), e(Some("old-a"), 2));
        let (merged, apply) = merge(&local, &remote);
        assert_eq!(merged["a"], e(Some("local-a"), 10));
        assert_eq!(merged["b"], e(None, 5));
        assert_eq!(merged["c"], e(Some("remote-c"), 3));
        let names: Vec<_> = apply.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, vec!["b", "c"]);
    }

    #[test]
    fn synced_names() {
        assert!(is_synced("ai-key-openhubs"));
        assert!(is_synced("anthropic-api-key"));
        assert!(is_synced("imagehost-secret"));
        assert!(!is_synced("google-refresh-token"));
    }
}
