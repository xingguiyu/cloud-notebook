//! MCP 服务（stdio）：让 Claude Code、Cursor 等 AI 编程工具把项目文档存进笔记库。
//!
//! 启动方式：`<应用可执行文件> mcp`。直接读写笔记库里的文件，应用不用开着；
//! 应用开着时靠文件监听自动刷新。
//!
//! 只能碰已绑定项目的文档文件夹：其他笔记、证件夹里的密钥和证件都不在这里暴露。

use crate::docs::{self, Config, Project};
use serde_json::{Value, json};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};

/// 一条请求最长这么多字节（文档上限 2 MB，JSON 转义后留出余量）
const MAX_LINE: u64 = 8 * 1024 * 1024;

const INSTRUCTIONS: &str = "Cloud Notebook keeps a project's planning documents (plans, designs, specs, reports) in the user's notes library, with a status on each one so it is clear which document is current. \
Use it when you write or update such a document, or when the user asks to tidy up the Markdown files scattered in a repository. \
The project is resolved from the working directory, so you normally do not pass `dir`. \
Saving a document with the same title (or importing the same source file) again stores a new version and keeps the old content as history. \
When a new document replaces an older one, pass the older one's path in `supersedes`. \
Files in the repository are copied, never moved or deleted.";

struct Ctx {
    config: PathBuf,
    root: PathBuf,
    /// 服务启动时所在的目录，也就是 AI 工具当前打开的项目
    cwd: PathBuf,
}

fn tools() -> Value {
    let dir = json!({"type": "string", "description": "Directory inside the project's repository. Defaults to the server's working directory."});
    let status = json!({"type": "string", "enum": docs::STATUSES, "description": "current: the version to follow. draft: not agreed yet. superseded: replaced by a newer document. archived: finished or abandoned."});
    let kind = json!({"type": "string", "description": "Kind of document, for example plan, design, spec, research, report, notes."});
    json!([
        {
            "name": "project_info",
            "description": "Show which Cloud Notebook project the current repository maps to and how many documents it has in each status.",
            "inputSchema": {"type": "object", "properties": {"dir": dir}}
        },
        {
            "name": "list_docs",
            "description": "List the project's documents with title, status, type, what each supersedes, source file and number of versions. Call this before saving so you can tell whether a document already exists or should be superseded.",
            "inputSchema": {"type": "object", "properties": {"dir": dir, "status": status}}
        },
        {
            "name": "read_doc",
            "description": "Read one project document. `path` is the path returned by list_docs.",
            "inputSchema": {"type": "object", "properties": {"dir": dir, "path": {"type": "string"}}, "required": ["path"]}
        },
        {
            "name": "save_doc",
            "description": "Save a Markdown document into the project. A document with the same title is updated in place and its previous content is kept as a version. List in `supersedes` the paths of older documents this one replaces; they are marked superseded.",
            "inputSchema": {"type": "object", "properties": {
                "dir": dir,
                "title": {"type": "string", "description": "Document title. Also used as the file name."},
                "content": {"type": "string", "description": "Full Markdown content."},
                "type": kind,
                "status": status,
                "supersedes": {"type": "array", "items": {"type": "string"}, "description": "Paths (from list_docs) of documents this one replaces."}
            }, "required": ["title", "content"]}
        },
        {
            "name": "set_doc_status",
            "description": "Change a document's status. With status superseded, pass `superseded_by` (path of the replacement) when there is one.",
            "inputSchema": {"type": "object", "properties": {"dir": dir, "path": {"type": "string"}, "status": status, "superseded_by": {"type": "string"}}, "required": ["path", "status"]}
        },
        {
            "name": "scan_repo",
            "description": "Find Markdown files in the repository and report a state for each: `new` (never imported), `same` (imported, identical), or `changed` (imported, but the repository file and the saved document now differ; either side may be the newer one, so read both before importing again). Use it to tidy up scattered documents: read the candidates, decide which are still valid, then call import_files.",
            "inputSchema": {"type": "object", "properties": {"dir": dir}}
        },
        {
            "name": "import_files",
            "description": "Copy Markdown files from the repository into the project. The originals are left untouched. For each file you may set title, type, status, and `supersedes`: repository paths of other files in the same call, or document paths from list_docs.",
            "inputSchema": {"type": "object", "properties": {
                "dir": dir,
                "files": {"type": "array", "items": {"type": "object", "properties": {
                    "path": {"type": "string", "description": "Path relative to the repository root."},
                    "title": {"type": "string"},
                    "type": kind,
                    "status": status,
                    "supersedes": {"type": "array", "items": {"type": "string"}}
                }, "required": ["path"]}}
            }, "required": ["files"]}
        }
    ])
}

/// 这次调用针对哪个目录。默认是服务启动时所在的目录（AI 工具当前打开的项目）。
/// `dir` 参数只能指到这个项目里面，或者用户已经绑定过的目录：不能随便指一个目录就把里面的文档读走。
fn dir_of(ctx: &Ctx, config: &Config, args: &Value) -> Result<PathBuf, String> {
    let cwd = docs::real(&ctx.cwd);
    let d = match args["dir"].as_str().filter(|s| !s.is_empty()) {
        None => cwd.clone(),
        Some(s) => {
            let d = PathBuf::from(s);
            if !d.is_absolute() || !d.is_dir() {
                return Err(format!("目录不存在或不是绝对路径：{}", d.display()));
            }
            let d = docs::real(&d);
            let here = docs::repo_root(&cwd);
            let bound = config.projects.iter().flat_map(|p| p.dirs.iter()).any(|b| d.starts_with(docs::real(Path::new(b))));
            if !d.starts_with(&here) && !bound {
                return Err(format!("{} 不在当前项目（{}）里，也不是已绑定的项目目录。要用别的目录，请先在 Cloud Notebook 里把它绑定到一个文件夹。", d.display(), here.display()));
            }
            d
        }
    };
    docs::check_project_dir(&ctx.config, &ctx.root, &d)?;
    Ok(d)
}

fn text(args: &Value, key: &str) -> Result<String, String> {
    args[key].as_str().filter(|s| !s.trim().is_empty()).map(String::from).ok_or_else(|| format!("缺少参数 {key}"))
}

fn need_write(c: &Config) -> Result<(), String> {
    if c.broken {
        Err("Cloud Notebook 的项目配置文件（projects.json）损坏，暂时不能写入。请打开应用的「设置 → 项目文档」检查。".into())
    } else if c.write {
        Ok(())
    } else {
        Err("Cloud Notebook 的设置里关闭了「允许 AI 写入」，现在只能读取。".into())
    }
}

fn project_json(p: &Project) -> Value {
    json!({"name": p.name, "folder": p.folder, "dirs": p.dirs, "remotes": p.remotes})
}

fn call(ctx: &Ctx, name: &str, args: &Value) -> Result<Value, String> {
    let config = docs::load_config(&ctx.config);
    let dir = dir_of(ctx, &config, args)?;
    let root: &Path = &ctx.root;
    // 读取类工具不新建项目
    let existing = || docs::find_project(&config, &dir).cloned();
    let unbound = || format!("这个目录还没有对应的项目：{}。保存或导入文档时会自动新建。", docs::repo_root(&dir).display());
    match name {
        "project_info" => Ok(match existing() {
            Some(p) => {
                let list = docs::list_docs(root, &p);
                let count = |s: &str| list.iter().filter(|d| d.status == s).count();
                json!({"project": project_json(&p), "documents": {"current": count("current"), "draft": count("draft"), "superseded": count("superseded"), "archived": count("archived")}, "write_allowed": config.write})
            }
            None => json!({"project": null, "note": unbound(), "write_allowed": config.write}),
        }),
        "list_docs" => {
            // 还没有项目不算出错：返回空列表和一句说明，免得 AI 把它当成故障
            let Some(p) = existing() else {
                return Ok(json!({"project": null, "documents": [], "note": unbound()}));
            };
            let want = args["status"].as_str();
            let list: Vec<_> = docs::list_docs(root, &p).into_iter().filter(|d| want.is_none_or(|s| d.status == s)).collect();
            Ok(json!({"project": p.name, "documents": list}))
        }
        "read_doc" => {
            let p = existing().ok_or_else(unbound)?;
            Ok(Value::String(docs::read_doc(root, &p, &text(args, "path")?)?))
        }
        "save_doc" => {
            need_write(&config)?;
            let new: docs::NewDoc = serde_json::from_value(args.clone()).map_err(|e| format!("参数不对：{e}"))?;
            if new.title.trim().is_empty() || new.content.trim().is_empty() {
                return Err("title 和 content 不能为空".into());
            }
            let p = docs::ensure_project(&ctx.config, root, &dir)?;
            Ok(json!({"project": p.name, "saved": docs::save_doc(root, &p, &new)?}))
        }
        "set_doc_status" => {
            need_write(&config)?;
            let p = existing().ok_or_else(unbound)?;
            Ok(json!({"updated": docs::set_status(root, &p, &text(args, "path")?, &text(args, "status")?, args["superseded_by"].as_str())?}))
        }
        "scan_repo" => {
            // 还没绑定项目时全部算新文件
            let files = docs::scan_repo(root, existing().as_ref(), &dir);
            Ok(json!({"repository": docs::repo_root(&dir), "project": existing().map(|p| p.name), "files": files}))
        }
        "import_files" => {
            need_write(&config)?;
            let items: Vec<docs::ImportItem> = serde_json::from_value(args["files"].clone()).map_err(|e| format!("files 参数不对：{e}"))?;
            if items.is_empty() {
                return Err("files 不能为空".into());
            }
            let p = docs::ensure_project(&ctx.config, root, &dir)?;
            Ok(json!({"project": p.name, "imported": docs::import_files(root, &p, &dir, &items)?}))
        }
        _ => Err(format!("没有这个工具：{name}")),
    }
}

fn render(v: Value) -> String {
    match v {
        Value::String(s) => s,
        other => serde_json::to_string_pretty(&other).unwrap_or_default(),
    }
}

/// 支持的协议版本，新的在前。客户端要的版本在里面就用它，否则回最新的，由客户端决定要不要继续
const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

fn handle(ctx: &Ctx, req: &Value) -> Option<Value> {
    // 不是一个请求对象（比如批量数组）：按 JSON-RPC 回「无效请求」，不能不吭声
    if !req.is_object() {
        return Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32600, "message": "Invalid Request"}}));
    }
    // 没有 method 的是对方发来的响应，这个服务不发请求，直接忽略
    req.get("method")?;
    let id = req.get("id").filter(|v| !v.is_null())?.clone();
    let ok = |result: Value| Some(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    match req["method"].as_str().unwrap_or("") {
        "initialize" => ok(json!({
            "protocolVersion": req["params"]["protocolVersion"].as_str().filter(|v| VERSIONS.contains(v)).unwrap_or(VERSIONS[0]),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "cloud-notebook", "version": env!("CARGO_PKG_VERSION")},
            "instructions": INSTRUCTIONS
        })),
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({"tools": tools()})),
        "tools/call" => {
            let name = req["params"]["name"].as_str().unwrap_or("");
            let empty = json!({});
            let args = req["params"].get("arguments").filter(|a| a.is_object()).unwrap_or(&empty);
            let (body, failed) = match call(ctx, name, args) {
                Ok(v) => (render(v), false),
                Err(e) => (e, true),
            };
            ok(json!({"content": [{"type": "text", "text": body}], "isError": failed}))
        }
        other => Some(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": format!("Method not found: {other}")}})),
    }
}

fn context() -> Result<Ctx, String> {
    let config = docs::config_dir()?;
    let root = docs::vault_root(&config)?;
    Ok(Ctx { config, root, cwd: std::env::current_dir().map_err(|e| e.to_string())? })
}

/// 命令行入口。返回 `true` 表示参数已经处理完，不用再启动图形界面。
pub fn cli(args: &[String]) -> bool {
    match args.first().map(String::as_str) {
        Some("mcp") => {
            if let Err(e) = serve() {
                eprintln!("cloud-notebook mcp: {e}");
                std::process::exit(1);
            }
            true
        }
        // 不经过 MCP 客户端直接调一个工具：`<可执行文件> tool list_docs '{"status":"current"}'`
        Some("tool") => {
            let name = args.get(1).map(String::as_str).unwrap_or("");
            let parsed = serde_json::from_str::<Value>(args.get(2).map_or("{}", String::as_str)).map_err(|e| format!("参数不是合法的 JSON：{e}"));
            match parsed.and_then(|a| context().and_then(|c| call(&c, name, &a))) {
                Ok(v) => println!("{}", render(v)),
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            }
            true
        }
        _ => false,
    }
}

fn serve() -> Result<(), String> {
    let ctx = context()?;
    let mut input = std::io::stdin().lock();
    let mut out = std::io::stdout().lock();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        // 一行最多读 MAX_LINE 字节；超长的一行读完丢掉，回一个错误
        let n = (&mut input).take(MAX_LINE + 1).read_until(b'\n', &mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if buf.len() as u64 > MAX_LINE && buf.last() != Some(&b'\n') {
            let mut sink = Vec::new();
            while input.read_until(b'\n', &mut sink).map_err(|e| e.to_string())? > 0 && sink.last() != Some(&b'\n') {
                sink.clear();
            }
            writeln!(out, "{}", json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32600, "message": "Request too large"}})).and_then(|_| out.flush()).map_err(|e| e.to_string())?;
            continue;
        }
        let line = String::from_utf8_lossy(&buf);
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(req) => handle(&ctx, &req),
            Err(_) => Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "Parse error"}})),
        };
        if let Some(r) = reply {
            writeln!(out, "{r}").and_then(|_| out.flush()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn ctx(name: &str) -> (Ctx, PathBuf) {
        let base = std::env::temp_dir().join(format!("cn-mcp-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let repo = base.join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(base.join("cfg")).unwrap();
        fs::create_dir_all(base.join("vault/日记")).unwrap();
        fs::write(base.join("vault/日记/secret.md"), "# 私人日记\n").unwrap();
        (Ctx { config: base.join("cfg"), root: base.join("vault"), cwd: repo.clone() }, repo)
    }

    fn rpc(ctx: &Ctx, method: &str, params: Value) -> Value {
        handle(ctx, &json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})).unwrap()
    }

    fn tool_call(ctx: &Ctx, name: &str, args: Value) -> (String, bool) {
        tool(ctx, name, args)
    }

    fn tool(ctx: &Ctx, name: &str, args: Value) -> (String, bool) {
        let r = rpc(ctx, "tools/call", json!({"name": name, "arguments": args}));
        (r["result"]["content"][0]["text"].as_str().unwrap().to_string(), r["result"]["isError"].as_bool().unwrap())
    }

    #[test]
    fn handshake_and_tool_list() {
        let (c, _) = ctx("hs");
        let init = rpc(&c, "initialize", json!({"protocolVersion": "2025-03-26", "capabilities": {}}));
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(rpc(&c, "initialize", json!({"protocolVersion": "2099-01-01"}))["result"]["protocolVersion"], VERSIONS[0]);
        assert_eq!(handle(&c, &json!([{"jsonrpc": "2.0", "id": 1, "method": "ping"}])).unwrap()["error"]["code"], -32600);
        assert!(handle(&c, &json!({"jsonrpc": "2.0", "id": 7, "result": {}})).is_none(), "a response from the client is ignored");
        assert!(init["result"]["capabilities"]["tools"].is_object());
        assert!(handle(&c, &json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).is_none(), "notifications get no reply");
        let list = rpc(&c, "tools/list", json!({}));
        let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["project_info", "list_docs", "read_doc", "save_doc", "set_doc_status", "scan_repo", "import_files"]);
        assert!(list["result"]["tools"].as_array().unwrap().iter().all(|t| t["inputSchema"]["type"] == "object"));
        assert_eq!(rpc(&c, "resources/list", json!({}))["error"]["code"], -32601);
    }

    #[test]
    fn dir_cannot_point_at_the_library_or_an_unrelated_folder() {
        let (c, repo) = ctx("dir");
        let other = repo.parent().unwrap().join("other");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("notes.md"), "# 别的项目\n").unwrap();
        let vault = c.root.to_string_lossy().to_string();
        for dir in [vault.clone(), format!("{vault}/日记"), other.to_string_lossy().to_string(), "/".to_string()] {
            for tool in ["scan_repo", "list_docs", "project_info"] {
                let (out, failed) = tool_call(&c, tool, json!({"dir": dir}));
                assert!(failed, "{tool} {dir}: {out}");
                assert!(!out.contains("私人日记") && !out.contains("secret.md") && !out.contains("别的项目"), "{out}");
            }
            let (out, failed) = tool_call(&c, "import_files", json!({"dir": dir, "files": [{"path": "日记/secret.md"}, {"path": "notes.md"}]}));
            assert!(failed, "{out}");
        }
        assert!(docs::load_config(&c.config).projects.is_empty(), "no project was created");
        // 当前项目里的子目录可以
        fs::create_dir_all(repo.join("docs")).unwrap();
        assert!(!tool_call(&c, "scan_repo", json!({"dir": repo.join("docs")})).1);
        // 服务本身就是在笔记库里启动的：一样拒绝
        let inside = Ctx { config: c.config.clone(), root: c.root.clone(), cwd: c.root.join("日记") };
        assert!(tool_call(&inside, "scan_repo", json!({})).1);
    }

    #[test]
    fn save_list_read_and_write_switch() {
        let (c, repo) = ctx("flow");
        let dir = repo.to_string_lossy().to_string();
        let (out, failed) = tool(&c, "list_docs", json!({"dir": dir}));
        assert!(!failed && out.contains("还没有对应的项目") && out.contains("\"documents\": []"), "{out}");

        let (out, failed) = tool(&c, "save_doc", json!({"dir": dir, "title": "方案", "content": "# 方案\n\n第一版", "type": "design"}));
        assert!(!failed, "{out}");
        let path = serde_json::from_str::<Value>(&out).unwrap()["saved"]["path"].as_str().unwrap().to_string();
        let (out, _) = tool(&c, "save_doc", json!({"dir": dir, "title": "方案二", "content": "# 方案二", "supersedes": [path]}));
        assert!(out.contains("方案二"), "{out}");

        let (out, _) = tool(&c, "list_docs", json!({"dir": dir, "status": "superseded"}));
        let list = serde_json::from_str::<Value>(&out).unwrap();
        assert_eq!(list["documents"].as_array().unwrap().len(), 1);
        assert_eq!(list["documents"][0]["path"], path.as_str());
        let (out, failed) = tool(&c, "read_doc", json!({"dir": dir, "path": path}));
        assert!(!failed && out.contains("status: superseded") && out.contains("第一版"), "{out}");
        assert!(tool(&c, "read_doc", json!({"dir": dir, "path": "../../etc/passwd"})).1);

        let mut cfg = docs::load_config(&c.config);
        cfg.write = false;
        docs::save_config(&c.config, &cfg).unwrap();
        let (out, failed) = tool(&c, "save_doc", json!({"dir": dir, "title": "x", "content": "y"}));
        assert!(failed && out.contains("允许 AI 写入"), "{out}");
        assert!(!tool(&c, "list_docs", json!({"dir": dir})).1, "reading still works");
    }
}
