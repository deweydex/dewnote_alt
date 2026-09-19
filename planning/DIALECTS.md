# The dialects dewnote must open and save

An inventory, taken 2026-09-06 from `build.py` in each site and from the
tutorials themselves, and updated 2026-09-12 against dewlab's own commits
since (§1's `sql exec`, `hint` fence, and `html/css/js site` fence
entries, and dewstack's changed status in §2 — see
`deweydex/dewlab@planning/DEWSTACK_MERGE.md`, written there 2026-09-10).
Each dialect becomes one module in the editor that declares its front
matter, its block kinds, what the add-block menu offers, and which
runtime a cell needs. This file is the reference those modules are
written from and checked against; when a build script changes, this file
changes first.

Everything is CommonMark underneath. A dialect is the set of additions.

---

## 1. dewlab

**File layout.** `tutorials/<id>/<id>.md`, flat — every tutorial sits
directly under `tutorials/`, whatever course it's on — with optional
`<id>-practice.md`, `<id>.glossary.yaml`, frozen `v<version>.md`
releases, and images beside it.

**A page's id is its path, and nothing else.** `build.py`'s own
`id_of()`: a tutorial's id is its file's stem, which is also its folder;
a practice page `<id>-practice.md` has an id of its own; a frozen release
`v<version>.md` takes the *folder's* id, since it is a version of that
folder's tutorial rather than a page of its own. Nothing is read from the
front matter, for the reason dewlab gives — the id is the address of the
page and the key every reader's saved work lives under, so a field that
could disagree with the folder would be a way to break both. An id is
site-wide and unique per page, which is not the same as unique per file:
a live tutorial and the frozen releases beside it all share one id, which
is why `file-index.ts`'s `defaultEntryFor` still exists.

**Placement is `courses/`, never a front matter field.** As of dewlab's
own 2026-09 refactor (its `refactor/PLAN.md`, and the spec it wrote for
this editor in `refactor/EDITOR.md` §2 — that folder is deleted now, so
it lives at `git show b7c5a6d:refactor/EDITOR.md` in dewlab), a tutorial
no longer says where it lives; a course says what it holds.
`courses/<course-id>.yaml` is `{title, code, status, card, description,
contents: [{title, tutorials: [<id>, ...]}, ...]}` — series with human
titles, each an ordered list of tutorial ids. `courses/index.yaml`
(`order:` a list of course ids) orders the courses themselves, and
`courses/redirects.yaml` maps every old address to its new one so links
into the pre-refactor layout still land. A tutorial may be listed by more
than one course, and one listed by none still builds — "published but on
no course" is a real state. courses.ts reads all of this; series-panel.ts
shows it.

**Front matter.** Required: `title`, `year`, `version` (`2026.09.04.1`
form). Optional: `status` (`live` or `archived`), `packages` (a list,
e.g. `[sympy]`), `practice_for` (a single tutorial id — a practice page
names the one tutorial it practises), `practice_across` (a list of ids,
for a mixed set spanning several tutorials instead), `covers` (sections
mapped to learning outcomes). A practice page is a tutorial in every
other mechanical sense — same required fields, same cells — and dewlab's
own `build.py` forbids one from also setting `covers`, or from naming
another practice page as what it practises.

`slug`, `module`, `module_title` and `series` were all required here
before the refactor and are all gone. dewnote's own form has no row for
any of them: a field for something the build ignores is worse than no
field, since it looks like it still places the tutorial.

The front-matter form (decision 11) has a row for `practice_for` —
scalar, and decision 33 gave the "+ field" mechanism its first optional
*text* field to handle — with autocomplete over every real id the open
folder or repository's own index knows. `practice_across`, `covers`, and
`packages` stay raw-YAML-only: each is a list or mapping, not the single
value a form row edits directly.

**Links.** `tutorial:<id>` is the only link scheme `build.py` resolves
(`resolve_links()`), and an id being site-wide is what makes it work from
any page without a module to qualify it. dewnote once also checked
`module:` and `series:` links; neither was ever real in either site's
build, and no tutorial in dewlab or dewstack has ever used one — see
`link-check.ts`'s own header.

**Cells.** Two cell languages as of `d2a21ed` (2026-09-10), both exec
fences sharing one header grammar: `python exec` and `sql exec`.

````markdown
```python exec
id: filter-evening
hint: Try printing readings["evening"] > 14 on its own first.
readings[readings["evening"] > 14]
```

```sql exec
id: total-readings
expect: len(_) > 0
select count(*) from readings;
```
````

The `id:` line is required and is a contract: saved student work is keyed
on it, so renaming one throws that work away. The editor must warn before
a rename and never generate ids that could collide. Header lines, in the
order dewlab's own `HEADER_RE` accepts them: `id:` (required), `hint:`,
`expect:`, `name:` (all optional) — `cell.ts` must recognise and preserve
all four verbatim, not just `id`/`hint`; a real dewlab tutorial using
`expect:` or `name:` currently has that line swallowed into the cell's
own *code* by dewnote's header parser, which then fails to run (§8 has
the fix). `expect:` is a Python expression checked after a run, driving a
staged hint's trigger (`planning/CELL_HINTS.md` in dewlab); `name:` is
reserved there for a related feature dewnote does not need to act on yet,
only preserve. A fence without `exec` is illustrative, read-only code.
Counted across the repository as of 2026-09-06: 806 `python exec`, 252
plain `python`, nothing else — `sql exec` and the newer headers postdate
that count.

A `sql exec` cell's body is SQL text, not Python, and runs against one
shared, page-wide SQLite connection (`tutorial-runtime.js`'s
`SEED_SQL_DB_SOURCE`, seeded into the same shared namespace every
`python exec` cell already uses, under the name `db`) — not a per-cell
named database the way dewstack's SQL cells work (§2). Running it means
wrapping the fence's raw SQL as
`tutorial_tools._run_sql_cell(db, <script>)` before handing it to the
same Python-exec pipeline every other cell already uses, exactly the way
`tutorial-runtime.js`'s own `wrapSqlCode()` does — not a second execution
path. `_run_sql_cell` is already dewmini's own SQL cell function
(`tutorial_tools.py`), which is also what dewnote's existing
`dewnote_sql_tools.py` was trimmed from for dewstack's cells, so the
runtime work is a second call site, not new plumbing.

**Shared setup.** `{{include: setup/load_readings.py}}` inside a cell,
spliced in at build time. Preserve verbatim; optionally show the included
text greyed beneath it.

**Folds.** Raw HTML, and the build fails on any `<details>` whose class is
not one of two:

```markdown
<details class="dl-hint"><summary>hint</summary>

Name the columns you want, separated by commas, in place of `*`.

</details>
```

`dl-answer` is the other. The blank lines inside are required for the
markdown within to render. These are the whole of the practice-problem
syntax; a problem is `**2.**` followed by prose, then a fold.

**Staged hints — a second, fence-based fold**, added `5b4bfaa`
(2026-09-07) and reworked into its final fence form by `d2a21ed`
(2026-09-10). Not the same thing as the `dl-hint` fold above, and not a
replacement for it — a staged hint waits for a real attempt (errors, a
repeated identical error, an unchanged run, or a failing `expect:`)
before it appears at all, where a hand-written `dl-hint` fold is always
there to open. Its own fence:

````markdown
```hint
after: 3 errors
title: Let's slow down a moment…

Check that every column name matches the table exactly, including case.
```
````

`for:` is optional (defaults to the exec cell immediately above it in
the source — `for:` names one explicitly, needed only when a hint
doesn't directly follow its cell); `after:` and `title:` are each
optional too, defaulting to `errors:5` and "Let's slow down a moment…".
Everything after the header lines is the hint's own markdown body. It
compiles to `<details class="dl-hint dl-hint-staged" data-cell="..."
data-after="..." hidden>` — a third fold shape, alongside `dl-hint` and
`dl-answer`, that dewnote's block splitter already passes through safely
as an opaque fence (its round-trip guarantee never depended on knowing
what a fence's info string means), but that `render-block.ts` currently
shows as a plain, unstyled code block rather than a fold, since nothing
reads the fence's `hint` info word yet (§8 has the plan).

**Notes.** `<aside class="dl-note" id="...">`, lifted out of the body into
the reference panel by the build. Built, currently unused by any tutorial.

**Links.** `[text](tutorial:<id>#anchor)`, resolved at build time; a dead
id or anchor fails the build. The editor offers a picker over real ids
and anchors and checks links on request.

decision 33 also added `module:name` and `series:name` to the editor's
own picker and link checker, ahead of a `build.py` resolver for them — a
home page linking to "the whole Computational Methods module" needed
somewhere to put that link first, and the passage here said plainly that
nothing in dewlab's build knew what to do with one.

**That resolver never arrived, and both kinds are now removed.** Two
years of content later, `tutorial:` is used 38 times as a real link
target across dewlab and dewstack and the other two are used zero times;
their only appearances anywhere were dewnote's own fixtures and tests.
Building ahead of a consumer is a reasonable bet and this one did not
pay: what it actually produced was a picker offering an author a link
that would ship as literal text, and a checker reporting such a link as
fine. dewlab's own spec for the courses refactor proposed renaming
`module:` to `course:`; that would have carried the same bet forward
under a new name, so it wasn't taken. A course page does have a real
address (`courses/<id>.html`), so the scheme could be built for real —
starting in `resolve_links()`, not here.

**Images.** `![alt](name.png)`, a bare file name resolved against the
tutorial's folder; `alt` is required. Built, currently unused.

**Maths.** `$…$` and `$$…$$`, extracted before markdown runs. `\$`
escapes. Inline maths does not match across a newline or against
whitespace on either side, so prices survive; the editor's renderer must
use the same rule or previews will differ from the site.

**Generated, never authored.** Table of contents (a closed `<details
class="dl-toc">`, emitted only with two or more sections), previous and
next, series navigation, the reference panel.

**Runtime.** Pyodide 0.28.3 in a module Worker; `numpy`, `pandas`,
`matplotlib` baseline; `packages:` adds more. Output rendering lives in
`assets/tutorial_tools.py`.

**Live-preview site cells**, added `4ac0176`/later commits through
2026-09-11 as dewlab's own answer to the web track dewstack's merge is
retiring (see §2's new header) — not a copy of dewstack's `site=name`
spelling, and deliberately so: dewlab's own authoring editor keeps only
the *first word* of a fence's info string on a round trip, so an
identity carried in the info string (`site=hero`) would come back inert.
The grouping key instead lives on a header line, the same place every
other exec-family fence already keeps its own identity:

````markdown
```html site
id: hero-markup
site: hero
<button>Hover me</button>
```

```css site
id: hero-style
site: hero
.btn { padding: 0.5rem 1rem; }
```
````

Fence language is one of `html`, `css`, `js` (`SITE_LANGS`); `id:` is
required (cells and panes share one id namespace — a build fails if any
two collide) and `site:` is the grouping key. Panes are grouped by
*consecutive* fences sharing the same `site:` value — nothing else may
sit between them, and the same `site:` name may not reappear later in
the document once its run has ended (the same "keep it together" rule
dewstack's own `site=` enforced). At most one pane per language per
site; panes are otherwise optional (an HTML+CSS site with no JS pane is
normal). A `js site` pane gets a Run button and a console; `html site`
and `css site` panes stay live, rebuilding the preview on every edit.
This is exactly the block-model gap plan §6 step 3 named and deliberately
deferred ("`site=`/`app=` cells... need consecutive-fence grouping
dewnote's block model doesn't have yet") — now with a real, stable target
grammar to build it against, since dewlab settled its own spelling rather
than dewstack's (§8 has the plan).

**Hand-written pages (`pages/`)**, added 2026-09-13 across three of
dewlab's own decisions (7.159, 7.161, 7.162) that moved the About, home,
and features pages out of hardcoded HTML strings in `build.py` and into
real markdown. A page is `pages/<name>.md` — no module, series, or
version, since it isn't part of the curriculum — with a `title`-only
front matter block:

```markdown
---
title: About this project
---

# About this project

dewlab is an open educational project...
```

`read_page()` there converts the body through the same markdown pipeline
a tutorial's own prose uses, plus two things ordinary prose doesn't have:

A ` ```card ` fence — the header-line idiom every other exec-family fence
already uses, applied to a fourth, non-runnable kind:

````markdown
```card
url: computational-methods.html
status: beta
meta: 5N0554 · QQI Level 5
### Computational Methods and Problem Solving
We work through matrices, simulation, algorithms and debugging, in Python.
```
````

`url:` (required by dewlab's own build; parsed as `null` here rather than
thrown on, an editor reading a fence mid-edit), `status:`, `meta:`, and
`wide:` (`true`/`yes`) are all optional header lines, then a markdown
heading and an optional paragraph. This is the markup a home-page module
tile used to be hand-written six times over (`.dl-module-card`); adjacent
cards share one `.dl-module-grid` wrapper automatically on dewlab's own
build, a purely cosmetic grouping this editor's own preview doesn't
reproduce — each card previews on its own (`cell.ts`'s `parseCardFence`,
`render-block.ts`'s `renderCardFencePreview`, wired into `app.ts` the same
way a staged hint's preview is, decision 15 unchanged: the fence itself
stays a live editor, never a render/edit toggle).

**Not a cell.** dewlab's own `Cell`/`CELL_TYPES`/`render_cell()` already
reserve that word for something that runs, with a real saved-progress
contract behind it (a cell id is a contract — renaming one throws away a
student's saved work). A card has no output and nothing to save, so it
stays a **card** throughout dewnote's own code and this document too —
"cell" is free here for dewnote's own broader sense of the word (any
boxed, focusable unit, plan §3's own "a cell is a box; a paragraph is
not"), and a course maintainer is free to call the rendered result a
"card cell" in conversation without either use stepping on the other.

A `[[name]]` marker is the second new piece — infrastructure a page can
point at but never author directly, dewlab's own `GENERATED_BLOCKS`
registry (today: `[[search-box]]`, the site-wide search widget). A
bracketed marker rather than an HTML comment in the source, specifically
so a markdown editor renders it as a real, visible, clickable line rather
than an invisible comment node — dewnote's block splitter has never had
to render one specially, since a fence's own placeholder convention
(`<!--dewlab-cell-N-->` and friends) is a build-time-only concern that
never reaches a page's own source text; a `[[name]]` marker does, and
today dewnote's block splitter treats it as ordinary prose text — it
round-trips correctly (nothing here breaks decision 1's guarantee) but
renders as the literal bracketed text, not a preview of what it stands
for. Giving it one is real, separate scope, not attempted here.

A `<div class="dl-hero">`/`<div class="dl-audience">`/`<div
class="dl-attribution">`/`<ul class="dl-feature-list">` section or list
wrapper is the third — dewlab's own `convert_page_wrapper_bodies()`
re-converts the markdown inside one a second time, since Python-Markdown
treats a raw HTML block as opaque through to its closing tag. dewnote's
own block splitter (`blocks.ts`) has no equivalent special case for these
wrappers today: a `<div class="dl-audience">` spanning several
blank-line-separated paragraphs splits into several ordinary prose
blocks, one of which is just the bare opening tag on its own line and
another just the closing tag — round-trips byte for byte (blocks.ts's
own guarantee doesn't depend on understanding what wraps a block), but
reads as several odd, meaningless one-line "paragraphs" in the editor
rather than one cohesive section. Documented as a known gap rather than
worked around, since giving these wrappers their own block kind is real
design work of its own, not a one-line fix.

## 2. dewstack — being retired into dewlab, 2026-09-10 onward

`deweydex/dewlab@planning/DEWSTACK_MERGE.md` (written 2026-09-10) records
Josh's decision to fold dewstack's two live tracks — `data` and `web` —
into dewlab itself as `database-methods` and `web-authoring`, rebuilt
against dewlab's own conventions rather than imported, and to retire
dewstack as a hosted site once both have run in front of a class. As of
2026-09-12 both tracks are staged, ported, and merged to dewlab's `main`
(`planning/DEWSTACK_MERGE.md` §9's own ledger) — not yet linked from
dewlab's homepage, but no longer "coming soon" as engineering. This
section stays as the record of dewstack's *own* grammar — still real for
as long as dewstack itself is live, and the shape dewnote's dialect
converter (§5) needs to read *from* for exactly this migration — but it
is no longer a second dialect dewnote should treat as an equally live
authoring target the way §1 is. Where dewstack and dewlab now both have
an answer to the same problem (SQL cells, site cells), dewlab's own
spelling in §1 is the one to write new tutorials in, in dewnote or
anywhere else — dewstack's spelling below is legacy dewstack could not
avoid once it existed, and it was never adopted by dewlab in the first
place, for reasons §1 gives at each entry.

**File layout.** `tutorials/<module>/<slug>/<slug>.md`, optional
`<slug>.glossary.yaml`. Same `order.yaml` convention as dewlab.

**Front matter.** Required: `title`, `slug`, `module`, `module_title`,
`series`, `version`. Optional: `status` (`live` or `draft`). No `year`,
no `covers`. Detection rule between the two sites: `year` present means
dewlab; `module_title` without `year` means dewstack.

**Cells.** Five fence forms, all pulled out before markdown sees them.

| Fence | Meaning |
|---|---|
| ` ```html site=name `, ` ```css site=name `, ` ```js site=name ` | Web track. Panes sharing a name form one site with a live preview in a sandboxed iframe. JS runs on Run only. |
| ` ```sql cell=name ` and ` ```sql cell=name persist ` | Data track. Cells sharing a name share one SQLite connection; `persist` keeps the script across visits. |
| ` ```sql-check db=name task=check_foo ` | An empty fence that renders a self-check button. |
| ` ```py cell=name ` | pandas and matplotlib, sharing a namespace by name; `read_sql("name", …)` reaches a SQL cell's connection. |
| ` ```html app=name `, ` ```css app=name `, ` ```js app=name ` | Full-stack track, rendered into the page, with `window.dlQuery(db, sql, params)`. |

The info string carries everything; the body has no header lines. This
is the case that broke Milkdown in dewlab and it is why the block
splitter keeps the info string whole.

**Folds.** Same two classes as dewlab, same spelling.

**Links.** Same `tutorial:` scheme.

**Images.** `<img>` without `alt` fails the build. No tutorial uses one.

**Maths.** None. No KaTeX, no `$` anywhere. A dewstack document with `$`
in it should render the dollar signs as text.

**Markdown extensions in the build.** `fenced_code`, `tables`, `toc`,
`sane_lists`, `attr_list`. No tutorial uses `attr_list` syntax
(`{: .class }`) as of 2026-09-06, so the renderer needs no plugin for it
until one does.

**Runtime.** One Pyodide interpreter per page serves SQL (`sqlite3`),
Python and app cells; the HTML/CSS/JS preview is an iframe with
`sandbox="allow-scripts"` and no `allow-same-origin`.

**Look.** Same tokens as dewlab, measure 30rem instead of 34rem.

## 3. Plain markdown (writing-content, and anything else)

YAML front matter with arbitrary keys, preserved in order and quoting
(`created`/`updated` are quoted ISO-8601 strings; a YAML re-dump would
unquote them). CommonMark with GFM tables and task lists, inline HTML
passed through, `$…$` maths on. No cells run; fences are highlighted.
The prompt-deck fields in writing-content (`prompt: 62`) are that app's
business and dewnote leaves them alone.

## 4. Jupyter (import and export only)

nbformat 4.5. Mapping from the block model:

- A run of prose blocks → one markdown cell, joined by blank lines.
- A code cell → a code cell. `id` from the dewlab `id:` line where there
  is one, else generated. The full fence info string, the `hint:` line,
  and the dialect name go in `metadata.dewnote` so import can rebuild the
  fence exactly.
- Illustrative (non-exec) fences stay inside markdown cells.
- Folds stay as raw HTML inside markdown cells; Jupyter renders
  `<details>` natively.
- Outputs, if included: `stream` for text, `display_data` with
  `image/png` for figures, taken from the last run.

Import inverts this. A notebook without `metadata.dewnote` becomes a plain
markdown document with `python exec` fences in the dewlab dialect if the
user chose dewlab as the target, else plain `python` fences.

## 5. Conversions between dialects

Block by block, with a report of what did not map:

| From | To | Rule |
|---|---|---|
| dewlab `python exec` with `id: x` | dewstack | `py cell=x`; `hint:`, `expect:`, `name:` have no home, report each |
| dewstack `py cell=x` | dewlab | `python exec` with `id: x` |
| dewstack `sql cell=x` | dewlab | `sql exec` with a fresh `id:` (dewstack's per-cell named database has no dewlab equivalent — dewlab's cells all share one `db` — report the name lost); `persist` has no home either, report it |
| dewstack `sql-check` | dewlab | no equivalent; keep as illustrative fence, report |
| dewstack `html/css/js site=name` | dewlab | `html/css/js site`, each pane getting its own fresh `id: <name>-<language>` and `site: <name>` |
| dewstack `html/css/js app=name` | dewlab | no equivalent (dewlab has no full-stack track yet — `planning/DEWSTACK_MERGE.md` §2 in dewlab defers this); keep as illustrative fences, report |
| dewlab `sql exec` | dewstack | no equivalent (dewstack's SQL cells are per-name databases dewlab's shared-`db` model can't address as one); keep as illustrative fence, report |
| dewlab `hint` fence | dewstack | no equivalent (dewstack has no staged-hint mechanism); keep as illustrative fence, report |
| dewlab `html/css/js site` | dewstack | `html/css/js site=<name>` (`id:` has no home — `site=name`'s own info string is the whole identity there — dropped, reported); a pane with no `site:` at all has nothing to carry over, kept as illustrative, reported |
| either | plain | drop attributes, keep language |
| dewlab front matter | dewstack | drop `year`, `covers`, `practice_*`; keep the rest |
| dewstack front matter | dewlab | add `year` (ask), `covers` empty |

All of the above is implemented in `dialect-convert.ts` as of plan §8's
own items 1-3.
