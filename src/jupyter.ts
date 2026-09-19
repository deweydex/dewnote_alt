// Step 6's second slice (plan §5.8): nbformat 4.5 JSON, in and out.
// "The dewlab cell id becomes the nbformat cell id... and hint: and the
// fence info string go in cell metadata under a dewnote key so the
// round trip back is lossless" — done here in the simplest way that is
// actually lossless, rather than one that reconstructs a fence's exact
// bytes from parsed pieces (id, hint, info, header order) and hopes
// nothing was unusual: every cell also carries `metadata.dewnote.raw`,
// the block's own exact original text, straight from blocks.ts. Import
// plays that back verbatim when it's present, which is always, for any
// document this module itself exported — the same "never reconstruct
// what you can just keep" discipline blocks.ts's own round-trip
// guarantee already runs on. A notebook with no such metadata (created
// directly in Jupyter, not round-tripped through dewnote) falls back to
// a best-effort reconstruction instead, since there is no original text
// to play back.
//
// Left out of this slice, honestly rather than by oversight: dewstack's
// SQL, `py cell=`, and `site=`/`app=` cells export as illustrative code
// (never marked runnable, whatever their own fence info says) — this
// only knows dewlab's `exec` convention (DIALECTS.md §1), and a real
// SQL-in-Jupyter story needs a setup cell this slice doesn't build.

import { parseDocument, type Block } from "./blocks.ts";
import { isRunnableFence, parseCellSource } from "./cell.ts";

export type CellType = "markdown" | "code" | "raw";

export interface NotebookCell {
  cell_type: CellType;
  id: string;
  metadata: { dewnote: DewnoteCellMeta } & Record<string, unknown>;
  /** nbformat allows either a plain string or an array of lines for a
   * cell's source — this module always writes a plain string, but
   * accepts either on the way in, since a real notebook (Jupyter's own
   * export, not dewnote's) is just as likely to use the array form. */
  source: string | string[];
  execution_count?: null;
  outputs?: unknown[];
}

export interface DewnoteCellMeta {
  /** The block's exact original text — the whole of what makes import
   * lossless. Never shown to a reader of the notebook; Jupyter itself
   * ignores metadata keys it doesn't recognise. */
  raw: string;
  kind: Block["kind"];
  info?: string;
  hint?: string | null;
}

export interface Notebook {
  nbformat: 4;
  nbformat_minor: 5;
  metadata: Record<string, unknown>;
  cells: NotebookCell[];
}

function fallbackId(index: number): string {
  return `dewnote-${index}`;
}

function exportBlock(block: Block, index: number): NotebookCell {
  if (block.kind === "fence") {
    const info = block.fence?.info ?? "";
    const runnable = isRunnableFence(info);
    // parseCellSource's header-stripping is a dewlab exec-cell reading —
    // applying it to an illustrative fence risks mistaking an ordinary
    // "key: value" line inside a code sample for a header, so only a
    // runnable fence gets it; anything else keeps its whole body as-is.
    const { id, hint, code } = runnable
      ? parseCellSource(block)
      : { id: null, hint: null, code: fenceBodyVerbatim(block.text) };
    return {
      cell_type: "code",
      id: id ?? fallbackId(index),
      metadata: { dewnote: { raw: block.text, kind: "fence", info, hint } },
      source: code,
      execution_count: null,
      outputs: [],
    };
  }
  return {
    cell_type: block.kind === "frontmatter" ? "raw" : "markdown",
    id: fallbackId(index),
    metadata: { dewnote: { raw: block.text, kind: block.kind } },
    source: block.text,
  };
}

/** The same "everything between the fence lines" extraction cell.ts's
 * own sqlScriptFromFenceText does — reimplemented locally rather than
 * imported under a SQL-specific name for a call site that has nothing
 * to do with SQL. */
function fenceBodyVerbatim(fenceText: string): string {
  const lines = fenceText.split("\n");
  let end = lines.length - 1;
  while (end > 0 && lines[end] === "") end--;
  return lines.slice(1, end).join("\n");
}

export function exportToNotebook(source: string): Notebook {
  const doc = parseDocument(source);
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: doc.blocks.map(exportBlock),
  };
}

function cellSourceText(source: string | string[]): string {
  return Array.isArray(source) ? source.join("") : source;
}

/** A notebook cell with no `dewnote.raw` — either hand-authored in
 * Jupyter, or exported from a future dewnote that changed this format —
 * gets a plausible reconstruction rather than a thrown error: a code
 * cell becomes a fresh dewlab-style exec fence (its own `id` field is
 * nbformat's, so it becomes the `id:` header the same convention would
 * write), everything else passes through as markdown, blank-line
 * separated from its neighbours the way blocks.ts's own prose rule
 * expects. */
function reconstructForeignCell(cell: NotebookCell): string {
  const source = cellSourceText(cell.source);
  if (cell.cell_type === "code") {
    const body = source.endsWith("\n") ? source : `${source}\n`;
    return `\`\`\`python exec\nid: ${cell.id}\n${body}\`\`\`\n\n`;
  }
  return source.endsWith("\n") ? source : `${source}\n`;
}

export function importFromNotebook(notebook: Notebook): string {
  return notebook.cells
    .map((cell) => {
      const raw = cell.metadata?.dewnote?.raw;
      return typeof raw === "string" ? raw : reconstructForeignCell(cell);
    })
    .join("");
}

/** `importFromNotebook(exportToNotebook(source))`, named for what it
 * proves — the plan's own "done when" line for this step: "a tutorial
 * survives markdown → ipynb → markdown unchanged." Exists mostly so
 * jupyter.test.ts can assert the identity by name rather than the two
 * calls spelled out at every use. */
export function roundTripThroughNotebook(source: string): string {
  return importFromNotebook(exportToNotebook(source));
}
