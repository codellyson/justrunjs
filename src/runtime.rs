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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use deno_core::{extension, op2, JsRuntime, OpState, RuntimeOptions};
use deno_error::JsErrorBox;

use crate::loader::RunjsModuleLoader;

/// Ordered list of `(line, formatted_value)` captured during execution.
pub type CaptureStore = Rc<RefCell<Vec<(u32, String)>>>;

/// Hard ceiling on how long a single eval may run before the isolate is
/// terminated. Bounds runaway code — an endless `setInterval`, or a beginner's
/// `while (true) {}` — instead of freezing the app. Whatever ran before the
/// cutoff is still shown. Shared by the worker (`run_one`) and `execute`.
pub(crate) const EVAL_BUDGET_MS: u64 = 2000;

/// The line-0 note appended when an eval is cut off by the budget.
pub(crate) fn budget_note() -> String {
    format!(
        "\u{23f1} stopped after {}s — code was still running (setInterval, or a long/infinite loop)",
        EVAL_BUDGET_MS / 1000
    )
}

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

    // Make the capture store reachable from the op. Keep a clone so we can
    // still append the budget note after moving the original into op_state.
    let store_ref = store.clone();
    runtime.op_state().borrow_mut().put::<CaptureStore>(store);

    // Install the inspector + __capture globals (classic script, sync).
    runtime.execute_script("[runjs:inspector]", INSPECTOR_JS)?;

    // Anchor the entry module at CWD so relative imports like `./util.ts`
    // resolve against the directory the app was launched from.
    let specifier = entry_specifier()?;
    let mod_id = runtime
        .load_main_es_module_from_code(&specifier, code)
        .await?;

    // Budget watchdog on a separate OS thread — terminates from outside so it
    // can interrupt a synchronous infinite loop too. See worker::run_one.
    let handle = runtime.v8_isolate().thread_safe_handle();
    let timed_out = Arc::new(AtomicBool::new(false));
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let timed_out_w = timed_out.clone();
    let watchdog = std::thread::spawn(move || {
        if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
            done_rx.recv_timeout(std::time::Duration::from_millis(EVAL_BUDGET_MS))
        {
            timed_out_w.store(true, Ordering::SeqCst);
            handle.terminate_execution();
        }
    });

    let eval = runtime.mod_evaluate(mod_id);
    let loop_result = runtime.run_event_loop(Default::default()).await;
    let _ = done_tx.send(());
    let _ = watchdog.join();

    // Termination can surface from the event loop OR the module-eval promise
    // ("Uncaught (in promise) Error: execution terminated"); fold them together
    // and treat termination as a soft cutoff (keep captures), not a failure.
    let outcome = match loop_result {
        Ok(()) => eval.await,
        Err(e) => Err(e),
    };
    match outcome {
        Ok(()) => {}
        Err(e) if e.to_string().contains("execution terminated") => {
            if timed_out.load(Ordering::SeqCst) {
                store_ref.borrow_mut().push((0, budget_note()));
            }
        }
        Err(e) => return Err(e.into()),
    }
    Ok(())
}

fn entry_specifier() -> Result<deno_core::ModuleSpecifier> {
    let cwd = std::env::current_dir()?;
    let base = deno_core::url::Url::from_directory_path(&cwd)
        .map_err(|_| anyhow!("cwd is not a valid file URL: {}", cwd.display()))?;
    Ok(base.join("runjs_input.js")?)
}
