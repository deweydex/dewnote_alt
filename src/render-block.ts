// Turns a Block (blocks.ts) into the HTML shown while it is *not* focused —
// the "render" half of "render when blurred, edit when focused" (plan
// §5.1, decision 2). This never touches the block model or its offsets;
// it is a second, independent parse of the same text purely for display,
// which is exactly what blocks.ts's own module comment says a fold's inner
// content will eventually need. Fence blocks are deliberately not handled
// here — a code cell has no rendered state at all (plan §5.1: "always a
// CodeMirror editor"), so the DOM layer never calls this for one.

import MarkdownIt from "markdown-it";
import texmath from "markdown-it-texmath";
import katex from "katex";
import type { Block } from "./blocks.ts";
import type { DialectName } from "./dialect.ts";
import { parseCardFence, parseHintFence, parseQuestionFence } from "./cell.ts";

const md = new MarkdownIt({ html: true, linkify: true }).use(texmath, {
  engine: katex,
  delimiters: "dollars",
  katexOptions: { throwOnError: false },
});

/** Render a non-fence block's text for its blurred state. `dialect` is
 * accepted now and unused — dewstack has no maths, so a future check here
 * (skip texmath, since decision-worthy "$ renders as text" behaviour, per
 * DIALECTS.md §2) belongs to this function once dewstack fixtures need it
 * rendered rather than just round-tripped. */
/** A prose block that is nothing but a blank line — the orphan `blocks.ts`
 * itself documents: a fence, fold or front-matter block doesn't absorb a
 * trailing blank run the way a real paragraph does, so the blank line right
 * after one becomes its own block. `md.render()` of pure whitespace is the
 * empty string, which collapses to zero height in the DOM — present in the
 * document, byte for byte, but with no surface a mouse can ever hover to
 * reach its own delete button. A single non-breaking space gives it that
 * surface back, through the exact same hover-toolbar/click-to-edit path
 * every other block already has, rather than a new mechanism of its own. */
const BLANK_LINE_PREVIEW = '<p class="dn-blank-line">&nbsp;</p>';

export function renderBlockPreview(block: Block, _dialect: DialectName): string {
  switch (block.kind) {
    case "frontmatter":
      return renderFrontMatterPreview(block);
    case "prose":
    case "math": {
      const html = md.render(block.text);
      return html.trim() === "" ? BLANK_LINE_PREVIEW : html;
    }
    case "fold":
      return renderFold(block);
    case "fence":
      throw new Error("renderBlockPreview: fence blocks have no rendered state — see this file's header comment");
  }
}

function renderFrontMatterPreview(block: Block): string {
  // The blurred state is always this quiet summary, whether a dialect's
  // full per-field form (decision 11) or the plain raw-YAML editor is
  // what focusing it actually opens — see app.ts's own dialect check.
  const raw = block.text.replace(/^---\r?\n/, "").replace(/\r?\n---\r?\n?$/, "");
  const fieldCount = raw.split(/\r?\n/).filter((line) => /^[A-Za-z_][\w-]*:/.test(line)).length;
  const label = fieldCount === 1 ? "1 field" : `${fieldCount} fields`;
  return `<p class="dn-frontmatter-summary">Front matter — ${label}</p>`;
}

const FOLD_OPEN_RE = /^<(details|aside)\b([^>]*)>\s*(?:<summary>([\s\S]*?)<\/summary>)?/i;

interface FoldParts {
  tag: string;
  className: string | null;
  summaryHtml: string;
  bodyMarkdown: string;
}

/** The editable part of a fold, with the exact wrapper text kept either
 * side of it. This lets the author edit an answer's Markdown without
 * turning the `<details>` implementation into visible document content. */
export interface EditableFoldSource {
  prefix: string;
  body: string;
  suffix: string;
}

export function editableFoldSource(text: string): EditableFoldSource | null {
  const openMatch = FOLD_OPEN_RE.exec(text);
  if (!openMatch) return null;
  const tag = openMatch[1]!.toLowerCase();
  const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
  let lastClose = -1;
  for (let match = closeRe.exec(text); match; match = closeRe.exec(text)) lastClose = match.index;
  if (lastClose === -1) return null;

  const bodyStart = openMatch.index + openMatch[0].length;
  const rawBody = text.slice(bodyStart, lastClose);
  const leading = rawBody.match(/^\s*/)?.[0] ?? "";
  const trailing = rawBody.slice(leading.length).match(/\s*$/)?.[0] ?? "";
  const contentStart = bodyStart + leading.length;
  const bodyEnd = lastClose - trailing.length;
  return {
    prefix: text.slice(0, contentStart),
    body: text.slice(contentStart, bodyEnd),
    suffix: text.slice(bodyEnd),
  };
}

export function replaceFoldBody(text: string, body: string): string {
  const editable = editableFoldSource(text);
  return editable ? `${editable.prefix}${body}${editable.suffix}` : text;
}

/** Split a fold block's raw text into its wrapper and its body, so the
 * body can be parsed as markdown independently — CommonMark's own raw-HTML-
 * block rule would otherwise swallow it un-rendered (checked directly: this
 * is not what dewlab's build does, which relies on Python-Markdown's
 * md_in_html extension to treat the same blank-line-separated body as real
 * markdown; markdown-it has no equivalent, hence this function). Exported
 * for its own unit tests, separate from the fuller renderFold. */
export function parseFold(text: string): FoldParts {
  const openMatch = FOLD_OPEN_RE.exec(text);
  if (!openMatch) {
    // Malformed input shouldn't happen — FOLD_OPEN_RE here is a superset of
    // the pattern blocks.ts used to call this a fold block in the first
    // place — but showing the raw text beats throwing.
    return { tag: "details", className: null, summaryHtml: "", bodyMarkdown: text };
  }
  const tag = openMatch[1]!.toLowerCase();
  const attrs = openMatch[2] ?? "";
  const classMatch = /class="([^"]*)"/.exec(attrs);
  const className = classMatch ? classMatch[1]! : null;
  const summaryHtml = openMatch[3] ?? "";

  const bodyStart = openMatch.index + openMatch[0].length;
  const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
  let lastClose = -1;
  for (let m = closeRe.exec(text); m; m = closeRe.exec(text)) lastClose = m.index;
  const bodyEnd = lastClose === -1 ? text.length : lastClose;

  const bodyMarkdown = text.slice(bodyStart, bodyEnd).trim();
  return { tag, className, summaryHtml, bodyMarkdown };
}

const FOLD_LABELS: Record<string, string> = {
  "dl-hint": "hint",
  "dl-answer": "answer",
};

function renderFold(block: Block): string {
  const { tag, className, summaryHtml, bodyMarkdown } = parseFold(block.text);
  const label = summaryHtml || (className && FOLD_LABELS[className]) || "details";
  const classAttr = className ? ` class="${escapeAttr(className)}"` : "";
  const bodyHtml = bodyMarkdown ? md.render(bodyMarkdown) : "";
  return `<${tag}${classAttr}><summary>${label}</summary>${bodyHtml}</${tag}>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** A staged-hint fence's own preview (DIALECTS.md §1, cell.ts's own
 * `parseHintFence`) — the same `<details class="dl-hint dl-hint-staged">`
 * shape dewlab's own `render_staged_hint()` builds, minus the `hidden`
 * attribute and its trigger data: dewnote is an authoring surface, not
 * the reading page, and has no trigger logic (errors, same-errors, an
 * unchanged run) to earn the reveal a real reader's page would gate on —
 * showing the hint's own title and body openly is the honest choice, not
 * a simulation of a mechanism this editor doesn't have. Called from
 * app.ts alongside a fence's own live editor, never in place of it —
 * unlike a fold block, a fence never loses its "always a live editor"
 * state (plan §5.1, decision 15); this is a read-only preview shown
 * beside it, not a render/edit toggle. */
export function renderHintFencePreview(block: Block): string {
  const hint = parseHintFence(block);
  const bodyHtml = hint.body ? md.render(hint.body) : "";
  return `<details class="dl-hint dl-hint-staged" open><summary>${md.utils.escapeHtml(hint.title)}</summary>${bodyHtml}</details>`;
}

/** A ```card fence's own preview — dewlab's own `.dl-module-card` markup
 * (DIALECTS.md §1, `build.py`'s `render_card()`), shown beside its live
 * editor the same way a staged hint's is (decision 15: a fence never
 * loses its live-editor state). A missing `url:`/heading shows a plain
 * placeholder rather than a broken link or an empty tile — this editor
 * reads a fence mid-edit, not a finished build, and dewlab's own build
 * would refuse to publish either gap rather than guess at one. */
export function renderCardFencePreview(block: Block): string {
  const card = parseCardFence(block);
  const classes = card.wide ? "dl-module-card dl-module-card-wide" : "dl-module-card";
  const heading = card.heading ? md.utils.escapeHtml(card.heading) : "(no heading yet)";
  const badge = card.status
    ? `<span class="dl-module-card-badge" data-status="${escapeAttr(card.status)}">${md.utils.escapeHtml(
        card.status.slice(0, 1).toUpperCase() + card.status.slice(1),
      )}</span>`
    : "";
  const meta = card.meta ? `<span class="dl-module-card-meta">${md.utils.escapeHtml(card.meta)}</span>` : "";
  const bodyHtml = card.body ? md.render(card.body) : "";
  const href = card.url ? escapeAttr(card.url) : "#";
  return `<a class="${classes}" href="${href}"><h3>${heading}${badge}</h3>${meta}${bodyHtml}</a>`;
}

/** A single paragraph's own `<p>...</p>`, unwrapped — an option sits on
 * a button, not inside a block of its own, the same reasoning build.py's
 * own `render_question()` unwraps an option's markdown for. markdown-it
 * itself decides whether that trailing newline is there; both are
 * handled rather than assumed. */
function stripSingleParagraph(html: string): string {
  const match = /^<p>([\s\S]*)<\/p>\n?$/.exec(html);
  return match ? match[1]! : html;
}

const QUESTION_GAP_RE = /\{([^{}]*)\}/g;

/** A fill-in-the-blank question's own `{...}` gaps, replaced with a
 * plain span showing the expected word — the first item for a `{a|b|c}`
 * dropdown, the whole thing for a `{word}` typing box. Not the live
 * `<select>`/`<input>` the built page actually mounts: this editor has
 * no reader to check an answer for, so showing the correct word inline
 * is the honest preview, not a simulation of a control this editor
 * never runs (the same reasoning `renderHintFencePreview`'s own comment
 * gives for skipping a staged hint's reveal trigger).
 *
 * Protected from Markdown's own inline pass the same way build.py's
 * `render_question()` protects a gap from it — a bare alphanumeric
 * token stands in while the sentence around it is converted, then the
 * real span is spliced back in, since a gap can sit mid-sentence where
 * an HTML-comment placeholder would not survive Markdown's inline pass
 * the way it survives a block fence. */
function renderQuestionGaps(text: string): string {
  const gaps: string[] = [];
  const tokenised = text.replace(QUESTION_GAP_RE, (_match, raw: string) => {
    const shown = raw.includes("|") ? raw.split("|")[0]!.trim() : raw.trim();
    gaps.push(`<span class="dn-question-gap">${md.utils.escapeHtml(shown)}</span>`);
    return `dlgap${gaps.length - 1}z`;
  });
  let html = md.render(tokenised);
  gaps.forEach((gap, index) => {
    html = html.replace(`dlgap${index}z`, gap);
  });
  return html;
}

/** A ```question fence's own preview (planning/QUESTION_BLOCKS.md,
 * cell.ts's own `parseQuestionFence`) — dewlab's real
 * `.dl-question`/`.dl-question-prompt`/`.dl-question-options`/
 * `.dl-question-option` markup for multiple-choice, minus the Check
 * button and feedback slot, which need a reader and a click this editor
 * never provides. The correct option carries the same `data-correct`
 * dewlab's own build writes, so an author sees at a glance which one
 * `correct:` currently names rather than counting positions by hand.
 *
 * A fill-in-the-blank question has no options markup at all — the whole
 * body is one prompt, its gaps turned into plain spans by
 * `renderQuestionGaps()`. Either way, missing content (`type:` not
 * typed yet, `correct:` naming nothing, no options written) shows a
 * placeholder or simply nothing extra, the same "an editor reads a
 * fence mid-edit, not a finished build" choice `renderCardFencePreview`
 * already makes for a missing heading. */
export function renderQuestionFencePreview(block: Block): string {
  const question = parseQuestionFence(block);
  if (question.type === "fill-in-the-blank") {
    const bodyHtml = question.body ? renderQuestionGaps(question.body) : "<p>(no text yet)</p>";
    return `<div class="dl-question" data-question-type="fill-in-the-blank"><div class="dl-question-prompt">${bodyHtml}</div></div>`;
  }
  const promptHtml = question.prompt ? md.render(question.prompt) : "<p>(no question yet)</p>";
  const optionsHtml = question.options.length
    ? `<div class="dl-question-options">${question.options
        .map((option, index) => {
          const optionHtml = stripSingleParagraph(md.render(option));
          const isCorrect = question.correct !== null && index + 1 === question.correct;
          const correctAttr = isCorrect ? ' data-correct="true"' : "";
          return `<button type="button" class="dl-question-option"${correctAttr}>${optionHtml}</button>`;
        })
        .join("")}</div>`
    : "";
  return `<div class="dl-question" data-question-type="multiple-choice"><div class="dl-question-prompt">${promptHtml}</div>${optionsHtml}</div>`;
}
