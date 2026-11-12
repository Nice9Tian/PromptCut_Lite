/**
 * Gatekeeper: Node built-in modules (`node:*` or bare names like `fs`, `crypto`) are not allowed
 * in static dependency chains of pages (editor page and stage page, entry point `src/main.tsx`).
 * Run: node --test src/pageNodeImports.test.mjs
 *
 * Approach: starting from `src/main.tsx`, follow **static** import / re-export (`import type` and
 * `export type` do not count; `import()` is on-demand loading and is not followed), traverse all
 * in-repo modules that will be loaded (following both `src/` and `server/`); flag as red whenever
 * a Node built-in module is encountered and provide the reference chain. Package names (`react`, etc.)
 * are not followed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const ENTRY = path.join(ROOT, "src", "main.tsx");
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");
const EXTS = ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx", "/index.mjs", "/index.js"];
const BUILTIN = new Set(builtinModules.flatMap((m) => [m, m.split("/")[0]]));

function resolveFrom(fromAbs, spec) {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  const clean = spec.split("?")[0];
  const base = clean.startsWith("/") ? path.join(ROOT, clean) : path.resolve(path.dirname(fromAbs), clean);
  for (const e of EXTS) {
    const p = base + e;
    try { if (fs.statSync(p).isFile()) return p; } catch { /* Next */ }
  }
  return null;
}

/** Static import / re-export in source code (excluding `import type`, `export type`) */
function staticSpecs(text) {
  const out = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  for (const m of code.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s+(type\s+)?(?:[\w*${}\s,]*?\s+from\s+)?["']([^"']+)["']/g)) {
    if (!m[1]) out.push(m[2]);
  }
  return out;
}

const isNodeBuiltin = (spec) => spec.startsWith("node:") || BUILTIN.has(spec) || BUILTIN.has(spec.split("/")[0]) && !spec.includes(".");

test("the page's static dependency chain has no Node built-in modules (otherwise the dev server shows a blank page)", () => {
  assert.ok(fs.existsSync(ENTRY), "entry src/main.tsx exists");
  const parent = new Map([[ENTRY, null]]);
  const queue = [ENTRY];
  const bad = [];
  let visited = 0;
  while (queue.length) {
    const file = queue.shift();
    visited++;
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const spec of staticSpecs(text)) {
      if (isNodeBuiltin(spec)) {
        const chain = [];
        for (let f = file; f; f = parent.get(f)) chain.unshift(rel(f));
        bad.push(`${spec} ← ${chain.join(" → ")}`);
        continue;
      }
      const next = resolveFrom(file, spec);
      if (!next || parent.has(next) || /\.(css|json|svg|png|woff2?)$/.test(next)) continue;
      parent.set(next, file);
      queue.push(next);
    }
  }
  assert.ok(visited > 100, `reached page modules: ${visited}`);
  assert.deepEqual(bad, [], `Node built-in modules appear in the page's static dependency chain:\n${bad.join("\n")}`);
});
