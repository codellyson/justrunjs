//! TypeScript -> instrumented JavaScript, using SWC for parsing, AST rewriting,
//! type stripping, and code generation.
//!
//! Pipeline:
//!   1. Parse the source as TypeScript into a `Module` AST (spans intact).
//!   2. Walk the top-level `module.body` and wrap "interesting" statements so
//!      their evaluated value flows through `__capture(<line>, <value>)`.
//!      The line number is read from the ORIGINAL source span and baked in as a
//!      numeric literal, so it survives later transforms.
//!   3. Run the resolver + TypeScript strip passes to erase type annotations.
//!   4. Emit JavaScript text.
//!
//! `__capture` is identity at runtime (returns its 2nd argument), so wrapping is
//! semantically transparent — we can wrap a `const` initializer or a bare
//! expression statement without changing what the program does.

use anyhow::{anyhow, Result};
use swc_core::common::{
    sync::Lrc, FileName, Globals, Mark, SourceMap, SyntaxContext, DUMMY_SP, GLOBALS,
};
use swc_core::ecma::ast::*;
use swc_core::ecma::codegen::{text_writer::JsWriter, Config as CodegenConfig, Emitter};
use swc_core::ecma::parser::{lexer::Lexer, Parser, StringInput, Syntax, TsSyntax};
use swc_core::ecma::transforms::base::resolver;
use swc_core::ecma::transforms::typescript::strip;

/// Transpile a TS snippet and instrument it. Returns runnable ESM JavaScript.
pub fn transpile_and_instrument(source: &str) -> Result<String> {
    let globals = Globals::default();
    GLOBALS.set(&globals, || {
        let cm: Lrc<SourceMap> = Default::default();
        let fm = cm.new_source_file(
            Lrc::new(FileName::Custom("input.ts".into())),
            source.to_string(),
        );

        // --- 1. Parse as TypeScript ---
        let lexer = Lexer::new(
            Syntax::Typescript(TsSyntax::default()),
            EsVersion::EsNext,
            StringInput::from(&*fm),
            None,
        );
        let mut parser = Parser::new_from(lexer);
        let mut module = parser
            .parse_module()
            .map_err(|e| anyhow!("parse error: {:?}", e.kind()))?;

        // --- 2. Instrument top-level statements (uses original spans) ---
        instrument_module(&mut module, &cm);

        // --- 3. Strip TypeScript types ---
        let unresolved_mark = Mark::new();
        let top_level_mark = Mark::new();
        let mut program = Program::Module(module);
        program.mutate(resolver(unresolved_mark, top_level_mark, true));
        program.mutate(strip(unresolved_mark, top_level_mark));
        let module = match program {
            Program::Module(m) => m,
            _ => unreachable!(),
        };

        // --- 4. Emit JavaScript ---
        let mut buf = Vec::new();
        {
            let writer = JsWriter::new(cm.clone(), "\n", &mut buf, None);
            let mut emitter = Emitter {
                cfg: CodegenConfig::default(),
                cm: cm.clone(),
                comments: None,
                wr: writer,
            };
            emitter
                .emit_module(&module)
                .map_err(|e| anyhow!("codegen error: {e}"))?;
        }
        Ok(String::from_utf8(buf)?)
    })
}

fn instrument_module(module: &mut Module, cm: &Lrc<SourceMap>) {
    for item in module.body.iter_mut() {
        if let ModuleItem::Stmt(stmt) = item {
            instrument_stmt(stmt, cm);
        }
    }
}

/// 1-based line number for a span's start.
fn line_of(cm: &Lrc<SourceMap>, span: swc_core::common::Span) -> u32 {
    cm.lookup_char_pos(span.lo()).line as u32
}

fn instrument_stmt(stmt: &mut Stmt, cm: &Lrc<SourceMap>) {
    match stmt {
        // Bare expression statement: `foo + 1;`  /  `await fetch(...)`
        // -> `__capture(line, foo + 1);`
        //
        // Exception: skip top-level `console.X(...)` calls. The console methods
        // are overridden in inspector.js to capture their args directly — if we
        // also wrapped, we'd emit a redundant `undefined` (the log call's
        // return value) for the same line.
        Stmt::Expr(expr_stmt) => {
            if is_console_call(&expr_stmt.expr) {
                return;
            }
            let line = line_of(cm, expr_stmt.span);
            let inner = std::mem::replace(&mut expr_stmt.expr, undefined_expr());
            expr_stmt.expr = Box::new(capture_call(line, inner));
        }
        // Variable declaration: `const x = 5;` -> `const x = __capture(line, 5);`
        // Each declarator is captured at its own line.
        Stmt::Decl(Decl::Var(var)) => {
            for decl in var.decls.iter_mut() {
                if let Some(init) = decl.init.take() {
                    let line = line_of(cm, decl.span);
                    decl.init = Some(Box::new(capture_call(line, init)));
                }
            }
        }
        _ => {}
    }
}

/// True if `expr` is `console.<log|info|warn|error|debug>(...)`.
fn is_console_call(expr: &Expr) -> bool {
    let Expr::Call(call) = expr else { return false };
    let Callee::Expr(callee) = &call.callee else { return false };
    let Expr::Member(member) = callee.as_ref() else { return false };
    let Expr::Ident(obj) = member.obj.as_ref() else { return false };
    if obj.sym.as_str() != "console" {
        return false;
    }
    let MemberProp::Ident(prop) = &member.prop else { return false };
    matches!(prop.sym.as_str(), "log" | "info" | "warn" | "error" | "debug")
}

/// Build `__capture(<line>, <expr>)`.
fn capture_call(line: u32, expr: Box<Expr>) -> Expr {
    Expr::Call(CallExpr {
        span: DUMMY_SP,
        ctxt: SyntaxContext::empty(),
        callee: Callee::Expr(Box::new(Expr::Ident(ident("__capture")))),
        args: vec![
            ExprOrSpread {
                spread: None,
                expr: Box::new(Expr::Lit(Lit::Num(Number {
                    span: DUMMY_SP,
                    value: line as f64,
                    raw: None,
                }))),
            },
            ExprOrSpread { spread: None, expr },
        ],
        type_args: None,
    })
}

fn ident(name: &str) -> Ident {
    Ident {
        span: DUMMY_SP,
        ctxt: SyntaxContext::empty(),
        sym: name.into(),
        optional: false,
    }
}

fn undefined_expr() -> Box<Expr> {
    Box::new(Expr::Ident(ident("undefined")))
}
