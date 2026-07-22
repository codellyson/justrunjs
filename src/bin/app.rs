// Release builds are a GUI (windows) subsystem app so Windows doesn't spawn a
// console window alongside the app (closing that console would kill the app).
// Dev builds keep the console for logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Desktop shell: a Tauri window hosting CodeMirror with live inline results.
//!
//! All JS evaluation happens on a single long-lived V8 worker thread (see
//! `EvalWorker`). The Tauri commands here are thin: marshal a request to the
//! worker, await the reply, hand the result back to the webview. We hold the
//! worker behind a `OnceLock` so it's spawned lazily on first eval and shared
//! across every subsequent command invocation.

use std::sync::OnceLock;

use runjs_rs::{EvalWorker, LineResult};
use tauri_plugin_updater::UpdaterExt;

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
        // Register the updater plugin (exposes the check/download API + the
        // `updater:default` capability). It does NOT poll on its own — the
        // check below is what actually looks for a new release.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // On launch, check the signed `latest.json` (endpoints in
            // tauri.conf.json) for a newer build; if there is one, download +
            // install it and restart into it. Best-effort: any error (offline,
            // no update) is ignored so it never blocks startup.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let updater = match handle.updater() {
                    Ok(u) => u,
                    Err(_) => return,
                };
                if let Ok(Some(update)) = updater.check().await {
                    if update
                        .download_and_install(|_, _| {}, || {})
                        .await
                        .is_ok()
                    {
                        handle.restart();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![evaluate_source, stop_eval])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
