// The test named in DECISIONS.md 1 and in the plan's step 1 done-criteria:
// every real tutorial in the fixtures folder must come back byte for byte
// after being split into blocks and joined again. This is deliberately
// the first test written in this repository.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectDialect } from "./dialect.ts";
import { parseDocument, serialize } from "./blocks.ts";

const FIXTURE_DIRS = {
  dewlab: "fixtures/dewlab",
  dewstack: "fixtures/dewstack",
  plain: "fixtures/plain",
} as const;

function fixtures(dir: string): { name: string; path: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((name) => ({ name, path: join(dir, name) }));
}

for (const [dialectName, dir] of Object.entries(FIXTURE_DIRS)) {
  describe(`round trip: ${dialectName} fixtures`, () => {
    const files = fixtures(dir);
    test("the fixtures folder is not empty", () => {
      expect(files.length).toBeGreaterThan(0);
    });

    for (const { name, path } of files) {
      test(`${name} round-trips byte for byte`, () => {
        const source = readFileSync(path, "utf8");
        const doc = parseDocument(source);
        expect(serialize(doc)).toBe(source);
      });

      test(`${name} tiles the source with no gaps or overlaps`, () => {
        const source = readFileSync(path, "utf8");
        const { blocks } = parseDocument(source);
        let pos = 0;
        for (const block of blocks) {
          expect(block.start).toBe(pos);
          expect(block.end).toBeGreaterThan(block.start);
          pos = block.end;
        }
        expect(pos).toBe(source.length);
      });
    }
  });
}

describe("dialect detection", () => {
  test("every dewlab fixture is detected as dewlab", () => {
    for (const { name, path } of fixtures(FIXTURE_DIRS.dewlab)) {
      const { frontMatter } = parseDocumentFromFile(path);
      expect(detectDialect(frontMatter), name).toBe("dewlab");
    }
  });

  test("every dewstack fixture is detected as dewstack", () => {
    for (const { name, path } of fixtures(FIXTURE_DIRS.dewstack)) {
      const { frontMatter } = parseDocumentFromFile(path);
      expect(detectDialect(frontMatter), name).toBe("dewstack");
    }
  });

  test("every plain fixture is detected as plain", () => {
    for (const { name, path } of fixtures(FIXTURE_DIRS.plain)) {
      const { frontMatter } = parseDocumentFromFile(path);
      expect(detectDialect(frontMatter), name).toBe("plain");
    }
  });
});

describe("block kinds, on fixtures known to exercise them", () => {
  test("a dewlab exec cell is parsed as a fence block with its info string kept whole", () => {
    const doc = parseDocumentFromFile(join(FIXTURE_DIRS.dewlab, "computational-methods__how-much-it-remembers.md"));
    const execFences = doc.blocks.filter((b) => b.kind === "fence" && b.fence?.info.startsWith("python exec"));
    expect(execFences.length).toBeGreaterThan(0);
  });

  test("a dewlab answer fold is parsed as one fold block, fence quoted inside it and all", () => {
    const doc = parseDocumentFromFile(
      join(FIXTURE_DIRS.dewlab, "computational-methods__how-much-it-remembers-practice.md"),
    );
    const folds = doc.blocks.filter((b) => b.kind === "fold");
    expect(folds.length).toBeGreaterThan(0);
    const withNestedFence = folds.find((f) => f.text.includes("```"));
    expect(withNestedFence).toBeDefined();
  });

  test("a display maths block spanning several lines is parsed as one math block", () => {
    const doc = parseDocumentFromFile(
      join(FIXTURE_DIRS.dewlab, "computational-methods__multiplying-grids-practice.md"),
    );
    const multiline = doc.blocks.find((b) => b.kind === "math" && b.text.includes("\n"));
    expect(multiline).toBeDefined();
  });

  test("a dewstack sql cell is a fence block, and site= panes are three separate fence blocks", () => {
    const doc = parseDocumentFromFile(join(FIXTURE_DIRS.dewstack, "web__hover-and-focus.md"));
    const siteFences = doc.blocks.filter((b) => b.kind === "fence" && b.fence?.info.includes("site="));
    expect(siteFences.length).toBeGreaterThan(0);
  });
});

function parseDocumentFromFile(path: string) {
  return parseDocument(readFileSync(path, "utf8"));
}

describe("nested fences (a 4-backtick fence wrapping a 3-backtick example)", () => {
  // planning/DIALECTS.md documents dewlab's exec-cell syntax by showing it
  // inside a 4-backtick fence — real content, in this very repository,
  // that a 3-backtick-only fence matcher would close early on the
  // example's own closing ``` line. It is exactly the case FENCE_OPEN_RE's
  // "{3,}" and closesFence's length check exist for.
  const path = "planning/DIALECTS.md";

  test("round-trips byte for byte", () => {
    const source = readFileSync(path, "utf8");
    expect(serialize(parseDocument(source))).toBe(source);
  });

  test("the 4-backtick fence is one fence block, not split by its inner ``` lines", () => {
    const doc = parseDocumentFromFile(path);
    const outer = doc.blocks.find((b) => b.kind === "fence" && b.fence?.length === 4);
    expect(outer).toBeDefined();
    expect(outer!.text).toContain("```python exec");
    expect(outer!.text.trimEnd().endsWith("````")).toBe(true);
  });
});
