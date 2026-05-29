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

use crate::loader::RunjsModuleLoader;

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
