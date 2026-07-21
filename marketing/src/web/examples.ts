// Curated learning examples for the browser editor.
//
// Each example opens as a normal editor tab, so the code stays plain,
// runnable TS/JS whose top-level values light up in the results pane. They're
// intentionally small and self-contained — a learner should be able to read
// the whole thing, run it, then start poking at values.
//
// To add one: drop an entry in the right category. `code` should end each
// interesting line with a bare expression so the inline value shows up.

export type ExampleLanguage = "typescript" | "javascript";

interface BaseExample {
  /** Stable id — used for the tab name and as a dedupe key. */
  id: string;
  /** Short human title shown in the library list. */
  title: string;
  /** One-line hint of what the learner will see. */
  blurb: string;
}

/** A single-file scratchpad snippet (opens as a scratchpad tab). */
export interface ScratchpadExample extends BaseExample {
  kind?: "scratchpad";
  language: ExampleLanguage;
  code: string;
}

/** An HTML/CSS/JS bundle (opens as a playground tab with live preview). */
export interface PlaygroundExample extends BaseExample {
  kind: "playground";
  html: string;
  css: string;
  js: string;
}

export type Example = ScratchpadExample | PlaygroundExample;

export interface ExampleCategory {
  /** Section heading in the library panel. */
  name: string;
  examples: Example[];
}

export const EXAMPLE_CATEGORIES: ExampleCategory[] = [
  {
    name: "Basics",
    examples: [
      {
        id: "variables",
        title: "Variables & types",
        blurb: "let / const and what each value evaluates to",
        language: "typescript",
        code: `// Every line's value appears on the right — no console.log needed.

const name = "Ada";
const age = 36;
const isEngineer = true;

// Expressions show their result too:
age + 10;
name + " Lovelace";
isEngineer ? "yes" : "no";
`,
      },
      {
        id: "template-strings",
        title: "Template strings",
        blurb: "Build strings with \${} interpolation",
        language: "javascript",
        code: `const user = "Grace";
const items = 3;

\`Hi \${user}, you have \${items} item\${items === 1 ? "" : "s"}.\`;

// Multi-line works too:
\`Line one
Line two\`;
`,
      },
      {
        id: "numbers-math",
        title: "Numbers & Math",
        blurb: "Arithmetic, rounding, random",
        language: "javascript",
        code: `10 / 3;
Math.round(10 / 3 * 100) / 100;
Math.max(4, 9, 2, 7);
Math.floor(3.9);
2 ** 10;
(0.1 + 0.2).toFixed(2); // classic floating-point gotcha
`,
      },
    ],
  },
  {
    name: "Arrays",
    examples: [
      {
        id: "array-basics",
        title: "Array basics",
        blurb: "push, length, indexing, slice",
        language: "javascript",
        code: `const nums = [1, 2, 3];
nums.push(4);
nums;
nums.length;
nums[0];
nums.slice(1, 3);
`,
      },
      {
        id: "map-filter-reduce",
        title: "map / filter / reduce",
        blurb: "The three you'll use every day",
        language: "javascript",
        code: `const nums = [1, 2, 3, 4, 5];

// Transform each item:
nums.map((n) => n * n);

// Keep only some:
nums.filter((n) => n % 2 === 0);

// Collapse to one value:
nums.reduce((sum, n) => sum + n, 0);

// Chain them:
nums.filter((n) => n > 2).map((n) => n * 10);
`,
      },
      {
        id: "array-sort",
        title: "Sorting",
        blurb: "Why sort() surprises people",
        language: "javascript",
        code: `// Default sort is alphabetical — even for numbers!
[10, 1, 2, 20].sort();

// Use a comparator for numbers:
[10, 1, 2, 20].sort((a, b) => a - b);

// Sort objects by a field:
const people = [{ name: "Zoe", age: 30 }, { name: "Al", age: 25 }];
people.sort((a, b) => a.age - b.age);
`,
      },
    ],
  },
  {
    name: "Objects & data",
    examples: [
      {
        id: "objects",
        title: "Objects",
        blurb: "Access, spread, destructure",
        language: "javascript",
        code: `const book = { title: "Dune", year: 1965 };

book.title;

// Copy + override with spread:
const reissue = { ...book, year: 2021 };
reissue;

// Pull fields out with destructuring:
const { title, year } = book;
title;
year;
`,
      },
      {
        id: "map-set",
        title: "Map & Set",
        blurb: "The inspector shows these properly",
        language: "typescript",
        code: `// A Map keeps insertion order and any key type.
const scores = new Map<string, number>();
scores.set("ada", 42);
scores.set("grace", 99);
scores; // => Map(2) { 'ada' => 42, 'grace' => 99 }

// A Set holds unique values.
const seen = new Set([1, 2, 2, 3, 3, 3]);
seen; // => Set(3) { 1, 2, 3 }
seen.has(2);
`,
      },
      {
        id: "json",
        title: "JSON parse & stringify",
        blurb: "Text <-> objects",
        language: "javascript",
        code: `const obj = { id: 1, tags: ["a", "b"] };

const text = JSON.stringify(obj);
text;

const back = JSON.parse(text);
back.tags;

// Pretty-print with indentation:
JSON.stringify(obj, null, 2);
`,
      },
    ],
  },
  {
    name: "Functions",
    examples: [
      {
        id: "functions",
        title: "Functions & arrows",
        blurb: "Declare, call, default params",
        language: "javascript",
        code: `function add(a, b) {
  return a + b;
}
add(2, 3);

// Arrow function with a default:
const greet = (name = "friend") => \`Hello, \${name}!\`;
greet();
greet("Ada");
`,
      },
      {
        id: "closures",
        title: "Closures",
        blurb: "Functions that remember state",
        language: "javascript",
        code: `function counter() {
  let count = 0;
  return () => ++count; // remembers 'count'
}

const next = counter();
next();
next();
next(); // each call keeps counting

// A second counter is independent:
const other = counter();
other();
`,
      },
    ],
  },
  {
    name: "Async",
    examples: [
      {
        id: "async-await",
        title: "async / await",
        blurb: "Top-level await just works here",
        language: "javascript",
        code: `// This editor supports top-level await.
function delay(value, ms) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const result = await delay("done!", 300);
result;

// Run several at once and wait for all:
await Promise.all([delay(1, 100), delay(2, 100), delay(3, 100)]);
`,
      },
      {
        id: "fetch",
        title: "fetch an API",
        blurb: "Real network request",
        language: "javascript",
        code: `// Fetch live data from a public test API.
const res = await fetch("https://jsonplaceholder.typicode.com/todos/1");
const todo = await res.json();
todo;
todo.title;
`,
      },
    ],
  },
  {
    name: "Playground (HTML/CSS/JS)",
    examples: [
      {
        id: "dom-list",
        kind: "playground",
        title: "Build a list from data",
        blurb: "Render an array into the DOM",
        html: `<h2>Fruit basket</h2>
<ul id="list"></ul>
`,
        css: `body { font-family: system-ui, sans-serif; padding: 24px; color: #1a1a2e; }
h2 { margin-top: 0; }
li { padding: 4px 0; }
`,
        js: `const fruits = ["apple", "banana", "cherry"];
const list = document.getElementById("list");

for (const fruit of fruits) {
  const li = document.createElement("li");
  li.textContent = fruit;
  list.appendChild(li);
}
`,
      },
      {
        id: "css-animation",
        kind: "playground",
        title: "A CSS animation",
        blurb: "Keyframes + a pulsing box",
        html: `<div class="pulse"></div>
<p>Pure CSS — no JS needed.</p>
`,
        css: `body {
  display: grid;
  place-items: center;
  min-height: 90vh;
  font-family: system-ui, sans-serif;
  color: #444;
}
.pulse {
  width: 80px;
  height: 80px;
  border-radius: 16px;
  background: #5b6cff;
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.3); opacity: 0.6; }
}
`,
        js: `// Nothing here — the animation is all CSS.
`,
      },
      {
        id: "canvas-ball",
        kind: "playground",
        title: "Bouncing ball (canvas)",
        blurb: "requestAnimationFrame loop",
        html: `<canvas id="c" width="320" height="200"></canvas>
`,
        css: `body { margin: 0; background: #0b1020; display: grid; place-items: center; min-height: 100vh; }
canvas { background: #10162e; border-radius: 8px; }
`,
        js: `const ctx = document.getElementById("c").getContext("2d");
let x = 40, y = 40, dx = 2.4, dy = 1.8;
const r = 12;

function frame() {
  ctx.clearRect(0, 0, 320, 200);
  x += dx; y += dy;
  if (x < r || x > 320 - r) dx = -dx;
  if (y < r || y > 200 - r) dy = -dy;
  ctx.fillStyle = "#5b6cff";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  requestAnimationFrame(frame);
}
frame();
`,
      },
    ],
  },
  {
    name: "npm packages",
    examples: [
      {
        id: "npm-lodash",
        title: "Import from npm",
        blurb: "Any package, via npm: specifiers",
        language: "typescript",
        code: `// npm: imports are served as ESM on the fly.
import _ from "npm:lodash@4";

_.chunk([1, 2, 3, 4, 5], 2);
_.uniq([1, 1, 2, 3, 3]);
_.groupBy(["one", "two", "three"], (w) => w.length);
`,
      },
    ],
  },
];

/** Flat lookup by id, handy for share/deep-link resolution later. */
export function findExample(id: string): Example | undefined {
  for (const cat of EXAMPLE_CATEGORIES) {
    const hit = cat.examples.find((e) => e.id === id);
    if (hit) return hit;
  }
  return undefined;
}
