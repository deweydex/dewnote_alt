// Plan §5.10's own index: "opening a folder, or a GitHub repository,
// builds a small in-memory index: one pass over every markdown file's
// front matter... refreshed on save." This is that pass, kept as a pure
// function over already-read file content so it can be exercised without
// a browser or a real GitHub token — folder-panel.ts and repo-panel.ts
// are the two places that actually read the files and call this.
//
// Only string-valued fields are kept — a `year: 2026` or a `covers: {}`
// isn't something a picker offers as a name, and treating a non-string
// value as one here would just be a different way of silently
// mis-indexing a file, the kind of thing §5.10 built this to prevent in
// the first place.
//
// ## The id comes from the path, and the modules from modules/
//
// dewlab moved placement out of front matter: a page's id is `id_of()`
// in its own build.py — "from where its file is and nothing else" —
// and which module lists that id lives in `modules/*.yaml` (modules.ts).
// So `id` here is derived, never read from a field, and `modules` is a
// join rather than a property of the file.
//
// `module`/`series` stay. dewlab's files no longer carry them, so they
// simply stop appearing on dewlab entries — but dewstack is a separate
// dialect on its own schedule and still places a tutorial from its front
// matter, and its own form still offers both as pickers over this index.
// (dewlab's own spec for this change said to drop them; that holds for
// dewlab and would break dewstack, so they're kept and left to empty out
// on their own.)

import type { Module } from "./modules.ts";
import { extractFrontMatter } from "./frontmatter.ts";

export interface FileIndexEntry {
  /** The path this entry was read from — a folder-relative path
   * (folder-store.ts) or a repo path (github.ts); the caller's own
   * space, not reinterpreted here. */
  path: string;
  /** The page's id, derived from the path the way dewlab's own `id_of()`
   * derives it. Site-wide and unique per *page*, which is not the same as
   * unique per *file* — see `defaultEntryFor`. */
  id?: string;
  title?: string;
  /** dewstack's own front-matter placement. A dewlab file written since
   * the move to `modules/` has none of these. */
  slug?: string;
  module?: string;
  series?: string;
  /** A practice page follows this tutorial onto every module that lists it;
   * it is deliberately not listed in the module file itself. */
  practiceFor?: string;
  /** A mixed practice page draws on several tutorials and is placed by a
   * module's top-level `mixed:` list rather than inside a series. */
  practiceAcross?: string[];
  /** Ids of the modules whose own `contents` list this entry's id, filled
   * in by `buildFileIndex` when it's given the module files. Empty (not
   * absent) for an indexed dewlab tutorial no module lists — which is a
   * real and buildable state, "published but on no module", and worth
   * telling apart from a file that was never cross-referenced at all. */
  modules?: string[];
  /** dewlab's own `status` (`draft`/`beta`/`live`/`archived`, `build.py`'s
   * own `STATUSES`) and `version` (a `YYYY.MM.DD.N` release date,
   * `build.py`'s own `VERSION_RE`) — read here only so `defaultEntryFor`
   * can pick the one file among several sharing an id that dewlab's own
   * build would actually serve. Absent entirely on a plain-markdown or
   * dewstack document, which have no versioning concept at all. */
  status?: string;
  version?: string;
}

/** `v2026.08.23.1.md` — a frozen past release, sitting in the folder of
 * the tutorial it is a release of (`build.py`'s own `VERSION_FILE_RE`). */
const VERSION_FILE_RE = /^v\d{4}\.\d{2}\.\d{2}\.\d+$/;

/**
 * A page's id from its path alone, following `build.py`'s own `id_of()`:
 * a tutorial is `tutorials/<id>/<id>.md` so the id is the file's stem;
 * a practice page is `<id>-practice.md` in the same folder and gets its
 * own id; a frozen release is `v<version>.md` and takes the *folder's*
 * name, since it is a version of that folder's tutorial rather than a
 * page of its own.
 *
 * Derived rather than read, for the reason dewlab gives: the id is the
 * address of the page and the key a reader's saved work lives under, so
 * a field that could disagree with the folder would be a way to break
 * both.
 */
export function idFromPath(path: string): string {
  const segments = path.split("/");
  const fileName = segments[segments.length - 1] ?? "";
  const stem = fileName.replace(/\.[^./]*$/, "");
  if (VERSION_FILE_RE.test(stem)) return segments[segments.length - 2] ?? stem;
  return stem;
}

function stringField(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Front matter only, never the body — the same "stays fast even on a
 * large folder" reasoning §5.10 gives for reading front matter alone
 * rather than the whole file. */
export function indexEntryFor(path: string, content: string): FileIndexEntry {
  const { fields } = extractFrontMatter(content);
  const entry: FileIndexEntry = { path, id: idFromPath(path) };
  const title = stringField(fields, "title");
  const slug = stringField(fields, "slug");
  const module = stringField(fields, "module");
  const series = stringField(fields, "series");
  const status = stringField(fields, "status");
  const version = stringField(fields, "version");
  const practiceFor = stringField(fields, "practice_for");
  const practiceAcross = Array.isArray(fields["practice_across"])
    ? fields["practice_across"].filter((value): value is string => typeof value === "string")
    : undefined;
  if (title !== undefined) entry.title = title;
  if (slug !== undefined) entry.slug = slug;
  if (module !== undefined) entry.module = module;
  if (series !== undefined) entry.series = series;
  if (status !== undefined) entry.status = status;
  if (version !== undefined) entry.version = version;
  if (practiceFor !== undefined) entry.practiceFor = practiceFor;
  if (practiceAcross !== undefined) entry.practiceAcross = practiceAcross;
  return entry;
}

/** Which modules list each tutorial id — one pass over the module files,
 * so the join below is a lookup rather than a scan per entry. A module
 * listing the same id in two of its own series names that module once. */
export function moduleMembership(modules: Module[]): Map<string, string[]> {
  const listedBy = new Map<string, string[]>();
  for (const module of modules) {
    for (const series of module.contents) {
      for (const id of series.tutorials) {
        const already = listedBy.get(id);
        if (!already) listedBy.set(id, [module.id]);
        else if (!already.includes(module.id)) already.push(module.id);
      }
    }
    for (const id of module.mixed ?? []) {
      const already = listedBy.get(id);
      if (!already) listedBy.set(id, [module.id]);
      else if (!already.includes(module.id)) already.push(module.id);
    }
  }
  return listedBy;
}

/**
 * The index, optionally cross-referenced against the module files the
 * same store just read. Without them every entry's `modules` is absent —
 * "nothing was cross-referenced" — rather than empty, which means "cross-
 * referenced, and no module lists this."
 */
export function buildFileIndex(
  files: { path: string; content: string }[],
  modules: Module[] = [],
): FileIndexEntry[] {
  const index = files.map(({ path, content }) => indexEntryFor(path, content));
  if (modules.length === 0) return index;
  const listedBy = moduleMembership(modules);
  for (const entry of index) {
    // A focused practice page inherits its tutorial's placement. Mixed
    // practice is listed explicitly in a module's top-level `mixed:` list.
    const membershipId = entry.practiceFor ?? entry.id;
    entry.modules = membershipId ? (listedBy.get(membershipId) ?? []) : [];
  }
  return index;
}

const STATUS_RANK: Record<string, number> = { draft: 0, archived: 1, beta: 2, live: 3 };

/** `build.py`'s own `Tutorial.status`: absent means `"live"`, not
 * "unknown" — most tutorials never set this field at all. An unrecognised
 * value (a typo, or a future status this hasn't been taught about yet)
 * ranks below every known one rather than crashing a lookup over it. */
function statusRank(status: string | undefined): number {
  return STATUS_RANK[status ?? "live"] ?? -1;
}

const VERSION_RE = /^(\d{4})\.(\d{2})\.(\d{2})\.(\d+)$/;

/** The same sortable tuple `build.py`'s own `Tutorial.released` builds —
 * numbers, not the string, so `2026.09.04.10` correctly outranks
 * `2026.09.04.9` (a plain string compare would not: `"10"` sorts before
 * `"9"`). Missing or unparseable sorts lowest, never highest — a file
 * with no real version is never preferred over one that has one. */
function versionRank(version: string | undefined): [number, number, number, number] {
  const match = version ? VERSION_RE.exec(version) : null;
  if (!match) return [-1, -1, -1, -1];
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

function isNewer(a: FileIndexEntry, b: FileIndexEntry): boolean {
  const statusDiff = statusRank(a.status) - statusRank(b.status);
  if (statusDiff !== 0) return statusDiff > 0;
  const [aRank, bRank] = [versionRank(a.version), versionRank(b.version)];
  for (let i = 0; i < 4; i++) if (aRank[i] !== bRank[i]) return aRank[i]! > bRank[i]!;
  return false;
}

/** Among every entry sharing `id`, the one `build.py`'s own
 * `versions_of()` would mark `is_default` — the newest `live` version,
 * or (with no live version at all) the newest version regardless of
 * status. Every version still gets its own entry in the index itself
 * (an author working on a draft, or browsing an archived one, needs to
 * find it by path); this only decides which *one* answers "what does
 * this id mean" for a lookup that has to pick exactly one — today,
 * series-panel.ts's own title lookup. Returns `undefined` for an id
 * nothing in `index` claims.
 *
 * Still needed after the move to site-wide ids, though dewlab's own spec
 * for this change expected it to go ("ids are unique"). Ids are unique
 * per *page*; a page can still be several *files*. A frozen release
 * `tutorials/first-steps/v2026.08.23.1.md` carries the same id as the
 * live `tutorials/first-steps/first-steps.md` beside it — there are real
 * ones in dewlab's tree today — and picking whichever happened to be
 * indexed first would show a frozen release's title where the live one
 * belongs. */
export function defaultEntryFor(index: FileIndexEntry[], id: string): FileIndexEntry | undefined {
  let best: FileIndexEntry | undefined;
  for (const entry of index) {
    if (entry.id !== id) continue;
    if (!best || isNewer(entry, best)) best = entry;
  }
  return best;
}

/** §5.10's own pickers read from these — every distinct value in use,
 * sorted, so dewstack's module picker offers `data` once rather than once
 * per tutorial that names it. `"id"` is the same mechanism for a
 * different purpose: not "which values repeat," since an id names one
 * page, but "every real id this index knows about" — `practice_for`'s own
 * datalist, so naming which tutorial a practice page is for offers real
 * choices rather than free text with nothing to check it against. */
export function distinctValues(index: FileIndexEntry[], field: "module" | "series" | "id"): string[] {
  const values = new Set<string>();
  for (const entry of index) {
    const value = entry[field];
    if (value) values.add(value);
  }
  return [...values].sort();
}
