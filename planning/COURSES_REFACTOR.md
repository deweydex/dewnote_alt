# Following dewlab's move of placement into `courses/`

dewlab wrote this editor's half of its own 2026-09 refactor, as
`refactor/EDITOR.md` §2 in its repository. That folder was temporary —
"deleted when the work is done", and it was — so §2 is reproduced here
before it becomes something only `git log` remembers. The original is at
`git show b7c5a6d:refactor/EDITOR.md` in dewlab.

Reproduced, then corrected: three things in it turned out to be wrong
when checked against the real tree, and one surface is missing from it.
Those are marked below rather than silently fixed, since the original is
a good-faith spec written by somebody with more context on dewlab's side
than this repository has, and knowing *which* parts didn't survive
contact is worth more than a clean-looking list.

## What changed in dewlab

A tutorial stopped declaring where it lives; placement moved into
`courses/`.

- `tutorials/<id>/<id>.md`, flat — no module directory. The id is the
  folder name, site-wide, and `build.py`'s own `id_of()` derives it from
  the path alone.
- Front matter is `title`, `year`, `version`, plus the optional `status`,
  `packages`, `practice_for`, `practice_across`, `covers`. `slug`,
  `module`, `module_title` and `series` are gone.
- `courses/<course-id>.yaml` holds `{title, code, status, card,
  description, contents: [{title, tutorials: [<id>, ...]}, ...]}`.
- `courses/index.yaml` orders the courses; `courses/redirects.yaml` maps
  every old address to its new one.
- A tutorial may be on several courses, or none. None still builds.

## dewlab's own spec for dewnote, as written

> dewnote decides a file's dialect from its frontmatter alone
> (`src/dialect.ts`: `year` present → dewlab), so migrated files are
> still recognised as dewlab. Everything else that touches placement:

| File | Today | Change |
|---|---|---|
| `src/frontmatter-fields.ts` | dewlab's required list: `title, slug, module, module_title, year, series, version`; `module`/`series` rows indexed as pickers (decision 11) | Required: `title, year, version`. Remove the `slug`, `module`, `module_title`, `series` rows. `practice_for` stays, indexed over ids. |
| `src/file-index.ts` | indexes `slug`, `module`, `series` from frontmatter; "the one file among several sharing a slug" logic for versions | Index the id from the path (`tutorials/<id>/`), and the courses that list it from `courses/*.yaml`; drop `module`/`series`; the shared-slug disambiguation goes (ids are unique). |
| `src/series.ts`, `src/series-panel.ts` | reads `<series>.order.yaml` under `tutorials/<module>/` into `{module, slug, title, order}`; the panel's "Module (leave blank if already inside one)" input | Read `courses/*.yaml`; a course has titled series with ordered ids; the panel groups by course, then series, and reorders by rewriting the list in the course file. The module input goes. |
| `src/folder-store.ts`, `src/github.ts`, `src/repo-panel.ts` | walk for `.order.yaml`; the new-file placeholder `tutorials/module/new-tutorial.md` | Walk for `courses/*.yaml`; placeholder `tutorials/new-tutorial/new-tutorial.md`; on create, offer a course and series to list it on. |
| `src/link-check.ts`, `src/link-picker.ts` | `tutorial:`, `module:`, `series:` link kinds checked against the index's module/series values | `tutorial:` checks against ids; `module:` becomes `course:` (or stays, as an alias, pointing at `courses/<id>.html`); `series:` links need a course to be meaningful — drop, or resolve to the first course that has a series of that title. |
| `src/dialect-convert.ts` | `DEWLAB_ONLY_FIELDS = ["year", "covers", "practice_for", "practice_across"]`; dewstack → dewlab adds `module`/`series` | Remove any code that adds `module`/`series`/`module_title`/`slug` when converting to dewlab; `year` stays. |
| `src/full-corpus.test.ts`, `fixtures/` | round-trips `../dewlab` tutorials byte for byte | Passes as is (round-trip is byte-level); fixtures gain one migrated file. |
| `planning/DIALECTS.md` §1 | the old layout and required list | Rewrite the layout and the required list; describe `courses/`. |
| `DECISIONS.md` | decision 11 (module and series pickers over the index) | A new decision: placement is read from course files, and the form has no placement fields; the picker survives as "list on course / series" at create time. |
| `planning/PLAN.md` §8 | dewlab's 2026-09 changes | Add this change and the order of work above. |

> What does not change in dewnote: cells and their header grammar, the
> block model, the round-trip guarantee, exports, the Mac app, GitHub
> authentication. The change is confined to how it finds and places
> files.

## Where it was wrong

**1. `defaultEntryFor` survives — ids are unique per *page*, not per
file.** The spec expected the version-picking logic to go. But a frozen
release `tutorials/first-steps/v2026.08.23.1.md` carries the id of the
folder it sits in, the same id as `first-steps.md` beside it — that's
`id_of()`'s own third case, and dewlab's tree has real ones today. So an
id still resolves to several files and something still has to pick which
one a title and a click mean. Following the spec here would have shown a
frozen release's title where the live one belongs. Rekeyed from slug to
id, kept otherwise.

**2. `module`/`series` stay in the index.** Dropping them holds for
dewlab, which no longer writes them, but dewnote serves three dialects
and dewstack still places a tutorial from its own front matter, with its
own form offering both as pickers over this index. They're kept and left
to empty out on their own as dewlab files stop carrying them.

**3. `module:`/`series:` links are deleted, not renamed to `course:`.**
Neither was ever resolved by either site's build: dewlab's
`resolve_links()` has only ever handled `tutorial:id`. Across every
tutorial in dewlab and dewstack, `tutorial:` is used 38 times as a real
link target and the other two zero times — their only uses anywhere were
this repository's own fixtures and tests. They came from decision 33,
which added them ahead of a `build.py` resolver that never arrived (see
DIALECTS.md §1's own note). Renaming `module:` to `course:` would carry
that bet forward under a new name; a course page has a real address, so
the scheme can be built properly when dewlab's build grows a resolver for
it.

One thing the spec got right that was worth confirming rather than
assuming: `full-corpus.test.ts` does pass unchanged, because its
`findMarkdownFiles` recurses arbitrarily deep, so a flat tutorial tree is
fine.

## What it missed

**`src/folder-panel.ts`.** The table covers `folder-store.ts`,
`github.ts` and `repo-panel.ts` for the store side, but folder-panel has
its own "New tutorial" form — Module, Slug, Title, Module title, Series
slug — building `tutorials/<module>/<slug>/<slug>.md` by hand. It is the
most visible placement surface in the editor. Now: an id, a title and a
year, writing `tutorials/<id>/<id>.md`, refusing an id some
`tutorials/<id>/` already holds.

## The order of work

Split in two, because the writing half is the risky half and deserves to
land on its own.

**Read side (PR #52).** courses.ts and its line ranges; the index by id
and course membership; the front-matter rows; the panel grouped by course
then series; both stores walking for `courses/*.yaml`; the creation
forms; the dead link kinds; these documents.

**Writer.** Reorder within a series, add a tutorial to one, remove one
from one — and "New series", which is now an entry in a course file
rather than a file of its own, so it belongs with the rest of the
writing. All of it is one splice into the line range courses.ts already
records, which is why the read side records them.

The writer landed as described, minus one thing it had promised.

**"New series" is still not there**, and the reason is the same one that
makes everything else here safe. Appending a series means splicing into
`contents:`, and courses.ts records the bounds of a `tutorials:` list,
not of the block above it. Inferring where the block ends — or what
indent a `- title:` line carries — from the tutorials indent is exactly
the guess that writes into somebody's prose. Recording that range
properly is its own piece of work, and a course file opens in the editor
like any other text file in the meantime.

So `repo-panel.ts`'s `createFile` still has no caller, though its
`readTextFile`/`writeTextFile` pair now does, and the repository's store
adapter is covered again through the rail's own reorder.

`folder-panel.ts`'s "New tutorial" still creates a tutorial on no course.
The spec's "on create, offer a course and series to list it on" is now
one click away rather than folded into that form: the new tutorial shows
up under "On no course", and the series it belongs in has an "Add a
tutorial" list that offers it.
