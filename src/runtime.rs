//! deno_core (V8) execution layer.
//!
//! We register a single op, `op_capture`, which the injected `__capture` JS
//! helper calls with `(line, formatted_string)`. Captured pairs accumulate in a
//! shared store that lives in the runtime's `OpState`.
//!
//! The user code is run as an **ES module** (via `load_main_es_module_from_code`
//! + `mod_evaluate`), which is what gives us top-level `await` for free.

use std::cell::RefCell;
use std::rc::Rc;

use anyhow::{anyhow, Result};
use deno_core::{extension, op2, JsRuntime, OpState, RuntimeOptions};
use deno_error::JsErrorBox;

use crate::loader::RunjsModuleLoader;

/// Ordered list of `(line, formatted_value)` captured during execution.
pub type CaptureStore = Rc<RefCell<Vec<(u32, String)>>>;

#[op2(fast)]
fn op_capture(state: &mut OpState, #[smi] line: u32, #[string] formatted: &str) {
    let store = state.borrow::<CaptureStore>().clone();
    store.borrow_mut().push((line, formatted.to_string()));
}

/// Backs the `setTimeout` shim: really wait `ms` (driven by the tokio runtime
/// that owns this isolate's event loop), then resolve so the JS callback fires.
/// The bare deno_core isolate has no `deno_web`, so timers live here instead.
#[op2(async(lazy), fast)]
async fn op_sleep(ms: f64) {
    let millis = if ms.is_finite() && ms > 0.0 {
        ms as u64
    } else {
        0
    };
    tokio::time::sleep(std::time::Duration::from_millis(millis)).await;
}

/// Minimal Response payload handed back to the `fetch` shim.
#[derive(serde::Serialize)]
struct FetchResponse {
    status: u16,
    status_text: String,
    ok: bool,
    headers: Vec<(String, String)>,
    body: String,
}

/// Backs the `fetch` shim over reqwest. Buffers the whole body (no streaming),
/// which is all a scratchpad needs. The bare deno_core isolate has no
/// `deno_fetch`, so this stands in for it.
#[op2(async(lazy))]
#[serde]
async fn op_fetch(
    #[string] url: String,
    #[string] method: String,
    #[serde] req_headers: Vec<(String, String)>,
    #[string] body: String,
) -> Result<FetchResponse, JsErrorBox> {
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| JsErrorBox::type_error(e.to_string()))?;
    let client = reqwest::Client::new();
    let mut req = client.request(method, &url);
    for (k, v) in req_headers {
        req = req.header(k, v);
    }
    if !body.is_empty() {
        req = req.body(body);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| JsErrorBox::generic(e.to_string()))?;
    let status = resp.status();
    let headers = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let text = resp
        .text()
        .await
        .map_err(|e| JsErrorBox::generic(e.to_string()))?;
    Ok(FetchResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        ok: status.is_success(),
        headers,
        body: text,
    })
}

extension!(runjs_ext, ops = [op_capture, op_sleep, op_fetch]);

/// The JS preamble defining `__inspect` / `__capture` in the global scope.
pub(crate) const INSPECTOR_JS: &str = include_str!("inspector.js");

/// Execute instrumented JS, recording captures into `store`.
pub async fn execute(code: String, store: CaptureStore) -> Result<()> {
    let mut runtime = JsRuntime::new(RuntimeOptions {
        module_loader: Some(Rc::new(RunjsModuleLoader::new())),
        extensions: vec![runjs_ext::init()],
        ..Default::default()
    });

    // Make the capture store reachable from the op.
    runtime.op_state().borrow_mut().put::<CaptureStore>(store);

    // Install the inspector + __capture globals (classic script, sync).
    runtime.execute_script("[runjs:inspector]", INSPECTOR_JS)?;

    // Anchor the entry module at CWD so relative imports like `./util.ts`
    // resolve against the directory the app was launched from.
    let specifier = entry_specifier()?;
    let mod_id = runtime
        .load_main_es_module_from_code(&specifier, code)
        .await?;
    let eval = runtime.mod_evaluate(mod_id);
    runtime.run_event_loop(Default::default()).await?;
    eval.await?;
    Ok(())
}

fn entry_specifier() -> Result<deno_core::ModuleSpecifier> {
    let cwd = std::env::current_dir()?;
    let base = deno_core::url::Url::from_directory_path(&cwd)
        .map_err(|_| anyhow!("cwd is not a valid file URL: {}", cwd.display()))?;
    Ok(base.join("runjs_input.js")?)
}
