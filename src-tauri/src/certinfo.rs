//! 读证书文件的信息（使用者、颁发者、有效期……），只在本机解析，内容不外传。

use serde::Serialize;
use x509_parser::prelude::*;

#[derive(Serialize, Default, Debug)]
pub struct CertInfo {
    /// 证书类型的友好名称，如「Apple 发布证书」
    pub kind: String,
    pub subject: String,
    pub issuer: String,
    pub serial: String,
    /// YYYY-MM-DD
    pub issued: String,
    pub expires: String,
    /// Apple 团队 ID（证书使用者里的 OU）
    pub team: String,
    pub has_key: bool,
}

fn ymd(t: &ASN1Time) -> String {
    let d = t.to_datetime();
    format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day())
}

fn attr(name: &X509Name, oid: &x509_parser::der_parser::oid::Oid) -> String {
    name.iter_by_oid(oid).filter_map(|a| a.as_str().ok()).collect::<Vec<_>>().join(", ")
}

pub fn from_der(der: &[u8]) -> Result<CertInfo, String> {
    let (_, c) = X509Certificate::from_der(der).map_err(|e| format!("不是有效的证书：{e}"))?;
    use x509_parser::oid_registry::*;
    let cn = attr(c.subject(), &OID_X509_COMMON_NAME);
    let org = attr(c.subject(), &OID_X509_ORGANIZATION_NAME);
    let team = attr(c.subject(), &OID_X509_ORGANIZATIONAL_UNIT);
    let issuer_cn = attr(c.issuer(), &OID_X509_COMMON_NAME);
    let kind = if cn.starts_with("Apple Distribution") || cn.starts_with("iPhone Distribution") {
        "Apple 发布证书"
    } else if cn.starts_with("Apple Development") || cn.starts_with("iPhone Developer") {
        "Apple 开发证书"
    } else if cn.starts_with("Developer ID Application") {
        "Developer ID 应用签名"
    } else if cn.starts_with("Developer ID Installer") {
        "Developer ID 安装包签名"
    } else if cn.contains("Push Services") || cn.contains("APNs") {
        "Apple 推送证书"
    } else if c.is_ca() {
        "CA 根/中间证书"
    } else {
        "X.509 证书"
    };
    let subject = match (cn.is_empty(), org.is_empty()) {
        (false, false) if !cn.contains(&org) => format!("{cn}（{org}）"),
        (false, _) => cn,
        _ => c.subject().to_string(),
    };
    Ok(CertInfo {
        kind: kind.into(),
        subject,
        issuer: if issuer_cn.is_empty() { c.issuer().to_string() } else { issuer_cn },
        serial: c.raw_serial_as_string(),
        issued: ymd(&c.validity().not_before),
        expires: ymd(&c.validity().not_after),
        team: if team.len() == 10 { team } else { String::new() },
        has_key: false,
    })
}

/// .cer/.crt/.der/.pem（取第一张证书）
pub fn from_cert_file(bytes: &[u8]) -> Result<CertInfo, String> {
    if bytes.starts_with(b"-----") || bytes.windows(11).any(|w| w == b"CERTIFICATE") {
        for pem in Pem::iter_from_buffer(bytes).flatten() {
            if pem.label == "CERTIFICATE" {
                return from_der(&pem.contents);
            }
        }
        return Err("PEM 里没有证书".into());
    }
    from_der(bytes)
}

/// .p12/.pfx：需要导出时设的密码；取带私钥的那张证书，没有就取第一张
pub fn from_p12(bytes: &[u8], password: &str) -> Result<CertInfo, String> {
    use p12_keystore::{KeyStore, KeyStoreEntry, Pkcs12ImportPolicy};
    let ks = KeyStore::from_pkcs12(bytes, password, Pkcs12ImportPolicy::Relaxed).map_err(|_| "密码不对，或不是有效的 p12 文件".to_string())?;
    if let Some((_, chain)) = ks.private_key_chain() {
        if let Some(c) = chain.certs().first() {
            let mut info = from_der(c.as_der())?;
            info.has_key = true;
            return Ok(info);
        }
    }
    for (_, e) in ks.entries() {
        if let KeyStoreEntry::Certificate(c) = e {
            return from_der(c.as_der());
        }
    }
    Err("p12 里没有证书".into())
}

/// 请求体是文件原始内容；x-kind: cert | p12；x-password: p12 密码（URL 编码）
#[tauri::command]
pub async fn cert_inspect(request: tauri::ipc::Request<'_>) -> Result<CertInfo, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("需要文件内容".into());
    };
    let h = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let password = urlencoding_decode(&h("x-password"));
    if h("x-kind") == "p12" { from_p12(bytes, &password) } else { from_cert_file(bytes) }
}

fn urlencoding_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用系统的 openssl 现做一张证书和 p12 来测
    #[test]
    fn reads_cert_and_p12() {
        let dir = std::env::temp_dir().join("cn-cert-test");
        let _ = std::fs::create_dir_all(&dir);
        let run = |args: &[&str]| std::process::Command::new("openssl").args(args).current_dir(&dir).output();
        let Ok(o) = run(&["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "k.pem", "-out", "c.pem", "-days", "30",
            "-subj", "/CN=Apple Distribution: Test Co (ABCDE12345)/OU=ABCDE12345/O=Test Co"]) else { return };
        if !o.status.success() { eprintln!("跳过：没有 openssl"); return }
        let info = from_cert_file(&std::fs::read(dir.join("c.pem")).unwrap()).unwrap();
        assert_eq!(info.kind, "Apple 发布证书");
        assert_eq!(info.team, "ABCDE12345");
        assert!(info.expires > info.issued);
        let o = run(&["pkcs12", "-export", "-inkey", "k.pem", "-in", "c.pem", "-out", "a.p12", "-passout", "pass:pa ss%"]).unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        let p12 = std::fs::read(dir.join("a.p12")).unwrap();
        let info = from_p12(&p12, "pa ss%").unwrap();
        assert!(info.has_key);
        assert_eq!(info.team, "ABCDE12345");
        assert!(from_p12(&p12, "wrong").is_err());
        assert_eq!(urlencoding_decode("pa%20ss%25"), "pa ss%");
    }
}

/// 调试：CN_CERT=路径 cargo test cert_dump -- --ignored --nocapture
#[cfg(test)]
#[test]
#[ignore]
fn cert_dump() {
    let p = std::env::var("CN_CERT").unwrap();
    let b = std::fs::read(&p).unwrap();
    let r = if p.ends_with(".p12") { from_p12(&b, &std::env::var("CN_PW").unwrap_or_default()) } else { from_cert_file(&b) };
    match r { Ok(i) => println!("CERT {} | {} | team={} | {}..{} key={}", i.kind, i.subject, i.team, i.issued, i.expires, i.has_key), Err(e) => println!("CERT err {e}") }
}
