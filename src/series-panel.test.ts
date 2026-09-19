// The pure part of the placement rail — which indexed tutorials count as
// "on no module". The DOM half (grouping by module, opening a listed
// tutorial, naming an id with no file) is covered against the built app
// in tests/e2e/series-panel.spec.ts, the same split outline-panel.ts
// uses. Unlike that one, this imports the real function rather than
// restating it: a test that re-implements what it checks proves nothing
// about the code that ships.

import { describe, expect, test } from "bun:test";
import type { FileIndexEntry } from "./file-index.ts";
import { tutorialsOnNoModule } from "./series-panel.ts";

describe("tutorialsOnNoModule", () => {
  test("an indexed tutorial no module lists", () => {
    const index: FileIndexEntry[] = [
      { path: "tutorials/listed/listed.md", id: "listed", title: "Listed", modules: ["a"] },
      { path: "tutorials/loose/loose.md", id: "loose", title: "Loose", modules: [] },
    ];
    expect(tutorialsOnNoModule(index).map((e) => e.id)).toEqual(["loose"]);
  });

  test("an entry never cross-referenced is not reported", () => {
    // `modules` undefined means no module files were read at all — a
    // folder with no modules/ directory shouldn't report every tutorial
    // in it as unplaced.
    const index: FileIndexEntry[] = [
      { path: "tutorials/loose/loose.md", id: "loose", title: "Loose" },
    ];
    expect(tutorialsOnNoModule(index)).toEqual([]);
  });

  test("a file outside tutorials/ is not a tutorial to place", () => {
    const index: FileIndexEntry[] = [
      { path: "notes.md", id: "notes", title: "Notes", modules: [] },
      { path: "pages/about.md", id: "about", title: "About", modules: [] },
    ];
    expect(tutorialsOnNoModule(index)).toEqual([]);
  });

  test("a tutorial with several files reports once, as the file the build would serve", () => {
    // A frozen release carries its folder's id, so both files are "on no
    // module" — but they are one page, and the live one is the one to
    // show and open.
    const index: FileIndexEntry[] = [
      {
        path: "tutorials/first-steps/v2026.01.01.1.md",
        id: "first-steps",
        title: "Old title",
        status: "archived",
        version: "2026.01.01.1",
        modules: [],
      },
      {
        path: "tutorials/first-steps/first-steps.md",
        id: "first-steps",
        title: "First Steps",
        status: "live",
        version: "2026.06.01.1",
        modules: [],
      },
    ];
    const found = tutorialsOnNoModule(index);
    expect(found).toHaveLength(1);
    expect(found[0]!.title).toBe("First Steps");
    expect(found[0]!.path).toBe("tutorials/first-steps/first-steps.md");
  });

  test("a focused practice page follows its tutorial rather than becoming loose content", () => {
    const index: FileIndexEntry[] = [
      {
        path: "tutorials/first-steps/first-steps.md",
        id: "first-steps",
        title: "First Steps",
        modules: ["a"],
      },
      {
        path: "tutorials/first-steps/first-steps-practice.md",
        id: "first-steps-practice",
        title: "First Steps — Practice",
        practiceFor: "first-steps",
        modules: [],
      },
    ];
    expect(tutorialsOnNoModule(index)).toEqual([]);
  });
});
