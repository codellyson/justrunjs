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

use anyhow::Result;
use deno_core::{extension, op2, JsRuntime, OpState, RuntimeOptions};

/// Ordered list of `(line, formatted_value)` captured during execution.
pub type CaptureStore = Rc<RefCell<Vec<(u32, String)>>>;

#[op2(fast)]
fn op_capture(state: &mut OpState, #[smi] line: u32, #[string] formatted: &str) {
    let store = state.borrow::<CaptureStore>().clone();
    store.borrow_mut().push((line, formatted.to_string()));
}

extension!(runjs_ext, ops = [op_capture]);

/// The JS preamble defining `__inspect` / `__capture` in the global scope.
const INSPECTOR_JS: &str = include_str!("inspector.js");

/// Execute instrumented JS, recording captures into `store`.
pub async fn execute(code: String, store: CaptureStore) -> Result<()> {
    let mut runtime = JsRuntime::new(RuntimeOptions {
        module_loader: Some(Rc::new(deno_core::NoopModuleLoader)),
        extensions: vec![runjs_ext::init()],
        ..Default::default()
    });

    // Make the capture store reachable from the op.
    runtime.op_state().borrow_mut().put::<CaptureStore>(store);

    // Install the inspector + __capture globals (classic script, sync).
    runtime.execute_script("[runjs:inspector]", INSPECTOR_JS)?;

    // Load + evaluate the user module (top-level await supported here).
    let specifier = deno_core::resolve_url("file:///runjs_input.js")?;
    let mod_id = runtime
        .load_main_es_module_from_code(&specifier, code)
        .await?;
    let eval = runtime.mod_evaluate(mod_id);
    runtime.run_event_loop(Default::default()).await?;
    eval.await?;
    Ok(())
}
