//! Desktop shell: a Tauri window hosting Monaco with live inline results.
//!
//! The frontend (static HTML/JS under `ui/`) calls the `evaluate_source`
//! command on each keystroke (debounced). We hand the source to the library's
//! `evaluate()`, which transpiles + instruments + runs it in V8, and return the
//! `Vec<LineResult>` the editor uses to paint inline value decorations.

use runjs_rs::{LineResult, evaluate};

#[tauri::command]
fn evaluate_source(source: String) -> Result<Vec<LineResult>, String> {
    evaluate(&source).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![evaluate_source])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
