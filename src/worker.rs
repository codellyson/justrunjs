//! Long-lived V8 worker.
//!
//! The naive design (build a fresh `JsRuntime` per eval) makes typing feel
//! sluggish: every keystroke pays for a brand-new V8 isolate (~tens of MB of
//! heap setup, fresh JIT caches, re-parsing the inspector preamble, re-fetching
//! and re-compiling every imported module). Macros that allocate large mmap'd
//! regions don't promptly return memory to the OS, so RSS climbs round after
//! round.
//!
//! This module keeps **one** isolate alive on a dedicated OS thread. Eval
//! requests come in over an mpsc channel; each one is run as a *side* ES
//! module with a unique URL (deno_core only allows one *main* module per
//! runtime). The captures store is created once and `clear()`ed between evals.
//!
//! `IsolateHandle` is `Send + Sync`, so the Tauri command side can call
//! `terminate_execution()` from another thread to cancel a runaway script —
//! this is what finally makes the Stop button real.
//!
//! After many evals the realm accumulates module records, so we recycle the
//! whole worker every `RECYCLE_EVERY` runs to bound long-session memory.

use std::rc::Rc;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use deno_core::{v8, JsRuntime, RuntimeOptions};
use tokio::sync::{mpsc, oneshot};

use crate::instrument::transpile_and_instrument;
use crate::loader::RunjsModuleLoader;
use crate::runtime::{runjs_ext, CaptureStore, INSPECTOR_JS};
use crate::{group_by_line, LineResult};

/// Recycle the runtime after this many evals to keep long sessions bounded.
/// Tuned by feel — large enough that the rebuild cost is amortized, small
/// enough that residual V8 module records don't pile up indefinitely.
const RECYCLE_EVERY: u64 = 250;

/// Handle to the worker thread. Cheap to clone (channel + Arc).
#[derive(Clone)]
pub struct EvalWorker {
    tx: mpsc::Sender<Request>,
    isolate_handle: Arc<Mutex<Option<v8::IsolateHandle>>>,
}

struct Request {
    code: String,
    reply: oneshot::Sender<std::result::Result<Vec<LineResult>, String>>,
}

impl EvalWorker {
    /// Spawn the worker thread and return a handle.
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel::<Request>(8);
        let isolate_handle: Arc<Mutex<Option<v8::IsolateHandle>>> =
            Arc::new(Mutex::new(None));
        let handle_for_thread = isolate_handle.clone();

        std::thread::Builder::new()
            .name("runjs-v8".into())
            .spawn(move || run_worker(rx, handle_for_thread))
            .expect("spawn runjs-v8 worker thread");

        Self {
            tx,
            isolate_handle,
        }
    }

    /// Run a snippet on the worker. Awaits the worker's reply.
    pub async fn evaluate(
        &self,
        code: String,
    ) -> std::result::Result<Vec<LineResult>, String> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(Request {
                code,
                reply: reply_tx,
            })
            .await
            .map_err(|_| "eval worker is gone".to_string())?;
        reply_rx
            .await
            .map_err(|_| "eval worker dropped reply".to_string())?
    }

    /// Ask V8 to abort whatever script is currently running. Safe to call from
    /// any thread; no-op if the worker hasn't installed its handle yet.
    pub fn stop(&self) {
        if let Some(handle) = self.isolate_handle.lock().unwrap().as_ref() {
            handle.terminate_execution();
        }
    }
}

fn run_worker(
    mut rx: mpsc::Receiver<Request>,
    handle_slot: Arc<Mutex<Option<v8::IsolateHandle>>>,
) {
    // Each worker thread owns its own current-thread tokio runtime — the V8
    // futures aren't `Send`, so they need to stay on this thread.
    let tokio_rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime for V8 worker");

    tokio_rt.block_on(async move {
        let mut runtime = build_runtime(&handle_slot);
        let mut counter: u64 = 0;

        while let Some(req) = rx.recv().await {
            counter += 1;
            if counter > RECYCLE_EVERY {
                runtime = build_runtime(&handle_slot);
                counter = 1;
            }

            let result = run_one(&mut runtime, req.code, counter).await;
            let _ = req
                .reply
                .send(result.map_err(|e| format_err(&e)));
        }
    });
}

fn build_runtime(handle_slot: &Arc<Mutex<Option<v8::IsolateHandle>>>) -> JsRuntime {
    let mut runtime = JsRuntime::new(RuntimeOptions {
        module_loader: Some(Rc::new(RunjsModuleLoader::new())),
        extensions: vec![runjs_ext::init()],
        ..Default::default()
    });

    let store: CaptureStore = Default::default();
    runtime.op_state().borrow_mut().put::<CaptureStore>(store);

    runtime
        .execute_script("[runjs:inspector]", INSPECTOR_JS)
        .expect("install inspector preamble");

    // Publish the isolate handle so external threads can call
    // terminate_execution() (the Stop button).
    let handle = runtime.v8_isolate().thread_safe_handle();
    *handle_slot.lock().unwrap() = Some(handle);

    runtime
}

async fn run_one(
    runtime: &mut JsRuntime,
    code: String,
    seq: u64,
) -> Result<Vec<LineResult>> {
    // 1. Clear any leftover termination flag from the previous Stop click.
    runtime.v8_isolate().cancel_terminate_execution();

    // 2. Clear the captures store in place — same Rc, just empty.
    let store = runtime
        .op_state()
        .borrow()
        .borrow::<CaptureStore>()
        .clone();
    store.borrow_mut().clear();

    // 3. Transpile + instrument outside V8 — SWC is fast and we don't want
    //    syntax errors to ever reach the isolate.
    let instrumented = transpile_and_instrument(&code)?;

    // 4. Load as a SIDE module so we can repeat: main modules can only be
    //    evaluated once per runtime. Unique URL per seq keeps the registry
    //    happy.
    let specifier = entry_specifier(seq)?;
    let mod_id = runtime
        .load_side_es_module_from_code(&specifier, instrumented)
        .await?;
    let eval = runtime.mod_evaluate(mod_id);
    runtime.run_event_loop(Default::default()).await?;
    eval.await?;

    let captures = store.borrow();
    Ok(group_by_line(&captures))
}

fn entry_specifier(seq: u64) -> Result<deno_core::ModuleSpecifier> {
    let cwd = std::env::current_dir()?;
    let base = deno_core::url::Url::from_directory_path(&cwd)
        .map_err(|_| anyhow!("cwd is not a valid file URL: {}", cwd.display()))?;
    Ok(base.join(&format!("runjs_input_{seq}.js"))?)
}

/// V8 termination surfaces as a particular error string — translate it into
/// something the UI can show cleanly.
fn format_err(e: &anyhow::Error) -> String {
    let s = e.to_string();
    if s.contains("execution terminated") {
        "stopped".to_string()
    } else {
        s
    }
}
