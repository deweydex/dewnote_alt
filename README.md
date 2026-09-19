# dewnote

A focused editor for Dewlab teaching documents written as Markdown: prose,
LaTeX maths, executable Python and SQL cells, questions, hints, cards, and
small HTML/CSS/JavaScript examples. Files remain ordinary Markdown and YAML;
nothing Dewnote writes is locked into a private document format.

Dewnote opens either a local teaching folder or a GitHub repository. It reads
Dewlab module descriptors, presents tutorials and practice pages in their
authored order, edits one document at a time, and saves locally or to a GitHub
working branch. A repository session can review its complete branch diff,
create dated tutorial versions, and open a draft pull request.

`planning/PROGRESSIVE_WORKFLOW_UI.md` describes the current source → document
→ save → publish workflow. `planning/PLAN.md` is the original build plan and
`planning/DIALECTS.md` inventories the files Dewnote opens and saves;
`DECISIONS.md` records what was decided and why, in the same spirit as
dewlab's `DECISIONS_LOG.md`. `planning/mockups/` has design sketches.

Named `dewnote`, to sit beside `dewlab`, `dewstack`, `dewmini` and `dewmark`.

## Running things

```bash
bun install       # first time only
bun test          # the document model's tests, fixtures/ included
bun run typecheck
```

`src/full-corpus.test.ts` additionally round-trips every tutorial in a sibling
`../dewlab` checkout. Historical compatibility fixtures remain in the test
suite, but Dewstack is retired and is not presented as a workspace or
conversion target.

## Where things are

The document model records byte offsets and round-trips untouched source byte
for byte. The browser interface adds rendered in-place editing, executable
cells, block creation and reordering, front-matter forms, module organisation,
local-folder access, GitHub branch saving, notebook import/export, standalone
HTML export, link checking, and source/outline views. Browser interaction tests
exercise the same built application rather than a separate UI harness.
