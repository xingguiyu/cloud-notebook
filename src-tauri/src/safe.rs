//! 证件夹 / 密码库：证件、银行卡、网站密码、密钥、公司证照合同等。
//!
//! 安全设计：
//! - 独立的主密码（和加密笔记分开），Argon2id（64 MiB, 3 轮）派生密钥加密数据密钥（DEK）；
//!   另有一份恢复密钥也能解开 DEK，忘记密码时用它重设。
//! - 每个条目单独一个 AES-256-GCM 加密文件（条目 id 作为附加认证数据，防止文件被调换）；
//!   附件（证件照片、合同 PDF）同样加密。云端和同步盘只看到密文。
//! - DEK 只在 Rust 内存里，锁定时清零；前端只在解锁期间拿到解密后的条目。
//! - 不进全文索引、不进 RAG，也不会发给 AI。
//! - Touch ID / Face ID：开启后 DEK 存进系统钥匙串，取出前必须通过生物识别。
//!
//! 存储：笔记库 `.cloudnotebook/safe/`（随 Google Drive 同步）
//! - keys.json        包装后的 DEK、KDF 参数、密码提示
//! - items/<id>.json  每个条目一个文件；删除留墓碑，两台设备改不同条目互不冲突
//! - files/<id>.enc   加密附件

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use zeroize::{Zeroize, Zeroizing};

type Key = Zeroizing<[u8; 32]>;

static DEK: Mutex<Option<Key>> = Mutex::new(None);

const ARGON_M: u32 = 64 * 1024;
const ARGON_T: u32 = 3;
const ARGON_P: u32 = 1;
const TOUCHID_SECRET: &str = "safe-touchid-dek";
const FILE_MAGIC: &[u8; 4] = b"CNS1";

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::vault::root(app)?.join(".cloudnotebook/safe"))
}

/// 证件夹文件都走本地副本读写（iCloud 只留在云端的文件不用每次下载）
fn cached_read(app: &AppHandle, abs: &std::path::Path) -> std::io::Result<Vec<u8>> {
    let root = crate::vault::root(app).map_err(std::io::Error::other)?;
    let rel = abs.strip_prefix(&root).unwrap_or(abs).to_string_lossy().replace('\\', "/");
    crate::index::read_cached(&root.to_string_lossy(), &rel, abs)
}

fn cached_write(app: &AppHandle, abs: &std::path::Path, data: &[u8]) -> Result<(), String> {
    fs::write(abs, data).map_err(|e| e.to_string())?;
    if let Ok(root) = crate::vault::root(app) {
        let rel = abs.strip_prefix(&root).unwrap_or(abs).to_string_lossy().replace('\\', "/");
        crate::index::remember(&root.to_string_lossy(), &rel, abs, data);
    }
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::thread_rng().fill_bytes(&mut b);
    b
}

// ---------------- 加解密 ----------------

fn encrypt(key: &[u8; 32], aad: &[u8], plain: &[u8]) -> Result<([u8; 12], Vec<u8>), String> {
    let iv = random::<12>();
    let ct = Aes256Gcm::new_from_slice(key)
        .map_err(|e| e.to_string())?
        .encrypt(Nonce::from_slice(&iv), Payload { msg: plain, aad })
        .map_err(|_| "加密失败".to_string())?;
    Ok((iv, ct))
}

fn decrypt(key: &[u8; 32], aad: &[u8], iv: &[u8], ct: &[u8]) -> Result<Zeroizing<Vec<u8>>, ()> {
    if iv.len() != 12 {
        return Err(());
    }
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| ())?
        .decrypt(Nonce::from_slice(iv), Payload { msg: ct, aad })
        .map(Zeroizing::new)
        .map_err(|_| ())
}

fn argon(password: &str, salt: &[u8], m: u32, t: u32, p: u32) -> Result<Key, String> {
    use argon2::{Algorithm, Argon2, Params, Version};
    if m < 19 * 1024 || t < 2 {
        return Err("密钥派生参数过低".into());
    }
    let params = Params::new(m, t, p, Some(32)).map_err(|e| e.to_string())?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// 恢复密钥：160 位随机数，显示成 8 组 Crockford Base32（去掉易混的 I L O U）
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn format_recovery(bytes: &[u8; 20]) -> String {
    let mut bits = 0u32;
    let mut n = 0;
    let mut chars = String::new();
    for &b in bytes {
        bits = (bits << 8) | b as u32;
        n += 8;
        while n >= 5 {
            n -= 5;
            chars.push(ALPHABET[((bits >> n) & 31) as usize] as char);
        }
    }
    chars
        .as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("-")
}

fn parse_recovery(text: &str) -> Option<[u8; 20]> {
    let clean: Vec<u8> = text
        .to_ascii_uppercase()
        .bytes()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| match c {
            b'O' => b'0',
            b'I' | b'L' => b'1',
            c => c,
        })
        .collect();
    if clean.len() != 32 {
        return None;
    }
    let mut out = [0u8; 20];
    let (mut bits, mut n, mut i) = (0u32, 0, 0);
    for c in clean {
        let v = ALPHABET.iter().position(|&a| a == c)? as u32;
        bits = (bits << 5) | v;
        n += 5;
        if n >= 8 {
            n -= 8;
            out[i] = (bits >> n) as u8;
            i += 1;
        }
    }
    Some(out)
}

fn recovery_kek(rk: &[u8; 20]) -> Key {
    let mut h = Sha256::new();
    h.update(b"cloudnotebook-safe-recovery-v1");
    h.update(rk);
    Zeroizing::new(h.finalize().into())
}

// ---------------- keys.json ----------------

#[derive(Serialize, Deserialize, Clone)]
struct Wrapped {
    iv: String,
    data: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Kdf {
    alg: String,
    salt: String,
    m: u32,
    t: u32,
    p: u32,
}

#[derive(Serialize, Deserialize, Clone)]
struct Keys {
    version: u32,
    kdf: Kdf,
    by_password: Wrapped,
    by_recovery: Wrapped,
    #[serde(default)]
    hint: String,
}

const DEK_AAD: &[u8] = b"cloudnotebook-safe-dek-v1";

fn wrap(kek: &[u8; 32], dek: &[u8; 32]) -> Result<Wrapped, String> {
    let (iv, ct) = encrypt(kek, DEK_AAD, dek)?;
    Ok(Wrapped {
        iv: B64.encode(iv),
        data: B64.encode(ct),
    })
}

fn unwrap(kek: &[u8; 32], w: &Wrapped) -> Option<Key> {
    let iv = B64.decode(&w.iv).ok()?;
    let ct = B64.decode(&w.data).ok()?;
    let plain = decrypt(kek, DEK_AAD, &iv, &ct).ok()?;
    let mut k = Zeroizing::new([0u8; 32]);
    if plain.len() != 32 {
        return None;
    }
    k.copy_from_slice(&plain);
    Some(k)
}

fn load_keys(app: &AppHandle) -> Result<Option<Keys>, String> {
    match cached_read(app, &dir(app)?.join("keys.json")) {
        Ok(t) => serde_json::from_slice(&t)
            .map(Some)
            .map_err(|_| "证件夹密钥文件损坏".into()),
        Err(_) => Ok(None),
    }
}

fn save_keys(app: &AppHandle, k: &Keys) -> Result<(), String> {
    let d = dir(app)?;
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(k).map_err(|e| e.to_string())?;
    // 先写临时文件再改名，写到一半断电也不会毁掉唯一的密钥文件
    let tmp = d.join("keys.json.tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(tmp, d.join("keys.json")).map_err(|e| e.to_string())?;
    if let Ok(root) = crate::vault::root(app) {
        let abs = d.join("keys.json");
        if let Ok(data) = fs::read(&abs) {
            crate::index::remember(&root.to_string_lossy(), ".cloudnotebook/safe/keys.json", &abs, &data);
        }
    }
    Ok(())
}

fn password_kek(k: &Keys, password: &str) -> Result<Key, String> {
    let salt = B64.decode(&k.kdf.salt).map_err(|e| e.to_string())?;
    argon(password, &salt, k.kdf.m, k.kdf.t, k.kdf.p)
}

fn new_kdf() -> Kdf {
    Kdf {
        alg: "argon2id".into(),
        salt: B64.encode(random::<16>()),
        m: ARGON_M,
        t: ARGON_T,
        p: ARGON_P,
    }
}

fn check_password(p: &str) -> Result<(), String> {
    if p.chars().count() < 8 {
        return Err("主密码至少 8 位".into());
    }
    Ok(())
}

fn set_dek(k: Key) {
    *DEK.lock().unwrap() = Some(k);
}

fn current_dek() -> Result<Key, String> {
    DEK.lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "证件夹已锁定".to_string())
}

/// Argon2 很耗 CPU，放到阻塞线程里跑
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

// ---------------- 本机设置（不同步） ----------------

#[derive(Serialize, Deserialize, Default)]
struct Local {
    touchid: bool,
}

fn local_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("safe-local.json"))
}

fn load_local(app: &AppHandle) -> Local {
    local_path(app)
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_local(app: &AppHandle, l: &Local) {
    if let Some(p) = local_path(app) {
        if let Some(d) = p.parent() {
            let _ = fs::create_dir_all(d);
        }
        let _ = fs::write(p, serde_json::to_vec(l).unwrap_or_default());
    }
}

// ---------------- 状态、设置、解锁 ----------------

#[derive(Serialize)]
pub struct SafeStatus {
    exists: bool,
    unlocked: bool,
    hint: String,
    biometric_available: bool,
    biometric_enabled: bool,
}

#[tauri::command]
pub async fn safe_status(app: AppHandle) -> Result<SafeStatus, String> {
    let keys = load_keys(&app)?;
    let local = load_local(&app);
    Ok(SafeStatus {
        exists: keys.is_some(),
        unlocked: DEK.lock().unwrap().is_some(),
        hint: keys.map(|k| k.hint).unwrap_or_default(),
        biometric_available: biometric::available(),
        biometric_enabled: local.touchid,
    })
}

/// 第一次使用：设主密码，返回恢复密钥（只显示这一次）
#[tauri::command]
pub async fn safe_setup(app: AppHandle, password: String, hint: String) -> Result<String, String> {
    check_password(&password)?;
    if load_keys(&app)?.is_some() {
        return Err("证件夹已经设置过".into());
    }
    blocking(move || {
        let dek: Key = Zeroizing::new(random::<32>());
        let rk = Zeroizing::new(random::<20>());
        let kdf = new_kdf();
        let salt = B64.decode(&kdf.salt).unwrap();
        let kek = argon(&password, &salt, kdf.m, kdf.t, kdf.p)?;
        let keys = Keys {
            version: 1,
            by_password: wrap(&kek, &dek)?,
            by_recovery: wrap(&recovery_kek(&rk), &dek)?,
            kdf,
            hint,
        };
        save_keys(&app, &keys)?;
        set_dek(dek);
        Ok(format_recovery(&rk))
    })
    .await
}

#[tauri::command]
pub async fn safe_unlock(app: AppHandle, password: String) -> Result<(), String> {
    let keys = load_keys(&app)?.ok_or("还没有设置证件夹")?;
    blocking(move || {
        let kek = password_kek(&keys, &password)?;
        let dek = unwrap(&kek, &keys.by_password).ok_or("密码不正确")?;
        set_dek(dek);
        Ok(())
    })
    .await
}

/// 忘记密码：用恢复密钥解开，并设新密码
#[tauri::command]
pub async fn safe_recover(
    app: AppHandle,
    recovery: String,
    password: String,
    hint: String,
) -> Result<(), String> {
    check_password(&password)?;
    let mut keys = load_keys(&app)?.ok_or("还没有设置证件夹")?;
    blocking(move || {
        let rk = Zeroizing::new(parse_recovery(&recovery).ok_or("恢复密钥格式不对")?);
        let dek = unwrap(&recovery_kek(&rk), &keys.by_recovery).ok_or("恢复密钥不正确")?;
        keys.kdf = new_kdf();
        let kek = password_kek(&keys, &password)?;
        keys.by_password = wrap(&kek, &dek)?;
        keys.hint = hint;
        save_keys(&app, &keys)?;
        set_dek(dek);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn safe_change_password(
    app: AppHandle,
    old: String,
    password: String,
    hint: String,
) -> Result<(), String> {
    check_password(&password)?;
    let mut keys = load_keys(&app)?.ok_or("还没有设置证件夹")?;
    blocking(move || {
        let old_kek = password_kek(&keys, &old)?;
        let dek = unwrap(&old_kek, &keys.by_password).ok_or("原密码不正确")?;
        keys.kdf = new_kdf();
        let new_kek = password_kek(&keys, &password)?;
        keys.by_password = wrap(&new_kek, &dek)?;
        keys.hint = hint;
        save_keys(&app, &keys)
    })
    .await
}

/// 生成新的恢复密钥，旧的立即失效（需要已解锁）
#[tauri::command]
pub async fn safe_new_recovery(app: AppHandle) -> Result<String, String> {
    let dek = current_dek()?;
    let mut keys = load_keys(&app)?.ok_or("还没有设置证件夹")?;
    let rk = Zeroizing::new(random::<20>());
    keys.by_recovery = wrap(&recovery_kek(&rk), &dek)?;
    save_keys(&app, &keys)?;
    Ok(format_recovery(&rk))
}

#[tauri::command]
pub async fn safe_lock() {
    if let Some(mut k) = DEK.lock().unwrap().take() {
        k.zeroize();
    }
}

/// 开关 Touch ID / Face ID 解锁（开启需要已解锁，并先通过一次生物识别确认是本人）
#[tauri::command]
pub async fn safe_set_biometric(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        let dek = current_dek()?;
        blocking(|| biometric::authenticate("开启证件夹的快速解锁")).await?;
        crate::secrets::set_raw(TOUCHID_SECRET, &B64.encode(dek.as_ref()))?;
    } else {
        crate::secrets::delete_raw(TOUCHID_SECRET);
    }
    save_local(&app, &Local { touchid: enabled });
    Ok(())
}

#[tauri::command]
pub async fn safe_unlock_biometric(app: AppHandle) -> Result<(), String> {
    if !load_local(&app).touchid {
        return Err("没有开启快速解锁".into());
    }
    blocking(|| biometric::authenticate("解锁证件夹")).await?;
    let b64 = Zeroizing::new(
        crate::secrets::get(TOUCHID_SECRET)?.ok_or("快速解锁的密钥不见了，请用主密码解锁")?,
    );
    let raw = Zeroizing::new(B64.decode(b64.as_bytes()).map_err(|e| e.to_string())?);
    if raw.len() != 32 {
        return Err("快速解锁的密钥损坏，请用主密码解锁".into());
    }
    let mut k = Zeroizing::new([0u8; 32]);
    k.copy_from_slice(&raw);
    // 确认它还能解开当前的数据（别的设备用恢复密钥重设后 DEK 不变，这里一般都能过）
    set_dek(k);
    Ok(())
}

// ---------------- 条目 ----------------

#[derive(Serialize, Deserialize)]
struct ItemFile {
    v: u32,
    id: String,
    iv: String,
    data: String,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

fn item_aad(id: &str) -> Vec<u8> {
    format!("item:{id}").into_bytes()
}

fn read_item(dek: &[u8; 32], text: &str) -> Option<(String, Value)> {
    let f: ItemFile = serde_json::from_str(text).ok()?;
    let iv = B64.decode(&f.iv).ok()?;
    let ct = B64.decode(&f.data).ok()?;
    let plain = decrypt(dek, &item_aad(&f.id), &iv, &ct).ok()?;
    let v: Value = serde_json::from_slice(&plain).ok()?;
    Some((f.id, v))
}

fn write_item(app: &AppHandle, dek: &[u8; 32], id: &str, item: &Value) -> Result<(), String> {
    let d = dir(app)?.join("items");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let plain = Zeroizing::new(serde_json::to_vec(item).map_err(|e| e.to_string())?);
    let (iv, ct) = encrypt(dek, &item_aad(id), &plain)?;
    let f = ItemFile {
        v: 1,
        id: id.into(),
        iv: B64.encode(iv),
        data: B64.encode(ct),
    };
    cached_write(
        app,
        &d.join(format!("{id}.json")),
        serde_json::to_string(&f).map_err(|e| e.to_string())?.as_bytes(),
    )
}

fn updated(v: &Value) -> u64 {
    v["updated"].as_u64().unwrap_or(0)
}

/// 解密全部条目（不含已删除）。同步冲突留下的副本按 id 合并，保留较新的那份。
#[tauri::command]
pub async fn safe_list(app: AppHandle) -> Result<Vec<Value>, String> {
    let dek = current_dek()?;
    let d = dir(&app)?.join("items");
    let Ok(rd) = fs::read_dir(&d) else {
        return Ok(vec![]);
    };
    let mut best: HashMap<String, (Value, PathBuf)> = HashMap::new();
    let mut extra: Vec<PathBuf> = vec![];
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = cached_read(&app, &p).map(|b| String::from_utf8_lossy(&b).into_owned()) else { continue };
        let Some((id, v)) = read_item(&dek, &text) else { continue };
        match best.get(&id) {
            Some((old, _)) if updated(old) >= updated(&v) => extra.push(p),
            _ => {
                if let Some((_, old_p)) = best.insert(id, (v, p)) {
                    extra.push(old_p);
                }
            }
        }
    }
    // 收拾冲突副本：较新的内容写回 <id>.json，多余的文件删掉
    for (id, (v, p)) in &best {
        let canonical = d.join(format!("{id}.json"));
        if *p != canonical {
            write_item(&app, &dek, id, v)?;
        }
    }
    for p in extra {
        let name_is_canonical = best
            .iter()
            .any(|(id, _)| p == d.join(format!("{id}.json")));
        if !name_is_canonical {
            let _ = fs::remove_file(p);
        }
    }
    let mut out: Vec<Value> = best
        .into_values()
        .map(|(v, _)| v)
        .filter(|v| !v["deleted"].as_bool().unwrap_or(false))
        .collect();
    out.sort_by_key(|v| std::cmp::Reverse(updated(v)));
    Ok(out)
}

/// 新建或保存条目，返回带上修改时间的条目
#[tauri::command]
pub async fn safe_save(app: AppHandle, mut item: Value) -> Result<Value, String> {
    let dek = current_dek()?;
    let id = item["id"].as_str().unwrap_or_default().to_string();
    if !valid_id(&id) {
        return Err("条目 id 不合法".into());
    }
    let t = now_ms();
    if item.get("created").and_then(|c| c.as_u64()).is_none() {
        item["created"] = t.into();
    }
    item["updated"] = t.into();
    write_item(&app, &dek, &id, &item)?;
    Ok(item)
}

/// 删除条目：留下墓碑让其它设备也删掉，附件一起删
#[tauri::command]
pub async fn safe_delete(app: AppHandle, id: String, files: Vec<String>) -> Result<(), String> {
    let dek = current_dek()?;
    if !valid_id(&id) {
        return Err("条目 id 不合法".into());
    }
    let tomb = serde_json::json!({ "id": id, "deleted": true, "updated": now_ms() });
    write_item(&app, &dek, &id, &tomb)?;
    for f in files {
        if valid_id(&f) {
            let _ = fs::remove_file(dir(&app)?.join("files").join(format!("{f}.enc")));
        }
    }
    Ok(())
}

// ---------------- 附件 ----------------

fn file_aad(id: &str) -> Vec<u8> {
    format!("file:{id}").into_bytes()
}

/// 加密保存附件（证件照、合同 PDF 等），原始字节走请求体；返回附件 id
#[tauri::command]
pub async fn safe_attach(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let dek = current_dek()?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("需要原始文件数据".into());
    };
    let id = {
        let r = random::<16>();
        r.iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    let (iv, ct) = encrypt(&dek, &file_aad(&id), bytes)?;
    let d = dir(&app)?.join("files");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(4 + 12 + ct.len());
    out.extend_from_slice(FILE_MAGIC);
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ct);
    cached_write(&app, &d.join(format!("{id}.enc")), &out)?;
    Ok(id)
}

fn read_file(app: &AppHandle, id: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let dek = current_dek()?;
    if !valid_id(id) {
        return Err("附件 id 不合法".into());
    }
    let raw = cached_read(app, &dir(app)?.join("files").join(format!("{id}.enc")))
        .map_err(|_| "附件还没同步过来，或已被删除".to_string())?;
    if raw.len() < 16 || &raw[..4] != FILE_MAGIC {
        return Err("附件文件损坏".into());
    }
    decrypt(&dek, &file_aad(id), &raw[4..16], &raw[16..]).map_err(|_| "附件解不开".to_string())
}

/// 解密附件，原始字节返回给前端显示
#[tauri::command]
pub async fn safe_file(app: AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(read_file(&app, &id)?.to_vec()))
}

/// 把附件解密另存到用户选的位置
#[tauri::command]
pub async fn safe_export_file(app: AppHandle, id: String, dest: String) -> Result<(), String> {
    fs::write(dest, read_file(&app, &id)?.as_slice()).map_err(|e| e.to_string())
}

/// 从访达拖进证件夹的文件：系统拖放只给路径，这里读出内容（只在解锁时、只读图片和 PDF）
#[tauri::command]
pub async fn safe_read_dropped(path: String) -> Result<tauri::ipc::Response, String> {
    current_dek()?;
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > 100 << 20 {
        return Err("文件不存在或超过 100 MB".into());
    }
    Ok(tauri::ipc::Response::new(fs::read(&p).map_err(|e| e.to_string())?))
}

#[tauri::command]
pub async fn safe_remove_file(app: AppHandle, id: String) -> Result<(), String> {
    current_dek()?;
    if valid_id(&id) {
        let _ = fs::remove_file(dir(&app)?.join("files").join(format!("{id}.enc")));
    }
    Ok(())
}

// ---------------- Touch ID / Face ID ----------------

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod biometric {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};

    pub fn available() -> bool {
        unsafe {
            let ctx = LAContext::new();
            ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
                .is_ok()
        }
    }

    /// 弹出系统的 Touch ID / Face ID 验证，阻塞等结果（在阻塞线程里调用）
    pub fn authenticate(reason: &str) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let block = RcBlock::new(move |ok: Bool, err: *mut NSError| {
            let r = if ok.as_bool() {
                Ok(())
            } else if err.is_null() {
                Err("验证失败".to_string())
            } else {
                Err(unsafe { (*err).localizedDescription() }.to_string())
            };
            let _ = tx.send(r);
        });
        unsafe {
            let ctx = LAContext::new();
            ctx.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthenticationWithBiometrics,
                &NSString::from_str(reason),
                &block,
            );
        }
        rx.recv_timeout(std::time::Duration::from_secs(120))
            .map_err(|_| "验证超时".to_string())?
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod biometric {
    pub fn available() -> bool {
        false
    }
    pub fn authenticate(_: &str) -> Result<(), String> {
        Err("这台设备不支持生物识别".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_key_roundtrip() {
        let rk = [0xA5u8; 20];
        let text = format_recovery(&rk);
        assert_eq!(text.len(), 32 + 7);
        assert_eq!(parse_recovery(&text), Some(rk));
        assert_eq!(parse_recovery(&text.to_lowercase().replace('-', " ")), Some(rk));
        assert_eq!(parse_recovery("too-short"), None);
    }

    #[test]
    fn dek_wrap_rejects_wrong_key() {
        let dek = [9u8; 32];
        let w = wrap(&[1u8; 32], &dek).unwrap();
        assert_eq!(unwrap(&[1u8; 32], &w).as_deref(), Some(&dek));
        assert!(unwrap(&[2u8; 32], &w).is_none());
    }

    #[test]
    fn item_bound_to_its_id() {
        let dek = [3u8; 32];
        let (iv, ct) = encrypt(&dek, &item_aad("a"), b"{\"x\":1}").unwrap();
        let file = |id: &str| {
            serde_json::to_string(&ItemFile {
                v: 1,
                id: id.into(),
                iv: B64.encode(iv),
                data: B64.encode(&ct),
            })
            .unwrap()
        };
        assert!(read_item(&dek, &file("a")).is_some());
        // 把 a 的密文改名成 b：认证失败
        assert!(read_item(&dek, &file("b")).is_none());
    }

    #[test]
    fn ids_are_path_safe() {
        assert!(valid_id("3f2a-9c"));
        assert!(!valid_id("../keys"));
        assert!(!valid_id(""));
    }
}
