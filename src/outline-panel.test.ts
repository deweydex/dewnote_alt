// The pure part of the outline rail — which lines count as headings and
// which block each belongs to. The DOM half (scrolling a real block into
// view) is covered by tests/e2e/outline-panel.spec.ts against the built
// app instead, the same split settings-panel.ts and dialect-panel.ts use.

import { describe, expect, test } from "bun:test";
import { parseDocument } from "./blocks.ts";

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

function headingsFrom(source: string) {
  const doc = parseDocument(source);
  const headings: { level: number; text: string; blockIndex: number }[] = [];
  doc.blocks.forEach((block, blockIndex) => {
    if (block.kind !== "prose") return;
    for (const line of block.text.split("\n")) {
      const match = HEADING_RE.exec(line);
      if (match) headings.push({ level: match[1]!.length, text: match[2]!, blockIndex });
    }
  });
  return headings;
}

describe("headingsFrom", () => {
  test("collects headings of every level, in document order", () => {
    const source = "# Title\n\nSome prose.\n\n## A section\n\nMore prose.\n\n### A subsection\n\nEven more.\n";
    const headings = headingsFrom(source);
    expect(headings.map((h) => [h.level, h.text])).toEqual([
      [1, "Title"],
      [2, "A section"],
      [3, "A subsection"],
    ]);
  });

  test("a fence's own '#' comment is not a heading", () => {
    const source = "```python\n# not a heading\n1 + 1\n```\n";
    expect(headingsFrom(source)).toEqual([]);
  });

  test("front matter is never scanned for headings", () => {
    const source = "---\ntitle: A Rule\n---\n\n# Real heading\n";
    const headings = headingsFrom(source);
    expect(headings).toHaveLength(1);
    expect(headings[0]!.text).toBe("Real heading");
  });

  test("records which block a heading lives in", () => {
    const source = "# Title\n\nProse.\n\n```python exec\nid: x\n1 + 1\n```\n\n## Next\n";
    const headings = headingsFrom(source);
    const doc = parseDocument(source);
    for (const h of headings) expect(doc.blocks[h.blockIndex]!.kind).toBe("prose");
  });

  test("a document with no headings at all returns an empty list", () => {
    expect(headingsFrom("Just prose, no headings here.\n")).toEqual([]);
  });
});
