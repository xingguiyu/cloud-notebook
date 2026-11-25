// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `app mcp` 等命令行用法：不启动图形界面
    let args: Vec<String> = std::env::args().skip(1).collect();
    if app_lib::mcp::cli(&args) {
        return;
    }
    app_lib::run();
}
