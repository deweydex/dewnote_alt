// Where a tutorial sits in a module, read from Dewlab's descriptor
// directory. Current Dewlab keeps these in `courses/` for repository
// compatibility; older checkouts used `modules/`. Both describe modules
// in the UI and both are accepted here.
// series.ts used to read, after dewlab moved placement out of a
// tutorial's front matter entirely (its DECISIONS_LOG 7.17x, and the
// spec it wrote for this editor in `refactor/EDITOR.md` §2, recoverable
// at `git show b7c5a6d:refactor/EDITOR.md` since that folder was deleted
// when the refactor finished).
//
// The shape, read against real module files rather than a summary of
// them: `modules/index.yaml` is `{order: [module-id, ...]}`; each
// `modules/<id>.yaml` is `{title, code, status, card, description,
// contents: [{title, tutorials: [tutorial-id, ...]}, ...]}`. A tutorial
// id is site-wide now — `tutorials/<id>/<id>.md` — so an id names one
// page from any module, and a module file is the only place that says
// which pages it holds and in what order.
//
// ## Why this records line ranges
//
// frontmatter.ts sets the house pattern for editing YAML here: read it
// with js-yaml for structure, never re-dump it, and write by replacing
// the exact text of the one thing that changed, so everything untouched
// stays byte-identical (DECISIONS.md 1 — the file is the document). A
// module file needs that discipline more than front matter does, not
// less: `card:` is a folded scalar whose continuation lines are indented
// prose, and `description:` is a single-quoted scalar carrying blank
// lines inside it. Both are student-facing text on dewlab's own front
// page. Re-serialising the file to reorder one list would refold and
// requote them on every drag.
//
// So each series records `tutorialsRange`, the half-open line range its
// `- id` items occupy, and the `indent` those items carry. Reordering,
// adding to and removing from a series are then one operation — splice
// different lines into the same range — rather than three features, and
// every other byte of the file is left alone.
//
// ## When a range is null
//
// The scan understands one shape: a block list of `- id` items under a
// `tutorials:` key. That is what dewlab's own migration writes and what
// a person editing the file by hand would write. A flow list
// (`tutorials: [a, b]`) still *parses* — js-yaml handles it, so the
// panel can show it — but gets `tutorialsRange: null`, because this
// module does not know how to rewrite one without reformatting it. A
// null range is the caller's signal to show the series read-only rather
// than to guess. The same goes for any file where the scan's own reading
// of the ids disagrees with what js-yaml parsed: rather than trust a
// line range that might not hold what this thinks it holds, it writes
// nowhere.

import { load as parseYaml } from "js-yaml";

export interface ModuleSeries {
  title: string;
  /** Tutorial ids, in the order the module file lists them. */
  tutorials: string[];
  /** Half-open `[start, end)` line range of the `- id` items under this
   * series' own `tutorials:` key, for a writer to splice. An empty list
   * has `start === end`, positioned where its first item would go. Null
   * when the list isn't in the block form this module can rewrite (see
   * the header). */
  tutorialsRange: { start: number; end: number } | null;
  /** The exact leading whitespace each `- id` item carries, so a spliced
   * line matches the ones around it. */
  indent: string;
  /** Complete line range for this series entry inside `contents:`. */
  entryRange?: { start: number; end: number } | null;
}

export interface Module {
  /** The file's own name minus `.yaml` — the module id, which is also
   * its page's address on the built site. */
  id: string;
  path: string;
  title: string;
  /** dewlab's own `status:` — "beta" and so on. Absent in a file that
   * doesn't set one. */
  status?: string;
  contents: ModuleSeries[];
  /** Mixed practice pages are module-level rather than members of one
   * series. Paired practice pages are discovered through `practice_for`. */
  mixed?: string[];
  /** Half-open `[start, end)` line range of the entries under this
   * module's own `contents:` key — where a new series is appended. Null
   * when the scan couldn't be sure of it, the same refusal
   * `tutorialsRange` makes.
   *
   * Recorded separately from the per-series ranges because it has a
   * different edge: a module file can carry more top-level keys after
   * `contents:` (`mixed:`, in two of dewlab's six), so the block ends in
   * the middle of the file and the scan has to find where rather than
   * run to the end. */
  contentsRange: { start: number; end: number } | null;
  /** The exact leading whitespace a `- title:` entry carries — `""` in
   * every real module file, where the dash sits at column 0 while the
   * `tutorials:` under it is indented two. Recorded rather than derived
   * from the tutorials indent, because deriving it is a guess and a
   * wrong one splices a series into somebody's prose. */
  entryIndent: string;
  /** What one level of indentation is worth inside an entry — the gap
   * between a `- title:` line and its own `tutorials:` key. Two spaces
   * everywhere today; read from the file rather than assumed so a module
   * written with four still round-trips. */
  innerIndent: string;
}

const YAML_SUFFIX = ".yaml";

/** Files this module reads, by path: anything directly inside a
 * `courses/` or legacy `modules/` directory, except the two that aren't modules. `index.yaml`
 * carries the order modules are shown in and `redirects.yaml` maps old
 * addresses to new ones; neither lists tutorials. */
export function isModuleFile(path: string): boolean {
  if (!path.endsWith(YAML_SUFFIX)) return false;
  const segments = path.split("/");
  const fileName = segments[segments.length - 1]!;
  const parent = segments[segments.length - 2];
  if (parent !== "courses" && parent !== "modules") return false;
  return fileName !== "index.yaml" && fileName !== "redirects.yaml";
}

/** `modules/index.yaml`'s own `order:` list — the order the modules are
 * shown in. An empty list for anything this can't read, which leaves the
 * caller to fall back on its own ordering rather than show nothing. */
export function parseModuleIndex(content: string): string[] {
  let data: unknown;
  try {
    data = parseYaml(content);
  } catch {
    return [];
  }
  if (!data || typeof data !== "object") return [];
  const { order } = data as Record<string, unknown>;
  if (!Array.isArray(order)) return [];
  return order.filter((entry): entry is string => typeof entry === "string");
}

/** One module file, or null for anything that isn't one or this can't
 * make sense of. dewlab's own build treats a malformed module file as a
 * hard failure; this is an editor, which has to stay open on a file it
 * doesn't understand, so an unreadable one is left out silently the way
 * series.ts's own order files always were. */
export function parseModuleFile(path: string, content: string): Module | null {
  if (!isModuleFile(path)) return null;

  let data: unknown;
  try {
    data = parseYaml(content);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { title, status, contents, mixed } = data as Record<string, unknown>;
  if (typeof title !== "string" || !title.trim()) return null;
  // `contents:` with nothing under it parses as null, and dewlab's own
  // read_module maps that to an empty list rather than failing — a
  // module with no series yet is a real, buildable state, and it is
  // exactly the state a module is in just before somebody adds the
  // first one. Refusing it here meant dewnote wouldn't read a file
  // dewlab builds happily.
  const entries = contents === null || contents === undefined ? [] : contents;
  if (!Array.isArray(entries)) return null;

  const segments = path.split("/");
  const id = segments[segments.length - 1]!.slice(0, -YAML_SUFFIX.length);
  const ranges = scanTutorialBlocks(content);

  const block = scanContentsBlock(content);
  const series: ModuleSeries[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object") return null;
    const { title: seriesTitle, tutorials } = entry as Record<string, unknown>;
    if (typeof seriesTitle !== "string") return null;
    const ids = Array.isArray(tutorials)
      ? tutorials.filter((one): one is string => typeof one === "string")
      : [];
    // The Nth block the scan found is the Nth series js-yaml parsed —
    // true whenever every series is in the block form, which is the
    // only case with a writable range anyway. A block whose own ids
    // don't match the parsed ones means the scan misread the file, so
    // that series gets no range rather than a wrong one.
    const scanned = ranges[index];
    const agrees =
      scanned !== undefined &&
      scanned.ids.length === ids.length &&
      scanned.ids.every((one, at) => one === ids[at]);
    series.push({
      title: seriesTitle,
      tutorials: ids,
      tutorialsRange: agrees ? { start: scanned.start, end: scanned.end } : null,
      indent: scanned?.indent ?? "  ",
      entryRange: block?.entries[index] ?? null,
    });
  }

  return {
    id,
    path,
    title: title.trim(),
    ...(typeof status === "string" ? { status } : {}),
    contents: series,
    mixed: Array.isArray(mixed) ? mixed.filter((one): one is string => typeof one === "string") : [],
    // The scan has to agree with js-yaml about how many entries there
    // are, the same cross-check each series' own range makes. A block
    // whose entry count differs from the parsed one means the scan
    // misread the file, so it offers no range rather than a wrong one.
    contentsRange: block && countsAgree(block, content, series.length) ? { start: block.start, end: block.end } : null,
    entryIndent: block?.entryIndent ?? "",
    innerIndent: block?.innerIndent ?? "  ",
  };
}

/** Every real module among `files`, in `index.yaml`'s own order where
 * one is given — modules it doesn't name keep their own relative order,
 * after the ones it does, so a module file added by hand shows up rather
 * than vanishing until someone remembers to list it. */
export function parseModuleFiles(
  files: { path: string; content: string }[],
  indexOrder: string[] = [],
): Module[] {
  const modules = files.flatMap((file) => {
    const module = parseModuleFile(file.path, file.content);
    return module ? [module] : [];
  });
  const rank = new Map(indexOrder.map((id, at) => [id, at]));
  return modules.sort((a, b) => {
    const left = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const right = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return left === right ? 0 : left - right;
  });
}

interface ScannedBlock {
  ids: string[];
  start: number;
  end: number;
  indent: string;
}

const TUTORIALS_KEY_RE = /^(\s*)tutorials\s*:\s*(.*)$/;
const LIST_ITEM_RE = /^(\s*)-\s+(.*?)\s*$/;

/**
 * Every `tutorials:` block list in the file, in the order they appear,
 * as line ranges over `content`'s own lines.
 *
 * Deliberately a line scan rather than anything cleverer: the one thing
 * a writer needs is which lines to replace, and a scan that can only
 * recognise the shape it knows how to rewrite is safer than a parser
 * that returns a position for a shape it would mangle. A `tutorials:`
 * key with anything after the colon is a flow list or a scalar, and is
 * skipped — `parseModuleFile` then finds no block for that series and
 * hands back a null range.
 */
function scanTutorialBlocks(content: string): ScannedBlock[] {
  const lines = content.split("\n");
  const blocks: ScannedBlock[] = [];

  for (let at = 0; at < lines.length; at += 1) {
    const key = TUTORIALS_KEY_RE.exec(lines[at]!);
    if (!key || key[2] !== "") continue;

    const keyIndent = key[1]!;
    const start = at + 1;
    let end = start;
    let indent: string | null = null;
    const ids: string[] = [];

    for (let item = start; item < lines.length; item += 1) {
      const match = LIST_ITEM_RE.exec(lines[item]!);
      if (!match) break;
      // An item has to be indented at least as far as its own key, or
      // it belongs to something above this list rather than to it.
      if (match[1]!.length < keyIndent.length) break;
      if (indent === null) indent = match[1]!;
      else if (match[1] !== indent) break;
      ids.push(match[2]!);
      end = item + 1;
    }

    blocks.push({ ids, start, end, indent: indent ?? `${keyIndent}` });
    at = end - 1;
  }

  return blocks;
}

interface ScannedContents {
  start: number;
  end: number;
  entryIndent: string;
  innerIndent: string;
  entries: { start: number; end: number }[];
}

const CONTENTS_KEY_RE = /^(\s*)contents\s*:\s*(.*)$/;

/** A `contents:` entry line, keeping the gap between the dash and the
 * entry's first key — `LIST_ITEM_RE` collapses that, and here it is the
 * thing being measured. */
const ENTRY_RE = /^(\s*)-( +)(\S.*?)\s*$/;

/**
 * Where the `contents:` block's own entries sit, so a series can be
 * appended after the last one.
 *
 * The hard part is the *end*. A per-series `tutorials:` list ends at the
 * first line that isn't one of its items, which is easy; `contents:` runs
 * until the file stops describing it, and two of dewlab's six module
 * files carry a `mixed:` key afterwards, so it genuinely ends in the
 * middle. The rule here: an entry starts with `<indent>- `, and every
 * line after it that is blank or indented further belongs to it. The
 * first line that is neither ends the block.
 *
 * `innerIndent` is what one level in is worth — the gap between a
 * `- title:` line and the `tutorials:` key beneath it. Read rather than
 * assumed, so a module file written with four spaces round-trips as one
 * written with two does.
 *
 * Returns null for anything it isn't sure of, the same refusal
 * `scanTutorialBlocks` makes, and for the same reason: a range this
 * module isn't certain about is how a splice lands in somebody's prose.
 */
function scanContentsBlock(content: string): ScannedContents | null {
  const lines = content.split("\n");

  let keyLine = -1;
  let keyIndent = "";
  for (let at = 0; at < lines.length; at += 1) {
    const key = CONTENTS_KEY_RE.exec(lines[at]!);
    // Anything after the colon is a flow list or a scalar — not a block
    // this knows how to append to.
    if (!key || key[2] !== "") continue;
    keyLine = at;
    keyIndent = key[1]!;
    break;
  }
  if (keyLine === -1) return null;

  const start = keyLine + 1;
  let entryIndent: string | null = null;
  let innerIndent: string | null = null;
  /** The last line that held actual content, so the block ends there
   * rather than at whatever blank lines trail it. A file's own trailing
   * newline is not part of its last series, and appending after it would
   * put a blank line in the middle of `contents:`. */
  let lastContent = start - 1;

  for (let at = start; at < lines.length; at += 1) {
    const line = lines[at]!;
    const item = ENTRY_RE.exec(line);
    if (item && item[1]!.length >= keyIndent.length && (entryIndent === null || item[1] === entryIndent)) {
      entryIndent = item[1]!;
      // How far the entry's own keys are indented, which YAML fixes: a
      // mapping under `- ` starts at the column after the dash and its
      // following spaces, and every later key has to line up with it. So
      // this is read off the dash rather than guessed, and it is "  " for
      // a plain `- ` — which is every module file dewlab has written.
      if (innerIndent === null) innerIndent = " ".repeat(1 + item[2]!.length);
      lastContent = at;
      continue;
    }
    // A blank line is passed over rather than ending the block — one can
    // sit between entries — but it never extends it either.
    if (entryIndent !== null && line.trim() === "") continue;
    // A continuation of the entry above: indented past its dash.
    if (entryIndent !== null) {
      const indent = /^(\s*)/.exec(line)![1]!;
      if (indent.length > entryIndent.length) {
        lastContent = at;
        continue;
      }
    }
    break;
  }
  const end = lastContent + 1;

  if (entryIndent === null) {
    // `contents:` with nothing under it — a real, buildable state
    // (read_module maps it to []), and an empty range is where a first
    // series goes. Two spaces is the only sane guess for the inner
    // indent when there is no entry to read one from, and it is what
    // every module file dewlab has written uses.
    return { start, end: start, entryIndent: keyIndent, innerIndent: "  ", entries: [] };
  }
  const starts: number[] = [];
  for (let at = start; at < end; at += 1) {
    const item = ENTRY_RE.exec(lines[at]!);
    if (item && item[1] === entryIndent) starts.push(at);
  }
  const entries = starts.map((entryStart, index) => ({ start: entryStart, end: starts[index + 1] ?? end }));
  return { start, end, entryIndent, innerIndent: innerIndent ?? "  ", entries };
}

/** How many `- ` entries the scanned block actually holds, against how
 * many series js-yaml parsed. Cheap, and it is the only check that
 * catches a block whose shape the scan read differently. */
function countsAgree(block: ScannedContents, content: string, parsed: number): boolean {
  const lines = content.split("\n").slice(block.start, block.end);
  const entries = lines.filter((line) => {
    const item = ENTRY_RE.exec(line);
    return item !== null && item[1] === block.entryIndent;
  }).length;
  return entries === parsed;
}
