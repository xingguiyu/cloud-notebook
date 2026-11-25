//! Argon2id 密钥派生。WebCrypto 只有 PBKDF2，抗 GPU 破解能力弱，这里用 Rust 计算。

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

/// `memory_kib` 内存（KiB）、`iterations` 轮数、`parallelism` 并行度，输出 32 字节密钥（base64）
#[tauri::command]
pub async fn kdf_argon2id(
    password: String,
    salt: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        derive(&password, &salt, memory_kib, iterations, parallelism)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn derive(password: &str, salt_b64: &str, m: u32, t: u32, p: u32) -> Result<String, String> {
    use argon2::{Algorithm, Argon2, Params, Version};
    // 参数下限，防止配置文件被改成极低成本
    if m < 19 * 1024 || t < 2 {
        return Err("密钥派生参数过低".into());
    }
    let salt = STANDARD.decode(salt_b64).map_err(|e| e.to_string())?;
    let params = Params::new(m, t, p, Some(32)).map_err(|e| e.to_string())?;
    let mut out = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), &salt, &mut out)
        .map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_salt_dependent() {
        let a = derive("密码", "c2FsdHNhbHRzYWx0c2FsdA==", 19 * 1024, 2, 1).unwrap();
        let b = derive("密码", "c2FsdHNhbHRzYWx0c2FsdA==", 19 * 1024, 2, 1).unwrap();
        let c = derive("密码", "b3RoZXJzYWx0b3RoZXJzYWw=", 19 * 1024, 2, 1).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(STANDARD.decode(a).unwrap().len(), 32);
    }

    #[test]
    fn rejects_weak_params() {
        assert!(derive("x", "c2FsdHNhbHRzYWx0c2FsdA==", 1024, 1, 1).is_err());
    }
}
