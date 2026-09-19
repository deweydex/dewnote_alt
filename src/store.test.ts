import { describe, expect, test } from "bun:test";
import { suggestedFilename } from "./store.ts";

describe("suggestedFilename", () => {
  test("prefers slug over title", () => {
    const source = "---\ntitle: My Tutorial\nslug: my-tutorial\n---\n\nBody.\n";
    expect(suggestedFilename(source)).toBe("my-tutorial.md");
  });

  test("falls back to a slugified title when there is no slug", () => {
    const source = "---\ntitle: A Rule and Where It Lives\n---\n\nBody.\n";
    expect(suggestedFilename(source)).toBe("a-rule-and-where-it-lives.md");
  });

  test("falls back to untitled.md with no front matter at all", () => {
    expect(suggestedFilename("# Untitled\n\nBody.\n")).toBe("untitled.md");
  });

  test("falls back to untitled.md when slug and title are both blank", () => {
    const source = "---\nslug: \"\"\n---\n\nBody.\n";
    expect(suggestedFilename(source)).toBe("untitled.md");
  });
});
