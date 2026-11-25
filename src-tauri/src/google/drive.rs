//! Drive v3 REST 的最小封装

use super::{Result, err};
use serde::Deserialize;
use serde_json::json;

const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";
pub const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
pub const DOC_MIME: &str = "application/vnd.google-apps.document";
const FIELDS: &str = "id,name,mimeType,md5Checksum,modifiedTime,webViewLink";

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub md5_checksum: Option<String>,
    pub modified_time: Option<String>,
    pub web_view_link: Option<String>,
    /// 只有单独查询一个文件时才带；列目录时已经过滤掉回收站里的
    #[serde(default)]
    pub trashed: Option<bool>,
}

pub struct Drive {
    http: reqwest::Client,
    token: String,
}

async fn check(resp: reqwest::Response) -> Result<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    Err(friendly_error(status.as_u16(), &body))
}

/// 把 Google 返回的 JSON 错误翻译成能看懂的提示
fn friendly_error(status: u16, body: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let reason = v["error"]["details"][0]["reason"]
        .as_str()
        .or(v["error"]["errors"][0]["reason"].as_str())
        .unwrap_or("");
    let message = v["error"]["message"].as_str().unwrap_or(body);
    match reason {
        "ACCESS_TOKEN_SCOPE_INSUFFICIENT" | "insufficientPermissions" => {
            "没有 Google Drive 权限：登录时可能没有勾选 Drive 授权。请在设置里退出 Google 账号，重新登录并勾选云端硬盘权限。".into()
        }
        "SERVICE_DISABLED" | "accessNotConfigured" => {
            "这个 Google Cloud 项目还没有启用 Google Drive API，请在控制台「API 和服务 → 库」里启用。".into()
        }
        "userRateLimitExceeded" | "rateLimitExceeded" | "RATE_LIMIT_EXCEEDED" => "请求太频繁，被 Google 暂时限流，请稍后再试。".into(),
        "storageQuotaExceeded" => "Google Drive 存储空间已满。".into(),
        _ if status == 401 => "Google 登录已失效，请重新登录。".into(),
        _ => format!("Google Drive 请求失败（{status}）：{message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::friendly_error;

    #[test]
    fn translates_scope_error() {
        let body = r#"{"error":{"code":403,"message":"Request had insufficient authentication scopes.","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}"#;
        assert!(friendly_error(403, body).contains("没有 Google Drive 权限"));
        assert!(friendly_error(500, r#"{"error":{"message":"boom"}}"#).ends_with("boom"));
    }
}

/// Drive 查询语句里的字符串转义
fn q(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

impl Drive {
    pub fn new(token: String) -> Self {
        Self {
            http: super::http_client(),
            token,
        }
    }

    pub async fn list_children(&self, folder_id: &str) -> Result<Vec<RemoteFile>> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Page {
            files: Vec<RemoteFile>,
            next_page_token: Option<String>,
        }
        let mut out = vec![];
        let mut page_token: Option<String> = None;
        loop {
            let mut req = self
                .http
                .get(format!("{API}/files"))
                .bearer_auth(&self.token)
                .query(&[
                    (
                        "q",
                        format!("'{}' in parents and trashed = false", q(folder_id)),
                    ),
                    ("fields", format!("nextPageToken,files({FIELDS})")),
                    ("pageSize", "1000".into()),
                ]);
            if let Some(t) = &page_token {
                req = req.query(&[("pageToken", t)]);
            }
            let page: Page = check(req.send().await.map_err(super::net_err)?)
                .await?
                .json()
                .await
                .map_err(err)?;
            out.extend(page.files);
            match page.next_page_token {
                Some(t) => page_token = Some(t),
                None => return Ok(out),
            }
        }
    }

    /// 找到或创建文件夹。`parent` 为空时在「我的云端硬盘」根目录。
    pub async fn ensure_folder(&self, name: &str, parent: Option<&str>) -> Result<String> {
        let parent_q = parent.map_or("'root' in parents".to_string(), |p| {
            format!("'{}' in parents", q(p))
        });
        let found: serde_json::Value = check(
            self.http
                .get(format!("{API}/files"))
                .bearer_auth(&self.token)
                .query(&[
                    (
                        "q",
                        format!("name = '{}' and mimeType = '{FOLDER_MIME}' and {parent_q} and trashed = false", q(name)),
                    ),
                    ("fields", "files(id)".into()),
                ])
                .send()
                .await
                .map_err(super::net_err)?,
        )
        .await?
        .json()
        .await
        .map_err(err)?;
        if let Some(id) = found["files"][0]["id"].as_str() {
            return Ok(id.into());
        }
        let mut meta = json!({ "name": name, "mimeType": FOLDER_MIME });
        if let Some(p) = parent {
            meta["parents"] = json!([p]);
        }
        let created: RemoteFile = check(
            self.http
                .post(format!("{API}/files"))
                .bearer_auth(&self.token)
                .query(&[("fields", FIELDS)])
                .json(&meta)
                .send()
                .await
                .map_err(super::net_err)?,
        )
        .await?
        .json()
        .await
        .map_err(err)?;
        Ok(created.id)
    }

    /// 上传文件。`existing` 有值时更新内容，否则在 parent 下新建。
    /// `target_mime` 设为 Google 文档类型时，Drive 会把内容转换成文档。
    pub async fn upload(
        &self,
        existing: Option<&str>,
        parent: Option<&str>,
        name: &str,
        bytes: Vec<u8>,
        mime: &str,
        target_mime: Option<&str>,
    ) -> Result<RemoteFile> {
        let mut meta = json!({ "name": name });
        if let Some(t) = target_mime {
            meta["mimeType"] = json!(t);
        }
        if existing.is_none() {
            if let Some(p) = parent {
                meta["parents"] = json!([p]);
            }
        }
        let form = reqwest::multipart::Form::new()
            .part(
                "metadata",
                reqwest::multipart::Part::text(meta.to_string())
                    .mime_str("application/json; charset=UTF-8")
                    .map_err(err)?,
            )
            .part(
                "media",
                reqwest::multipart::Part::bytes(bytes)
                    .mime_str(mime)
                    .map_err(err)?,
            );
        let req = match existing {
            Some(id) => self.http.patch(format!("{UPLOAD}/files/{id}")),
            None => self.http.post(format!("{UPLOAD}/files")),
        };
        check(
            req.bearer_auth(&self.token)
                .query(&[("uploadType", "multipart"), ("fields", FIELDS)])
                .multipart(form)
                .send()
                .await
                .map_err(super::net_err)?,
        )
        .await?
        .json()
        .await
        .map_err(err)
    }

    pub async fn download(&self, id: &str) -> Result<Vec<u8>> {
        let resp = self
            .http
            .get(format!("{API}/files/{id}"))
            .bearer_auth(&self.token)
            .query(&[("alt", "media")])
            .send()
            .await
            .map_err(super::net_err)?;
        Ok(check(resp).await?.bytes().await.map_err(err)?.to_vec())
    }

    /// 把 Google 文档导出成指定格式（如 text/markdown）
    pub async fn export(&self, id: &str, mime: &str) -> Result<Vec<u8>> {
        let resp = self
            .http
            .get(format!("{API}/files/{id}/export"))
            .bearer_auth(&self.token)
            .query(&[("mimeType", mime)])
            .send()
            .await
            .map_err(super::net_err)?;
        Ok(check(resp).await?.bytes().await.map_err(err)?.to_vec())
    }

    pub async fn get(&self, id: &str) -> Result<RemoteFile> {
        check(
            self.http
                .get(format!("{API}/files/{id}"))
                .bearer_auth(&self.token)
                .query(&[("fields", format!("{FIELDS},trashed"))])
                .send()
                .await
                .map_err(super::net_err)?,
        )
        .await?
        .json()
        .await
        .map_err(err)
    }

    /// 移到 Drive 回收站（30 天内可恢复），不做永久删除
    pub async fn trash(&self, id: &str) -> Result<()> {
        check(
            self.http
                .patch(format!("{API}/files/{id}"))
                .bearer_auth(&self.token)
                .json(&json!({ "trashed": true }))
                .send()
                .await
                .map_err(super::net_err)?,
        )
        .await?;
        Ok(())
    }
}
