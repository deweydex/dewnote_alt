// The block surface: decision 2's "render when blurred, edit when
// focused." This owns the one piece of mutable state that matters — the
// document's source text — and treats every edit as: rebuild the source by
// joining every block's text in order, taking a live editor's current
// content over the block's own stale text wherever one is mounted, then
// reparse from scratch (blocks.ts's round-trip guarantee is what makes
// that safe).
//
// Insert and delete are expressed the same way — as a change to that same
// per-block join, keyed by block index — rather than as a splice at some
// remembered character offset. A remembered offset goes stale the moment
// any *other* live block's content changes length before the click lands;
// an index into the block list currently on screen does not, because
// baking and restructuring happen in the same pass, against the one `doc`
// that is still guaranteed to match what's rendered.
//
// A fence block has no rendered state at all (plan §5.1) — it is always a
// live CodeMirror instance, which means a document with several cells can
// have several editors live at once, unlike a prose/math/fold/frontmatter
// block, where at most one is ever focused. That is exactly why a commit
// patches only the one block whose editor just blurred rather than
// rebuilding the whole container: an early version did the latter, and a
// Playwright test (tests/e2e/surface.spec.ts, "editing one fence and then
// focusing a second") caught the real consequence directly — clicking
// from a live fence into a second one blurs the first, whose commit tore
// down and remounted *every* block including the second, destroying the
// very click that was about to focus it. A structural edit (one that adds
// or removes a block, changes a block's kind, or reorders — checked by
// comparing the reparsed block list's shape to the old one) still falls
// back to a full rebuild, since indices no longer line up cleanly enough
// to patch in place.

import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet, type KeyBinding } from "@codemirror/view";
import { EditorSelection, EditorState, Prec, type Extension, type Range } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { parseDocument, serialize, type Block, type Document } from "./blocks.ts";
import { detectDialect } from "./dialect.ts";
import { setFrontMatterField } from "./frontmatter.ts";
import { frontMatterFieldsFor, isScalarField, type FrontMatterFieldSpec } from "./frontmatter-fields.ts";
import { editableFoldSource, renderBlockPreview, renderCardFencePreview, renderHintFencePreview, renderQuestionFencePreview, replaceFoldBody } from "./render-block.ts";
import { buildBlockMenuList, BLOCK_MENU_ITEMS, SLASH_MENU_ITEMS, type BlockKind } from "./block-menu.ts";
import { languageExtensionFor, sourceLanguageExtension } from "./lang.ts";
import { distinctValues, type FileIndexEntry } from "./file-index.ts";
import { pickLink } from "./link-picker.ts";
import { canWriteAssets, createBinaryFile, currentPath, listNamesIn } from "./active-store.ts";
import { assetNameFor, folderOf, isAssetFile, siblingPath } from "./asset-name.ts";
import { forgetAssetUrls, resolveSiblingImages } from "./asset-preview.ts";
import {
  declaredPackages,
  execCellLanguage,
  isCardFence,
  isHintFence,
  isQuestionFence,
  isRunnableFence,
  isSitePaneFence,
  parseCellSourceFromFenceText,
  parseSitePaneInfo,
  parseSqlCellInfo,
  replaceCellCode,
  setCellHeaderField,
  sqlPersistStorageKey,
  sqlScriptFromFenceText,
  wrapSqlExecCode,
  type CellHeaderKey,
  type CellSource,
  type SitePaneInfo,
  type SqlCellInfo,
} from "./cell.ts";
import { findSiteGroups, siteGroupContaining, type SiteGroup, type SitePane } from "./site-cell.ts";
import { mountSite, type SiteMountOptions } from "./runtime/site-relay.ts";
import {
  canStop,
  ensureBooted,
  requestStop,
  resetSql,
  runCell,
  runSql,
  setStatusListener,
  type OutputEvent,
} from "./runtime/pyodide-engine.ts";

export interface MountedDocument {
  /** The document's current source, byte for byte, including whatever is
   * live in any currently-mounted editor — this is what a save writes. */
  getSource(): string;
  /** Tears down every CodeMirror instance this mount created. */
  destroy(): void;
}

const EDITOR_HIGHLIGHT = HighlightStyle.define([
  { tag: tags.comment, color: "var(--dl-muted)", fontStyle: "italic" },
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword], color: "var(--dl-orange)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--dl-pass-fg)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--dl-type-html)" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: "var(--dl-type-css)" },
  { tag: [tags.typeName, tags.className], color: "var(--dl-type-js)" },
  { tag: [tags.heading, tags.strong], color: "var(--dl-heading)", fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: [tags.link, tags.url], color: "var(--dl-link)", textDecoration: "underline" },
  { tag: [tags.meta, tags.processingInstruction], color: "var(--dl-muted)" },
]);

const EDITOR_THEME = EditorView.theme({
  "&": { color: "var(--dl-fg)", backgroundColor: "transparent" },
  ".cm-content": { caretColor: "var(--dl-orange)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--dl-orange)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--dl-orange) 28%, transparent)",
  },
});

const BASE_EXTENSIONS: Extension[] = [
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  EditorView.lineWrapping,
  EDITOR_THEME,
  syntaxHighlighting(EDITOR_HIGHLIGHT),
];

/** An Obsidian-style editing layer for inline Markdown. Formatting stays
 * recognisable and punctuation stays folded until the caret enters that
 * particular construct. Source remains the editor's real document; these
 * are display decorations only, so round-tripping is untouched. */
function proseMarkdownDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const caret = view.state.selection.main.head;
  const doc = view.state.doc;
  syntaxTree(view.state).iterate({
    enter(node) {
      const parent = node.node.parent;
      const active = Boolean(parent && caret >= parent.from && caret <= parent.to);
      if (!active && ["EmphasisMark", "LinkMark", "URL", "CodeMark"].includes(node.name)) {
        ranges.push(Decoration.replace({}).range(node.from, node.to));
        return;
      }
      if (node.name === "StrongEmphasis") {
        const text = doc.sliceString(node.from, node.to);
        const inset = text.startsWith("**") || text.startsWith("__") ? 2 : 1;
        ranges.push(Decoration.mark({ class: "dn-md-strong" }).range(node.from + inset, node.to - inset));
      } else if (node.name === "Emphasis") {
        ranges.push(Decoration.mark({ class: "dn-md-emphasis" }).range(node.from + 1, node.to - 1));
      } else if (node.name === "InlineCode") {
        ranges.push(Decoration.mark({ class: "dn-md-code" }).range(node.from + 1, node.to - 1));
      } else if (node.name === "Link") {
        const text = doc.sliceString(node.from, node.to);
        const closeLabel = text.indexOf("]");
        if (closeLabel > 1) ranges.push(Decoration.mark({ class: "dn-md-link" }).range(node.from + 1, node.from + closeLabel));
      }
    },
  });
  return Decoration.set(ranges, true);
}

const proseMarkdownPreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = proseMarkdownDecorations(view); }
    update(update: { view: EditorView; docChanged: boolean; selectionSet: boolean; viewportChanged: boolean }) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = proseMarkdownDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// PEDAGOGICAL_STYLE_GUIDE §6's own worked forms, transcribed rather than
// paraphrased — this is a template an author types over, so every word
// it leaves behind is a word that ships.
//
// The hint's shape is the part worth being exact about. §6: "Two folds,
// opened in order, so a stuck student gets a route rather than the
// answer. The reflection and the follow-on question at the end matter as
// much as the steps — a hint that ends at the answer teaches the answer,
// and one that ends in a related question teaches the method." So the
// template carries **Think about:** and **Try this next:** as prompts an
// author has to delete deliberately, not as something they have to
// remember to add.
//
// Offered on every document, not only one whose front matter says
// `practice_for`. An answer fold is where the working goes, and the
// working belongs wherever the author decides to put it; §6 is a rule
// about how to teach, which the author applies, and not a rule the
// editor is in a position to enforce by withholding the block.
/** The kinds NEW_BLOCK_SPEC can build outright. Image and Link are the
 * other two: each finishes through a picker, so neither has a template
 * to drop in — see placePickedBlock. */
type TemplateKind = Exclude<BlockKind, "image" | "link">;

const PROBLEM_PLACEHOLDER = "The problem, written as a question.";
const ANSWER_PLACEHOLDER = "The answer, with the working.";
const ANSWER_FOLD = `<details class="dl-answer"><summary>answer</summary>\n\n${ANSWER_PLACEHOLDER}\n\n</details>\n\n`;
const STEPPED_HINT = [
  '<details class="dl-hint"><summary>stuck? here are some steps</summary>',
  "",
  "1. The first thing to work out.",
  "2. What that lets you do next.",
  "3. The step people usually miss.",
  "",
  "**Think about:** the question that makes the method make sense.",
  "",
  "**Try this next:** a related problem the same steps solve.",
  "",
  "</details>",
  "",
  "",
].join("\n");

// dewlab's own ```question fence (planning/QUESTION_BLOCKS.md,
// build.py's own parse_question()) — id:/type:/correct: headers, then
// ordinary markdown. Templates below are the smallest fence that passes
// every one of build.py's own checks: an id, a real type, a prompt with
// at least two options and a correct: naming one of them for multiple
// choice; a sentence with at least one {gap} for fill-in-the-blank.
const QUESTION_PROMPT_PLACEHOLDER = "The question, written so it has one right answer.";
const QUESTION_SENTENCE_PLACEHOLDER = "Write a sentence here, with the missing word in curly brackets like {this}.";

/** Set by main.ts whenever folder-panel.ts or repo-panel.ts (re)builds
 * its own file-index.ts index — a module-level singleton rather than
 * something threaded through mountDocument, since there is only ever one
 * store open and one document mounted at a time (the same reasoning
 * window.__dewnote's own test hook already relies on). Starts empty, so
 * a document opened before any folder or repository is opened still
 * gets a working link picker — DIALECTS.md never had a `tutorial:` link
 * depend on the index existing, only on it being helpful when it does. */
let sharedFileIndex: FileIndexEntry[] = [];
export function setFileIndex(index: FileIndexEntry[]): void {
  sharedFileIndex = index;
}
/** link-check.ts's own read of the same index the link picker searches —
 * a getter alongside the existing setter rather than exporting the
 * variable itself, so every reader goes through one place regardless of
 * whether the index has been built yet. */
export function getFileIndex(): FileIndexEntry[] {
  return sharedFileIndex;
}

/** file-bar.ts's own promptForNotebookFile follows the same shape: an
 * `<input type=file>` never attached to the DOM, clicked once and
 * discarded. A picker dismissed without choosing a file never fires
 * `change` in every browser this app targets, so a cancelled pick just
 * leaves this promise unsettled rather than resolving null — the same
 * behaviour file-bar.ts's own picker already has, not a new gap. */
function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.click();
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error as Error);
    reader.readAsDataURL(file);
  });
}

async function readAsBytes(file: File): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await file.arrayBuffer());
}

// A persisted SQL cell's saved script lives in localStorage, wrapped in
// try/catch the way dewstack's own save/restore is — private browsing or
// blocked storage just means this run's script won't be there to offer
// back next time, never a reason to fail the run or the restore click
// itself.
function readPersistedSql(name: string): string | null {
  try {
    return localStorage.getItem(sqlPersistStorageKey(name));
  } catch {
    return null;
  }
}
function writePersistedSql(name: string, script: string): void {
  try {
    localStorage.setItem(sqlPersistStorageKey(name), script);
  } catch {
    // Nothing to do — this run's own result is unaffected either way.
  }
}
function clearPersistedSql(name: string): void {
  try {
    localStorage.removeItem(sqlPersistStorageKey(name));
  } catch {
    // Couldn't have written it in the first place, then.
  }
}

/** Same block count, same kind at every position — the condition under
 * which a change can be patched at one index rather than requiring a full
 * rebuild, because every other block's position and meaning is unchanged. */
function sameShape(a: Document, b: Document): boolean {
  return a.blocks.length === b.blocks.length && a.blocks.every((block, i) => block.kind === b.blocks[i]!.kind);
}

export function mountDocument(container: HTMLElement, initialSource: string): MountedDocument {
  // A different document means a different folder, and the same bare
  // image name in it may well mean a different picture — so nothing
  // cached for the last one carries over (asset-preview.ts).
  forgetAssetUrls();
  let source = initialSource;
  let doc = parseDocument(source);
  const liveViews = new Map<number, EditorView>();
  /** A runnable fence's own code-only CodeMirror instance (decision 27) —
   * kept separate from `liveViews` because `blockTexts()` has to treat it
   * differently: the block's full text is the header lines (committed
   * straight into `doc`/`source` by `commitCellHeaderField`/`commitCellId`,
   * never live in an editor) plus whatever this view currently holds, not
   * this view's content standing in for the whole block the way every
   * other live editor's does. */
  const fenceCodeViews = new Map<number, EditorView>();
  /** A fold edits only its Markdown body; the `<details>` wrapper remains
   * rendered chrome and is reattached byte-for-byte by blockTexts(). */
  const foldBodyViews = new Map<number, EditorView>();
  const blockElements: HTMLElement[] = [];
  let focusedProseIndex: number | null = null;
  // Front matter's own edit state has two views (decision 11): the
  // per-field form (the default) or the plain raw-YAML editor every other
  // block already has. Reset whenever a fresh edit session starts, so
  // toggling to raw and then blurring away and back always lands on the
  // form again rather than getting stuck in whichever mode was last left.
  let frontMatterRawMode = false;
  /** decision 33: an optional *text* field's own "+ field" button reveals
   * an empty row to type into rather than committing a value immediately
   * the way an optional *select* field's own "+" already does (a select
   * always has a first option to seed itself with; a text field has
   * nothing sensible to seed with, so there is nothing to commit yet).
   * Keyed by field name, reset at the same three points frontMatterRawMode
   * is — a fresh edit session should never inherit a previous one's
   * still-empty revealed row. */
  let revealedOptionalTextFields = new Set<string>();
  /** The one block, if any, currently armed for drag reorder — set by
   * clicking its own grip handle, never by hovering or focusing the
   * block itself. A block is draggable only while armed (renderBlockWrapper
   * sets `wrapper.draggable` from this), so dragging never fires by
   * accident while selecting text or clicking through the document the
   * way an always-draggable block would invite. */
  let armedIndex: number | null = null;
  /** Guards mountEditor's own blur handler against a specific reentrancy:
   * destroying a view that currently has DOM focus (the block a keyboard
   * action, not a click, just replaced or removed — the slash menu's own
   * confirm is the first thing here that can do that) fires that view's
   * blur synchronously as part of `EditorView.destroy()`, which would
   * otherwise call `commit()` for a block already mid-teardown, reading
   * `blockTexts()` against a `doc` this function hasn't finished
   * reassigning yet and clobbering `source` with a stale reconstruction.
   * Every other teardown (a click on the "+" menu, the delete button, a
   * drag) never destroys the block that has focus, so this never fired
   * before; set for the duration of `teardownLiveViews`'s own destroy
   * loop, not for the length of any commit it might otherwise trigger. */
  let suppressBlurCommit = false;

  /** Every block's current text — a live editor's content where one is
   * mounted, the block's own text otherwise — joined in order. A
   * runnable fence with its own code-only view (`fenceCodeViews`) folds
   * that view's live content back into the block's own (already
   * header-current) text via `replaceCellCode`, rather than standing in
   * for the block's whole text the way every other live editor's does. */
  function blockTexts(): string[] {
    return doc.blocks.map((block, index) => {
      const codeView = fenceCodeViews.get(index);
      if (codeView) return replaceCellCode(block.text, codeView.state.doc.toString());
      const foldView = foldBodyViews.get(index);
      if (foldView) return replaceFoldBody(block.text, foldView.state.doc.toString());
      const liveText = liveViews.get(index)?.state.doc.toString();
      if (liveText === undefined) return block.text;
      // A prose block's terminal newlines are document separators, not
      // visible content. They are omitted from the inline editor so they
      // cannot create a phantom final line, then restored byte-for-byte.
      if (block.kind === "prose") return liveText + (block.text.match(/\n+$/)?.[0] ?? "");
      return liveText;
    });
  }

  function currentSource(): string {
    return blockTexts().join("");
  }

  function destroyEditorAt(index: number) {
    liveViews.get(index)?.destroy();
    liveViews.delete(index);
    fenceCodeViews.get(index)?.destroy();
    fenceCodeViews.delete(index);
    foldBodyViews.get(index)?.destroy();
    foldBodyViews.delete(index);
  }

  function teardownLiveViews() {
    suppressBlurCommit = true;
    for (const view of liveViews.values()) view.destroy();
    liveViews.clear();
    for (const view of fenceCodeViews.values()) view.destroy();
    fenceCodeViews.clear();
    for (const view of foldBodyViews.values()) view.destroy();
    foldBodyViews.clear();
    suppressBlurCommit = false;
    focusedProseIndex = null;
    frontMatterRawMode = false;
    revealedOptionalTextFields = new Set();
  }

  /** The common tail of every commit path that patches one block in
   * place rather than falling back to a full rebuild: re-render just
   * that block's wrapper from the current `doc` and swap it in. */
  function rerenderBlock(index: number) {
    const newWrapper = renderBlockWrapper(doc.blocks[index]!, index);
    blockElements[index]!.replaceWith(newWrapper);
    blockElements[index] = newWrapper;
  }

  /** Called on a block's own blur. Patches just that block in place when
   * the document's shape hasn't changed; falls back to a full rebuild
   * otherwise. See this file's header comment for why the patch path
   * exists at all. */
  function commit(changedIndex: number) {
    const newSource = currentSource();
    const newDoc = parseDocument(newSource);

    // A site pane's own live preview lives on a *different* block's
    // wrapper (its group's last pane — see buildSiteGroupPreview), which
    // the single-block patch below never touches. Forcing the full
    // rebuild here, the same path a structural change already takes, is
    // what makes editing any pane actually refresh the shared preview —
    // a small, deliberate cost, not an oversight.
    const editedBlock = doc.blocks[changedIndex];
    const editedIsSitePane = editedBlock?.kind === "fence" && isSitePaneFence(editedBlock.fence?.info ?? "");

    if (!sameShape(doc, newDoc) || editedIsSitePane) {
      source = newSource;
      teardownLiveViews();
      doc = newDoc;
      render();
      return;
    }

    destroyEditorAt(changedIndex);
    if (changedIndex === focusedProseIndex) focusedProseIndex = null;
    source = newSource;
    doc = newDoc;
    rerenderBlock(changedIndex);
  }

  /** The front-matter form's own commit path (decision 11) — there is no
   * live EditorView backing a plain HTML form field, so this can't go
   * through `commit()`, but it patches the one changed block the same
   * way: reparse, and either patch in place (the common case — editing a
   * scalar field never changes the document's shape) or fall back to a
   * full rebuild if it somehow did. `setFrontMatterField` itself only
   * ever touches the one field's line, so every other line's bytes are
   * untouched (DECISIONS.md 1). Stays on the form (focusedProseIndex is
   * never changed here) so a field's own row simply shows its new value. */
  function commitFrontMatterField(index: number, key: string, value: string) {
    const block = doc.blocks[index]!;
    const newText = setFrontMatterField(block.text, key, value);
    if (newText === block.text) return;

    const parts = blockTexts();
    parts[index] = newText;
    source = parts.join("");
    const newDoc = parseDocument(source);

    if (!sameShape(doc, newDoc)) {
      teardownLiveViews();
      doc = newDoc;
      render();
      return;
    }

    doc = newDoc;
    rerenderBlock(index);
  }

  /** The form's "Done" button: collapse front matter back to its one-line
   * summary, the same gate every other block's blurred state uses. */
  function exitFrontMatterEdit(index: number) {
    if (focusedProseIndex === index) focusedProseIndex = null;
    frontMatterRawMode = false;
    revealedOptionalTextFields = new Set();
    rerenderBlock(index);
  }

  /** Every dewlab `id:` line already in the document, front-fence-block's
   * own excepted (so a rename can freely reuse the value it's leaving —
   * the check is "does some *other* cell have this", not "did I have it
   * a moment ago"). Shared by `generateCellId` (a fresh id must avoid
   * every existing one) and `commitCellId` (a renamed id must avoid every
   * *other* cell's), so the two can never silently disagree about what
   * counts as taken. */
  function collectExistingCellIds(excludeIndex: number | null): Set<string> {
    const existing = new Set<string>();
    doc.blocks.forEach((block, i) => {
      if (i === excludeIndex || block.kind !== "fence") return;
      const match = /^id:\s*(.+)$/m.exec(block.text);
      if (match) existing.add(match[1]!.trim());
    });
    return existing;
  }

  /** A new block's starting text and where the cursor should land, by
   * kind offered from the add menu — a selection spanning real
   * placeholder words (`paragraph`, `hint`) so the first keystroke
   * replaces it outright, or a bare cursor on an empty line (`cell`,
   * `math`) where there is nothing to replace, only somewhere to start
   * typing. Not yet dialect-aware — decision 3 already promises a
   * dialect its own add-menu content (dewstack has no maths and five
   * cell forms, not dewlab's one), and this is the same universal set
   * regardless of the open document's dialect until that per-dialect
   * module exists. */
  const NEW_BLOCK_SPEC: Record<TemplateKind, () => { text: string; anchor: number; head: number }> = {
    paragraph: () => ({ text: "New paragraph.\n\n", anchor: 0, head: "New paragraph.".length }),
    cell: () => {
      const text = `\`\`\`python exec\nid: ${generateBlockId("new-cell")}\n\n\`\`\`\n\n`;
      // A fresh cell's own code-only editor (fenceCodeViews) starts
      // empty, so position 0 is always right — unlike the other three
      // kinds here, this offset was never into the full spliced text.
      return { text, anchor: 0, head: 0 };
    },
    "sql-cell": () => {
      const text = `\`\`\`sql exec\nid: ${generateBlockId("new-sql")}\n\n\`\`\`\n\n`;
      return { text, anchor: 0, head: 0 };
    },
    "code-block": () => {
      const text = "```python\n# Example code\n\n```\n\n";
      const at = text.indexOf("# Example code");
      return { text, anchor: at, head: at + "# Example code".length };
    },
    site: () => {
      const site = generateBlockId("new-site");
      const text =
        `\`\`\`html site\nid: ${site}-html\nsite: ${site}\n<div class="example">Hello</div>\n\`\`\`\n\n` +
        `\`\`\`css site\nid: ${site}-css\nsite: ${site}\n.example {\n  color: tomato;\n}\n\`\`\`\n\n` +
        `\`\`\`js site\nid: ${site}-js\nsite: ${site}\nconsole.log("Site ready");\n\`\`\`\n\n`;
      const at = text.indexOf("<div");
      return { text, anchor: at, head: at + '<div class="example">Hello</div>'.length };
    },
    math: () => {
      const text = "$$\n\n$$\n\n";
      const at = text.indexOf("\n\n") + 1;
      return { text, anchor: at, head: at };
    },
    hint: () => {
      const text = '<details class="dl-hint"><summary>hint</summary>\n\nHint text.\n\n</details>\n\n';
      const at = text.indexOf("Hint text.");
      return { text, anchor: at, head: at + "Hint text.".length };
    },
    "staged-hint": () => {
      const text = "```hint\nafter: errors:5\ntitle: Let’s slow down a moment…\n\nWrite the next useful clue here.\n```\n\n";
      const at = text.indexOf("Write the next useful clue here.");
      return { text, anchor: at, head: at + "Write the next useful clue here.".length };
    },
    answer: () => {
      const text = ANSWER_FOLD;
      const at = text.indexOf(ANSWER_PLACEHOLDER);
      return { text, anchor: at, head: at + ANSWER_PLACEHOLDER.length };
    },
    practice: () => {
      const text = `${PROBLEM_PLACEHOLDER}\n\n${STEPPED_HINT}${ANSWER_FOLD}`;
      // The cursor lands on the problem itself, which is the one part
      // that has to be written before the rest means anything.
      return { text, anchor: 0, head: PROBLEM_PLACEHOLDER.length };
    },
    "multiple-choice": () => {
      const text =
        "```question\n" +
        `id: ${generateBlockId("new-question")}\n` +
        "type: multiple-choice\n" +
        "correct: 1\n\n" +
        `${QUESTION_PROMPT_PLACEHOLDER}\n\n` +
        "- The right answer.\n" +
        "- A wrong answer.\n" +
        "- Another wrong answer.\n" +
        "```\n\n";
      const at = text.indexOf(QUESTION_PROMPT_PLACEHOLDER);
      return { text, anchor: at, head: at + QUESTION_PROMPT_PLACEHOLDER.length };
    },
    "fill-in-the-blank": () => {
      const text = "```question\n" + `id: ${generateBlockId("new-question")}\n` + "type: fill-in-the-blank\n\n" + `${QUESTION_SENTENCE_PLACEHOLDER}\n` + "```\n\n";
      const at = text.indexOf(QUESTION_SENTENCE_PLACEHOLDER);
      return { text, anchor: at, head: at + QUESTION_SENTENCE_PLACEHOLDER.length };
    },
    card: () => {
      const text = "```card\nurl: tutorial:example\nstatus: live\nmeta: Tutorial\n\n## Card title\n\nDescribe what the reader will learn.\n```\n\n";
      const at = text.indexOf("Card title");
      return { text, anchor: at, head: at + "Card title".length };
    },
  };

  /** `new-cell-1`/`new-question-1`/... — the first `${prefix}-N` not
   * already used as a dewlab `id:` line anywhere in the document. One
   * generator for both: a question's id is a contract on the same terms
   * a cell's is (planning/QUESTION_BLOCKS.md), sharing dewlab's own one
   * saved-answer namespace, and `collectExistingCellIds` already scans
   * every fence's `id:` line regardless of what kind of fence it is. */
  function generateBlockId(prefix: string): string {
    const existing = collectExistingCellIds(null);
    let n = 1;
    while (existing.has(`${prefix}-${n}`)) n++;
    return `${prefix}-${n}`;
  }

  /** Not in NEW_BLOCK_SPEC's own synchronous table because picking a
   * file and reading it are both async, unlike every other add-menu
   * kind.
   *
   * ## A real file beside the document, when there is one
   *
   * Both builds resolve an image the same way: the markdown names a bare
   * file, and the build looks for it in the folder the markdown sits in
   * — dewlab's `resolve_assets()`, which *fails the build* on a name
   * with no file behind it, and dewstack's own copy of every
   * non-`.md`/`.yaml` sibling into the page's output. Under dewlab's
   * current layout that folder is `tutorials/<id>/`, shared by the
   * tutorial, its practice page and every frozen release of it, so all
   * three resolve the same bare name against the same picture.
   *
   * So when a store is open and the open document has a path, the bytes
   * are written next to it and the markdown gets the bare name dewlab
   * expects. `asset-name.ts` decides the name: reshaped so markdown
   * can't misread it (`![alt](My Photo (1).png)` ends its link at the
   * first `)`), and stepped past any name already in that folder, since
   * a name in use belongs to a picture already on a page.
   *
   * ## A `data:` URI when there is nowhere to write
   *
   * A document dropped onto the editor has no folder, and neither does
   * one being written before anything is opened. Inlining is the honest
   * answer there rather than refusing the image: it renders, it
   * round-trips, and dewlab's own `EXTERNAL_URL_RE` leaves a `data:` URI
   * alone rather than failing on it. What it costs is a real file — an
   * export or a push carries the whole picture inline — so the status
   * line says which of the two just happened rather than leaving the
   * reader to find out at build time.
   *
   * Alt text is asked for the same way DIALECTS.md's own worked examples
   * always write it: required in the markdown, never left empty by this
   * UI even though a reader could still hand-edit it away afterwards.
   * dewlab's `check_alt_text()` fails the build on an image with no
   * `alt` at all, and reads an explicit empty one as "decorative". */
  async function markdownForImage(): Promise<string | null> {
    const file = await pickImageFile();
    if (!file) return null;
    const alt = window.prompt("Alt text for this image:", "") ?? "";
    const target = await writeImageBeside(file);
    return `![${alt}](${target})`;
  }

  /** The bare file name a real copy was written under, or a `data:` URI
   * when there was nowhere to write one. A failed write falls back to
   * inlining rather than losing the image the reader just picked — the
   * picture still lands on the page, and the reason the copy didn't
   * happen is the one thing worth saying out loud. */
  async function writeImageBeside(file: File): Promise<string> {
    if (!canWriteAssets()) return readAsDataUrl(file);
    const documentPath = currentPath();
    if (!documentPath) return readAsDataUrl(file);

    const folder = folderOf(documentPath);
    const taken = (await listNamesIn(folder)).filter(isAssetFile);
    const name = assetNameFor(file.name, taken);
    try {
      await createBinaryFile(siblingPath(documentPath, name), await readAsBytes(file));
      return name;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      window.alert(`Couldn't save the image beside this document (${why}) — it's in the document itself instead, which every build will still render.`);
      return readAsDataUrl(file);
    }
  }

  /** Also async, like markdownForImage, and for the same reason neither
   * is in NEW_BLOCK_SPEC — pickLink is a whole search overlay, not a
   * synchronous placeholder. It resolves to finished `[text](target)`
   * markdown already, so there is nothing to build here; sharedFileIndex
   * is whatever main.ts last set from an opened folder or repository,
   * empty until then. */
  async function markdownForLink(): Promise<string | null> {
    return await pickLink(sharedFileIndex);
  }

  /** Where a picker's finished markdown goes, for either menu.
   *
   * ## Why this is not just insertAfter with an await in front of it
   *
   * The "+" menu's case is the easy one: the reader clicked a button in
   * the margin, nothing in the document is focused, and the result is
   * spliced in after block `afterIndex` exactly the way a template
   * would be.
   *
   * The slash menu's case is the one this function exists for. The
   * reader typed "/image" into a block whose editor is still live and
   * focused, and the file chooser that opens next takes that focus
   * away. The blur commits "/image" as real prose and re-renders — so
   * by the time the picker resolves, the promise's own idea of "the
   * block the reader was typing into" is a paragraph that now says
   * "/image", and replacing it is exactly right. That is what
   * `replacing` asks for.
   *
   * It is checked rather than assumed. The link picker is an overlay in
   * the same page, not an OS file chooser, so a reader can in principle
   * click back into the document while it is open and change what is
   * there. If the block no longer reads as the slash command that
   * started this, the markdown lands after it instead of over whatever
   * the reader has since written — losing the reader's own words is the
   * one outcome worth writing a branch to avoid. */
  function placePickedBlock(markdown: string, index: number | null, replacing: boolean) {
    const text = `${markdown}\n\n`;
    const parts = blockTexts();
    const at = index === null ? 0 : index;
    const stillTheSlashCommand = replacing && index !== null && /^\/[a-zA-Z]*\s*$/.test(parts[at] ?? "");
    const spliceIndex = stillTheSlashCommand ? at : index === null ? 0 : at + 1;
    parts.splice(spliceIndex, stillTheSlashCommand ? 1 : 0, text);
    source = parts.join("");
    teardownLiveViews();
    doc = parseDocument(source);
    render();
  }

  /** One route to a picker for both menus: run it, and if the reader
   * chose something, place it. */
  async function addPickedBlock(kind: "image" | "link", index: number | null, replacing: boolean) {
    const markdown = kind === "image" ? await markdownForImage() : await markdownForLink();
    if (markdown) placePickedBlock(markdown, index, replacing);
  }

  /** Shared by insertAfter (deleteCount 0 — the "+" menu, between two
   * existing blocks) and insertViaSlash (deleteCount 1 — the slash
   * menu, replacing the very block the reader is typing into): splice a
   * freshly-specced block's text into `parts` at `spliceIndex`, reparse,
   * and focus it exactly the way a block just created from a placeholder
   * wants — immediately, not on a second click. A fence is already live
   * the moment it renders; anything else needs enterEdit to swap it into
   * its source view. A runnable fence's own live editor is its code-only
   * view (fenceCodeViews), not liveViews — every other fence kind still
   * uses liveViews, same as ever. */
  function spliceNewBlock(spliceIndex: number, deleteCount: number, spec: { text: string; anchor: number; head: number }) {
    const parts = blockTexts();
    parts.splice(spliceIndex, deleteCount, spec.text);
    source = parts.join("");
    teardownLiveViews();
    doc = parseDocument(source);
    render();
    const newBlock = doc.blocks[spliceIndex];
    const newFenceView = newBlock?.kind === "fence" ? fenceCodeViews.get(spliceIndex) : undefined;
    if (newFenceView) newFenceView.focus();
    else if (newBlock?.kind === "fence") liveViews.get(spliceIndex)?.focus();
    else if (newBlock) enterEdit(spliceIndex);
    // enterEdit's own focus (renderBlockWrapper's queueMicrotask) queues
    // first when it applies; queuing this one after it, rather than
    // setting the selection synchronously here, is what makes it land
    // after that focus instead of being clobbered by it.
    queueMicrotask(() => {
      (newFenceView ?? liveViews.get(spliceIndex))?.dispatch({ selection: EditorSelection.single(spec.anchor, spec.head) });
    });
  }

  function insertAfter(afterIndex: number | null, kind: TemplateKind) {
    const spec = NEW_BLOCK_SPEC[kind]();
    const newIndex = afterIndex === null ? 0 : afterIndex + 1;
    spliceNewBlock(newIndex, 0, spec);
  }

  /** The slash menu's own confirm for a template kind (buildSlashMenu):
   * replaces the block the reader is mid-typing into — not the block
   * after it, the way the "+" menu's insertAfter does — since the whole
   * point of typing "/cell" is that there is nothing in this block worth
   * keeping. A picked kind (Image, Link) goes through addPickedBlock
   * instead, which cannot replace the block until its picker resolves. */
  function insertViaSlash(index: number, kind: TemplateKind) {
    const spec = NEW_BLOCK_SPEC[kind]();
    spliceNewBlock(index, 1, spec);
  }

  function deleteBlock(index: number) {
    const parts = blockTexts();
    parts.splice(index, 1);
    source = parts.join("");
    teardownLiveViews();
    doc = parseDocument(source);
    render();
  }

  function canMoveUp(index: number): boolean {
    if (doc.blocks[index]!.kind === "frontmatter") return false;
    const target = index - 1;
    return target >= 0 && doc.blocks[target]!.kind !== "frontmatter";
  }

  function canMoveDown(index: number): boolean {
    return doc.blocks[index]!.kind !== "frontmatter" && index < doc.blocks.length - 1;
  }

  /** Keyboard reorder — ArrowUp/ArrowDown on an armed block's own grip
   * handle. Re-arms the block at its new position afterward, since
   * render() tears down and rebuilds every wrapper (including the grip
   * that has focus), and a keyboard user pressing the arrow again
   * expects the same block still armed under their finger, not the one
   * that used to be at this index. */
  function moveBlock(index: number, delta: -1 | 1) {
    const parts = blockTexts();
    const [moved] = parts.splice(index, 1);
    parts.splice(index + delta, 0, moved!);
    source = parts.join("");
    teardownLiveViews();
    doc = parseDocument(source);
    render();
    setArmed(index + delta);
    // The grip is the one in the cluster now, not one inside the block —
    // `setArmed` has already moved the cluster to the block's new index,
    // so this is simply "keep the key you were pressing under your
    // finger" and a second arrow continues the move.
    grip.focus();
  }

  /** Drag reorder's own move — dropping block `fromIndex` onto block
   * `toIndex`. Clamped to never land above front matter (canMoveUp's own
   * rule, expressed differently here since drag has no "one step at a
   * time" adjacent-index shape to check against). */
  function moveBlockTo(fromIndex: number, toIndex: number) {
    const minIndex = doc.blocks[0]?.kind === "frontmatter" ? 1 : 0;
    if (fromIndex < minIndex || fromIndex === toIndex) return;
    const parts = blockTexts();
    const [moved] = parts.splice(fromIndex, 1);
    let target = toIndex > fromIndex ? toIndex - 1 : toIndex;
    if (target < minIndex) target = minIndex;
    parts.splice(target, 0, moved!);
    source = parts.join("");
    teardownLiveViews();
    doc = parseDocument(source);
    render();
  }

  /** Arms exactly one block for drag reorder at a time — arming a second
   * disarms the first, the same "one thing open" rule closeOpenAddMenus
   * already keeps for the add menus. */
  function setArmed(index: number | null) {
    if (armedIndex !== null && blockElements[armedIndex]) blockElements[armedIndex]!.classList.remove("is-armed");
    armedIndex = index;
    if (index !== null && blockElements[index]) blockElements[index]!.classList.add("is-armed");
    // The grip and the delete button both live in the one cluster now, so
    // arming is a matter of re-reading it rather than of finding the
    // right block's own copy. Delete appears here and nowhere else:
    // arming is what reveals it.
    if (index !== null) attachControls(index);
    else if (controlsIndex !== null) attachControls(controlsIndex);
  }

  /** `targetMap` defaults to `liveViews` — the generic "this view's own
   * content is the whole block" case every kind but a split runnable
   * fence is. A runnable fence's own code-only view passes
   * `fenceCodeViews` instead, so `blockTexts()` knows to reassemble its
   * content with the block's header lines rather than stand in for the
   * whole block on its own (see `fenceCodeViews`'s own comment). */
  function mountEditor(
    host: HTMLElement,
    index: number,
    text: string,
    extensions: Extension[],
    targetMap: Map<number, EditorView> = liveViews,
  ): EditorView {
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          ...BASE_EXTENSIONS,
          ...extensions,
          EditorView.domEventHandlers({
            blur: () => {
              if (!suppressBlurCommit) commit(index);
              return false;
            },
          }),
        ],
      }),
      parent: host,
    });
    targetMap.set(index, view);
    return view;
  }

  function enterEdit(index: number) {
    if (focusedProseIndex !== null) return; // one non-fence block editable at a time, in this first cut
    focusedProseIndex = index;
    frontMatterRawMode = false;
    revealedOptionalTextFields = new Set();
    rerenderBlock(index);
  }

  function closeOpenAddMenus() {
    for (const menu of container.querySelectorAll(".dn-add-menu.is-open")) menu.classList.remove("is-open");
  }

  // ## One set of controls, not one per block
  //
  // Every block used to carry its own: a "+" gap above it holding a full
  // copy of the six-item add menu, and a toolbar holding a grip and a
  // delete button. For a six-block document that is seven menus and six
  // toolbars — over fifty buttons in the DOM, almost none of them visible
  // at any moment, and on a touch screen (where `@media (hover: none)`
  // reveals them all) six "+" circles running down the middle of the page.
  //
  // At most one block is ever being acted on, so there is one cluster and
  // it moves to whichever block the reader is pointing at. This is the
  // shape every editor of this kind converged on, and the reason is not
  // fashion: chrome that repeats per block reads as part of the document,
  // and chrome that appears at one place reads as a tool.
  //
  // It sits in the left margin, outside the column the text runs in. That
  // keeps it out of the reading line, and it is also what stops it
  // colliding with the icon rail on the right — on a phone the two used
  // to overlap, every block's grip sitting underneath a rail button and
  // flush to the screen edge.
  //
  // ## What each control does, and what is deliberately not here
  //
  // `+` inserts *after* the block it is attached to. Front matter is
  // block 0 in every dewlab and dewstack document, so its own "+" is how
  // the top of the body is reached; a plain markdown file with no front
  // matter has no way to insert above its first block, which is the one
  // position this costs, and adding then dragging covers it. A second
  // permanent "+" pinned above the document to serve that case would put
  // chrome on every document for the sake of a rare one.
  //
  // Delete is not in the resting set. It appears only once a block is
  // armed — clicking the grip, which already arms for keyboard
  // reordering. So the resting state is two controls, and deleting a
  // block is a deliberate two-step rather than a click on a button that
  // sat one pixel from the drag handle.
  //
  // Reordering stays two ways and not three: drag the grip, or arm it and
  // use the arrow keys. There are no up/down buttons, and adding a pair
  // per block is exactly the repetition this replaces.
  const controls = document.createElement("div");
  controls.className = "dn-block-controls";
  controls.hidden = true;

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "dn-add-btn";
  addButton.setAttribute("aria-label", "Add a block after this one");
  addButton.title = "Add a block after this one";
  addButton.textContent = "+";

  // ## The "+" menu is a small palette, not a list of buttons
  //
  // It holds a search field, then the same grouped list the slash menu
  // draws (block-menu.ts). Search is what lets the list hold everything
  // without getting harder to use: two letters reaches any kind, so the
  // next kind added costs nothing, and a reader who does not know what
  // they want reads three short groups rather than one long column.
  //
  // The field takes focus when the menu opens and the keys work the way
  // they do everywhere else in the app — ↑ and ↓ move, Enter confirms,
  // Escape closes. A reader who never touches it clicks a row instead,
  // and on a touch screen the whole thing is a sheet at the bottom of
  // the window with rows the size of a thumb.
  const addMenu = document.createElement("div");
  addMenu.className = "dn-add-menu";
  addMenu.setAttribute("role", "dialog");
  addMenu.setAttribute("aria-label", "Add a block");

  const addSearch = document.createElement("input");
  addSearch.type = "text";
  addSearch.className = "dn-add-search";
  addSearch.setAttribute("placeholder", "Search blocks…");
  addSearch.setAttribute("aria-label", "Search blocks");
  addMenu.appendChild(addSearch);

  const addList = buildBlockMenuList({
    items: BLOCK_MENU_ITEMS,
    onConfirm: (kind) => {
      const after = controlsIndex;
      closeOpenAddMenus();
      if (kind === "image" || kind === "link") void addPickedBlock(kind, after, false);
      else insertAfter(after, kind);
    },
  });
  addMenu.appendChild(addList.element);

  const addEmpty = document.createElement("div");
  addEmpty.className = "dn-add-empty";
  addEmpty.hidden = true;
  addEmpty.textContent = "Nothing by that name.";
  addMenu.appendChild(addEmpty);

  function syncAddMenu() {
    addList.setQuery(addSearch.value);
    addEmpty.hidden = addList.isOpen();
  }

  addSearch.addEventListener("input", syncAddMenu);
  addSearch.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && addList.move(1)) event.preventDefault();
    else if (event.key === "ArrowUp" && addList.move(-1)) event.preventDefault();
    else if (event.key === "Enter") {
      event.preventDefault();
      addList.confirmSelected();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeOpenAddMenus();
      addButton.focus();
    }
  });

  addButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const wasOpen = addMenu.classList.contains("is-open");
    closeOpenAddMenus();
    if (!wasOpen) {
      addSearch.value = "";
      syncAddMenu();
      addMenu.classList.add("is-open");
      addSearch.focus();
    }
  });

  const grip = document.createElement("button");
  grip.type = "button";
  grip.className = "dn-block-grip";
  grip.draggable = true;
  grip.setAttribute("aria-label", "Drag to reorder, or click and use the arrow keys");
  grip.title = "Drag to move, or click then use the arrow keys";
  grip.textContent = "⠿";
  grip.addEventListener("click", (event) => {
    event.stopPropagation();
    const target = heldIndex ?? controlsIndex;
    heldIndex = null;
    if (target === null) return;
    setArmed(armedIndex === target ? null : target);
  });
  // The block the grip was on when it was pressed.
  //
  // Set on pointerdown, not dragstart, and that is the whole point: the
  // cluster follows the pointer, and by the time `dragstart` fires the
  // pointer has already travelled far enough to count as a drag — over
  // other blocks, each of which would have pulled the cluster along and
  // left the drag reporting whichever block it happened to be passing.
  // Pressing is when the reader chose a block; everything after that
  // reads from here.
  grip.addEventListener("pointerdown", () => {
    heldIndex = controlsIndex;
  });
  // A press that never became a drag.
  window.addEventListener("pointerup", releaseGrip);
  grip.addEventListener("dragstart", (event) => {
    const from = heldIndex ?? controlsIndex;
    if (from === null) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData("text/plain", String(from));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    draggingIndex = from;
  });
  grip.addEventListener("dragend", () => {
    draggingIndex = null;
    heldIndex = null;
  });
  grip.addEventListener("keydown", (event) => {
    if (armedIndex === null || armedIndex !== controlsIndex) return;
    if (event.key === "ArrowUp" && canMoveUp(armedIndex)) {
      event.preventDefault();
      moveBlock(armedIndex, -1);
    } else if (event.key === "ArrowDown" && canMoveDown(armedIndex)) {
      event.preventDefault();
      moveBlock(armedIndex, 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setArmed(null);
    }
  });

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "dn-block-delete";
  deleteButton.setAttribute("aria-label", "Delete this block");
  deleteButton.title = "Delete this block";
  deleteButton.textContent = "×";
  deleteButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (controlsIndex !== null) deleteBlock(controlsIndex);
  });

  controls.append(addButton, grip, deleteButton, addMenu);

  /** Which block the cluster is currently attached to, or null when it is
   * parked. Every control reads this rather than closing over an index,
   * which is what lets one set of handlers serve every block. */
  let controlsIndex: number | null = null;
  /** The block currently being dragged by its grip, so a wrapper knows to
   * accept a drop. Replaces the old rule that a block had to be *armed*
   * before it could be dragged at all — that existed because the whole
   * wrapper was draggable and a stray drag would have fought text
   * selection. The grip is a deliberate target, so it drags directly. */
  let draggingIndex: number | null = null;
  /** The block the grip was pressed on, held from pointerdown until the
   * drag ends or the press is released. While it is set the cluster stays
   * put — see the pointerdown handler. */
  let heldIndex: number | null = null;
  function releaseGrip() {
    if (draggingIndex === null) heldIndex = null;
  }

  /** Moves the cluster to `index`, or parks it when null.
   *
   * Positioned against the container rather than appended into the block,
   * so moving it never re-renders anything and never disturbs a live
   * editor. Front matter gets the "+" but no grip and no delete: it stays
   * first and is not a block anybody removes. */
  function attachControls(index: number | null) {
    // Never while the grip is held. The cluster follows the pointer, and
    // a pointer on its way to a drop crosses every block in between —
    // letting it follow would move the grip out from under the drag that
    // started on it.
    if (heldIndex !== null || draggingIndex !== null) return;
    if (index === null || !blockElements[index]) {
      controls.hidden = true;
      delete controls.dataset["index"];
      controlsIndex = null;
      return;
    }
    const wrapper = blockElements[index]!;
    const isFrontMatter = doc.blocks[index]?.kind === "frontmatter";
    controlsIndex = index;
    controls.hidden = false;
    // Which block these belong to, readable from the DOM. The cluster
    // glides between blocks rather than jumping, so its pixel position is
    // mid-transition for a moment after it moves and is not a reliable
    // answer to "which block is this on" — for a test or for anybody
    // debugging.
    controls.dataset["index"] = String(index);
    controls.style.top = `${wrapper.offsetTop}px`;
    grip.hidden = isFrontMatter;
    // Delete is armed-only, and front matter is never armed.
    deleteButton.hidden = isFrontMatter || armedIndex !== index;
    grip.setAttribute("aria-pressed", String(armedIndex === index));
    controls.classList.toggle("is-armed", armedIndex === index);
  }

  /** A prose block's own keyboard shortcut for the "+" menu: typing "/"
   * (optionally followed by a few letters) while the block holds nothing
   * else offers to turn the whole block into any other kind.
   *
   * Deliberately whole-block, not per-line the way Notion's own slash
   * menu is — a block that already holds real prose typing a literal
   * "/" is not offering to replace itself, only a block that is nothing
   * else yet reads as one.
   *
   * It offers `SLASH_MENU_ITEMS`, which is everything the "+" menu
   * offers except Paragraph: a block you can type "/" into already is a
   * paragraph, so that one command alone would do nothing. Image and
   * Link used to be missing here too, on the grounds that each hands
   * the reader to a picker while this block's editor is still focused
   * and live, with a blur mid-flight to account for. That was a real
   * problem and the wrong answer to it — the fix belongs in the one
   * place that places a picker's result (placePickedBlock), not in a
   * menu that quietly offers less than the button beside it.
   *
   * Renders into the block wrapper (renderBlockWrapper's own prose
   * branch), `sync` called from an `EditorView.updateListener` on every
   * doc change, `keymap` wired in alongside it so the arrow
   * keys/Enter/Escape only ever mean "the menu" while it actually has
   * items open. */
  function buildSlashMenu(index: number): { element: HTMLElement; sync: (text: string) => void; keymap: readonly KeyBinding[] } {
    // Escape dismisses this one slash attempt, not slash commands in
    // general — set here and cleared only once the text stops looking
    // like a slash command at all (sync's own "no match" branch), so
    // the very next keystroke after Escape (still matching) doesn't
    // reopen the menu the reader just closed.
    let dismissed = false;

    const list = buildBlockMenuList({
      items: SLASH_MENU_ITEMS,
      // mousedown, not click: fires before the editor's own blur
      // handler would commit "/answer" as the block's real prose text.
      confirmOn: "mousedown",
      onConfirm: (kind) => {
        list.close();
        if (kind === "image" || kind === "link") void addPickedBlock(kind, index, true);
        else insertViaSlash(index, kind);
      },
    });
    list.element.classList.add("dn-slash-menu");

    function sync(text: string) {
      // Trailing newlines stripped before matching: the "+" menu's own
      // fresh paragraph (NEW_BLOCK_SPEC.paragraph) selects only its
      // placeholder words, so typing "/c" over that selection leaves the
      // block's own "\n\n" after it untouched — still nothing but a
      // slash command as far as this block's own content goes.
      const match = /^\/([a-zA-Z]*)$/.exec(text.replace(/\n+$/, ""));
      const filter = match?.[1] ?? null;
      if (filter === null) dismissed = false;
      if (filter === null || dismissed) list.close();
      else list.setQuery(filter);
    }

    const bindings: KeyBinding[] = [
      { key: "ArrowDown", run: () => list.move(1) },
      { key: "ArrowUp", run: () => list.move(-1) },
      { key: "Enter", run: () => list.confirmSelected() },
      {
        key: "Escape",
        run: () => {
          if (!list.isOpen()) return false;
          dismissed = true;
          list.close();
          return true;
        },
      },
    ];

    return { element: list.element, sync, keymap: bindings };
  }

  /** Move and delete apply to every block kind, fences included — a code
   * cell is as reorderable and removable as a paragraph, even though it
   * has no rendered state to click into the way the others do. */
  /** A single grip, not up/down arrows — clicking it arms the block for
   * drag reorder (setArmed), and once armed, ArrowUp/ArrowDown on the
   * grip itself move it exactly as the old buttons did, so keyboard
   * reorder loses nothing by losing the arrows. */
  /** dewlab's own output-event protocol (clear/stream/append), applied to
   * one cell's output area exactly the way dewlab's applyOutputEvent
   * does: "clear" wipes it, "stream" appends running text (coalesced onto
   * the previous run of the same css class rather than one element per
   * write, since print() calls one line at a time), "append" inserts one
   * complete HTML fragment (a table, a figure, an error) verbatim — safe
   * because dewnote_tools.py, not any external input, produced it. */
  function applyOutputEvent(output: HTMLElement, event: OutputEvent) {
    if (event.kind === "clear") {
      output.replaceChildren();
      return;
    }
    if (event.kind === "stream") {
      const last = output.lastElementChild;
      if (last instanceof HTMLElement && last.dataset["stream"] === event.cssClass) {
        last.append(event.text);
      } else {
        const span = document.createElement("pre");
        span.className = `dn-cell-stream ${event.cssClass}`;
        span.dataset["stream"] = event.cssClass;
        span.textContent = event.text;
        output.appendChild(span);
      }
      return;
    }
    output.insertAdjacentHTML("beforeend", event.markup);
  }

  /** The shared shell every fence's below-editor "extra stuff" is built
   * on — a cell's Run bar and output, a SQL cell's restore banner and
   * output, a staged hint's read-only preview, a site group's live
   * preview. Grew up as four separate ad-hoc `<div>` trees across four
   * separate PRs; each kind keeps its own class (`dn-cell-panel`, and so
   * on) for its own look and for the tests that already select by it —
   * this only carries what all four genuinely share (the CSS to match,
   * on `.dn-fence-panel`), so a spacing change happens once instead of
   * four times over. `children` is filtered for `null`/`undefined` so a
   * caller can pass an optional part (a restore banner, a Run bar that
   * only exists when a group has a `js` pane) inline rather than
   * building the array up with conditional `.push`es. */
  function buildFencePanel(modifierClass: string, ...children: (HTMLElement | null | undefined)[]): HTMLElement {
    const panel = document.createElement("div");
    panel.className = `dn-fence-panel ${modifierClass}`;
    for (const child of children) if (child) panel.appendChild(child);
    return panel;
  }

  interface CellHeaderFieldSpec {
    key: CellHeaderKey;
    label: string;
    required: boolean;
  }

  /** dewlab's own fixed header shape for an exec cell (DIALECTS.md §1) —
   * `id:` required, the rest optional. Not a per-dialect list the way
   * `frontmatter-fields.ts`'s is: dewstack has no `python exec` cells of
   * its own to give a different shape to, so there is only one shape to
   * describe here, ever. */
  const CELL_HEADER_FIELDS: CellHeaderFieldSpec[] = [
    { key: "id", label: "id", required: true },
    { key: "hint", label: "hint", required: false },
    { key: "expect", label: "expect", required: false },
    { key: "name", label: "name", required: false },
  ];

  /** One header field's own compact row (decision 27) — a label, a plain
   * text input with no visible border until it's hovered or focused (the
   * plan's own "quiet by default, everything one press away," applied to
   * a cell's own chrome exactly as it already is to a document's), and
   * for an optional field a small clear button. `id` is required and
   * never removable — DIALECTS.md §1's own contract — and edits to it go
   * through `commitCellId`'s own rename safeguards rather than the
   * generic commit every other field uses. */
  function buildCellHeaderField(index: number, field: CellHeaderFieldSpec, value: string): HTMLElement {
    const row = document.createElement("label");
    row.className = "dn-cell-header-field";

    const labelSpan = document.createElement("span");
    labelSpan.className = "dn-cell-header-label";
    labelSpan.textContent = field.label;
    row.appendChild(labelSpan);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "dn-cell-header-input";
    input.value = value;
    input.addEventListener("change", () => {
      if (field.key === "id") commitCellId(index, input.value);
      else commitCellHeaderField(index, field.key, input.value);
    });
    row.appendChild(input);

    if (!field.required) {
      const clearButton = document.createElement("button");
      clearButton.type = "button";
      clearButton.className = "dn-cell-header-clear";
      clearButton.setAttribute("aria-label", `Remove ${field.label}`);
      clearButton.textContent = "×";
      clearButton.addEventListener("click", (event) => {
        event.preventDefault();
        commitCellHeaderField(index, field.key, "");
      });
      row.appendChild(clearButton);
    }

    return row;
  }

  /** A runnable fence's own compact meta-bar (decision 27): the language,
   * `id` (always present, required), and any of `hint`/`expect`/`name`
   * already on the cell — one row, wrapping only when there's more on it
   * than fits, so the common case (just `id`) costs almost no space at
   * all. A "+ field" button seeds an absent optional field with an empty
   * value and focuses it immediately, reverting back to the button on
   * blur if nothing was typed — the same "clearing a field that was
   * never there is a no-op" rule `setCellHeaderField` itself already
   * holds to, just given a way to back out of the empty row it leaves
   * showing rather than leaving that lying around. */
  function buildCellHeaderBar(index: number, cellSource: CellSource, info: string): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "dn-cell-header";

    const langLabel = document.createElement("span");
    const language = execCellLanguage(info);
    langLabel.className = `dn-cell-lang dn-cell-lang-${language}`;
    langLabel.textContent = language === "sql" ? "SQL" : "Python";
    bar.appendChild(langLabel);

    const values: Record<CellHeaderKey, string | null> = {
      id: cellSource.id,
      hint: cellSource.hint,
      expect: cellSource.expect,
      name: cellSource.name,
    };

    const hiddenOptional: CellHeaderFieldSpec[] = [];
    for (const field of CELL_HEADER_FIELDS) {
      const value = values[field.key];
      if (!field.required && value === null) {
        hiddenOptional.push(field);
        continue;
      }
      bar.appendChild(buildCellHeaderField(index, field, value ?? ""));
    }

    if (hiddenOptional.length > 0) {
      const addRow = document.createElement("div");
      addRow.className = "dn-cell-header-add-row";
      for (const field of hiddenOptional) {
        const addButton = document.createElement("button");
        addButton.type = "button";
        addButton.className = "dn-cell-header-add";
        addButton.textContent = `+ ${field.label}`;
        addButton.addEventListener("click", () => {
          const row = buildCellHeaderField(index, field, "");
          const input = row.querySelector("input")!;
          addButton.replaceWith(row);
          input.focus();
          input.addEventListener(
            "blur",
            () => {
              if (input.value.trim() === "") row.replaceWith(addButton);
            },
            { once: true },
          );
        });
        addRow.appendChild(addButton);
      }
      bar.appendChild(addRow);
    }

    return bar;
  }

  /** Commits one optional header field's edit (`hint`/`expect`/`name`),
   * patching only the header bar's own DOM rather than the whole block —
   * unlike every other commit path here, this leaves the code's own live
   * editor (`fenceCodeViews`) completely untouched, so editing a hint
   * mid-session never costs the code editor its cursor position or undo
   * history the way a full block re-render would. Safe because a header
   * field's own line never changes the document's shape (still one fence
   * block, same kind) except in some pathological case `sameShape` would
   * still catch, falling back to the full rebuild every other path uses. */
  function commitCellHeaderField(index: number, key: CellHeaderKey, value: string) {
    const parts = blockTexts();
    const currentFenceText = parts[index]!;
    const newText = setCellHeaderField(currentFenceText, key, value);
    if (newText === currentFenceText) return;

    parts[index] = newText;
    source = parts.join("");
    const newDoc = parseDocument(source);

    if (!sameShape(doc, newDoc)) {
      teardownLiveViews();
      doc = newDoc;
      render();
      return;
    }

    doc = newDoc;
    const info = doc.blocks[index]!.fence?.info ?? "";
    const cellSource = parseCellSourceFromFenceText(newText);
    const newHeaderBar = buildCellHeaderBar(index, cellSource, info);
    blockElements[index]!.querySelector(".dn-cell-header")?.replaceWith(newHeaderBar);
  }

  /** Commits an `id` edit — never silently: DIALECTS.md §1 calls a cell's
   * id a contract (saved student work is keyed on it), so an empty value
   * is refused outright, a value already used by another cell in the
   * same document is refused outright, and an actual change to a
   * non-empty existing id is confirmed before it applies, the same
   * warning dewlab's own authoring editor gives (plan §4). A refused or
   * declined edit re-renders the block to restore the input's old value
   * rather than leaving the stale typed text sitting there unconfirmed.
   * Unlike `commitCellHeaderField`, this rebuilds the whole block: the
   * Run button's own closed-over `id` needs the same fresh value the
   * header bar does, and an id change is rare and deliberate enough that
   * losing the code editor's cursor position over it is a fair trade. */
  function commitCellId(index: number, rawValue: string) {
    const parts = blockTexts();
    const currentFenceText = parts[index]!;
    const oldId = parseCellSourceFromFenceText(currentFenceText).id ?? "";
    const trimmed = rawValue.trim();
    if (trimmed === oldId) return;

    if (trimmed === "") {
      rerenderBlock(index);
      return;
    }
    if (collectExistingCellIds(index).has(trimmed)) {
      window.alert(`Another cell already uses the id "${trimmed}" — cell ids must be unique.`);
      rerenderBlock(index);
      return;
    }
    if (oldId !== "") {
      const confirmed = window.confirm(
        `Renaming this cell's id from "${oldId}" to "${trimmed}" will disconnect it from any work ` +
          `saved under "${oldId}". Rename anyway?`,
      );
      if (!confirmed) {
        rerenderBlock(index);
        return;
      }
    }

    const newText = setCellHeaderField(currentFenceText, "id", trimmed);
    parts[index] = newText;
    source = parts.join("");
    const newDoc = parseDocument(source);

    if (!sameShape(doc, newDoc)) {
      teardownLiveViews();
      doc = newDoc;
      render();
      return;
    }

    doc = newDoc;
    rerenderBlock(index);
  }

  /** A runnable fence (isRunnableFence) gets a Run/Stop bar and an output
   * area under its editor. `view` is the fence's own code-only editor
   * (decision 27) — its content *is* the code to run, no header lines to
   * strip off first — so Run reads it directly, live, not `block.text`,
   * which is only as fresh as this fence's last blur; typing and running
   * without ever leaving the editor works the way a notebook cell does.
   * `id` is read once, at render time — `commitCellId` always triggers a
   * full re-render of this block on an actual id change, so this closure
   * is never stale for longer than that one re-render takes. Stop only
   * ever becomes enabled once booted with cross-origin isolation in
   * effect (pyodide-engine.ts's canStop()); on a page without it there is
   * no way to interrupt a running cell, a documented gap, not a bug here. */
  function buildCellRunner(index: number, view: EditorView, info: string, id: string | null): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "dn-cell-runner";

    const runButton = document.createElement("button");
    runButton.type = "button";
    runButton.className = "dn-cell-run";
    runButton.textContent = "Run";

    const stopButton = document.createElement("button");
    stopButton.type = "button";
    stopButton.className = "dn-cell-stop";
    stopButton.textContent = "Stop";
    stopButton.disabled = true;
    stopButton.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      requestStop();
    });

    const output = document.createElement("div");
    output.className = "dn-cell-output";

    runButton.addEventListener("click", async (clickEvent) => {
      clickEvent.stopPropagation();
      const code = view.state.doc.toString();
      const cellId = id ?? `cell-${index}`;
      runButton.disabled = true;
      runButton.textContent = "Running…";
      stopButton.disabled = true;
      // pyodide-engine.ts's status listener is one global slot, not one
      // per cell — there is only ever one interpreter booting for the
      // whole page, so whichever cell's Run was clicked last owns the
      // button that shows it, a fine simplification until a page
      // regularly has two cells clicked before the first boot finishes.
      setStatusListener((text) => {
        runButton.textContent = text || "Running…";
      });
      try {
        await ensureBooted(declaredPackages(doc.frontMatter.fields));
        stopButton.disabled = !canStop();
        const isSql = execCellLanguage(info) === "sql";
        const toRun = isSql ? wrapSqlExecCode(code) : code;
        await runCell(cellId, toRun, (out) => applyOutputEvent(output, out), { sql: isSql });
      } catch (err) {
        // A rejection here, rather than a `{ ok: false }` result, means
        // the cell never got to run its own error handling at all — the
        // interpreter itself was terminated (requestStop's fallback for a
        // page without cross-origin isolation) rather than interrupted.
        // Built as a real element with textContent, not markup — unlike
        // dewnote_tools.py's own output, this message is a raw JS Error,
        // never pre-escaped HTML.
        const message = err instanceof Error ? err.message : String(err);
        const errorNode = document.createElement("pre");
        errorNode.className = "dn-error";
        errorNode.textContent = message;
        output.appendChild(errorNode);
      } finally {
        setStatusListener(null);
        runButton.disabled = false;
        runButton.textContent = "Run";
        stopButton.disabled = true;
      }
    });

    bar.append(runButton, stopButton);
    return buildFencePanel("dn-cell-panel", bar, output);
  }

  /** A dewstack SQL cell (parseSqlCellInfo) gets a Run/Reset bar and an
   * output area under its editor. The whole fence body is the SQL
   * script — there are no header lines the way an exec cell has — and
   * every SQL cell sharing `info.name`, anywhere on the page, runs
   * against the same connection (pyodide-engine.ts's runSql), so a
   * second cell can query a table an earlier one created. Unlike an exec
   * cell's Run, this has no Stop: dewstack's own SQL cells don't have
   * one either, and a script's worth of statements runs to completion or
   * to its first error, not indefinitely.
   *
   * `persist` restores by an explicit reader click, never automatically —
   * unlike dewstack, where the visible text is disposable generated
   * markup, a fence's live editor content here IS the document's own
   * saved text (`blockTexts()` reads it back out on every commit). An
   * automatic restore would mean opening a document with an old browser
   * session lying around silently overwrites the fence's authored
   * starter script the moment it next commits, with nothing to undo it.
   * A visible "Restore saved work" banner turns that into a choice
   * instead of a surprise. */
  function buildSqlCellRunner(index: number, view: EditorView, info: SqlCellInfo): HTMLElement {
    const restoreBar = document.createElement("div");
    restoreBar.className = "dn-sql-restore";
    restoreBar.hidden = true;

    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.className = "dn-sql-restore-button";
    restoreButton.textContent = "Restore saved work";
    restoreBar.append("A saved script for this cell is in this browser. ", restoreButton);

    const bar = document.createElement("div");
    bar.className = "dn-sql-runner";

    const runButton = document.createElement("button");
    runButton.type = "button";
    runButton.className = "dn-sql-run";
    runButton.textContent = "Run";

    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "dn-sql-reset";
    resetButton.textContent = "Reset";

    const output = document.createElement("div");
    output.className = "dn-sql-output";

    function showError(err: unknown) {
      output.replaceChildren();
      const errorNode = document.createElement("pre");
      errorNode.className = "dn-error";
      errorNode.textContent = err instanceof Error ? err.message : String(err);
      output.appendChild(errorNode);
    }

    if (info.persist && readPersistedSql(info.name) !== null) {
      restoreBar.hidden = false;
    }

    restoreButton.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      const saved = readPersistedSql(info.name);
      if (saved === null) {
        restoreBar.hidden = true;
        return;
      }
      // Only the body changes — the opening (`sql cell=name persist`) and
      // closing fence lines stay exactly as authored, the same shape
      // fenceBody/sqlScriptFromFenceText already expect.
      const lines = view.state.doc.toString().split("\n");
      const openLine = lines[0]!;
      let closeIndex = lines.length - 1;
      while (closeIndex > 0 && lines[closeIndex] === "") closeIndex--;
      const closeLine = lines[closeIndex]!;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: `${openLine}\n${saved}\n${closeLine}\n` },
      });
      restoreBar.hidden = true;
    });

    runButton.addEventListener("click", async (clickEvent) => {
      clickEvent.stopPropagation();
      const script = sqlScriptFromFenceText(view.state.doc.toString());
      runButton.disabled = true;
      resetButton.disabled = true;
      if (info.persist) writePersistedSql(info.name, script);
      restoreBar.hidden = true;
      try {
        // dewnote_sql_tools.py already renders a complete, self-escaped
        // HTML fragment (a table, a row count, or a dn-error) — the same
        // "Python returns HTML, JS assigns it" contract dewstack's own
        // sql_tools.py uses, so there is no separate result type to walk.
        const result = await runSql(info.name, script);
        output.innerHTML = result.html;
      } catch (err) {
        showError(err);
      } finally {
        runButton.disabled = false;
        resetButton.disabled = false;
      }
    });

    resetButton.addEventListener("click", async (clickEvent) => {
      clickEvent.stopPropagation();
      runButton.disabled = true;
      resetButton.disabled = true;
      if (info.persist) clearPersistedSql(info.name);
      restoreBar.hidden = true;
      try {
        await resetSql(info.name);
        output.replaceChildren();
      } catch (err) {
        showError(err);
      } finally {
        runButton.disabled = false;
        resetButton.disabled = false;
      }
    });

    bar.append(runButton, resetButton);
    return buildFencePanel("dn-sql-panel", restoreBar, bar, output);
  }

  /** One field's row in the front-matter form: a label, its control (a
   * text input or, for `status`, a dialect-aware select), and — for an
   * optional field only, never a required one — a button to clear it back
   * out of the document entirely. Commits on `change`, not on every
   * keystroke, matching a plain HTML form's own native "did the reader
   * move on" signal rather than trying to debounce keystrokes ourselves. */
  function buildFrontMatterRow(index: number, field: FrontMatterFieldSpec, currentValue: unknown): HTMLElement {
    const row = document.createElement("label");
    row.className = "dn-frontmatter-row";

    const labelSpan = document.createElement("span");
    labelSpan.className = "dn-frontmatter-label";
    labelSpan.textContent = field.required ? field.label : `${field.label} (optional)`;
    row.appendChild(labelSpan);

    const stringValue = currentValue === undefined || currentValue === null ? "" : String(currentValue);
    const wasPresent = typeof currentValue === "string" || typeof currentValue === "number" || typeof currentValue === "boolean";
    let control: HTMLInputElement | HTMLSelectElement;
    if (field.kind === "select") {
      const select = document.createElement("select");
      for (const option of field.options ?? []) {
        const optionEl = document.createElement("option");
        optionEl.value = option.value;
        optionEl.textContent = option.label;
        select.appendChild(optionEl);
      }
      select.value = stringValue;
      control = select;
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.value = stringValue;
      // Decision 11's own "picker over the index, not free text": a
      // native <datalist> suggests every distinct value already in use
      // elsewhere, typing anything else still works (the "new" escape
      // hatch, for free — a datalist never restricts input to its own
      // options), and an empty index just leaves this an ordinary text
      // field, same as before the index existed.
      if (field.indexedAs) {
        const suggestions = distinctValues(sharedFileIndex, field.indexedAs);
        if (suggestions.length > 0) {
          const datalistId = `dn-frontmatter-list-${field.key}-${index}`;
          const datalist = document.createElement("datalist");
          datalist.id = datalistId;
          for (const value of suggestions) {
            const option = document.createElement("option");
            option.value = value;
            datalist.appendChild(option);
          }
          input.setAttribute("list", datalistId);
          row.appendChild(datalist);
        }
      }
      control = input;
    }
    control.dataset["field"] = field.key;
    control.addEventListener("change", () => commitFrontMatterField(index, field.key, control.value));
    row.appendChild(control);

    if (!field.required) {
      const clearButton = document.createElement("button");
      clearButton.type = "button";
      clearButton.className = "dn-frontmatter-clear";
      clearButton.setAttribute("aria-label", `Remove ${field.label}`);
      clearButton.textContent = "×";
      clearButton.addEventListener("click", (event) => {
        event.preventDefault();
        // decision 33: an optional text field revealed but never actually
        // filled in has nothing for commitFrontMatterField to do (its own
        // no-op guard means it wouldn't even re-render) — un-revealing it
        // directly is what makes × collapse the row back to "+ field" in
        // that case, not just when a real value is being cleared out.
        revealedOptionalTextFields.delete(field.key);
        if (wasPresent) commitFrontMatterField(index, field.key, "");
        else rerenderBlock(index);
      });
      row.appendChild(clearButton);
    }

    return row;
  }

  /** The front-matter form itself (decision 11): one row per dialect field
   * that's either required or already present with a scalar value, a
   * "+ field" button for every optional field that's still absent, and a
   * footer offering the raw-YAML fallback (for the list/mapping fields —
   * dewlab's `packages`, `covers`, and the rest — this form has no row
   * for) plus Done to collapse back to the one-line summary. Only ever
   * called with a non-empty `fields` list — a dialect with none (plain
   * markdown) has nothing here to build a form from, so its front matter
   * goes straight to the raw editor instead; see renderBlockWrapper. */
  function buildFrontMatterForm(index: number, docFields: Record<string, unknown>, fieldList: FrontMatterFieldSpec[]): HTMLElement {
    const form = document.createElement("div");
    form.className = "dn-frontmatter-form";

    const hiddenOptional: FrontMatterFieldSpec[] = [];
    for (const field of fieldList) {
      const present = isScalarField(docFields, field.key);
      if (!field.required && !present && !revealedOptionalTextFields.has(field.key)) {
        hiddenOptional.push(field);
        continue;
      }
      form.appendChild(buildFrontMatterRow(index, field, docFields[field.key]));
    }

    if (hiddenOptional.length > 0) {
      const addRow = document.createElement("div");
      addRow.className = "dn-frontmatter-add-row";
      for (const field of hiddenOptional) {
        const addButton = document.createElement("button");
        addButton.type = "button";
        addButton.className = "dn-frontmatter-add-field";
        addButton.textContent = `+ ${field.label}`;
        addButton.addEventListener("click", () => {
          if (field.kind === "select") {
            // A select field has a sensible non-empty default to add with
            // (its first option) — an empty value is setFrontMatterField's
            // own "not set" sentinel, so this commits a real line straight
            // away, the same as picking any other value later would.
            commitFrontMatterField(index, field.key, field.options?.[0]?.value ?? "");
            return;
          }
          // decision 33: a text field has nothing sensible to seed itself
          // with, so "+" reveals an empty row to type into instead of
          // committing anything yet — buildFrontMatterRow's own `change`
          // handler is what actually writes a value, once there is one.
          revealedOptionalTextFields.add(field.key);
          rerenderBlock(index);
          queueMicrotask(() => {
            blockElements[index]?.querySelector<HTMLInputElement>(`input[data-field="${field.key}"]`)?.focus();
          });
        });
        addRow.appendChild(addButton);
      }
      form.appendChild(addRow);
    }

    const footer = document.createElement("div");
    footer.className = "dn-frontmatter-footer";

    const rawToggle = document.createElement("button");
    rawToggle.type = "button";
    rawToggle.className = "dn-frontmatter-raw-toggle";
    rawToggle.textContent = "Edit raw YAML";
    rawToggle.addEventListener("click", () => {
      frontMatterRawMode = true;
      const newWrapper = renderBlockWrapper(doc.blocks[index]!, index);
      blockElements[index]!.replaceWith(newWrapper);
      blockElements[index] = newWrapper;
    });

    const doneButton = document.createElement("button");
    doneButton.type = "button";
    doneButton.className = "dn-frontmatter-done";
    doneButton.textContent = "Done";
    doneButton.addEventListener("click", () => exitFrontMatterEdit(index));

    footer.append(rawToggle, doneButton);
    form.appendChild(footer);
    return form;
  }

  /** A staged-hint fence's own read-only preview, shown alongside its
   * live editor — never in place of it, unlike a fold block, since a
   * fence never loses its "always a live editor" state (plan §5.1,
   * decision 15). render-block.ts's renderHintFencePreview builds the
   * actual markup; this only hosts it. */
  function buildHintPreview(block: Block): HTMLElement {
    const container = buildFencePanel("dn-hint-preview");
    container.innerHTML = renderHintFencePreview(block);
    return container;
  }

  /** A ```card fence's own read-only preview — dewlab's own
   * `.dl-module-card` markup, shown alongside its live editor for the
   * same reason a staged hint's is (decision 15). Each card previews on
   * its own: dewlab's build groups adjacent cards into one shared
   * `.dl-module-grid`, a purely cosmetic detail across several fences
   * this editor doesn't reproduce, so a grid of one stands in here
   * instead — the card itself renders exactly as it would on the built
   * page either way. */
  function buildCardPreview(block: Block): HTMLElement {
    const container = buildFencePanel("dn-card-preview");
    container.innerHTML = `<div class="dl-module-grid">${renderCardFencePreview(block)}</div>`;
    return container;
  }

  /** A ```question fence's own read-only preview — dewlab's real
   * `.dl-question` markup for multiple-choice, minus the Check button
   * and feedback slot a reader's own click needs, which this editor
   * never provides (render-block.ts's own `renderQuestionFencePreview`
   * comment says why). Shown alongside the fence's live editor, same as
   * every other non-runnable fence's preview (decision 15). */
  function buildQuestionPreview(block: Block): HTMLElement {
    const container = buildFencePanel("dn-question-preview");
    container.innerHTML = renderQuestionFencePreview(block);
    return container;
  }

  /** A small label above a site pane's own live editor, since three
   * fences in a row otherwise look identical until you read their info
   * strings — the same reason a cell's Run bar names nothing but a
   * site pane genuinely needs a "which language, which site" hint a
   * plain code fence doesn't. */
  function buildSitePaneLabel(info: SitePaneInfo): HTMLElement {
    const label = document.createElement("div");
    label.className = "dn-site-pane-label";
    label.textContent = `${info.language} · site: ${info.site || "(none)"}`;
    return label;
  }

  /** A site group's one shared live preview — HTML and CSS rebuild it
   * immediately (site-relay.ts's own `update`); a `js` pane, if the
   * group has one, gets its own Run button, since JS only ever runs on
   * an explicit click (plan §5.4's own convention, DIALECTS.md §2).
   * Reads every pane's *current, committed* body straight from `doc`,
   * which commit()'s own forced full-render for a site pane guarantees
   * is fresh by the time this runs — never blockTexts()'s live,
   * uncommitted text, since a pane that's still focused hasn't been
   * parsed into a body yet. */
  function buildSiteGroupPreview(group: SiteGroup): HTMLElement {
    const header = document.createElement("div");
    header.className = "dn-site-preview-header";
    header.textContent = `Preview — site: ${group.site || "(none)"}`;

    function bodyOf(pane: SitePane | undefined): string {
      return pane ? parseSitePaneInfo(doc.blocks[pane.blockIndex]!).body : "";
    }
    function currentBodies(): SiteMountOptions {
      return { html: bodyOf(group.panes.html), css: bodyOf(group.panes.css), js: bodyOf(group.panes.js) };
    }

    let runBar: HTMLElement | null = null;
    if (group.panes.js) {
      runBar = document.createElement("div");
      runBar.className = "dn-site-run-bar";
      const runButton = document.createElement("button");
      runButton.type = "button";
      runButton.className = "dn-site-run";
      runButton.textContent = "Run";
      runButton.addEventListener("click", (event) => {
        event.stopPropagation();
        consoleOutput.replaceChildren();
        mount.update(currentBodies());
        mount.run();
      });
      runBar.appendChild(runButton);
    }

    const frameHost = document.createElement("div");
    frameHost.className = "dn-site-frame-host";

    const consoleOutput = document.createElement("div");
    consoleOutput.className = "dn-site-console";

    const mount = mountSite(frameHost, (message) => {
      const line = document.createElement("div");
      line.className = `dn-site-console-line dn-site-console-${message.level}`;
      line.textContent = message.text;
      consoleOutput.appendChild(line);
    });
    mount.update(currentBodies());

    return buildFencePanel("dn-site-preview", header, runBar, frameHost, consoleOutput);
  }

  function renderBlockWrapper(block: Block, index: number): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = `dn-block dn-block-${block.kind}`;
    wrapper.dataset["index"] = String(index);

    // Every block is a drop target, front matter included — dropping onto
    // it is how a block reaches the very top of the body, and
    // moveBlockTo's own clamp is what keeps anything from landing above
    // it. Nothing is draggable here any more: the grip does the dragging
    // (see the control cluster above), so a drag can only ever start from
    // a deliberate handle rather than from anywhere in the block's text.
    wrapper.addEventListener("dragover", (event) => {
      if (draggingIndex === null) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      wrapper.classList.add("is-drop-target");
    });
    wrapper.addEventListener("dragleave", () => wrapper.classList.remove("is-drop-target"));
    wrapper.addEventListener("drop", (event) => {
      event.preventDefault();
      wrapper.classList.remove("is-drop-target");
      const from = Number(event.dataTransfer?.getData("text/plain"));
      if (Number.isNaN(from)) return;
      moveBlockTo(from, index);
      setArmed(null);
    });

    // What moves the one cluster to this block. `mouseenter` is the
    // pointer case; `focusin` is the keyboard one, so tabbing through a
    // document brings the controls along instead of leaving them behind
    // wherever the mouse last was. On a touch screen neither fires from
    // scrolling alone — a tap into a block is what attaches them, which
    // is why the resting state on a phone is a document with no chrome on
    // it at all.
    wrapper.addEventListener("mouseenter", () => attachControls(index));
    wrapper.addEventListener("focusin", () => attachControls(index));

    if (block.kind === "fence") {
      const info = block.fence?.info ?? "";

      if (isRunnableFence(info)) {
        // Decision 27: a runnable fence's header lines (id/hint/expect/
        // name) render as a compact form bar, not raw text, and the
        // fence's own live editor holds only the code beneath them —
        // still always a live CodeMirror instance either way (decision
        // 15 is untouched), just one that no longer mixes header syntax
        // in with the code it sits above.
        const cellSource = parseCellSourceFromFenceText(block.text);
        const box = document.createElement("div");
        box.className = "dn-cell-box";
        box.appendChild(buildCellHeaderBar(index, cellSource, info));

        const host = document.createElement("div");
        host.className = "dn-block-source dn-cell-code";
        box.appendChild(host);
        const view = mountEditor(host, index, cellSource.code, languageExtensionFor(info), fenceCodeViews);

        wrapper.appendChild(box);
        wrapper.appendChild(buildCellRunner(index, view, info, cellSource.id));
        return wrapper;
      }

      const host = document.createElement("div");
      host.className = "dn-block-source";
      wrapper.appendChild(host);
      const view = mountEditor(host, index, block.text, languageExtensionFor(info));
      const sqlInfo = parseSqlCellInfo(info);
      if (sqlInfo) wrapper.appendChild(buildSqlCellRunner(index, view, sqlInfo));
      else if (isHintFence(info)) wrapper.appendChild(buildHintPreview(block));
      else if (isCardFence(info)) wrapper.appendChild(buildCardPreview(block));
      else if (isQuestionFence(info)) wrapper.appendChild(buildQuestionPreview(block));
      else if (isSitePaneFence(info)) {
        wrapper.appendChild(buildSitePaneLabel(parseSitePaneInfo(block)));
        const group = siteGroupContaining(findSiteGroups(doc.blocks), index);
        // Only the group's *last* pane hosts the shared preview — three
        // panes sharing one site get exactly one preview between them,
        // not one each.
        if (group && group.endIndex === index) wrapper.appendChild(buildSiteGroupPreview(group));
      }
      return wrapper;
    }

    if (block.kind === "frontmatter" && index === focusedProseIndex) {
      const fieldList = frontMatterFieldsFor(detectDialect(doc.frontMatter));
      if (fieldList.length > 0 && !frontMatterRawMode) {
        wrapper.appendChild(buildFrontMatterForm(index, doc.frontMatter.fields, fieldList));
        return wrapper;
      }
      // Plain markdown (no dialect field list to build a form from) or
      // the form's own "Edit raw YAML" toggle: falls through to the same
      // raw-source editor every other block already uses, just below. Only
      // the first case gets a caption — a dewlab/dewstack author who
      // clicked "Edit raw YAML" already knows what they asked for.
      if (fieldList.length === 0) {
        const caption = document.createElement("p");
        caption.className = "dn-frontmatter-plain-caption";
        caption.textContent =
          "No Dewlab fields were recognised here, so this is plain YAML — add year: to use the structured document fields instead.";
        wrapper.appendChild(caption);
      }
    }

    if (block.kind === "fold" && index === focusedProseIndex) {
      const editable = editableFoldSource(block.text);
      if (editable) {
        const shell = document.createElement("div");
        shell.className = "dn-block-render dn-fold-editor";
        shell.innerHTML = renderBlockPreview(block, detectDialect(doc.frontMatter));
        const fold = shell.querySelector<HTMLDetailsElement>("details");
        if (fold) {
          fold.open = true;
          for (const child of [...fold.children]) if (child.tagName !== "SUMMARY") child.remove();
          const host = document.createElement("div");
          host.className = "dn-fold-body-source";
          fold.appendChild(host);
          wrapper.appendChild(shell);
          const view = mountEditor(host, index, editable.body, [sourceLanguageExtension()], foldBodyViews);
          queueMicrotask(() => view.focus());
          return wrapper;
        }
      }
    }

    if (index === focusedProseIndex) {
      const host = document.createElement("div");
      host.className = `dn-block-source${block.kind === "prose" ? " dn-block-prose-source" : ""}`;
      wrapper.appendChild(host);

      // Slash commands (buildSlashMenu) apply only to a real prose
      // block — front matter's own raw-YAML fallback and a hint fold's
      // raw HTML have no business turning into a code cell mid-edit.
      const extensions: Extension[] = [sourceLanguageExtension()];
      if (block.kind === "prose") {
        const slashMenu = buildSlashMenu(index);
        wrapper.appendChild(slashMenu.element);
        extensions.push(
          proseMarkdownPreview,
          // Prec.highest: BASE_EXTENSIONS' own defaultKeymap already
          // binds Enter (insertNewlineAndIndent) and the arrow keys at
          // the same default precedence CodeMirror gives a plain
          // keymap.of — without this, that earlier-installed keymap
          // wins ties and this one's own run() never even gets called
          // while the menu is open.
          Prec.highest(keymap.of(slashMenu.keymap)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) slashMenu.sync(update.state.doc.toString());
          }),
        );
      }

      const editorText = block.kind === "prose" ? block.text.replace(/\n+$/, "") : block.text;
      const view = mountEditor(host, index, editorText, extensions);
      queueMicrotask(() => view.focus());
      return wrapper;
    }

    const rendered = document.createElement("div");
    rendered.className = "dn-block-render";
    rendered.innerHTML = renderBlockPreview(block, detectDialect(doc.frontMatter));
    // An image the markdown names by bare file name resolves against the
    // folder the document sits in, not against this editor's own page —
    // so the bytes come back through the store (asset-preview.ts). The
    // markdown keeps the bare name either way.
    resolveSiblingImages(rendered);
    rendered.tabIndex = 0;
    rendered.addEventListener("click", (event) => {
      // Opening or closing an answer/hint is a reading action, not a
      // request to replace the fold with its source. Editing starts from
      // its open body (or from the keyboard), while the native summary
      // remains a native disclosure control.
      if (block.kind === "fold" && (event.target as Element).closest("summary")) return;
      enterEdit(index);
    });
    rendered.addEventListener("keydown", (event) => {
      if (event.key === "Enter") enterEdit(index);
    });

    wrapper.appendChild(rendered);
    return wrapper;
  }

  function render() {
    container.innerHTML = "";
    blockElements.length = 0;
    // The cluster is appended once and survives every render — it is
    // positioned against the container, not inside any block, so a
    // re-render never tears it down mid-drag or mid-menu.
    container.appendChild(controls);
    doc.blocks.forEach((block, index) => {
      const wrapper = renderBlockWrapper(block, index);
      blockElements[index] = wrapper;
      container.appendChild(wrapper);
    });
    // Whatever it was attached to may have moved, changed kind, or gone.
    attachControls(controlsIndex !== null && controlsIndex < doc.blocks.length ? controlsIndex : null);
  }

  render();

  // A click anywhere outside an open add menu closes it — each menu
  // button already stops its own click from reaching here, so this only
  // ever fires for a click genuinely elsewhere.
  document.addEventListener("click", closeOpenAddMenus);

  /** A click anywhere outside the armed block disarms it, the same
   * "elsewhere means done with this" rule closeOpenAddMenus follows —
   * the grip's own click handler stops propagation, so arming or
   * disarming via the grip itself never reaches this. */
  function disarmOnOutsideClick(event: MouseEvent) {
    if (armedIndex === null) return;
    const armedWrapper = blockElements[armedIndex];
    if (armedWrapper && event.target instanceof Node && armedWrapper.contains(event.target)) return;
    setArmed(null);
  }
  document.addEventListener("click", disarmOnOutsideClick);

  return {
    getSource: currentSource,
    destroy() {
      document.removeEventListener("click", closeOpenAddMenus);
      document.removeEventListener("click", disarmOnOutsideClick);
      window.removeEventListener("pointerup", releaseGrip);
      teardownLiveViews();
      container.innerHTML = "";
    },
  };
}

/** Exists so a test can assert the byte-round-trip invariant holds through
 * the DOM, not just through blocks.ts directly — the point of decision 1
 * is that this file never breaks it, and that is only checked by actually
 * mounting, not editing anything, reading getSource() back out, and
 * comparing. */
export function roundTripsUnedited(source: string): boolean {
  return serialize(parseDocument(source)) === source;
}
