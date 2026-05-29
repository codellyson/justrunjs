//! CLI front-end for the runjs-rs core.
//!
//!   echo 'const m = new Map(); m.set("a", 1); m;' | cargo run
//!   cargo run -- path/to/snippet.ts
//!
//! Prints the user's source with each top-level line's evaluated value shown
//! inline to the right, RunJS-style. Pass `--show-instrumented` to also dump the
//! JS that SWC produced after the instrumentation pass.

use std::io::Read;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let show_instrumented = args.iter().any(|a| a == "--show-instrumented");
    let path = args.iter().find(|a| !a.starts_with("--"));

    let source = match path {
        Some(p) => std::fs::read_to_string(p).unwrap_or_else(|e| {
            eprintln!("cannot read {p}: {e}");
            std::process::exit(1);
        }),
        None => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s).expect("read stdin");
            if s.trim().is_empty() {
                s = DEMO.to_string();
            }
            s
        }
    };

    if show_instrumented {
        match runjs_rs::instrument_only(&source) {
            Ok(js) => {
                println!("// ---- instrumented JS ----");
                println!("{js}");
                println!("// -------------------------");
            }
            Err(e) => eprintln!("instrument error: {e}"),
        }
    }

    match runjs_rs::evaluate(&source) {
        Ok(results) => print_inline(&source, &results),
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}

/// Render source lines on the left, captured values on the right (`// =>`).
fn print_inline(source: &str, results: &[runjs_rs::LineResult]) {
    let width = source.lines().map(|l| l.len()).max().unwrap_or(0).max(20);
    for (i, line) in source.lines().enumerate() {
        let n = (i + 1) as u32;
        let value = results.iter().find(|r| r.line == n).map(|r| &r.display);
        match value {
            Some(v) => println!("{line:<width$}  // => {v}"),
            None => println!("{line}"),
        }
    }
}

const DEMO: &str = r#"const greeting: string = "hello";
greeting.toUpperCase();

const m = new Map<string, { name: string }>();
m.set("test1", { name: "Isaac" });
m;

const s = new Set([1, 2, 2, 3]);
s;

const total = await Promise.resolve(40 + 2);
total;
"#;
