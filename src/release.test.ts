import { describe, expect, test } from "bun:test";
import { nextVersion, prepareRelease } from "./release.ts";

const ORIGINAL = "---\ntitle: First Steps\nyear: \"2026\"\nversion: 2026.09.15.1\n---\n\n# First Steps\n\nOriginal.\n";
const EDITED = ORIGINAL.replace("Original.", "Rewritten.");

describe("nextVersion", () => {
  test("increments an existing release made on the same day", () => {
    expect(nextVersion(["2026.09.16.1", "2026.09.16.3"], new Date(2026, 8, 16))).toBe("2026.09.16.4");
  });
});

describe("prepareRelease", () => {
  test("freezes the committed source and versions the edit at the canonical path", () => {
    const result = prepareRelease(
      "tutorials/first-steps/first-steps.md",
      ORIGINAL,
      EDITED,
      ["2026.09.15.1"],
      new Date(2026, 8, 16),
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.frozenPath).toBe("tutorials/first-steps/v2026.09.15.1.md");
    expect(result.frozenContent).toBe(ORIGINAL);
    expect(result.releasedContent).toContain("version: 2026.09.16.1");
    expect(result.releasedContent).toContain("supersedes: 2026.09.15.1");
    expect(result.releasedContent).toContain("Rewritten.");
  });

  test("refuses an unchanged or non-canonical document", () => {
    const unchanged = prepareRelease("tutorials/first-steps/first-steps.md", ORIGINAL, ORIGINAL, []);
    const misplaced = prepareRelease("notes.md", ORIGINAL, EDITED, []);
    expect("error" in unchanged ? unchanged.error : "").toContain("Nothing");
    expect("error" in misplaced ? misplaced.error : "").toContain("tutorials/<id>/<id>.md");
  });
});
