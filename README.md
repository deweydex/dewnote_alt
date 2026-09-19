# dewnote

A minimal editor for notebooks written as markdown: prose, LaTeX maths, and
code cells that run in the page. The file on disk is a plain markdown file
in whichever dialect a target site expects (dewlab, dewstack, or none), so
nothing the editor writes is private to the editor. It runs as a single
HTML file in a browser, and as a Mac application built from the same code.

`planning/PLAN.md` is the design and the order of work; `planning/DIALECTS.md`
is the inventory of what the files it must open and save look like;
`DECISIONS.md` records what was decided and why, in the same spirit as
dewlab's `DECISIONS_LOG.md`. `planning/mockups/` has design sketches.

Named `dewnote`, to sit beside `dewlab`, `dewstack`, `dewmini` and `dewmark`.

## Running things

```bash
bun install       # first time only
bun test          # the document model's tests, fixtures/ included
bun run typecheck
```

`src/full-corpus.test.ts` additionally round-trips every tutorial in
`../dewlab` and `../dewstack` when those repositories are checked out as
siblings of this one; it skips itself otherwise.

## Where things are

The plan's step 1 (`planning/PLAN.md` §6) — the document model — is
built: `src/lines.ts` indexes a document by line span, `src/frontmatter.ts`
and `src/dialect.ts` read a document's front matter and decide dewlab,
dewstack, or plain, and `src/blocks.ts` splits a document into the blocks
described in the plan's §5.2 (fences, display maths, folds, front matter,
and blank-line-separated prose), recording only byte offsets. Every
tutorial in `fixtures/`, and every tutorial in dewlab and dewstack when
checked out alongside this repository, round-trips through it byte for
byte — see `src/roundtrip.test.ts` and `src/full-corpus.test.ts`. Nothing
past that (the editing surface, running cells, files, GitHub, exports, the
Mac app) is built yet; §6 has the rest of the order.
