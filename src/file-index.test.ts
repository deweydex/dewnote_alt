import { describe, expect, test } from "bun:test";
import { parseModuleFile } from "./modules.ts";
import {
  buildFileIndex,
  moduleMembership,
  defaultEntryFor,
  distinctValues,
  idFromPath,
  indexEntryFor,
} from "./file-index.ts";

describe("idFromPath", () => {
  // build.py's own id_of(): the id is the address of the page and the
  // key a reader's saved work lives under, so it comes from where the
  // file is and nothing else.
  test("a tutorial's id is its stem, which is also its folder", () => {
    expect(idFromPath("tutorials/first-steps/first-steps.md")).toBe("first-steps");
  });

  test("a practice page has an id of its own", () => {
    expect(idFromPath("tutorials/first-steps/first-steps-practice.md")).toBe(
      "first-steps-practice",
    );
  });

  test("a frozen release takes the folder's id, not the version file's name", () => {
    expect(idFromPath("tutorials/first-steps/v2026.08.23.1.md")).toBe("first-steps");
  });

  test("a v-name that isn't a real version is a page of its own", () => {
    // `VERSION_FILE_RE` wants a full `vYYYY.MM.DD.N`; anything else is
    // just a file whose name happens to start with v.
    expect(idFromPath("tutorials/first-steps/v9.md")).toBe("v9");
    expect(idFromPath("tutorials/first-steps/visualising.md")).toBe("visualising");
  });

  test("a file with no folder above it still has a stem", () => {
    expect(idFromPath("notes.md")).toBe("notes");
  });
});

describe("indexEntryFor", () => {
  test("derives the id from the path and reads title from front matter", () => {
    const content = "---\ntitle: First Steps\nyear: '2026-2027'\nversion: 2026.08.23.2\n---\n\nBody.\n";
    expect(indexEntryFor("tutorials/first-steps/first-steps.md", content)).toEqual({
      path: "tutorials/first-steps/first-steps.md",
      id: "first-steps",
      title: "First Steps",
      version: "2026.08.23.2",
    });
  });

  test("dewstack's own front-matter placement is still read", () => {
    // dewstack is a separate dialect on its own schedule and still
    // places a tutorial from its front matter.
    const content = "---\ntitle: A Rule\nslug: a-rule\nmodule: data\nseries: intro\n---\n\nBody.\n";
    const entry = indexEntryFor("tutorials/data/a-rule/a-rule.md", content);
    expect(entry.slug).toBe("a-rule");
    expect(entry.module).toBe("data");
    expect(entry.series).toBe("intro");
  });

  test("a file with no front matter still indexes its path and id", () => {
    expect(indexEntryFor("plain.md", "Just prose.\n")).toEqual({ path: "plain.md", id: "plain" });
  });

  test("a non-string field (year: 2026, covers: {}) is left out rather than coerced", () => {
    const content = "---\ntitle: A Rule\nyear: 2026\ncovers: {}\n---\n\nBody.\n";
    const entry = indexEntryFor("a-rule.md", content);
    expect(entry.title).toBe("A Rule");
    expect((entry as unknown as Record<string, unknown>)["year"]).toBeUndefined();
    expect(entry.module).toBeUndefined();
  });

  test("reads dewlab's own status and version fields, when present", () => {
    const content = "---\ntitle: A Rule\nstatus: archived\nversion: 2026.01.02.1\n---\n\nBody.\n";
    const entry = indexEntryFor("tutorials/a-rule/v2026.01.02.1.md", content);
    expect(entry.status).toBe("archived");
    expect(entry.version).toBe("2026.01.02.1");
  });
});

const MODULE = `title: Computational Methods
contents:
- title: Python fundamentals
  tutorials:
  - first-steps
  - working-with-tables
- title: Matrices
  tutorials:
  - grid-of-numbers
`;

const OTHER_MODULE = `title: Programming and Design Principles
contents:
- title: Programming Foundations
  tutorials:
  - first-steps
`;

describe("moduleMembership", () => {
  test("maps each id to the modules that list it", () => {
    const modules = [
      parseModuleFile("modules/computational-methods.yaml", MODULE)!,
      parseModuleFile("modules/programming-design-principles.yaml", OTHER_MODULE)!,
    ];
    const listedBy = moduleMembership(modules);
    // A tutorial can be listed by more than one module — dewlab's own
    // Programming and Design Principles is built from the integrated
    // module's own tutorials.
    expect(listedBy.get("first-steps")).toEqual([
      "computational-methods",
      "programming-design-principles",
    ]);
    expect(listedBy.get("grid-of-numbers")).toEqual(["computational-methods"]);
    expect(listedBy.get("never-listed")).toBeUndefined();
  });

  test("a module listing the same id in two of its series names itself once", () => {
    const twice = `title: A module
contents:
- title: One
  tutorials:
  - shared
- title: Two
  tutorials:
  - shared
`;
    const listedBy = moduleMembership([parseModuleFile("modules/a.yaml", twice)!]);
    expect(listedBy.get("shared")).toEqual(["a"]);
  });
});

describe("buildFileIndex", () => {
  test("indexes every file independently, in the order given", () => {
    const index = buildFileIndex([
      { path: "one.md", content: "---\ntitle: One\n---\n" },
      { path: "two.md", content: "---\ntitle: Two\n---\n" },
    ]);
    expect(index.map((e) => e.title)).toEqual(["One", "Two"]);
  });

  test("with no module files, modules is absent rather than empty", () => {
    // "Nothing was cross-referenced" is a different fact from "cross-
    // referenced, and no module lists this."
    const index = buildFileIndex([{ path: "tutorials/x/x.md", content: "---\ntitle: X\n---\n" }]);
    expect(index[0]!.modules).toBeUndefined();
  });

  test("given module files, each entry carries the modules that list it", () => {
    const modules = [parseModuleFile("modules/computational-methods.yaml", MODULE)!];
    const index = buildFileIndex(
      [
        { path: "tutorials/first-steps/first-steps.md", content: "---\ntitle: First Steps\n---\n" },
        { path: "tutorials/on-no-module/on-no-module.md", content: "---\ntitle: Loose\n---\n" },
      ],
      modules,
    );
    expect(index[0]!.modules).toEqual(["computational-methods"]);
    // Published but on no module — a real, buildable state.
    expect(index[1]!.modules).toEqual([]);
  });

  test("a frozen release is listed by the same modules as its live file", () => {
    const modules = [parseModuleFile("modules/computational-methods.yaml", MODULE)!];
    const index = buildFileIndex(
      [{ path: "tutorials/first-steps/v2026.08.23.1.md", content: "---\ntitle: Frozen\n---\n" }],
      modules,
    );
    expect(index[0]!.modules).toEqual(["computational-methods"]);
  });

  test("a focused practice page inherits its tutorial's module", () => {
    const modules = [parseModuleFile("modules/computational-methods.yaml", MODULE)!];
    const index = buildFileIndex(
      [{
        path: "tutorials/first-steps/first-steps-practice.md",
        content: "---\ntitle: Practice\npractice_for: first-steps\n---\n",
      }],
      modules,
    );
    expect(index[0]!.practiceFor).toBe("first-steps");
    expect(index[0]!.modules).toEqual(["computational-methods"]);
  });

  test("mixed practice is placed by a module's top-level mixed list", () => {
    const source = `${MODULE}mixed:\n- cumulative-practice\n`;
    const modules = [parseModuleFile("modules/computational-methods.yaml", source)!];
    expect(moduleMembership(modules).get("cumulative-practice")).toEqual(["computational-methods"]);
    const index = buildFileIndex(
      [{
        path: "tutorials/cumulative-practice/cumulative-practice.md",
        content: "---\ntitle: Cumulative practice\npractice_across:\n- first-steps\n- working-with-tables\n---\n",
      }],
      modules,
    );
    expect(index[0]!.modules).toEqual(["computational-methods"]);
  });
});

describe("distinctValues", () => {
  test("collects every distinct module name, sorted, once each", () => {
    const index = buildFileIndex([
      { path: "a.md", content: "---\nmodule: computational-methods\n---\n" },
      { path: "b.md", content: "---\nmodule: data-wrangling\n---\n" },
      { path: "c.md", content: "---\nmodule: computational-methods\n---\n" },
      { path: "d.md", content: "No front matter.\n" },
    ]);
    expect(distinctValues(index, "module")).toEqual(["computational-methods", "data-wrangling"]);
  });

  // decision 33: practice_for's own datalist — unlike dewstack's
  // module/series, an id already names one page on its own, so "distinct"
  // here just means "every real id this index has," not "every value more
  // than one file shares."
  test("collects every real id, sorted, when asked for id", () => {
    const index = buildFileIndex([
      { path: "tutorials/filter-evening/filter-evening.md", content: "---\ntitle: Evening\n---\n" },
      { path: "tutorials/filter-morning/filter-morning.md", content: "---\ntitle: Morning\n---\n" },
    ]);
    expect(distinctValues(index, "id")).toEqual(["filter-evening", "filter-morning"]);
  });

  test("a frozen release contributes its tutorial's id, not a second one", () => {
    const index = buildFileIndex([
      { path: "tutorials/first-steps/first-steps.md", content: "---\ntitle: Live\n---\n" },
      { path: "tutorials/first-steps/v2026.08.23.1.md", content: "---\ntitle: Frozen\n---\n" },
    ]);
    expect(distinctValues(index, "id")).toEqual(["first-steps"]);
  });
});

describe("defaultEntryFor", () => {
  // Every file here sits in `tutorials/a-rule/`, so they all carry the
  // id `a-rule` — a live file and the frozen releases beside it, which
  // is the real shape dewlab's tree has and the reason this function
  // survives the move to site-wide ids.
  function entry(
    fileName: string,
    extra: Partial<{ title: string; status: string; version: string }>,
  ): { path: string; content: string } {
    const yaml = Object.entries(extra)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
    return { path: `tutorials/a-rule/${fileName}`, content: `---\n${yaml}\n---\n` };
  }

  test("a single matching entry is returned outright", () => {
    const index = buildFileIndex([entry("a-rule.md", { title: "A Rule" })]);
    expect(defaultEntryFor(index, "a-rule")?.title).toBe("A Rule");
  });

  test("no matching id returns undefined", () => {
    expect(
      defaultEntryFor(buildFileIndex([entry("a-rule.md", { title: "A Rule" })]), "missing"),
    ).toBeUndefined();
  });

  test("among several versions, the newest live one wins over an older live one", () => {
    const index = buildFileIndex([
      entry("v2026.01.01.1.md", { title: "Older", status: "live", version: "2026.01.01.1" }),
      entry("v2026.06.01.1.md", { title: "Newer", status: "live", version: "2026.06.01.1" }),
    ]);
    expect(defaultEntryFor(index, "a-rule")?.title).toBe("Newer");
  });

  test("live outranks archived regardless of version dates", () => {
    const index = buildFileIndex([
      entry("v2026.06.01.1.md", {
        title: "Archived but newer",
        status: "archived",
        version: "2026.06.01.1",
      }),
      entry("v2026.01.01.1.md", {
        title: "Live but older",
        status: "live",
        version: "2026.01.01.1",
      }),
    ]);
    expect(defaultEntryFor(index, "a-rule")?.title).toBe("Live but older");
  });

  test("with no live version at all, the newest version regardless of status wins", () => {
    const index = buildFileIndex([
      entry("v2026.01.01.1.md", {
        title: "Older archived",
        status: "archived",
        version: "2026.01.01.1",
      }),
      entry("v2026.06.01.1.md", { title: "Newer beta", status: "beta", version: "2026.06.01.1" }),
    ]);
    expect(defaultEntryFor(index, "a-rule")?.title).toBe("Newer beta");
  });

  test("no status field at all is treated as live, dewlab's own default", () => {
    const index = buildFileIndex([
      entry("v2026.06.01.1.md", { title: "A draft", status: "draft", version: "2026.06.01.1" }),
      entry("a-rule.md", { title: "No status field" }),
    ]);
    expect(defaultEntryFor(index, "a-rule")?.title).toBe("No status field");
  });

  test("a two-digit version number correctly outranks a one-digit one, not lexicographically", () => {
    const index = buildFileIndex([
      entry("v2026.01.01.9.md", {
        title: "Ninth release",
        status: "live",
        version: "2026.01.01.9",
      }),
      entry("v2026.01.01.10.md", {
        title: "Tenth release",
        status: "live",
        version: "2026.01.01.10",
      }),
    ]);
    expect(defaultEntryFor(index, "a-rule")?.title).toBe("Tenth release");
  });
});
