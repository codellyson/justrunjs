//! runjs-rs — a minimal proof-of-concept of a RunJS-style live scratchpad core.
//!
//! Public entry point: [`evaluate`]. Give it a TypeScript snippet; get back the
//! inline value produced at each top-level line, formatted like Node's
//! `util.inspect` (so a `Map` reads as `Map(1) { 'k' => 'v' }`, not `{}`).
//!
//! The flow is: transpile + instrument with SWC -> run in V8 (deno_core) ->
//! collect per-line captures -> hand them back grouped by line.

mod instrument;
mod loader;
mod runtime;
mod worker;

pub use worker::EvalWorker;

use anyhow::Result;
use serde::Serialize;

/// One inline result, as it would appear in the editor gutter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LineResult {
    /// 1-based source line.
    pub line: u32,
    /// Inspector-formatted value(s) for that line. If a line produced multiple
    /// captures (e.g. a loop body), they are joined in execution order.
    pub display: String,
}

/// Evaluate a TS/JS snippet and return inline results, ordered by line.
pub fn evaluate(source: &str) -> Result<Vec<LineResult>> {
    let instrumented = instrument::transpile_and_instrument(source)?;
    let store: runtime::CaptureStore = Default::default();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(runtime::execute(instrumented, store.clone()))?;

    let captures = store.borrow();
    Ok(group_by_line(&captures))
}

/// For debugging / the DESIGN doc: see the instrumented JS for a snippet.
pub fn instrument_only(source: &str) -> Result<String> {
    instrument::transpile_and_instrument(source)
}

pub(crate) fn group_by_line(captures: &[(u32, String)]) -> Vec<LineResult> {
    let mut out: Vec<LineResult> = Vec::new();
    for (line, display) in captures {
        match out.iter_mut().find(|r| r.line == *line) {
            Some(existing) => {
                existing.display.push_str(", ");
                existing.display.push_str(display);
            }
            None => out.push(LineResult {
                line: *line,
                display: display.clone(),
            }),
        }
    }
    out.sort_by_key(|r| r.line);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find(results: &[LineResult], line: u32) -> &str {
        results
            .iter()
            .find(|r| r.line == line)
            .map(|r| r.display.as_str())
            .unwrap_or_else(|| panic!("no result on line {line}: {results:?}"))
    }

    #[test]
    fn primitives_and_expressions() {
        let src = "\
const x = 5;
const y = x * 2;
x + y;
'hello'.toUpperCase();
";
        let r = evaluate(src).unwrap();
        assert_eq!(find(&r, 1), "5");
        assert_eq!(find(&r, 2), "10");
        assert_eq!(find(&r, 3), "15");
        assert_eq!(find(&r, 4), "'HELLO'");
    }

    #[test]
    fn map_is_inspected_not_jsonified() {
        // The headline case: JSON.stringify(map) === "{}". We must do better.
        let src = "\
const m = new Map();
m.set('test1', { name: 'Isaac' });
m;
";
        let r = evaluate(src).unwrap();
        assert_eq!(find(&r, 3), "Map(1) { 'test1' => { name: 'Isaac' } }");
    }

    #[test]
    fn set_and_array_and_nested() {
        let src = "\
new Set([1, 2, 3]);
[1, 'two', { three: 3 }];
({ a: 1, b: [true, null] });
";
        let r = evaluate(src).unwrap();
        assert_eq!(find(&r, 1), "Set(3) { 1, 2, 3 }");
        assert_eq!(find(&r, 2), "[ 1, 'two', { three: 3 } ]");
        assert_eq!(find(&r, 3), "{ a: 1, b: [ true, null ] }");
    }

    #[test]
    fn bigint_symbol_class_instance() {
        let src = "\
10n * 2n;
class Point { x = 1; y = 2; }
new Point();
Symbol('tag');
";
        let r = evaluate(src).unwrap();
        assert_eq!(find(&r, 1), "20n");
        assert_eq!(find(&r, 3), "Point { x: 1, y: 2 }");
        assert_eq!(find(&r, 4), "Symbol(tag)");
    }

    #[test]
    fn circular_reference() {
        let src = "\
const a = { name: 'a' };
a.self = a;
a;
";
        let r = evaluate(src).unwrap();
        assert_eq!(find(&r, 3), "{ name: 'a', self: [Circular *1] }");
    }

    #[test]
    fn typescript_types_are_stripped() {
        let src = "\
interface User { id: number; name: string; }
const u: User = { id: 1, name: 'Ada' };
const ids: number[] = [1, 2, 3];
u;
ids.length;
";
        let r = evaluate(src).unwrap();
        assert_eq!(find(&r, 2), "{ id: 1, name: 'Ada' }");
        assert_eq!(find(&r, 4), "{ id: 1, name: 'Ada' }");
        assert_eq!(find(&r, 5), "3");
    }

    #[test]
    fn top_level_await() {
        let src = "\
const v = await Promise.resolve(42);
v + 1;
";
        let r = evaluate(src).unwrap();
        assert_eq!(find(&r, 1), "42");
        assert_eq!(find(&r, 2), "43");
    }

    #[test]
    fn relative_typescript_import() {
        use std::io::Write;

        // Drop a util.ts under a unique temp dir and import it by absolute
        // file:// URL — sidesteps any CWD coupling between parallel tests.
        let tmp = std::env::temp_dir().join("runjs_test_import");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let util_path = tmp.join("util.ts");
        {
            let mut f = std::fs::File::create(&util_path).unwrap();
            writeln!(
                f,
                "export function greet(name: string): string {{ return `hi ${{name}}`; }}"
            )
            .unwrap();
        }
        let util_url = url::Url::from_file_path(&util_path).unwrap();

        let src = format!(
            "\
import {{ greet }} from \"{util_url}\";
greet(\"Ada\");
"
        );
        let r = evaluate(&src).unwrap();
        assert_eq!(find(&r, 2), "'hi Ada'");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
