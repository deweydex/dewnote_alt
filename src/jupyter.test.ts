// The plan's own "done when" for this step: "a tutorial survives
// markdown → ipynb → markdown unchanged." Mirrors roundtrip.test.ts's
// own fixtures-driven shape for that reason — this is the same
// guarantee, one layer further out.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exportToNotebook, importFromNotebook, roundTripThroughNotebook } from "./jupyter.ts";

const SAMPLE = `---
title: A Rule
slug: a-rule
---

# A Rule

Where it lives.

\`\`\`python exec
id: first
hint: not really a hint, just here to check ordering
1 + 1
\`\`\`

<details class="dl-hint"><summary>hint</summary>

Try squaring it instead.

</details>
`;

describe("exportToNotebook", () => {
  test("produces one cell per block, in order, with the right cell_type", () => {
    const nb = exportToNotebook(SAMPLE);
    expect(nb.nbformat).toBe(4);
    expect(nb.nbformat_minor).toBe(5);
    expect(nb.cells.map((c) => c.cell_type)).toEqual([
      "raw",
      "markdown",
      "markdown",
      "markdown",
      "code",
      "markdown",
      "markdown",
    ]);
  });

  test("an exec cell's id becomes the nbformat cell id, headers stripped from source", () => {
    const nb = exportToNotebook(SAMPLE);
    const code = nb.cells.find((c) => c.cell_type === "code")!;
    expect(code.id).toBe("first");
    expect(code.source).toBe("1 + 1");
    expect(code.source).not.toContain("id:");
    expect(code.metadata.dewnote.hint).toBe("not really a hint, just here to check ordering");
  });

  test("every cell keeps the block's exact original text for a lossless import", () => {
    const nb = exportToNotebook(SAMPLE);
    const doc = SAMPLE;
    const joined = nb.cells.map((c) => c.metadata.dewnote.raw).join("");
    expect(joined).toBe(doc);
  });

  test("an illustrative (non-exec) fence keeps its whole body, no header stripped", () => {
    const source = "```python\nid: not-a-header\n1 + 1\n```\n";
    const nb = exportToNotebook(source);
    expect(nb.cells[0]!.source).toBe("id: not-a-header\n1 + 1");
  });
});

describe("importFromNotebook / roundTripThroughNotebook", () => {
  test("round-trips a hand-written sample exactly", () => {
    expect(roundTripThroughNotebook(SAMPLE)).toBe(SAMPLE);
  });

  test("falls back to a plausible reconstruction for a notebook with no dewnote metadata", () => {
    const notebook = {
      nbformat: 4 as const,
      nbformat_minor: 5 as const,
      metadata: {},
      cells: [
        { cell_type: "markdown" as const, id: "a", metadata: {} as never, source: "# Hi\n" },
        { cell_type: "code" as const, id: "b", metadata: {} as never, source: "1 + 1" },
      ],
    };
    const markdown = importFromNotebook(notebook);
    expect(markdown).toContain("# Hi\n");
    expect(markdown).toContain("```python exec\nid: b\n1 + 1\n```\n");
  });

  test("handles nbformat's array-of-lines source form too", () => {
    const notebook = {
      nbformat: 4 as const,
      nbformat_minor: 5 as const,
      metadata: {},
      cells: [{ cell_type: "markdown" as const, id: "a", metadata: {} as never, source: ["# Hi\n", "\n", "Body.\n"] }],
    };
    expect(importFromNotebook(notebook)).toBe("# Hi\n\nBody.\n");
  });
});

describe("round trip through a notebook: dewlab fixtures", () => {
  const dir = "fixtures/dewlab";
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));

  test("the fixtures folder is not empty", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const name of files) {
    test(`${name} survives markdown -> ipynb -> markdown unchanged`, () => {
      const source = readFileSync(join(dir, name), "utf8");
      expect(roundTripThroughNotebook(source)).toBe(source);
    });
  }
});
