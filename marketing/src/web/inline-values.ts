// Values shown at the end of their source lines (`⇒ value`, or `✕ message` for an error),
// with "show all" opening a multi-line value in full under its line.
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

export type InlineValue = { line: number; text: string; error?: boolean; expandable?: boolean };

/** Replace every inline value in the editor. */
export const setInlineValues = StateEffect.define<InlineValue[]>();
const toggleExpanded = StateEffect.define<number>();

/** A multi-line value shown in full, as a block under its line. */
class FullValueWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: FullValueWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const pre = document.createElement("pre");
    pre.className = "cm-full-value";
    pre.textContent = this.text;
    return pre;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

class InlineValueWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly error = false,
    readonly line = 0,
    readonly expandable = false,
    readonly open = false, // part of equality, so toggling redraws the button
  ) {
    super();
  }
  eq(other: InlineValueWidget): boolean {
    return (
      other.text === this.text && other.error === this.error && other.line === this.line &&
      other.expandable === this.expandable && other.open === this.open
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-inline-value" + (this.error ? " cm-inline-error" : "");
    const firstLine = this.text.split("\n")[0];
    const more = this.text.includes("\n");
    span.textContent = (this.error ? "  ✕ " : "  ⇒ ") + firstLine + (more && !this.expandable ? " …" : "");
    if (this.expandable) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "cm-value-toggle";
      toggle.textContent = this.open ? "hide" : "show all";
      toggle.setAttribute("aria-expanded", String(this.open));
      toggle.addEventListener("mousedown", (e) => e.preventDefault()); // keep the caret where it is
      toggle.addEventListener("click", () => view.dispatch({ effects: toggleExpanded.of(this.line) }));
      span.append(" ", toggle);
    }
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

interface InlineState {
  values: InlineValue[];
  expanded: Set<number>;
  deco: DecorationSet;
}

function build(state: EditorState, values: InlineValue[], expanded: Set<number>): DecorationSet {
  const ranges = [];
  for (const { line, text, error, expandable } of values) {
    if (line < 1 || line > state.doc.lines) continue;
    const { from, to } = state.doc.line(line);
    if (error) ranges.push(Decoration.line({ class: "cm-error-line" }).range(from));
    ranges.push(
      Decoration.widget({
        widget: new InlineValueWidget(text, error, line, expandable, expanded.has(line)),
        side: 1,
      }).range(to),
    );
    if (expandable && expanded.has(line)) {
      ranges.push(Decoration.widget({ widget: new FullValueWidget(text), block: true, side: 2 }).range(to));
    }
  }
  return Decoration.set(ranges, true);
}

/** Add to an editor's extensions; fill it with `setInlineValues`. */
export const inlineValuesField = StateField.define<InlineState>({
  create: () => ({ values: [], expanded: new Set(), deco: Decoration.none }),
  update(s, tr) {
    let { values, expanded } = s;
    let deco = s.deco.map(tr.changes);
    let rebuild = false;
    for (const e of tr.effects) {
      if (e.is(setInlineValues)) {
        values = e.value;
        rebuild = true;
      } else if (e.is(toggleExpanded)) {
        expanded = new Set(expanded);
        if (expanded.has(e.value)) expanded.delete(e.value);
        else expanded.add(e.value);
        rebuild = true;
      }
    }
    if (rebuild) deco = build(tr.state, values, expanded);
    return rebuild || deco !== s.deco ? { values, expanded, deco } : s;
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.deco),
});
