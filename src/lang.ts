// Maps a fence's own language token (the first word of its info string —
// blocks.ts's FenceInfo.info, e.g. "python exec" or "sql cell=name") to a
// CodeMirror language extension. A fence block is always a live editor
// (plan §5.1); this is the only per-language decision that view needs to
// make, so it lives in its own small module rather than inside app.ts.

import type { Extension } from "@codemirror/state";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";

const LANGUAGES: Record<string, () => Extension> = {
  python: () => python(),
  py: () => python(),
  sql: () => sql(),
  html: () => html(),
  css: () => css(),
  js: () => javascript(),
  javascript: () => javascript(),
};

/** The fence's own token, lower-cased, or "" for an info string with
 * nothing before the first space (seen in practice: a bare ` ```` ` fence
 * used only as a visual divider). Exported for its own unit test. */
export function fenceLanguageToken(info: string): string {
  return (info.split(/\s+/, 1)[0] ?? "").toLowerCase();
}

/** No extension for an unrecognised or absent token — CodeMirror edits
 * perfectly well with no language, just without highlighting, rather than
 * refusing to show the fence at all. */
export function languageExtensionFor(info: string): Extension[] {
  const token = fenceLanguageToken(info);
  const factory = LANGUAGES[token];
  return factory ? [factory()] : [];
}

/** The language a block's own *source* editing uses when it isn't a fence
 * — prose, math, a fold, or front matter are all edited as markdown text,
 * since none of them are a distinct enough grammar to warrant their own
 * CodeMirror language (a math block's body is really just text that
 * happens to be LaTeX, and highlighting it as markdown does no harm). */
export function sourceLanguageExtension(): Extension {
  return markdown();
}
