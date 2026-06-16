//! Desktop shell: a Tauri window hosting CodeMirror with live inline results.
//!
//! All JS evaluation happens on a single long-lived V8 worker thread (see
//! `EvalWorker`). The Tauri commands here are thin: marshal a request to the
//! worker, await the reply, hand the result back to the webview. We hold the
//! worker behind a `OnceLock` so it's spawned lazily on first eval and shared
//! across every subsequent command invocation.

use std::sync::OnceLock;

use runjs_rs::{EvalWorker, LineResult};

static WORKER: OnceLock<EvalWorker> = OnceLock::new();

fn worker() -> &'static EvalWorker {
    WORKER.get_or_init(EvalWorker::spawn)
}

#[tauri::command]
async fn evaluate_source(source: String) -> Result<Vec<LineResult>, String> {
    worker().evaluate(source).await
}

#[tauri::command]
fn stop_eval() {
    worker().stop();
}

fn main() {
    // Touch the worker so the V8 thread is up before the user's first keystroke.
    let _ = worker();

    tauri::Builder::default()
        // Auto-update support: the plugin polls the `endpoints` listed in
        // tauri.conf.json, downloads the new bundle if it's signed with the
        // matching minisign pubkey, and prompts the user to restart. See
        // DEPLOYMENT.md for how to issue + sign a release.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![evaluate_source, stop_eval])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
