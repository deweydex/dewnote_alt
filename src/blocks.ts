// The document model. DECISIONS.md 1: the editor holds offsets into the
// source text, never a tree it re-serialises from — so splitting a
// document into blocks and concatenating every block's `text` back
// together must reproduce the original bytes exactly, for every
// document, always. That equality is the whole of what src/roundtrip.test.ts
// checks, and it is the test that matters most in this repository.
//
// The rule blocks are split on (plan section 5.2): fenced code, `$$`
// display maths, `<details>`/`<aside>` folds, and blank-line-separated
// prose. Front matter, when present, is its own leading block. Nothing
// else gets special treatment yet — a heading or a list is just a line
// (or several) inside a prose block, edited as markdown source the same
// as any paragraph.
//
// A fold's content is swallowed whole here rather than parsed into its
// own child blocks — a code fence quoted inside an answer fold (real and
// common in dewlab's practice pages) is not a fence Block in this file's
// own sense, and is never a live, runnable cell (a deliberate choice, not
// a gap: a reader adapting a hint's code by hand, rather than clicking
// Run on it, is the better pedagogical experience). render-block.ts's
// `renderFold` runs a second, independent markdown-it pass over a fold's
// body text for its own rendered (blurred) state, and markdown-it's own
// fence rule already turns a quoted fence into a plain, correctly
// highlighted `<pre><code class="language-x">` there — verified directly
// in render-block.test.ts, not merely assumed. What that second pass does
// not give a fold is a *live* CodeMirror instance while the fold itself is
// focused for editing: entering edit on a fold still shows its whole body,
// fence and all, as one flat markdown-source block (`sourceLanguageExtension`,
// app.ts) — real, minor editing-polish room, not a rendering gap.

import { extractFrontMatter, type FrontMatter } from "./frontmatter.ts";
import { isBlank, splitLines, type Line } from "./lines.ts";

export type BlockKind = "frontmatter" | "fence" | "math" | "fold" | "prose";

export interface FenceInfo {
  /** The character the fence is made of: only backticks are handled; a
   * document opening a fence with tildes is treated as prose instead,
   * since none of dewlab, dewstack or writing-content ever do. */
  char: "`";
  /** How many fence characters the opening line used. */
  length: number;
  /** Everything after the fence characters on the opening line, trimmed. */
  info: string;
}

export interface FoldInfo {
  /** `details` or `aside`, lower-cased, from the opening tag. */
  tag: string;
}

export interface Block {
  kind: BlockKind;
  start: number;
  end: number;
  text: string;
  fence?: FenceInfo;
  fold?: FoldInfo;
}

export interface Document {
  source: string;
  frontMatter: FrontMatter;
  blocks: Block[];
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,})(.*)$/;

function closesFence(content: string, length: number): boolean {
  const m = /^ {0,3}(`{3,})\s*$/.exec(content);
  return m !== null && m[1]!.length >= length;
}

const MATH_OPEN_RE = /^\s*\$\$/;
const FOLD_OPEN_RE = /<(details|aside)\b/i;

/** Parse a document's text into a contiguous, gap-free list of blocks. */
export function parseDocument(source: string): Document {
  const frontMatter = extractFrontMatter(source);
  const blocks: Block[] = [];
  if (frontMatter.present) {
    blocks.push({ kind: "frontmatter", start: 0, end: frontMatter.bodyStart, text: frontMatter.fenceText });
  }

  const lines = splitLines(source, frontMatter.bodyStart);
  let i = 0;

  const push = (kind: BlockKind, from: Line, to: Line, extra?: Partial<Block>) => {
    blocks.push({ kind, start: from.start, end: to.end, text: source.slice(from.start, to.end), ...extra });
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const fenceOpen = FENCE_OPEN_RE.exec(line.content);
    if (fenceOpen) {
      const length = fenceOpen[1]!.length;
      const info = fenceOpen[2]!.trim();
      let j = i + 1;
      while (j < lines.length && !closesFence(lines[j]!.content, length)) j++;
      const closeIndex = Math.min(j, lines.length - 1);
      push("fence", line, lines[closeIndex]!, { fence: { char: "`", length, info } });
      i = closeIndex + 1;
      continue;
    }

    if (MATH_OPEN_RE.test(line.content)) {
      // Look for the closing "$$" starting just after the opening one on
      // this same line, then on every line after, per the multi-line
      // display-maths blocks real tutorials actually write (opening $$
      // with content trailing it, closing $$ ending a later line).
      const afterOpen = line.content.replace(MATH_OPEN_RE, "");
      let closeIndex = afterOpen.includes("$$") ? i : -1;
      let j = i + 1;
      while (closeIndex === -1 && j < lines.length) {
        if (lines[j]!.content.includes("$$")) closeIndex = j;
        else j++;
      }
      if (closeIndex === -1) closeIndex = lines.length - 1;
      push("math", line, lines[closeIndex]!);
      i = closeIndex + 1;
      continue;
    }

    const foldOpen = FOLD_OPEN_RE.exec(line.content);
    if (foldOpen) {
      const tag = foldOpen[1]!.toLowerCase();
      let depth = 0;
      let j = i;
      let closeIndex = lines.length - 1;
      // Count opens/closes in the order they appear on the line, so a
      // single-line fold (`<details>...</details>` with no line break in
      // between) closes on the line it opened on rather than needing a
      // later one, and so a fold nested inside a same-named tag (not seen
      // in dewlab or dewstack today, but cheap to get right) still
      // balances correctly.
      outer: while (j < lines.length) {
        const tags = lines[j]!.content.matchAll(/<(\/?)(?:details|aside)\b[^>]*>/gi);
        for (const t of tags) {
          depth += t[1] === "/" ? -1 : 1;
          if (depth === 0) {
            closeIndex = j;
            break outer;
          }
        }
        j++;
      }
      push("fold", line, lines[closeIndex]!, { fold: { tag } });
      i = closeIndex + 1;
      continue;
    }

    // Prose: the paragraph's own non-blank lines, plus every blank line
    // that follows before the next real content — see the module comment
    // in this file's header for why that ownership rule keeps blocks
    // contiguous without a separate "blank" block kind.
    let j = i;
    while (
      j < lines.length &&
      !isBlank(lines[j]!.content) &&
      !FENCE_OPEN_RE.test(lines[j]!.content) &&
      !MATH_OPEN_RE.test(lines[j]!.content) &&
      !hasFoldOpen(lines[j]!.content)
    ) {
      j++;
    }
    // j now points at the first blank line, the first special-block
    // opener, or past the end — the paragraph's content is lines[i..j).
    // Extend over any run of blank lines that follows, unconditionally,
    // so this block owns the separator before whatever comes next. j is
    // always > i by this point: either the paragraph loop above consumed
    // at least the (non-blank, non-special) starting line, or that line
    // was itself blank and this loop consumes it as its first iteration.
    let k = j;
    while (k < lines.length && isBlank(lines[k]!.content)) k++;
    const lastIndex = k - 1;
    push("prose", line, lines[lastIndex]!);
    i = lastIndex + 1;
  }

  return { source, frontMatter, blocks };
}

function hasFoldOpen(content: string): boolean {
  return FOLD_OPEN_RE.test(content);
}

/** The inverse of parseDocument: every block's text, concatenated in
 * order. Exists mostly to name the invariant the round-trip test checks —
 * `serialize(parseDocument(source)) === source` — rather than to do
 * anything parseDocument's own block spans don't already guarantee. */
export function serialize(doc: Document): string {
  return doc.blocks.map((b) => b.text).join("");
}
