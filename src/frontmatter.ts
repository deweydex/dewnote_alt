// Front matter is read for the form fields the editor shows, but never
// re-dumped: a tutorial's front matter is only ever touched byte-for-byte
// (extractFrontMatter) unless a field is actually edited, so key order and
// quoting (writing-content's quoted ISO-8601 timestamps, for instance)
// survive a save that changed nothing up here. See DECISIONS.md 1 and the
// plan's section 5.2.

import { load as parseYaml } from "js-yaml";

export interface FrontMatter {
  /** True if the document opens with a `---` front matter block at all. */
  present: boolean;
  /** The raw text between the fences, exactly as written (no fences). */
  raw: string;
  /** Parsed fields, for the form UI. Empty if `present` is false. */
  fields: Record<string, unknown>;
  /** Byte offset in the source where the body starts (0 if `present` is false). */
  bodyStart: number;
  /** The exact text of the front matter block including both `---` fences and
   * the trailing newline, so `source.slice(0, bodyStart) === fenceText`. */
  fenceText: string;
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split a document's leading `---`-fenced front matter from its body.
 * Only ever reads; never reformats. A document with no leading `---`
 * fence (or one not closed) has no front matter, by design — an
 * unclosed fence is a body's problem to report, not something this
 * function guesses at.
 */
export function extractFrontMatter(source: string): FrontMatter {
  const match = FRONT_MATTER_RE.exec(source);
  if (!match) {
    return { present: false, raw: "", fields: {}, bodyStart: 0, fenceText: "" };
  }
  const fenceText = match[0];
  const raw = match[1] ?? "";
  const fields = (parseYaml(raw) as Record<string, unknown> | null) ?? {};
  return { present: true, raw, fields, bodyStart: fenceText.length, fenceText };
}

const TOP_LEVEL_KEY_RE = (key: string) => new RegExp(`^(${escapeRegExp(key)}\\s*:)(.*)$`);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `value`, written bare (no quotes), would still read back as the
 * same string — the cases a form field actually needs to worry about:
 * empty, YAML's own reserved words, something that parses as a number,
 * or a colon-space/leading-marker sequence that YAML would otherwise
 * read as structure. Deliberately narrow rather than a general "is this
 * safe YAML" check — a scalar a person typed into a text box, not
 * arbitrary content. */
function needsQuoting(value: string): boolean {
  if (value === "") return true;
  if (/^\s|\s$/.test(value)) return true;
  if (/^(true|false|null|yes|no|~)$/i.test(value)) return true;
  if (/^-?\d+(\.\d+)?$/.test(value)) return true;
  if (/[:#&*!|>'"%@`]/.test(value) || value.includes(": ")) return true;
  return false;
}

function quoteValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Re-renders one field's value the way it was already written, if it
 * was quoted, or bare with the same quoting decision a fresh value would
 * get otherwise — never touching the key, its spacing, or any other
 * line, per this file's own header comment (decision 1: edit values in
 * the original text, never re-dump). */
function formatValue(value: string, previousRaw: string | undefined): string {
  const trimmed = previousRaw?.trim() ?? "";
  const wasDoubleQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
  const wasSingleQuoted = trimmed.startsWith("'") && trimmed.endsWith("'");
  if (wasDoubleQuoted || needsQuoting(value)) return quoteValue(value);
  if (wasSingleQuoted) return `'${value.replace(/'/g, "''")}'`;
  return value;
}

/**
 * Sets one top-level scalar field's value inside a front-matter block's
 * own text (fences included), touching only that field's line — every
 * other line, key order, and quoting elsewhere is untouched, the same
 * byte-for-byte discipline `extractFrontMatter` itself follows (decision
 * 1). Only ever meant for a field whose current value (if any) is a
 * plain scalar, not a list or a nested mapping — `app.ts`'s own form
 * only calls this for fields it already knows are scalar-shaped, and a
 * list/mapping value is left to the raw-text fallback instead.
 *
 * An empty `value` removes the field's line entirely if it already
 * exists (an optional field a reader cleared out); if the field wasn't
 * present, nothing happens — clearing a field that was never there is a
 * no-op, not an edit. A non-empty value updates the existing line in
 * place, or appends a new one just before the closing fence if the field
 * wasn't present yet.
 */
export function setFrontMatterField(blockText: string, key: string, value: string): string {
  const match = FRONT_MATTER_RE.exec(blockText);
  if (!match) return blockText;
  const fenceText = match[0];
  const raw = match[1] ?? "";
  const afterFence = blockText.slice(fenceText.length);

  const lines = raw.length > 0 ? raw.split("\n") : [];
  const keyRe = TOP_LEVEL_KEY_RE(key);
  const lineIndex = lines.findIndex((line) => keyRe.test(line));

  if (lineIndex === -1) {
    if (value === "") return blockText;
    lines.push(`${key}: ${formatValue(value, undefined)}`);
  } else if (value === "") {
    lines.splice(lineIndex, 1);
  } else {
    const lineMatch = keyRe.exec(lines[lineIndex]!)!;
    lines[lineIndex] = `${lineMatch[1]} ${formatValue(value, lineMatch[2])}`;
  }

  const newRaw = lines.join("\n");
  if (newRaw === raw) return blockText;

  // The opening/closing delimiters are whatever surrounds `raw` inside
  // `fenceText` — read back out rather than assumed, so this still works
  // regardless of \r\n vs \n or a missing trailing newline on the last
  // line of the document.
  const rawStart = fenceText.indexOf(raw);
  const openDelim = fenceText.slice(0, rawStart);
  const closeDelim = fenceText.slice(rawStart + raw.length);
  return openDelim + newRaw + closeDelim + afterFence;
}
