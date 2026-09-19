// Builds the Pyodide worker's source as a string, the same way dewstack's
// site-editor.js builds its iframe RELAY script: code for a different
// execution context, embedded as text rather than imported as a module,
// because it has to end up runnable from a Blob URL inside dewnote's
// single-file build — there is no separate worker.js file on disk to
// point a real `new Worker(url)` at once everything is one HTML file.
// Bun's bundler doesn't follow a `new Worker(new URL(...))` reference the
// way Vite's does (checked directly against a browser-target build,
// which left the reference unresolved rather than producing a second
// chunk), so a hand-authored string is the plain fix, not a workaround.
//
// This is a trimmed adaptation of dewlab's assets/pyodide-worker.js —
// boot, run a cell, and support Stop — not a port of its filesystem
// mounting or autocomplete message types, none of which dewnote's cells
// need yet. See DECISIONS.md for the fuller comparison. SQL cells
// (run-sql/reset-sql) are dewstack's own convention, not dewlab's;
// dewnote_sql_tools.py is a trimmed adaptation of dewstack's own
// sql_tools.py, sharing this same one Pyodide interpreter rather than a
// second one, the same way dewstack's SQL and exec cells do.
//
// Because this is a plain string, not a module TypeScript can check, keep
// it as small and literal as reasonably possible — anything that can live
// in real, type-checked TypeScript instead (the main-thread side, in
// pyodide-engine.ts) should.

import pythonToolsSource from "./dewnote_tools.py" with { type: "text" };
import sqlToolsSource from "./dewnote_sql_tools.py" with { type: "text" };

// Nothing loads eagerly at boot any more — a document that never imports
// pandas or matplotlib shouldn't pay for either. runCell's own
// loadPackagesFromImports call (Pyodide's own mechanism for this) loads
// exactly what a given cell's `import` lines ask for, the first time it
// asks for it, and is a no-op every time after.
export const DEFAULT_PACKAGES: string[] = [];

export function buildWorkerSource(): string {
  const pythonSourceLiteral = JSON.stringify(pythonToolsSource);
  const sqlSourceLiteral = JSON.stringify(sqlToolsSource);
  return `
"use strict";

let pyodide = null;
let tools = null;
let sqlTools = null;
let sqliteLoading = null;
let matplotlibConfigured = false;
let sharedDbSeeded = false;

function post(message) {
  self.postMessage(message);
}

function respond(id, result) {
  post({ type: "response", id, result });
}

function fail(id, error) {
  post({ type: "response", id, error: String((error && error.message) || error) });
}

async function boot(msg) {
  post({ type: "status", text: "Loading Python…" });
  const { loadPyodide } = await import(msg.pyodideBase + "pyodide.mjs");
  pyodide = await loadPyodide({ indexURL: msg.pyodideBase });

  if (msg.packages && msg.packages.length) {
    post({ type: "status", text: "Loading packages…" });
    await pyodide.loadPackage(msg.packages);
  }

  pyodide.FS.writeFile("/home/pyodide/dewnote_tools.py", ${pythonSourceLiteral}, { encoding: "utf8" });
  tools = pyodide.pyimport("dewnote_tools");
}

async function runCell(msg) {
  await pyodide.loadPackagesFromImports(msg.code, {
    messageCallback: (text) => post({ type: "status", text }),
  });
  if (!matplotlibConfigured && pyodide.loadedPackages && pyodide.loadedPackages["matplotlib"]) {
    await pyodide.runPythonAsync("import matplotlib; matplotlib.use('AGG')");
    matplotlibConfigured = true;
  }
  // A cell reading a SQL cell's table (dewnote_tools.py's read_sql,
  // pre-seeded into every exec cell's namespace) isn't a Python import
  // line loadPackagesFromImports can see — the literal substring check
  // is a plain heuristic standing in for it, same limitation dewstack's
  // own build-time "a py cell= on this page always gets sqlite3" rule
  // has, just applied per cell instead of per page.
  if (msg.code.indexOf("read_sql(") !== -1 || msg.sql) {
    await ensureSqlTools();
    if (!pyodide.loadedPackages || !pyodide.loadedPackages["pandas"]) {
      post({ type: "status", text: "Loading pandas…" });
      await pyodide.loadPackage(["pandas"]);
    }
  }
  // A sql exec cell (msg.sql, set by pyodide-engine.ts's own runCell
  // call — dewnote_sql_tools.run_sql_cell's own first argument, wrapped
  // into the cell's code by cell.ts's wrapSqlExecCode) needs the one
  // shared, page-wide "db" connection dewlab's own sql exec model uses
  // (DIALECTS.md §1) seeded into the same namespace every python exec
  // cell already shares — seeded once, lazily, on whichever cell (SQL
  // or Python) actually needs it first, the same "pay for what's used"
  // discipline read_sql's own sqlite3 load already follows.
  if (msg.sql && !sharedDbSeeded) {
    // This code lives inside the JavaScript source string returned by
    // buildWorkerSource. Keep the newline escaped in that generated
    // program; a literal newline inside its quoted string prevents the
    // worker from parsing, which leaves every Python cell at “Running…”.
    await pyodide.runPythonAsync("import sqlite3, dewnote_tools\\ndewnote_tools._page_globals['db'] = sqlite3.connect(':memory:')");
    sharedDbSeeded = true;
  }
  post({ type: "status", text: "" });
  const emit = (kind, cssClass, text, markup) =>
    post({ type: "output", cellId: msg.cellId, kind, cssClass, text, markup });
  const ok = await tools.run_cell(msg.cellId, emit, msg.code);
  return { ok: !!ok };
}

// sqlite3 is only ever loaded once, on the first SQL cell any page
// actually runs — a document with no sql cell= fence never pays for it,
// the same "load what's actually used" discipline as runCell's own
// loadPackagesFromImports, just triggered by a different kind of cell
// instead of a Python import line.
async function ensureSqlTools() {
  if (sqlTools) return;
  if (!sqliteLoading) sqliteLoading = pyodide.loadPackage(["sqlite3"]);
  await sqliteLoading;
  pyodide.FS.writeFile("/home/pyodide/dewnote_sql_tools.py", ${sqlSourceLiteral}, { encoding: "utf8" });
  sqlTools = pyodide.pyimport("dewnote_sql_tools");
}

async function runSql(msg) {
  await ensureSqlTools();
  return { html: sqlTools.run_sql(msg.dbName, msg.sql) };
}

async function resetSql(msg) {
  await ensureSqlTools();
  sqlTools.reset(msg.dbName);
  return true;
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === "set-interrupt-buffer") {
    if (pyodide) pyodide.setInterruptBuffer(new Int32Array(msg.buffer));
    return;
  }
  try {
    let result;
    if (msg.type === "boot") {
      await boot(msg);
      result = true;
    } else if (msg.type === "run-cell") {
      result = await runCell(msg);
    } else if (msg.type === "run-sql") {
      result = await runSql(msg);
    } else if (msg.type === "reset-sql") {
      result = await resetSql(msg);
    } else {
      throw new Error("unknown message type: " + msg.type);
    }
    respond(msg.id, result);
  } catch (err) {
    fail(msg.id, err);
  }
};
`;
}
