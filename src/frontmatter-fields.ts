// Which top-level scalar fields each dialect's front-matter form shows,
// and in what order — decision 11, built as data rather than a code path
// per decision 3. Only a scalar field (string/number/boolean) gets a row
// here; a list or nested mapping (dewlab's `packages`, `covers`,
// `practice_across` — see DIALECTS.md §1) has no row and stays reachable
// only through the form's raw-YAML fallback in app.ts. `practice_for` is
// the one exception decision 33 carves out: unlike those, it's a single
// flat slug, not a list, so it gets a row of its own like any other text
// field.
//
// `indexedAs` names which of file-index.ts's `distinctValues` fields a
// text field's row should offer as autocomplete suggestions. A plain HTML
// `<datalist>` is the picker: type anything (a "new" value costs nothing,
// since a datalist never restricts input to its own options) or pick a
// suggestion. Decision 11 introduced this for `module` and `series`;
// decision 33 extended it to `practice_for`'s own "which tutorial." Only
// `practice_for` still carries one — dewlab moved placement out of front
// matter entirely (see below), so the two fields that first motivated the
// picker no longer exist to pick for.
//
// ## dewlab's list is three fields now
//
// A dewlab tutorial used to name its own place in the site: `slug`,
// `module`, `module_title`, `series`. It doesn't any more. A tutorial is
// `tutorials/<id>/<id>.md`, its id comes from the path and is site-wide,
// and which module lists it — in what series, in what order — lives in
// `modules/*.yaml` (modules.ts). So those four rows are gone rather than
// relabelled: a form field for something the build ignores is worse than
// no field, because it looks like it still places the tutorial.
//
// Placement didn't stop being editable; it stopped being front matter.
// It's the series panel's job now, and the create-a-tutorial form's
// ("list it on this module, in this series"), which is where decision
// 11's picker survives.

import type { DialectName } from "./dialect.ts";

export interface FrontMatterFieldSpec {
  key: string;
  label: string;
  required: boolean;
  kind: "text" | "select";
  options?: { value: string; label: string }[];
  /** Which file-index.ts field this text field's own datalist suggestions
   * should be drawn from (app.ts's buildFrontMatterRow). Undefined for a
   * field with no meaningful cross-file index — a title is unique per
   * document, so suggesting one from elsewhere would suggest the wrong
   * document's own value. */
  indexedAs?: "module" | "series" | "id";
}

const DEWLAB_FIELDS: FrontMatterFieldSpec[] = [
  { key: "title", label: "Title", required: true, kind: "text" },
  { key: "year", label: "Year", required: true, kind: "text" },
  { key: "version", label: "Version", required: true, kind: "text" },
  {
    key: "status",
    label: "Status",
    required: false,
    kind: "select",
    options: [
      { value: "live", label: "Live" },
      { value: "archived", label: "Archived" },
    ],
  },
  // Optional, and absent from the vast majority of tutorials (a practice
  // page's own field, not an ordinary tutorial's) — decision 33. Its
  // value is a tutorial id, which is what it always was in substance:
  // dewlab's `slug` and its id are the same string, and the id is now
  // simply where that string lives.
  { key: "practice_for", label: "Practice for", required: false, kind: "text", indexedAs: "id" },
];

const DEWSTACK_FIELDS: FrontMatterFieldSpec[] = [
  { key: "title", label: "Title", required: true, kind: "text" },
  { key: "slug", label: "Slug", required: true, kind: "text" },
  { key: "module", label: "Module", required: true, kind: "text", indexedAs: "module" },
  { key: "module_title", label: "Module title", required: true, kind: "text" },
  { key: "series", label: "Series", required: true, kind: "text", indexedAs: "series" },
  { key: "version", label: "Version", required: true, kind: "text" },
  {
    key: "status",
    label: "Status",
    required: false,
    kind: "select",
    options: [
      { value: "live", label: "Live" },
      { value: "draft", label: "Draft" },
    ],
  },
];

const FIELD_LISTS: Record<DialectName, FrontMatterFieldSpec[]> = {
  dewlab: DEWLAB_FIELDS,
  dewstack: DEWSTACK_FIELDS,
  // Plain markdown's front matter is arbitrary keys, not a fixed shape
  // (DIALECTS.md §3) — there is no dialect-specific list to build a form
  // from, so a plain document has no form at all, only the raw editor.
  plain: [],
};

/** The fixed rows a dialect's form offers: required fields always shown,
 * optional ones only when the caller finds them already present with a
 * scalar value. An empty list (plain markdown) is the caller's own signal
 * to skip the form and fall back to the raw-YAML editor. */
export function frontMatterFieldsFor(dialect: DialectName): FrontMatterFieldSpec[] {
  return FIELD_LISTS[dialect];
}

/** True if `fields[key]` is a plain scalar the form can show and edit
 * directly — a string, number or boolean, never a list or mapping. */
export function isScalarField(fields: Record<string, unknown>, key: string): boolean {
  const value = fields[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
