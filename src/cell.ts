// Parses a dewlab-style exec cell's body — the `id:`, `hint:`, `expect:`
// and `name:` header lines DIALECTS.md documents (`HEADER_RE`, matching
// dewlab's own `d2a21ed`), followed by the code itself — out of a fence
// block's raw text. blocks.ts deliberately never does this itself: it
// only needs a fence's own info string to split the document correctly,
// and the header lines are a rendering/running concern, not a
// document-model one.
//
// `expect:` and `name:` are read and preserved verbatim but not acted on
// — dewnote has no reader-side trigger logic to evaluate `expect:`
// against (that's a staged hint's business, plan §8 item 2) and `name:`
// is reserved on dewlab's own side for a feature dewnote doesn't need to
// know about yet. What matters here is only that *not* recognising them
// used to mean their line fell through into `code` — a real bug, not a
// missing feature: `expect: len(readings) == 4` is not valid Python, and
// dewnote would hand it straight to Pyodide on Run.

import type { Block } from "./blocks.ts";

export interface CellSource {
  id: string | null;
  hint: string | null;
  expect: string | null;
  name: string | null;
  code: string;
}

const HEADER_RE = /^\s*(id|hint|expect|name)\s*:\s*(.*)$/;
export type CellHeaderKey = "id" | "hint" | "expect" | "name";

/** A fence block's own text always starts and ends with fence lines
 * (blocks.ts's own invariant); `bodyEnd` is the closing fence line's own
 * index, skipping back over any blank lines directly before it, so both
 * reading and editing the header agree on exactly where the body ends. */
function fenceBoundaries(fenceText: string): { lines: string[]; bodyEnd: number } {
  const lines = fenceText.split("\n");
  let end = lines.length - 1;
  while (end > 0 && lines[end] === "") end--;
  return { lines, bodyEnd: end };
}

function fenceBody(fenceText: string): string {
  const { lines, bodyEnd } = fenceBoundaries(fenceText);
  return lines.slice(1, bodyEnd).join("\n");
}

/** Where a fence body's header lines end and its real code starts —
 * shared by both reading (`parseHeaderAndCode`) and editing
 * (`setCellHeaderField`), so the two can never disagree about which line
 * is which. `name:`, uniquely among these four keys, collides with real
 * code: a type-annotated first line of a cell's own body —
 * `name: str = "Ada"` — is indistinguishable from the header by shape
 * alone. dewlab's own fix (`ca6e16e`, 2026-09-07) is the same rule ported
 * verbatim: `=` never appears in a genuine name (a short label), so its
 * presence means this was never the header. `expect:` keeps matching
 * even with `=` in it, since a real expectation legitimately uses one
 * (`expect: total == 6`). */
function headerLineCount(bodyLines: string[]): number {
  let i = 0;
  while (i < bodyLines.length) {
    const match = HEADER_RE.exec(bodyLines[i]!);
    if (!match) break;
    if (match[1] === "name" && match[2]!.includes("=")) break;
    i++;
  }
  return i;
}

function parseHeaderAndCode(body: string): CellSource {
  const lines = body.split("\n");
  const headerCount = headerLineCount(lines);
  let id: string | null = null;
  let hint: string | null = null;
  let expect: string | null = null;
  let name: string | null = null;
  for (let i = 0; i < headerCount; i++) {
    const match = HEADER_RE.exec(lines[i]!)!;
    const key = match[1]!;
    const value = match[2]!.trim();
    if (key === "id") id = value;
    else if (key === "hint") hint = value;
    else if (key === "expect") expect = value;
    else name = value;
  }
  return { id, hint, expect, name, code: lines.slice(headerCount).join("\n") };
}

/** Sets one header field's value inside a fence's own text, touching only
 * that field's line — every other line, including the code, is untouched
 * byte for byte, the same discipline `frontmatter.ts`'s
 * `setFrontMatterField` holds itself to (decision 1). An empty `value`
 * removes the line if it exists; `id` is required (DIALECTS.md §1) and
 * this is never called to clear it — the header form only ever offers a
 * clear button for `hint`/`expect`/`name`. Returns the input completely
 * unchanged when the new value is identical to what was already there. */
export function setCellHeaderField(fenceText: string, key: CellHeaderKey, value: string): string {
  const { lines, bodyEnd } = fenceBoundaries(fenceText);
  const bodyLines = lines.slice(1, bodyEnd);
  const headerCount = headerLineCount(bodyLines);
  const headerLines = bodyLines.slice(0, headerCount);
  const codeLines = bodyLines.slice(headerCount);

  const keyRe = new RegExp(`^(\\s*${key}\\s*:)(.*)$`);
  const lineIndex = headerLines.findIndex((line) => keyRe.test(line));
  const newHeaderLines = headerLines.slice();

  if (lineIndex === -1) {
    if (value === "") return fenceText;
    newHeaderLines.push(`${key}: ${value}`);
  } else if (value === "") {
    newHeaderLines.splice(lineIndex, 1);
  } else {
    const match = keyRe.exec(headerLines[lineIndex]!)!;
    newHeaderLines[lineIndex] = `${match[1]} ${value}`;
  }

  if (newHeaderLines.join("\n") === headerLines.join("\n")) return fenceText;

  const newBodyLines = [...newHeaderLines, ...codeLines];
  return [lines[0], ...newBodyLines, ...lines.slice(bodyEnd)].join("\n");
}

/** Replaces just a fence's own code — everything after its header lines —
 * keeping the opening fence line and every header line exactly as they
 * are. This is `setCellHeaderField`'s mirror image: where that touches
 * one header line and leaves the code alone, this touches the code and
 * leaves every header line alone. Used to fold a live, still-focused code
 * editor's current text back into the block's full fence text without
 * needing that editor to know the header exists at all. */
export function replaceCellCode(fenceText: string, newCode: string): string {
  const { lines, bodyEnd } = fenceBoundaries(fenceText);
  const bodyLines = lines.slice(1, bodyEnd);
  const headerCount = headerLineCount(bodyLines);
  const headerLines = bodyLines.slice(0, headerCount);
  const codeLines = bodyLines.slice(headerCount);

  // No-op guard, same discipline as setCellHeaderField: an untouched code
  // editor (mounted with exactly this fence's own parsed code, never
  // edited) must reproduce the original bytes exactly, not an
  // "equivalent" reconstruction — which matters here because "" is
  // ambiguous. parseHeaderAndCode collapses both a body with no code
  // lines at all and one with a single blank code line to the same
  // code: "", so comparing against *this* fenceText's own codeLines,
  // rather than reconstructing unconditionally, is what keeps a
  // never-edited cell of either shape byte-exact instead of drifting to
  // whichever shape a bare `newCode === ""` guess would pick.
  if (newCode === codeLines.join("\n")) return fenceText;

  const newCodeLines = newCode === "" ? [] : newCode.split("\n");
  const newBodyLines = [...headerLines, ...newCodeLines];
  return [lines[0], ...newBodyLines, ...lines.slice(bodyEnd)].join("\n");
}

export function parseCellSource(block: Block): CellSource {
  return parseHeaderAndCode(fenceBody(block.text));
}

/** Same parse, run directly against a fence's live text — what a Run
 * click needs, since the code just typed into a still-focused fence
 * editor isn't in `block.text` until that editor next blurs and commits
 * (see app.ts's header comment). */
export function parseCellSourceFromFenceText(fenceText: string): CellSource {
  return parseHeaderAndCode(fenceBody(fenceText));
}

/** Whether a fence's info string marks it runnable — dewlab's own and
 * only convention (DIALECTS.md §1): the word "exec" anywhere in the
 * info string, alongside the language. A fence without it is
 * illustrative, read-only code, never executed. */
export function isRunnableFence(info: string): boolean {
  return info.split(/\s+/).includes("exec");
}

/** Which of dewlab's two exec-cell languages a runnable fence is
 * (DIALECTS.md §1, `d2a21ed`) — mirrors dewlab's own `CELL_TYPES`
 * check in `parse_cell()`: the fence's first word decides, and
 * anything other than literally `sql` is Python, `exec` itself
 * included (a bare ` ```exec ` fence, dewlab's own shorthand for
 * `python exec`). Only meaningful for a fence `isRunnableFence`
 * already said yes to. */
export function execCellLanguage(info: string): "python" | "sql" {
  return info.trim().split(/\s+/)[0] === "sql" ? "sql" : "python";
}

/** The Python dewnote actually runs for a `sql exec` cell — the fence's
 * raw SQL text, wrapped into a call against the one shared, page-wide
 * `db` connection (DIALECTS.md §1), mirroring dewlab's own
 * `wrapSqlCode()`. A bare expression, not assigned to anything: unlike
 * dewlab's own `_run_sql_cell` (which renders itself and returns a value
 * that must then be discarded to avoid a second render), dewnote's
 * `dewnote_sql_tools.run_sql_cell` only *returns* a DataFrame or `None`,
 * so leaving this as the cell's own trailing expression is what lets
 * `dewnote_tools.py`'s existing `_render_value` render it — the same
 * path any other cell's trailing DataFrame already takes, not a second
 * rendering mechanism. */
export function wrapSqlExecCode(script: string): string {
  return `import dewnote_sql_tools as _dn_sql\n_dn_sql.run_sql_cell(db, ${JSON.stringify(script)})`;
}

export interface SqlCellInfo {
  /** The database this cell's script runs against — dewstack's own
   * sharing key (DIALECTS.md §2): every `sql cell=name` fence on the
   * page with the same name runs against the same in-memory SQLite
   * connection, in the order they're run, not the order they appear. */
  name: string;
  /** Whether this fence asked to have its script remembered across
   * visits (`cell=name persist`). See `sqlPersistStorageKey` for what
   * this actually does in dewnote, which is not what it does in
   * dewstack — DECISIONS.md has the reasoning. */
  persist: boolean;
}

const SQL_CELL_RE = /^sql\s+cell=([a-z0-9-]+)(\s+persist)?\s*$/;

/** Parses a dewstack SQL cell's info string (` ```sql cell=name `, or
 * ` ```sql cell=name persist `). Unlike a dewlab exec cell, there are no
 * header lines — the info string carries everything, and the fence body
 * is the SQL script itself, verbatim. `null` for anything else, fence
 * body included: a fence not shaped like this is not a SQL cell,
 * whatever language its info string names. */
export function parseSqlCellInfo(info: string): SqlCellInfo | null {
  const match = SQL_CELL_RE.exec(info.trim());
  return match ? { name: match[1]!, persist: !!match[2] } : null;
}

/** The localStorage key a persisted SQL cell's saved script lives under.
 * Keyed by name alone, matching dewstack's own convention — dewnote has
 * no per-document identity yet to fold in, a real (if narrow) gap: two
 * differently-named documents each using `cell=totals persist` would
 * offer each other's saved script for restore. Harmless rather than
 * destructive, though, because of *how* it's offered — see
 * `parseSqlCellInfo`'s own doc comment and DECISIONS.md for why restore
 * is a reader's own explicit choice here, never automatic. */
export function sqlPersistStorageKey(name: string): string {
  return `dewnote-sql:${name}`;
}

/** A SQL cell's whole fence body, verbatim — there are no header lines
 * to peel off the way an exec cell has, so this is the same extraction
 * `parseCellSourceFromFenceText` does internally, exported under its own
 * name for a SQL cell's Run to call directly against the fence's live
 * text. */
export function sqlScriptFromFenceText(fenceText: string): string {
  return fenceBody(fenceText);
}

/** dewlab's `packages:` front-matter field (DIALECTS.md §1) — a document
 * declaring a package `loadPackagesFromImports` can't infer from a cell's
 * own `import` lines (a different import name than the package's own, or
 * a package a cell needs without importing it by name). Anything not a
 * list of strings is treated as absent rather than thrown on — front
 * matter is arbitrary YAML a person typed, not a schema this editor
 * enforces. */
export function declaredPackages(fields: Record<string, unknown>): string[] {
  const value = fields["packages"];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** dewlab's own staged-hint fence (DIALECTS.md §1, `d2a21ed`) — a
 * `for:`/`after:`/`title:` header, the same shape dewlab's own
 * `parse_hint()` reads, followed by the hint's own markdown body. */
export interface HintFenceInfo {
  /** The exec cell this hint belongs to, from an explicit `for:` line.
   * No default: dewlab's own build falls back to "the exec cell
   * immediately above this fence in the source," but that's a
   * document-wide notion dewnote's own per-fence parsing has no access
   * to here — a real, narrower gap than dewlab's own, left null rather
   * than guessed at (see cell.ts's own `parseHintFence` for where a
   * caller with the surrounding document could still work it out). */
  for: string | null;
  after: string;
  title: string;
  body: string;
}

const HINT_HEADER_RE = /^\s*(for|after|title)\s*:\s*(.*)$/;
export const DEFAULT_HINT_AFTER = "errors:5";
export const DEFAULT_HINT_TITLE = "Let’s slow down a moment…";

/** Whether a fence is a staged-hint fence — its first info word is
 * literally "hint", the same test dewlab's own `extract_blocks()` runs
 * (`info and info[0] == "hint"`). */
export function isHintFence(info: string): boolean {
  return info.trim().split(/\s+/)[0] === "hint";
}

/** Reads a staged-hint fence's own header lines and body, defaults
 * (`errors:5`, dewlab's own default title) included, so a caller with no
 * header lines at all still gets something meaningful to show. */
export function parseHintFence(block: Block): HintFenceInfo {
  const lines = fenceBody(block.text).split("\n");
  const header: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const match = HINT_HEADER_RE.exec(lines[i]!);
    if (!match || match[1]! in header) break;
    header[match[1]!] = match[2]!.trim();
    i++;
  }
  return {
    for: header["for"] ?? null,
    after: header["after"] || DEFAULT_HINT_AFTER,
    title: header["title"] || DEFAULT_HINT_TITLE,
    body: lines.slice(i).join("\n").trim(),
  };
}

/** dewlab's own native site-editor fence (DIALECTS.md §1) — `html
 * site`/`css site`/`js site`, an `id:`/`site:` header the same shape
 * every other exec-family fence uses, in place of dewstack's
 * `site=name` (which puts the identity in the info string itself,
 * something dewlab's own authoring editor can't round-trip — DIALECTS.md
 * §1's own note). Consecutive fences sharing one `site:` value group
 * into one editor; site-cell.ts owns that grouping, this module only
 * parses one pane at a time. */
export type SiteLanguage = "html" | "css" | "js";
const SITE_LANGUAGES = new Set<string>(["html", "css", "js"]);

export interface SitePaneInfo {
  language: SiteLanguage;
  id: string | null;
  site: string | null;
  body: string;
}

const SITE_HEADER_RE = /^\s*(id|site)\s*:\s*(.*)$/;

/** dewlab's own `len(info) >= 2 and info[1] == "site"` check — the
 * fence's first word must be one of the three site languages and its
 * second word must be literally "site". */
export function isSitePaneFence(info: string): boolean {
  const words = info.trim().split(/\s+/);
  return words.length >= 2 && words[1] === "site" && SITE_LANGUAGES.has(words[0]!);
}

/** Reads a site pane's own `id:`/`site:` header and body. Only
 * meaningful for a fence `isSitePaneFence` already said yes to — the
 * language comes from the fence's own first info word, not re-validated
 * here. */
export function parseSitePaneInfo(block: Block): SitePaneInfo {
  const language = (block.fence?.info.trim().split(/\s+/)[0] ?? "html") as SiteLanguage;
  const lines = fenceBody(block.text).split("\n");
  const header: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const match = SITE_HEADER_RE.exec(lines[i]!);
    if (!match || match[1]! in header) break;
    header[match[1]!] = match[2]!.trim();
    i++;
  }
  return {
    language,
    id: header["id"] ?? null,
    site: header["site"] ?? null,
    body: lines.slice(i).join("\n"),
  };
}

/** dewlab's own `` ```card `` fence (DIALECTS.md §1, `build.py`'s
 * `parse_card()`/`render_card()`) — a hand-written page's clickable tile,
 * the markup `render_index()` used to write out by hand six times over
 * before decision 7.161 there gave it a real syntax. `url:`/`status:`/
 * `meta:`/`wide:` header lines, the same idiom every other exec-family
 * fence already uses, then a markdown heading and an optional paragraph.
 *
 * Not a cell: nothing here runs, and nothing is saved against an id the
 * way a runnable fence's `id:` is a contract (dewlab's `Cell`/
 * `CELL_TYPES`/`render_cell()` all reserve "cell" for something with a
 * saved-progress contract behind it) — so this stays a **card**
 * throughout dewnote's own code and docs, "cell" left for dewnote's own
 * broader, non-runnable sense of the word only where nothing already
 * claims it more narrowly (a module maintainer may still call the
 * rendered result a "card cell" in conversation; the type and function
 * names here don't). */
export interface CardFenceInfo {
  url: string | null;
  status: string | null;
  meta: string | null;
  wide: boolean;
  /** `null` when the fence's body doesn't open with a markdown heading —
   * dewlab's own build fails outright on this; an editor, mid-edit, just
   * shows a placeholder instead (renderCardFencePreview). */
  heading: string | null;
  body: string;
}

const CARD_HEADER_RE = /^\s*(url|status|meta|wide)\s*:\s*(.*)$/;
const CARD_HEADING_RE = /^#{1,6}\s*(.+?)\s*#*$/;

/** Whether a fence's info string is exactly `card` — dewlab's own
 * `extract_page_cards()` check (`info.strip() == "card"`), no room for a
 * language word the way an exec or site fence's info string has. */
export function isCardFence(info: string): boolean {
  return info.trim() === "card";
}

/** Reads a card fence's own header lines, heading, and body. Leading
 * blank lines before the heading are skipped, matching dewlab's own
 * `parse_card()` (`rest.strip("\n")` there). */
export function parseCardFence(block: Block): CardFenceInfo {
  const lines = fenceBody(block.text).split("\n");
  const header: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const match = CARD_HEADER_RE.exec(lines[i]!);
    if (!match || match[1]! in header) break;
    header[match[1]!] = match[2]!.trim();
    i++;
  }
  const rest = lines.slice(i);
  const firstContentLine = rest.findIndex((line) => line.trim() !== "");
  let heading: string | null = null;
  let bodyLines = rest;
  if (firstContentLine !== -1) {
    const headingMatch = CARD_HEADING_RE.exec(rest[firstContentLine]!);
    if (headingMatch) {
      heading = headingMatch[1]!;
      bodyLines = rest.slice(firstContentLine + 1);
    }
  }
  const wideValue = (header["wide"] ?? "").toLowerCase();
  return {
    url: header["url"] ?? null,
    status: header["status"] || null,
    meta: header["meta"] || null,
    wide: wideValue === "true" || wideValue === "yes",
    heading,
    body: bodyLines.join("\n").trim(),
  };
}

/** dewlab's own ```question fence (planning/QUESTION_BLOCKS.md,
 * build.py's `parse_question()`/`render_question()`) — a multiple-choice
 * or fill-in-the-blank self-check. `id:`/`type:`/`correct:` header lines
 * read the same way every other exec-family fence's header is, then
 * ordinary markdown: the prompt and its options for multiple-choice, or
 * the sentence itself, `{gaps}` and all, for fill-in-the-blank.
 *
 * Not a cell, for the same reason a card fence isn't one (`CardFenceInfo`'s
 * own comment): nothing here runs. Its id still shares dewlab's one
 * saved-answer namespace with every cell on the page, though — see
 * `generateBlockId()` in app.ts, which checks a new id against both. */
export interface QuestionFenceInfo {
  id: string | null;
  type: "multiple-choice" | "fill-in-the-blank" | null;
  /** 1-based, multiple-choice only; `null` otherwise, or when the header
   * is missing or unparseable — an editor reads a fence mid-edit, not a
   * finished build, so a bad `correct:` shows as "no option marked"
   * here rather than refusing to preview at all. */
  correct: number | null;
  /** multiple-choice only — the prompt above the options list, or the
   * whole body when `type:` hasn't been typed yet (so a bullet list
   * started before the header line still previews as one). Empty for
   * fill-in-the-blank, where the whole sentence is in `body` instead. */
  prompt: string;
  /** multiple-choice only — each option's own raw markdown, in the
   * order written. */
  options: string[];
  /** The fence's full body below the header lines, untouched — what a
   * fill-in-the-blank question's own `{...}` gaps are read out of. */
  body: string;
}

const QUESTION_HEADER_RE = /^\s*(id|type|correct)\s*:\s*(.*)$/;
const QUESTION_OPTION_RE = /^[ \t]*[-*+]\s+(.*\S)\s*$/;

/** Whether a fence's info string is exactly `question` — dewlab's own
 * `info and info[0] == "question"` check (build.py's `extract_blocks()`),
 * the same "one bare word" shape `isCardFence` already tests for. */
export function isQuestionFence(info: string): boolean {
  return info.trim() === "question";
}

/** Reads a question fence's own header lines, and splits what follows
 * into a prompt and its options when the fence reads as multiple-choice
 * — the same "first bullet line starts the options" rule build.py's own
 * `_split_multiple_choice()` uses. Run whether or not `type:` has been
 * typed yet, since a bullet list under a question already looks like a
 * multiple-choice one to an author reading it; only a fence that already
 * says `fill-in-the-blank` skips the split, since the body there is the
 * sentence itself and any `- ` inside it is the author's own markdown,
 * not an options list. */
export function parseQuestionFence(block: Block): QuestionFenceInfo {
  const lines = fenceBody(block.text).split("\n");
  const header: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const match = QUESTION_HEADER_RE.exec(lines[i]!);
    if (!match || match[1]! in header) break;
    header[match[1]!] = match[2]!.trim();
    i++;
  }
  const bodyLines = lines.slice(i);
  const body = bodyLines.join("\n").trim();
  const type = header["type"] === "multiple-choice" || header["type"] === "fill-in-the-blank" ? header["type"] : null;

  let prompt = "";
  let options: string[] = [];
  if (type !== "fill-in-the-blank") {
    let start = bodyLines.length;
    for (let j = 0; j < bodyLines.length; j++) {
      if (QUESTION_OPTION_RE.test(bodyLines[j]!)) {
        start = j;
        break;
      }
    }
    prompt = bodyLines.slice(0, start).join("\n").trim();
    options = bodyLines
      .slice(start)
      .map((line) => QUESTION_OPTION_RE.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1]!);
  }

  const correctRaw = header["correct"];
  const correct = correctRaw && /^\d+$/.test(correctRaw) ? Number(correctRaw) : null;

  return { id: header["id"] ?? null, type, correct, prompt, options, body };
}
