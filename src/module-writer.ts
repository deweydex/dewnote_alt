// Writing a module file back — the other half of modules.ts, and the one
// that actually moves a tutorial.
//
// Everything here is one operation: replace the lines a series'
// `tutorials:` list occupies with a different list of ids. Reordering
// within a series, moving a tutorial to a sibling series, adding one and
// removing one are all that same splice with a different array, which is
// why modules.ts records the range rather than this module hunting for
// it. Nothing else in the file is read, written or re-serialised: a
// module file's `card:` is a folded scalar whose continuation lines are
// indented prose and its `description:` is single-quoted with blank
// lines inside it, both student-facing text on dewlab's front page, and
// both would be refolded and requoted by any round trip through a YAML
// dumper (DECISIONS.md 1 — the file is the document).
//
// ## What it refuses
//
// Three refusals, each returning a reason rather than throwing, because
// every one of them is something a reader can see and act on rather than
// a bug:
//
// - A series whose range modules.ts could not record. That is a flow
//   list, or a file the line scan and js-yaml read differently. Writing
//   somewhere this module isn't sure about is how a reader loses the
//   prose above it.
// - Adding an id the module already lists in another series. dewlab's
//   own `read_module()` fails the build on that — "A tutorial sits in
//   one place on a module" — so writing it would hand somebody a file
//   that no longer builds, with no sign here that anything was wrong.
// - An id that names no tutorial, when the caller passes the ids it
//   knows about. A module listing an id with no `tutorials/<id>/`
//   folder behind it also stops dewlab's build.
//
// ## What it does not check
//
// Whether the ids are *the ones the reader meant*. This writes what it
// is given, in the order it is given, which is what makes a drag a drag.

import type { Module, ModuleSeries } from "./modules.ts";

/** One series' new list of ids. Several may be applied at once — a drag
 * from one series to a sibling is two of these against the same file. */
export interface SeriesEdit {
  series: ModuleSeries;
  tutorials: string[];
}

/** Either the file's new text, or why nothing was written. Never a
 * partial write: a refusal leaves the file exactly as it was. */
export type WriteResult = { ok: true; content: string } | { ok: false; reason: string };

/** The ids a module already lists, anywhere in it — dewlab's own
 * `read_module()` reads this as the rule that a tutorial sits in one
 * place on a module. Exported because the panel wants it too, to grey
 * out the tutorials an "add to this series" list should not offer. */
export function idsListedBy(module: Module): Set<string> {
  return new Set(module.contents.flatMap((series) => series.tutorials));
}

/**
 * Splices each edit's ids into the lines its series' `tutorials:` list
 * occupies, and returns the whole file's new text.
 *
 * Applied from the bottom of the file upwards, so an edit that changes
 * how many lines a list takes never shifts a range that has not been
 * written yet — the reason a two-series move needs no re-parse between
 * its two halves.
 */
export function writeModuleFile(content: string, edits: SeriesEdit[]): WriteResult {
  const ranges: { start: number; end: number; lines: string[]; title: string }[] = [];
  for (const edit of edits) {
    const range = edit.series.tutorialsRange;
    if (!range) {
      return {
        ok: false,
        reason: `"${edit.series.title}" is written in a form dewnote can't rewrite safely — edit the module file directly.`,
      };
    }
    ranges.push({
      start: range.start,
      end: range.end,
      lines: edit.tutorials.map((id) => `${edit.series.indent}- ${id}`),
      title: edit.series.title,
    });
  }

  const sorted = [...ranges].sort((a, b) => b.start - a.start);
  for (let at = 1; at < sorted.length; at += 1) {
    // Descending, so the previous one starts later: it overlaps when it
    // starts before this one ends. Two edits to the same series would
    // land here too, and are just as much a caller bug.
    if (sorted[at - 1]!.start < sorted[at]!.end) {
      return { ok: false, reason: `"${sorted[at]!.title}" and "${sorted[at - 1]!.title}" overlap in the file — nothing was written.` };
    }
  }

  const lines = content.split("\n");
  for (const range of sorted) {
    lines.splice(range.start, range.end - range.start, ...range.lines);
  }
  return { ok: true, content: lines.join("\n") };
}

/** Where a tutorial sits: which series of a module, and where in it. */
export interface Position {
  series: number;
  index: number;
}

/** Where `id` sits on this module, or null if it isn't on it.
 *
 * A module lists a tutorial at most once — dewlab's own `read_module()`
 * fails the build otherwise — so an id names one position, which is what
 * lets a caller hold on to an id across a re-read rather than an index
 * that a change under it would quietly redirect. */
export function locateTutorial(module: Module, id: string): Position | null {
  for (const [series, entry] of module.contents.entries()) {
    const index = entry.tutorials.indexOf(id);
    if (index !== -1) return { series, index };
  }
  return null;
}

/** The index of the series called `title`, or -1.
 *
 * By title rather than by position for the same reason: two series on a
 * module can't share a title (`read_module()` again, after normalising
 * punctuation), so a title survives a re-read of a file somebody else
 * edited in the meantime where a position would silently name whichever
 * series had moved into that slot. */
export function findSeries(module: Module, title: string): number {
  return module.contents.findIndex((series) => series.title === title);
}

/**
 * Moves the tutorial at `from` to `to` — a drag, whether it lands in the
 * same series or a sibling one.
 *
 * `to.index` is read against the destination list *as it stands once the
 * tutorial has been taken out of its old place*, which is the only
 * reading that behaves the same whether the drag crossed series or not.
 * Dragging the second of three items to the end is `{index: 2}` either
 * way.
 */
export function moveTutorial(module: Module, content: string, from: Position, to: Position): WriteResult {
  const source = module.contents[from.series];
  const target = module.contents[to.series];
  if (!source || !target) return { ok: false, reason: "That series is no longer in this module — reopen it." };

  const id = source.tutorials[from.index];
  if (id === undefined) return { ok: false, reason: "That tutorial is no longer where it was — reopen the module." };

  if (from.series === to.series) {
    const ids = [...source.tutorials];
    ids.splice(from.index, 1);
    ids.splice(clamp(to.index, ids.length), 0, id);
    return writeModuleFile(content, [{ series: source, tutorials: ids }]);
  }

  const sourceIds = [...source.tutorials];
  sourceIds.splice(from.index, 1);
  const targetIds = [...target.tutorials];
  targetIds.splice(clamp(to.index, targetIds.length), 0, id);
  return writeModuleFile(content, [
    { series: source, tutorials: sourceIds },
    { series: target, tutorials: targetIds },
  ]);
}

/** Lists `id` in one of the module's series, at `index` (the end when
 * that is past it). Refused when the module already lists it somewhere,
 * since dewlab's build fails on a module that lists a tutorial twice. */
export function addTutorial(module: Module, content: string, seriesIndex: number, id: string, index?: number): WriteResult {
  const series = module.contents[seriesIndex];
  if (!series) return { ok: false, reason: "That series is no longer in this module — reopen it." };
  const listed = idsListedBy(module);
  if (listed.has(id)) {
    const holder = module.contents.find((one) => one.tutorials.includes(id));
    return { ok: false, reason: `${module.title} already lists ${id}, under "${holder?.title ?? "another series"}". A tutorial sits in one place on a module.` };
  }
  const ids = [...series.tutorials];
  ids.splice(clamp(index ?? ids.length, ids.length), 0, id);
  return writeModuleFile(content, [{ series, tutorials: ids }]);
}

/**
 * Takes `id` out of one of the module's series.
 *
 * This unlists a tutorial; it never deletes the file. A tutorial on no
 * module still builds, and its id is the key a reader's saved work lives
 * under, so throwing the file away is a different and much heavier act
 * than taking it off a reading order — one this panel deliberately
 * doesn't offer.
 */
export function removeTutorial(module: Module, content: string, seriesIndex: number, id: string): WriteResult {
  const series = module.contents[seriesIndex];
  if (!series) return { ok: false, reason: "That series is no longer in this module — reopen it." };
  const at = series.tutorials.indexOf(id);
  if (at === -1) return { ok: false, reason: `"${series.title}" doesn't list ${id} — reopen the module.` };
  const ids = [...series.tutorials];
  ids.splice(at, 1);
  return writeModuleFile(content, [{ series, tutorials: ids }]);
}

function clamp(index: number, length: number): number {
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.min(Math.trunc(index), length);
}

/** dewlab's own `series_key()`: lowercase, every run of non-alphanumeric
 * characters to a hyphen, ends trimmed. Two series on one module whose
 * titles come out the same here fail its build — "Python fundamentals"
 * and "python-fundamentals" are the same series to it, and so are
 * "Matrices" and "Matrices!". Reimplemented rather than approximated,
 * because a near-duplicate that only dewlab notices is exactly the kind
 * of file this editor should refuse to write. */
export function seriesKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Appends a titled series, with nothing in it yet, to the end of a
 * module's `contents:`.
 *
 * At the end rather than at a chosen position: a module's series are a
 * reading order, a new one is the next thing to teach, and offering to
 * insert it third would be offering a decision nobody has made yet. It
 * can be dragged into place afterwards — or rather, its tutorials can,
 * which is the same thing at this stage since it is empty.
 *
 * Three refusals. A module whose `contents:` block the scan couldn't
 * bound (modules.ts's `contentsRange`), a title that is blank once
 * trimmed, and a title that collides with one the module already has
 * under dewlab's own normalisation.
 */
export function addSeries(module: Module, content: string, title: string): WriteResult {
  const trimmed = title.trim();
  if (!trimmed) return { ok: false, reason: "A series needs a title — it's the heading a student reads." };

  const key = seriesKey(trimmed);
  if (!key) {
    return { ok: false, reason: `"${trimmed}" has no letters or digits in it, so dewlab has nothing to name its section.` };
  }
  const clash = module.contents.find((series) => seriesKey(series.title) === key);
  if (clash) {
    return {
      ok: false,
      reason:
        clash.title === trimmed
          ? `${module.title} already has a series called "${trimmed}".`
          : `${module.title} already has "${clash.title}", which dewlab reads as the same section as "${trimmed}". Give one of them another title.`,
    };
  }

  const range = module.contentsRange;
  if (!range) {
    return { ok: false, reason: `${module.path} is written in a form dewnote can't add a series to — edit the module file directly.` };
  }

  // `tutorials:` with nothing under it, which dewlab's own read_module
  // maps to an empty list. The alternative, `tutorials: []`, is a flow
  // list — and a flow list is exactly what modules.ts refuses to rewrite
  // later, so writing one here would hand back a series that could never
  // be dragged into.
  const lines = content.split("\n");
  const entry = [`${module.entryIndent}- title: ${trimmed}`, `${module.entryIndent}${module.innerIndent}tutorials:`];
  lines.splice(range.end, 0, ...entry);
  return { ok: true, content: lines.join("\n") };
}

/** Move one complete series entry while preserving its comments and
 * formatting, and every byte outside `contents:`. */
export function moveSeries(module: Module, content: string, from: number, to: number): WriteResult {
  const source = module.contents[from];
  const range = module.contentsRange;
  if (!source?.entryRange || !range || module.contents.some((series) => !series.entryRange)) {
    return { ok: false, reason: "That series cannot be moved safely — edit the module file directly." };
  }
  const target = Math.max(0, Math.min(Math.trunc(to), module.contents.length - 1));
  if (target === from) return { ok: true, content };
  const lines = content.split("\n");
  const chunks = module.contents.map((series) => lines.slice(series.entryRange!.start, series.entryRange!.end));
  const [moved] = chunks.splice(from, 1);
  if (!moved) return { ok: false, reason: "That series is no longer in this module — reopen it." };
  chunks.splice(target, 0, moved);
  lines.splice(range.start, range.end - range.start, ...chunks.flat());
  return { ok: true, content: lines.join("\n") };
}

/** Rename the heading line using a quoted YAML scalar. */
export function renameSeries(module: Module, content: string, index: number, title: string): WriteResult {
  const series = module.contents[index];
  if (!series?.entryRange) return { ok: false, reason: "That series cannot be renamed safely — edit the module file directly." };
  const trimmed = title.trim();
  if (!trimmed) return { ok: false, reason: "A series needs a title — it's the heading a student reads." };
  const key = seriesKey(trimmed);
  const clash = module.contents.find((entry, at) => at !== index && seriesKey(entry.title) === key);
  if (!key || clash) return { ok: false, reason: clash ? `${module.title} already has a series that dewlab reads as “${trimmed}”.` : "A series title needs a letter or number." };
  const lines = content.split("\n");
  lines[series.entryRange.start] = `${module.entryIndent}- title: '${trimmed.replace(/'/g, "''")}'`;
  return { ok: true, content: lines.join("\n") };
}
