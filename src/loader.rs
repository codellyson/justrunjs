//! Module loader for runjs-rs.
//!
//! Replaces `NoopModuleLoader` so user code can use `import` statements.
//! Supported schemes:
//!
//! - `file://` — read from disk; `.ts` / `.tsx` / `.mts` transpiled via SWC.
//! - `https://` / `http://` — fetched via reqwest; transpiled if the URL path
//!   ends in `.ts` / `.tsx` / `.mts`.
//! - `npm:pkg[@ver][/sub]` — rewritten to `https://esm.sh/pkg[@ver][/sub]` at
//!   resolve time; the rest of the load + cache path is the ordinary https://
//!   case.
//!
//! Bare specifiers (`import x from "lodash"`) and other schemes are rejected
//! — use the explicit `npm:` form for npm packages.
//!
//! Each fresh `JsRuntime` (we build one per `evaluate` call) consults a
//! process-wide in-memory cache, so the cost of a network fetch is paid once
//! per URL per process lifetime, not once per keystroke.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use deno_core::futures::FutureExt;
use deno_core::{
    resolve_import, ModuleLoadOptions, ModuleLoadReferrer, ModuleLoadResponse, ModuleLoader,
    ModuleResolveResponse, ModuleSource, ModuleSourceCode, ModuleSpecifier, ModuleType,
    ResolutionKind,
};
use deno_error::JsErrorBox;

use crate::instrument::transpile_only;

pub struct RunjsModuleLoader;

impl RunjsModuleLoader {
    pub fn new() -> Self {
        Self
    }
}

/// Process-wide cache of loaded module source, keyed by resolved URL.
/// First load over the network; subsequent loads (e.g. on the next eval
/// triggered by a keystroke) hit memory.
fn cache() -> &'static Mutex<HashMap<String, String>> {
    static C: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn looks_like_typescript(url: &ModuleSpecifier) -> bool {
    let path = url.path();
    path.ends_with(".ts") || path.ends_with(".tsx") || path.ends_with(".mts")
}

async fn load_source(url: ModuleSpecifier) -> Result<String, JsErrorBox> {
    let key = url.to_string();

    if let Some(hit) = cache().lock().unwrap().get(&key).cloned() {
        return Ok(hit);
    }

    let raw = match url.scheme() {
        "file" => {
            let path = url.to_file_path().map_err(|_| {
                JsErrorBox::generic(format!("invalid file URL: {key}"))
            })?;
            std::fs::read_to_string(&path).map_err(|e| {
                JsErrorBox::generic(format!("could not read {}: {e}", path.display()))
            })?
        }
        "https" | "http" => {
            let resp = reqwest::get(url.as_str())
                .await
                .map_err(|e| JsErrorBox::generic(format!("fetch {key}: {e}")))?;
            let status = resp.status();
            if !status.is_success() {
                return Err(JsErrorBox::generic(format!("fetch {key}: HTTP {status}")));
            }
            resp.text()
                .await
                .map_err(|e| JsErrorBox::generic(format!("read body {key}: {e}")))?
        }
        scheme => {
            return Err(JsErrorBox::generic(format!(
                "unsupported import scheme '{scheme}:' for {key}"
            )));
        }
    };

    let js = if looks_like_typescript(&url) {
        transpile_only(&raw)
            .map_err(|e| JsErrorBox::generic(format!("transpile {key}: {e}")))?
    } else {
        raw
    };

    cache().lock().unwrap().insert(key, js.clone());
    Ok(js)
}

impl ModuleLoader for RunjsModuleLoader {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        _kind: ResolutionKind,
    ) -> ModuleResolveResponse {
        // npm: specifiers route through esm.sh, which serves npm packages as
        // ESM modules. The remaining load/cache path is identical to the
        // ordinary https:// case.
        if let Some(rest) = specifier.strip_prefix("npm:") {
            let rewritten = format!("https://esm.sh/{rest}");
            return resolve_import(&rewritten, referrer).map_err(JsErrorBox::from_err);
        }
        resolve_import(specifier, referrer).map_err(JsErrorBox::from_err)
    }

    fn load(
        &self,
        module_specifier: &ModuleSpecifier,
        _maybe_referrer: Option<&ModuleLoadReferrer>,
        _options: ModuleLoadOptions,
    ) -> ModuleLoadResponse {
        let url = module_specifier.clone();
        let fut = async move {
            let code = load_source(url.clone()).await?;
            Ok(ModuleSource::new(
                ModuleType::JavaScript,
                ModuleSourceCode::String(code.into()),
                &url,
                None,
            ))
        }
        .boxed_local();
        ModuleLoadResponse::Async(fut)
    }
}
