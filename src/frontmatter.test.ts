import { describe, expect, test } from "bun:test";
import { extractFrontMatter, setFrontMatterField } from "./frontmatter.ts";

const DEWLAB_DOC = `---
title: Filtering rows
slug: filter-evening
module: pandas-basics
module_title: Pandas basics
year: "2026"
series: core
version: 2026.09.04.1
status: live
---

Body text here.
`;

describe("setFrontMatterField", () => {
  test("updates an existing field's value, keeping its quote style", () => {
    const result = setFrontMatterField(DEWLAB_DOC, "title", "Filtering evening rows");
    expect(result).toContain("title: Filtering evening rows\n");
    // Every other line is untouched, byte for byte.
    expect(result).toContain('year: "2026"\n');
    expect(result).toContain("Body text here.\n");
  });

  test("preserves a double-quoted field's quoting when the new value still needs it", () => {
    const result = setFrontMatterField(DEWLAB_DOC, "year", "2027");
    expect(result).toContain('year: "2027"\n');
  });

  test("adds a new optional field just before the closing fence", () => {
    const result = setFrontMatterField(DEWLAB_DOC, "packages", "sympy");
    const front = extractFrontMatter(result);
    expect(front.fields["packages"]).toBe("sympy");
    // Still ends the front matter the same way, and the body is untouched.
    expect(result).toContain("---\n\nBody text here.\n");
  });

  test("clears an existing optional field to empty by removing its line", () => {
    const result = setFrontMatterField(DEWLAB_DOC, "status", "");
    expect(result).not.toContain("status:");
    const front = extractFrontMatter(result);
    expect(front.fields["status"]).toBeUndefined();
  });

  test("clearing a field that was never present is a no-op", () => {
    const result = setFrontMatterField(DEWLAB_DOC, "covers", "");
    expect(result).toBe(DEWLAB_DOC);
  });

  test("setting a field to the value it already has is a no-op, byte for byte", () => {
    const result = setFrontMatterField(DEWLAB_DOC, "title", "Filtering rows");
    expect(result).toBe(DEWLAB_DOC);
  });

  test("quotes a new value that would otherwise read back wrong", () => {
    const result = setFrontMatterField(DEWLAB_DOC, "series", "42");
    expect(result).toContain('series: "42"\n');
    const front = extractFrontMatter(result);
    expect(front.fields["series"]).toBe("42");
  });

  test("does nothing to a document with no front matter", () => {
    const plain = "Just a body, no fence.\n";
    expect(setFrontMatterField(plain, "title", "x")).toBe(plain);
  });

  test("leaves every other line's exact bytes untouched", () => {
    const before = DEWLAB_DOC.split("\n");
    const result = setFrontMatterField(DEWLAB_DOC, "module_title", "Pandas fundamentals");
    const after = result.split("\n");
    for (let i = 0; i < before.length; i++) {
      if (before[i]?.startsWith("module_title:")) continue;
      expect(after[i]).toBe(before[i]);
    }
  });

  test("preserves a single-quoted field's quoting style", () => {
    const doc = "---\ntitle: 'Quoted title'\nslug: x\n---\n\nBody.\n";
    const result = setFrontMatterField(doc, "title", "New title");
    expect(result).toContain("title: 'New title'\n");
  });

  test("round-trips through extractFrontMatter after an edit", () => {
    const result = setFrontMatterField(DEWLAB_DOC, "module", "pandas-advanced");
    const front = extractFrontMatter(result);
    expect(front.present).toBe(true);
    expect(front.fields["module"]).toBe("pandas-advanced");
    expect(front.fields["slug"]).toBe("filter-evening");
  });
});
