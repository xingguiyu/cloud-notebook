//! 本地索引库（SQLite，放在应用数据目录，不受 iCloud / 同步盘影响）。
//!
//! Markdown 文件仍是唯一真相，这里只是它的本地副本：
//! - 启动时直接从这里画出笔记列表和正文，再在后台对照磁盘更新（秒开，不等 iCloud 下载）
//! - 以后的全文检索（FTS5）、RAG 分块和向量（sqlite-vec）也放这里
//! 库坏了或丢了都没关系，删掉后会从笔记文件重新建立。

use rusqlite::{params, Connection};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

static DB: OnceLock<Mutex<Connection>> = OnceLock::new();

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (
    path     TEXT PRIMARY KEY,
    modified INTEGER NOT NULL,
    content  TEXT NOT NULL
);
-- RAG 预留：笔记分块和向量（向量列存 float32 小端字节，接入 sqlite-vec 后建虚拟表索引）
CREATE TABLE IF NOT EXISTS chunks (
    id        INTEGER PRIMARY KEY,
    path      TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    text      TEXT NOT NULL,
    model     TEXT,
    embedding BLOB,
    UNIQUE (path, seq)
);
CREATE INDEX IF NOT EXISTS chunks_path ON chunks (path);
-- 其它文件的本地副本（设置、证件夹的密钥和条目、加密附件，都是磁盘上的原样字节，证件夹仍是密文）
-- 按修改时间和大小判断是否变了：iCloud 只留在云端的文件也能读到这两项，不用下载
CREATE TABLE IF NOT EXISTS files (
    rel   TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL,
    size  INTEGER NOT NULL,
    data  BLOB NOT NULL
);
-- 全文检索：trigram 分词，中文按字切，3 个字以上的词走这里（更短的词直接 LIKE）
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED, body, tokenize = 'trigram');
";

pub fn init(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("index.db");
    let open = |p: &std::path::Path| -> rusqlite::Result<Connection> {
        let c = Connection::open(p)?;
        c.execute_batch(SCHEMA)?;
        backfill_fts(&c)?;
        Ok(c)
    };
    let conn = match open(&path) {
        Ok(c) => c,
        Err(e) => {
            // 库损坏：删掉重建，内容会从笔记文件重新填回来
            log::warn!("索引库打不开，重建：{e}");
            let _ = std::fs::remove_file(&path);
            match open(&path) {
                Ok(c) => c,
                Err(_) => return,
            }
        }
    };
    let _ = DB.set(Mutex::new(conn));
}

/// 旧版本的索引库里有笔记但没有全文索引：补建一次
fn backfill_fts(c: &Connection) -> rusqlite::Result<()> {
    let notes: i64 = c.query_row("SELECT count(*) FROM notes", [], |r| r.get(0))?;
    let indexed: i64 = c.query_row("SELECT count(*) FROM notes_fts", [], |r| r.get(0))?;
    if notes != indexed {
        c.execute_batch("DELETE FROM notes_fts; INSERT INTO notes_fts (path, body) SELECT path, content FROM notes;")?;
    }
    Ok(())
}

fn with<T>(f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Option<T> {
    let db = DB.get()?;
    let c = db.lock().ok()?;
    f(&c).map_err(|e| log::warn!("索引库：{e}")).ok()
}

/// 当前缓存属于哪个笔记库；换了笔记库位置就作废
fn bind_root(c: &Connection, root: &str) -> rusqlite::Result<()> {
    let cur: Option<String> = c
        .query_row("SELECT value FROM kv WHERE key = 'root'", [], |r| r.get(0))
        .ok();
    if cur.as_deref() != Some(root) {
        c.execute_batch("DELETE FROM notes; DELETE FROM notes_fts; DELETE FROM chunks; DELETE FROM files; DELETE FROM kv;")?;
        c.execute("INSERT INTO kv (key, value) VALUES ('root', ?1)", [root])?;
    }
    Ok(())
}

/// 扫描完目录后调用：记下目录树，删掉已经不存在的笔记
pub fn save_tree(root: &str, tree_json: &str, paths: &[String]) {
    with(|c| {
        bind_root(c, root)?;
        c.execute(
            "INSERT OR REPLACE INTO kv (key, value) VALUES ('tree', ?1)",
            [tree_json],
        )?;
        let tx = c.unchecked_transaction()?;
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS live (path TEXT PRIMARY KEY); DELETE FROM live;")?;
        {
            let mut ins = tx.prepare("INSERT OR IGNORE INTO live (path) VALUES (?1)")?;
            for p in paths {
                ins.execute([p])?;
            }
        }
        tx.execute_batch(
            "DELETE FROM notes WHERE path NOT IN (SELECT path FROM live);
             DELETE FROM notes_fts WHERE path NOT IN (SELECT path FROM live);
             DELETE FROM chunks WHERE path NOT IN (SELECT path FROM live);",
        )?;
        tx.commit()
    });
}

/// 读到或写入笔记正文后调用
pub fn save_notes(root: &str, notes: &[(String, u64, String)]) {
    if notes.is_empty() {
        return;
    }
    with(|c| {
        bind_root(c, root)?;
        let tx = c.unchecked_transaction()?;
        {
            let mut st = tx.prepare(
                "INSERT OR REPLACE INTO notes (path, modified, content) VALUES (?1, ?2, ?3)",
            )?;
            let mut del = tx.prepare("DELETE FROM notes_fts WHERE path = ?1")?;
            let mut fts = tx.prepare("INSERT INTO notes_fts (path, body) VALUES (?1, ?2)")?;
            for (p, m, t) in notes {
                st.execute(params![p, *m as i64, t])?;
                del.execute([p])?;
                fts.execute(params![p, t])?;
            }
        }
        tx.commit()
    });
}

fn stamp(abs: &std::path::Path) -> std::io::Result<(i64, i64)> {
    let m = std::fs::metadata(abs)?;
    let t = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64);
    Ok((t, m.len() as i64))
}

/// 本地副本最多存多大的文件（更大的照常直接读）
const MAX_CACHED: i64 = 30 << 20;

/// 读文件：修改时间和大小都没变就用本地副本，避免等 iCloud 下载；变了再读磁盘并更新副本
pub fn read_cached(root: &str, rel: &str, abs: &std::path::Path) -> std::io::Result<Vec<u8>> {
    let (mtime, size) = stamp(abs)?;
    let hit: Option<Vec<u8>> = with(|c| {
        bind_root(c, root)?;
        Ok(c
            .query_row(
                "SELECT data FROM files WHERE rel = ?1 AND mtime = ?2 AND size = ?3",
                params![rel, mtime, size],
                |r| r.get(0),
            )
            .ok())
    })
    .flatten();
    if let Some(d) = hit {
        return Ok(d);
    }
    let data = std::fs::read(abs)?;
    remember(root, rel, abs, &data);
    Ok(data)
}

/// 写完文件后调用，把新内容记进副本
pub fn remember(root: &str, rel: &str, abs: &std::path::Path, data: &[u8]) {
    let Ok((mtime, size)) = stamp(abs) else { return };
    if size > MAX_CACHED {
        return;
    }
    with(|c| {
        bind_root(c, root)?;
        c.execute(
            "INSERT OR REPLACE INTO files (rel, mtime, size, data) VALUES (?1, ?2, ?3, ?4)",
            params![rel, mtime, size, data],
        )
        .map(|_| ())
    });
}

pub fn forget(root: &str, rel: &str) {
    with(|c| {
        bind_root(c, root)?;
        c.execute("DELETE FROM files WHERE rel = ?1", [rel]).map(|_| ())
    });
}

#[derive(Serialize)]
pub struct CachedNote {
    path: String,
    modified: u64,
    content: String,
}

#[derive(Serialize)]
pub struct Snapshot {
    tree: serde_json::Value,
    notes: Vec<CachedNote>,
}

/// 启动时调用：上次的目录树和全部笔记正文。没有缓存（第一次打开、换了笔记库）返回 None。
#[tauri::command]
pub async fn index_snapshot(app: AppHandle) -> Result<Option<Snapshot>, String> {
    let root = crate::vault::root(&app)?.to_string_lossy().to_string();
    Ok(with(|c| {
        let cur: Option<String> = c
            .query_row("SELECT value FROM kv WHERE key = 'root'", [], |r| r.get(0))
            .ok();
        let tree: Option<String> = c
            .query_row("SELECT value FROM kv WHERE key = 'tree'", [], |r| r.get(0))
            .ok();
        let (Some(cur), Some(tree)) = (cur, tree) else { return Ok(None) };
        if cur != root {
            return Ok(None);
        }
        let mut st = c.prepare("SELECT path, modified, content FROM notes")?;
        let notes = st
            .query_map([], |r| {
                Ok(CachedNote {
                    path: r.get(0)?,
                    modified: r.get::<_, i64>(1)? as u64,
                    content: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Some(Snapshot {
            tree: serde_json::from_str(&tree).unwrap_or_default(),
            notes,
        }))
    })
    .flatten())
}

#[derive(Serialize, Debug)]
pub struct Hit {
    path: String,
    /// 命中处前后的一小段原文，命中的词用 \u{1}…\u{2} 包起来，界面上换成高亮
    snippet: String,
    /// 正文里命中的次数（所有词加起来）
    count: usize,
}

/// 把查询拆成词：空格分开的每个词都要出现（不分大小写）
fn terms(query: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for t in query.split_whitespace().map(|t| t.to_lowercase()) {
        if !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

fn like_escape(t: &str) -> String {
    let mut s = String::from("%");
    for ch in t.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            s.push('\\');
        }
        s.push(ch);
    }
    s.push('%');
    s
}

/// 命中处的片段和命中次数。按字符算位置，不会切坏中文。
fn snippet(content: &str, terms: &[String]) -> (String, usize) {
    let chars: Vec<char> = content.chars().collect();
    let lower: Vec<char> = chars.iter().map(|c| c.to_lowercase().next().unwrap_or(*c)).collect();
    let mut hits: Vec<(usize, usize)> = vec![];
    for t in terms {
        let needle: Vec<char> = t.chars().collect();
        if needle.is_empty() || needle.len() > lower.len() {
            continue;
        }
        let mut i = 0;
        while i + needle.len() <= lower.len() {
            if lower[i..i + needle.len()] == needle[..] {
                hits.push((i, i + needle.len()));
                i += needle.len();
            } else {
                i += 1;
            }
        }
    }
    hits.sort();
    let Some(&(first, _)) = hits.first() else { return (String::new(), 0) };
    let start = first.saturating_sub(24);
    let end = (first + 110).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    let mut i = start;
    while i < end {
        if let Some(&(_, e)) = hits.iter().find(|h| h.0 == i) {
            let e = e.min(end);
            out.push('\u{1}');
            out.extend(chars[i..e].iter().map(|c| if c.is_whitespace() { ' ' } else { *c }));
            out.push('\u{2}');
            i = e;
        } else {
            out.push(if chars[i].is_whitespace() { ' ' } else { chars[i] });
            i += 1;
        }
    }
    if end < chars.len() {
        out.push('…');
    }
    (out, hits.len())
}

fn search(c: &Connection, query: &str) -> rusqlite::Result<Vec<Hit>> {
    let terms = terms(query);
    if terms.is_empty() {
        return Ok(vec![]);
    }
    // 每个词一个条件：3 个字以上用全文索引，更短的（trigram 切不出来）用 LIKE
    let mut sql = String::from("SELECT n.path, n.content FROM notes n WHERE 1");
    let mut args: Vec<String> = vec![];
    for t in &terms {
        if t.chars().count() >= 3 {
            sql.push_str(" AND n.path IN (SELECT path FROM notes_fts WHERE notes_fts MATCH ?)");
            args.push(format!("body : \"{}\"", t.replace('"', "\"\"")));
        } else {
            sql.push_str(" AND n.content LIKE ? ESCAPE '\\'");
            args.push(like_escape(t));
        }
    }
    let mut st = c.prepare(&sql)?;
    let rows = st.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut hits = vec![];
    for row in rows {
        let (path, content) = row?;
        let (snippet, count) = snippet(&content, &terms);
        hits.push(Hit { path, snippet, count });
    }
    // 命中次数多的排前面
    hits.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.path.cmp(&b.path)));
    Ok(hits)
}

/// 全文搜索正文。标题和文件名的匹配由界面自己做（它手里有最新的内容）。
#[tauri::command]
pub async fn index_search(query: String) -> Result<Vec<Hit>, String> {
    with(|c| search(c, &query)).ok_or_else(|| "索引库不可用".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_change_clears_cache() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        bind_root(&c, "/a").unwrap();
        c.execute("INSERT INTO notes VALUES ('x.md', 1, 'hi')", []).unwrap();
        bind_root(&c, "/a").unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        bind_root(&c, "/b").unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn search_finds_short_and_long_terms() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        for (p, t) in [
            ("a.md", "# 报销\n\n三月的发票已经交给财务，Stripe 的 Invoice 还没开。发票抬头要改。"),
            ("b.md", "# 读书\n\n今天读了三体第二部，黑暗森林。"),
            ("c.md", "100%_done\n这里没有别的"),
        ] {
            c.execute("INSERT INTO notes VALUES (?1, 1, ?2)", params![p, t]).unwrap();
        }
        backfill_fts(&c).unwrap();
        let paths = |q: &str| search(&c, q).unwrap().into_iter().map(|h| h.path).collect::<Vec<_>>();
        assert_eq!(paths("发票"), ["a.md"]); // 两个字：LIKE
        assert_eq!(paths("黑暗森林"), ["b.md"]); // 全文索引
        assert_eq!(paths("invoice 发票"), ["a.md"]); // 多个词都要有，不分大小写
        assert_eq!(paths("发票 三体"), Vec::<String>::new());
        assert_eq!(paths("三"), ["a.md", "b.md"]);
        assert_eq!(paths("100%_"), ["c.md"]); // LIKE 的通配符按字面算
        assert_eq!(paths("\"引号"), Vec::<String>::new());
        let h = &search(&c, "发票").unwrap()[0];
        assert_eq!(h.count, 2);
        assert!(h.snippet.contains("\u{1}发票\u{2}"), "{}", h.snippet);
    }

    #[test]
    fn fts_follows_note_changes() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        DB.set(Mutex::new(c)).ok();
        save_notes("/r", &[("x.md".into(), 1, "原来写的是苹果手机".into())]);
        assert_eq!(with(|c| search(c, "苹果手机")).unwrap().len(), 1);
        save_notes("/r", &[("x.md".into(), 2, "现在改成了安卓平板".into())]);
        assert_eq!(with(|c| search(c, "苹果手机")).unwrap().len(), 0);
        assert_eq!(with(|c| search(c, "安卓平板")).unwrap().len(), 1);
        save_tree("/r", "[]", &[]);
        assert_eq!(with(|c| search(c, "安卓平板")).unwrap().len(), 0);
    }

    #[test]
    fn fts5_and_trigram_available() {
        // 以后全文检索要用 FTS5 的 trigram 分词（中文按字切），确认打包的 SQLite 支持
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram'); INSERT INTO t VALUES ('今天读了三体第二部');").unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM t WHERE t MATCH '三体第'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }
}
