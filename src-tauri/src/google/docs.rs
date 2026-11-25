//! 把笔记发布成 Google 文档。
//! 前端把 Markdown 渲染成 HTML（图片内嵌成 data URI）交过来，
//! 以 HTML 上传并让 Drive 转换成文档，图片、表格、代码块都能保留下来。

use super::drive::Drive;
use super::sync::{DocState, GOOGLE_DOC_MIME, load_state, md5_hex, save_state};
use super::{GoogleState, Result, auth, err};
use serde::Serialize;
use std::collections::BTreeMap;
use tauri::{AppHandle, State};

const DOCS_FOLDER: &str = "Cloud Notebook 文档";

#[derive(Serialize)]
pub struct DocInfo {
    link: String,
    two_way: bool,
}

/// 发布或更新。首次发布新建文档，之后覆盖同一篇文档（链接不变）
#[tauri::command]
pub async fn google_publish_doc(
    app: AppHandle,
    state: State<'_, GoogleState>,
    note: String,
    title: String,
    html: String,
    two_way: Option<bool>,
) -> Result<String> {
    let _guard = state.lock.lock().await;
    let drive = Drive::new(auth::access_token(&app).await?);
    let mut st = load_state(&app)?;
    let parent = match &st.docs_root_id {
        Some(id) => id.clone(),
        None => {
            let root = drive.ensure_folder(super::sync::ROOT_FOLDER, None).await?;
            let id = drive.ensure_folder(DOCS_FOLDER, Some(&root)).await?;
            st.root_id.get_or_insert(root);
            st.docs_root_id = Some(id.clone());
            id
        }
    };
    let existing = st.docs.get(&note).cloned();
    let upload = |existing: Option<String>| {
        let drive = &drive;
        let (parent, title, html) = (&parent, &title, &html);
        async move {
            drive
                .upload(
                    existing.as_deref(),
                    Some(parent),
                    title,
                    html.as_bytes().to_vec(),
                    "text/html",
                    Some(GOOGLE_DOC_MIME),
                )
                .await
        }
    };
    // 文档可能已在 Drive 里被删掉，更新失败就新建一篇
    let f = match upload(existing.as_ref().map(|d| d.doc_id.clone())).await {
        Ok(f) => f,
        Err(_) if existing.is_some() => upload(None).await?,
        Err(e) => return Err(e),
    };
    // 上传后取一次元数据，拿到转换完成后的修改时间作为基准
    let meta = drive.get(&f.id).await?;
    let note_md5 = md5_hex(&std::fs::read(crate::vault::root(&app)?.join(&note)).map_err(err)?);
    let link = meta.web_view_link.clone().unwrap_or_default();
    st.docs.insert(
        note,
        DocState {
            doc_id: f.id,
            pushed_md5: note_md5,
            remote_modified: meta.modified_time.unwrap_or_default(),
            two_way: two_way.or(existing.map(|d| d.two_way)).unwrap_or(false),
            link: link.clone(),
        },
    );
    save_state(&app, &st)?;
    Ok(link)
}

#[tauri::command]
pub async fn google_docs_list(app: AppHandle) -> Result<BTreeMap<String, DocInfo>> {
    Ok(load_state(&app)?
        .docs
        .into_iter()
        .map(|(k, d)| {
            (
                k,
                DocInfo {
                    link: d.link,
                    two_way: d.two_way,
                },
            )
        })
        .collect())
}

#[tauri::command]
pub async fn google_doc_set_two_way(
    app: AppHandle,
    state: State<'_, GoogleState>,
    note: String,
    enabled: bool,
) -> Result<()> {
    let _guard = state.lock.lock().await;
    let mut st = load_state(&app)?;
    if let Some(d) = st.docs.get_mut(&note) {
        d.two_way = enabled;
    }
    save_state(&app, &st)
}

/// 笔记改名后，把发布记录跟过去
#[tauri::command]
pub async fn google_doc_move(
    app: AppHandle,
    state: State<'_, GoogleState>,
    from: String,
    to: String,
) -> Result<()> {
    let _guard = state.lock.lock().await;
    let mut st = load_state(&app)?;
    if let Some(d) = st.docs.remove(&from) {
        st.docs.insert(to, d);
        save_state(&app, &st)?;
    }
    Ok(())
}
