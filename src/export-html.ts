// Step 6's first slice (plan §5.8): "the rendered document with the
// stylesheet and KaTeX CSS inlined, cells shown with their last output,
// no runtime — a page to send to someone." Scoped here to rendering: a
// cell's *last output* is not part of dewnote's document model at
// all — it lives only in the live worker and the live DOM for as long as
// a page stays open (Pyodide's own namespace, `runtime/pyodide-engine.ts`),
// never written back into the block text the way an edit is. So this
// exports the rendered *source* faithfully — prose, maths, folds — and a
// fence as a plain, labelled code block, the same honest illustrative
// text a fold's own quoted code already gets (decision 23), rather than
// a captured run this architecture has nowhere to keep between a Run
// click and a later export.


import { parseDocument, type Block } from "./blocks.ts";
import { renderBlockPreview } from "./render-block.ts";
import { detectDialect } from "./dialect.ts";
import { isRunnableFence, parseCellSource, sqlScriptFromFenceText as fenceBodyOnly } from "./cell.ts";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderFenceBlock(block: Block): string {
  const info = block.fence?.info ?? "";
  const language = info.split(/\s+/)[0] || "text";
  // sqlScriptFromFenceText is the same "everything between the fence
  // lines" extraction an exec cell's own parseCellSource builds on —
  // exported under a SQL-specific name there because that was the first
  // caller, but it does exactly what a plain or SQL fence both need here.
  const code = isRunnableFence(info) ? parseCellSource(block).code : fenceBodyOnly(block.text);
  return `<pre><code class="language-${escapeHtml(language)}">${escapeHtml(code)}</code></pre>`;
}

/** Renders a document's blocks to the same HTML shape the live page's
 * own blurred (rendered) state uses — `.dn-block .dn-block-<kind>`
 * wrappers around each, so the inlined stylesheet styles it identically.
 * Pure and unit-tested directly; front matter is never shown, matching
 * the live page (a reader never sees it rendered there either). */
export function renderBlocksToHtml(source: string): string {
  const doc = parseDocument(source);
  const dialect = detectDialect(doc.frontMatter);
  const parts: string[] = [];
  for (const block of doc.blocks) {
    if (block.kind === "frontmatter") continue;
    const inner = block.kind === "fence" ? renderFenceBlock(block) : renderBlockPreview(block, dialect);
    parts.push(`<div class="dn-block dn-block-${block.kind}">${inner}</div>`);
  }
  return parts.join("\n");
}

function titleFrom(source: string): string {
  const doc = parseDocument(source);
  const title = doc.frontMatter.fields["title"];
  return typeof title === "string" && title.trim() ? title.trim() : "Untitled";
}

/**
 * Wraps rendered blocks into one standalone HTML document — `pageCss` is
 * every rule already active on the live page (see `collectPageCss`,
 * export-html's own browser-only half), so the exported page looks like
 * dewnote's own reading surface, including KaTeX's fonts, without a
 * second copy of any of it to keep in sync by hand.
 */
export function buildStandaloneHtmlPage(source: string, pageCss: string): string {
  const title = titleFrom(source);
  const body = renderBlocksToHtml(source);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${pageCss}</style>
</head>
<body>
<div class="dn-page">
${body}
</div>
</body>
</html>
`;
}

/** Every CSS rule currently active on the page, from whichever form the
 * build put it in — a `<style>` tag (the single-file build, decision 14)
 * or a `<link>` (dev mode's own `bun --hot`) — so export works the same
 * way regardless of how dewnote itself is being run. A cross-origin
 * stylesheet (there are none in this app today) is skipped rather than
 * thrown on, since reading its rules would throw first anyway. */
export function collectPageCss(): string {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) parts.push(rule.cssText);
    } catch {
      // Cross-origin stylesheet; nothing this app ships today, but skip
      // rather than fail the whole export over one unreadable sheet.
    }
  }
  return parts.join("\n");
}
