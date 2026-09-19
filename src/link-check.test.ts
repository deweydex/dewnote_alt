import { describe, expect, test } from "bun:test";
import { findBrokenLinks } from "./link-check.ts";
import type { FileIndexEntry } from "./file-index.ts";

// Ids come from the path, the way file-index.ts derives them.
const INDEX: FileIndexEntry[] = [
  { path: "tutorials/filtering/filtering.md", id: "filtering", title: "Filtering" },
  { path: "tutorials/grouping/grouping.md", id: "grouping", title: "Grouping" },
];

describe("findBrokenLinks", () => {
  test("a link to a real id is not reported", () => {
    const source = "See [filtering](tutorial:filtering) for more.\n";
    expect(findBrokenLinks(source, INDEX)).toEqual([]);
  });

  test("a link to an id not in the index is reported, with its own visible text", () => {
    const source = "See [sorting rows](tutorial:sorting) for more.\n";
    expect(findBrokenLinks(source, INDEX)).toEqual([
      { kind: "tutorial", target: "sorting", text: "sorting rows" },
    ]);
  });

  test("an anchor after the id doesn't change whether the id itself resolves", () => {
    const source = "See [filtering](tutorial:filtering#worked-example) for more.\n";
    expect(findBrokenLinks(source, INDEX)).toEqual([]);
  });

  test("an ordinary link (no tutorial: scheme) is ignored entirely", () => {
    const source = "See [the docs](https://example.com/filtering) or [a file](./notes.md).\n";
    expect(findBrokenLinks(source, INDEX)).toEqual([]);
  });

  test("with an empty index, every tutorial: link is reported — an unopened folder, not an error", () => {
    const source = "See [filtering](tutorial:filtering).\n";
    expect(findBrokenLinks(source, [])).toEqual([
      { kind: "tutorial", target: "filtering", text: "filtering" },
    ]);
  });

  test("several links in one document are each checked independently", () => {
    const source = "[a](tutorial:filtering) and [b](tutorial:missing) and [c](tutorial:grouping)\n";
    expect(findBrokenLinks(source, INDEX)).toEqual([
      { kind: "tutorial", target: "missing", text: "b" },
    ]);
  });

  // Neither scheme was ever resolved by dewlab's or dewstack's build —
  // `resolve_links()` has only ever handled `tutorial:id`, and no
  // tutorial in either repository uses them. Reporting one as broken was
  // as wrong as clearing it: an author was told a link worked, or that it
  // didn't, when the scheme itself would have shipped as literal text.
  test("a module: or series: link is left alone, like any other unknown scheme", () => {
    const source = "See [the module](module:data) and [the series](series:core).\n";
    expect(findBrokenLinks(source, INDEX)).toEqual([]);
  });

  test("a frozen release and its live file share one id, so a link to it resolves once", () => {
    const index: FileIndexEntry[] = [
      { path: "tutorials/first-steps/first-steps.md", id: "first-steps", title: "First Steps" },
      { path: "tutorials/first-steps/v2026.08.23.1.md", id: "first-steps", title: "First Steps" },
    ];
    expect(findBrokenLinks("[a](tutorial:first-steps)\n", index)).toEqual([]);
  });
});
