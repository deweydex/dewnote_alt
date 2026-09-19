// Not part of `bun test`'s default run — a heavier stress pass over every
// tutorial in dewlab and dewstack, not just the sampled fixtures/ folder,
// run by hand (or in CI later) with the sibling repos checked out next to
// this one. Skips itself silently when they aren't there, since a fresh
// clone of this repo alone has no reason to fail a test that needs paths
// outside it.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, serialize } from "./blocks.ts";

function findMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...findMarkdownFiles(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

const SIBLINGS = ["../dewlab/tutorials", "../dewstack/tutorials"];

for (const dir of SIBLINGS) {
  const present = existsSync(dir);
  describe(`full corpus: ${dir}${present ? "" : " (not checked out — skipped)"}`, () => {
    test.skipIf(!present)("every tutorial markdown file round-trips byte for byte", () => {
      const files = findMarkdownFiles(dir);
      expect(files.length).toBeGreaterThan(0);
      const failures: string[] = [];
      for (const path of files) {
        const source = readFileSync(path, "utf8");
        const doc = parseDocument(source);
        if (serialize(doc) !== source) failures.push(path);
      }
      expect(failures).toEqual([]);
    });
  });
}
