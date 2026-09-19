import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isModuleFile,
  parseModuleFile,
  parseModuleFiles,
  parseModuleIndex,
} from "./modules.ts";

// dewlab's own shape, copied from a real module file rather than
// invented: a folded `card:` whose continuation line is indented prose,
// a single-quoted `description:` carrying blank lines, then `contents:`.
// The two prose fields are here specifically so the range assertions
// prove a writer would never touch them.
const MODULE = `title: Programming and Design Principles
code: 5N2927 · QQI Level 5
status: beta
card: This is the programming half of the integrated module, on its own. It runs
  from a first cell to reusable tools, then a project built in a team.
description: 'This module is Programming and Design Principles (5N2927) on its own,
  without the maths.


  Two series carry it.'
contents:
- title: Programming Foundations
  tutorials:
  - first-steps
  - storing-and-computing
- title: Working in a Team
  tutorials:
  - critique-and-reflection
  - the-team-project
`;

describe("isModuleFile", () => {
  test("a module file directly inside current courses/ or legacy modules/", () => {
    expect(isModuleFile("courses/web-authoring.yaml")).toBe(true);
    expect(isModuleFile("some/checkout/courses/web-authoring.yaml")).toBe(true);
    expect(isModuleFile("modules/web-authoring.yaml")).toBe(true);
    expect(isModuleFile("some/checkout/modules/web-authoring.yaml")).toBe(true);
  });

  test("index.yaml and redirects.yaml are not modules", () => {
    expect(isModuleFile("modules/index.yaml")).toBe(false);
    expect(isModuleFile("modules/redirects.yaml")).toBe(false);
    expect(isModuleFile("courses/index.yaml")).toBe(false);
    expect(isModuleFile("courses/redirects.yaml")).toBe(false);
  });

  test("anything else", () => {
    expect(isModuleFile("modules/web-authoring.md")).toBe(false);
    expect(isModuleFile("tutorials/first-steps/first-steps.md")).toBe(false);
    // A yaml file one level deeper isn't a module file.
    expect(isModuleFile("modules/old/web-authoring.yaml")).toBe(false);
    expect(isModuleFile("courses/old/web-authoring.yaml")).toBe(false);
  });

  test("a current Dewlab course descriptor parses as a user-facing module", () => {
    const module = parseModuleFile("courses/computational-methods.yaml", MODULE)!;
    expect(module.id).toBe("computational-methods");
    expect(module.title).toBe("Programming and Design Principles");
  });
});

describe("parseModuleIndex", () => {
  test("reads the order list", () => {
    expect(parseModuleIndex("order:\n- one\n- two\n")).toEqual(["one", "two"]);
  });

  test("empty for anything unreadable, rather than throwing", () => {
    expect(parseModuleIndex("order: [\n")).toEqual([]);
    expect(parseModuleIndex("something-else: true\n")).toEqual([]);
    expect(parseModuleIndex("")).toEqual([]);
  });
});

describe("parseModuleFile", () => {
  test("reads the module, its series and their tutorials in order", () => {
    const module = parseModuleFile("modules/programming-design-principles.yaml", MODULE)!;
    expect(module.id).toBe("programming-design-principles");
    expect(module.title).toBe("Programming and Design Principles");
    expect(module.status).toBe("beta");
    expect(module.contents.map((series) => series.title)).toEqual([
      "Programming Foundations",
      "Working in a Team",
    ]);
    expect(module.contents[0]!.tutorials).toEqual(["first-steps", "storing-and-computing"]);
    expect(module.contents[1]!.tutorials).toEqual(["critique-and-reflection", "the-team-project"]);
  });

  test("each series' range covers exactly its own item lines", () => {
    const module = parseModuleFile("modules/x.yaml", MODULE)!;
    const lines = MODULE.split("\n");

    const first = module.contents[0]!.tutorialsRange!;
    expect(lines.slice(first.start, first.end)).toEqual([
      "  - first-steps",
      "  - storing-and-computing",
    ]);

    const second = module.contents[1]!.tutorialsRange!;
    expect(lines.slice(second.start, second.end)).toEqual([
      "  - critique-and-reflection",
      "  - the-team-project",
    ]);

    // The ranges never reach the prose above them, which is the whole
    // point of scanning for them rather than re-dumping the file.
    expect(lines.slice(0, first.start).join("\n")).toContain("card: This is the programming half");
    expect(lines.slice(0, first.start).join("\n")).toContain("Two series carry it.");
  });

  test("the indent is the one the items actually carry", () => {
    const module = parseModuleFile("modules/x.yaml", MODULE)!;
    expect(module.contents[0]!.indent).toBe("  ");
  });

  test("a series with an empty block list gets an empty range where its first item would go", () => {
    const source = `title: A module
contents:
- title: Nothing yet
  tutorials:
- title: Something
  tutorials:
  - one
`;
    const module = parseModuleFile("modules/x.yaml", source)!;
    const empty = module.contents[0]!;
    expect(empty.tutorials).toEqual([]);
    // Line 3 is `  tutorials:`; an item would go on line 4, so that's
    // where an empty range sits — splicing at the key's own line would
    // put the item above the key it belongs to.
    expect(empty.tutorialsRange).toEqual({ start: 4, end: 4 });
    expect(empty.indent).toBe("  ");
    expect(module.contents[1]!.tutorials).toEqual(["one"]);
  });

  test("a flow list parses but offers no range to write into", () => {
    const source = `title: A module
contents:
- title: Inline
  tutorials: [one, two]
`;
    const module = parseModuleFile("modules/x.yaml", source)!;
    expect(module.contents[0]!.tutorials).toEqual(["one", "two"]);
    expect(module.contents[0]!.tutorialsRange).toBeNull();
  });

  test("null for a file that isn't a module, or one it can't read", () => {
    expect(parseModuleFile("modules/index.yaml", "order:\n- one\n")).toBeNull();
    expect(parseModuleFile("modules/x.yaml", "title: [\n")).toBeNull();
    // No title is the one thing dewlab's read_module fails outright on.
    expect(parseModuleFile("modules/x.yaml", "contents: []\n")).toBeNull();
  });

  test("a module with a title but no contents key at all is read, not refused", () => {
    // read_module maps a missing or empty `contents:` to [] rather than
    // failing, so this file builds. Refusing it here meant dewnote
    // wouldn't show a module dewlab is perfectly happy with — and it is
    // the exact state a module is in before its first series.
    const module = parseModuleFile("modules/x.yaml", "title: A module\n");
    expect(module).not.toBeNull();
    expect(module!.title).toBe("A module");
    expect(module!.contents).toEqual([]);
    // Nothing to append to, though: no `contents:` key means no block.
    expect(module!.contentsRange).toBeNull();
  });
});

describe("parseModuleFiles", () => {
  const files = [
    { path: "modules/b.yaml", content: "title: B\ncontents: []\n" },
    { path: "modules/a.yaml", content: "title: A\ncontents: []\n" },
    { path: "modules/index.yaml", content: "order:\n- a\n- b\n" },
    { path: "tutorials/x/x.md", content: "# not a module\n" },
  ];

  test("keeps only real module files", () => {
    expect(parseModuleFiles(files).map((module) => module.id).sort()).toEqual(["a", "b"]);
  });

  test("orders by index.yaml, with unlisted modules after the listed ones", () => {
    const withExtra = [...files, { path: "modules/c.yaml", content: "title: C\ncontents: []\n" }];
    expect(parseModuleFiles(withExtra, ["b", "a"]).map((module) => module.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });
});

// The real thing, when dewlab is checked out beside this repo — the same
// discipline full-corpus.test.ts uses, and the reason this module was
// read against real files rather than a description of them. Skips
// itself when the sibling isn't there.
const DEWLAB_MODULES = "../dewlab/modules";

describe(`real module files: ${DEWLAB_MODULES}${existsSync(DEWLAB_MODULES) ? "" : " (not checked out — skipped)"}`, () => {
  test.skipIf(!existsSync(DEWLAB_MODULES))(
    "every module file parses, and every series offers a writable range",
    () => {
      const files = readdirSync(DEWLAB_MODULES)
        .filter((name) => name.endsWith(".yaml"))
        .map((name) => ({
          path: `modules/${name}`,
          content: readFileSync(join(DEWLAB_MODULES, name), "utf8"),
        }));
      const indexFile = files.find((file) => file.path === "modules/index.yaml");
      const modules = parseModuleFiles(files, indexFile ? parseModuleIndex(indexFile.content) : []);

      expect(modules.length).toBeGreaterThan(0);
      for (const module of modules) {
        expect(module.contents.length).toBeGreaterThan(0);
        for (const series of module.contents) {
          // Every series dewlab's own migration wrote is in the block
          // form, so every one of them is writable. A null here would
          // mean the scan and js-yaml disagree about a real file.
          expect({
            module: module.id,
            series: series.title,
            range: series.tutorialsRange,
          }).toMatchObject({ range: { start: expect.any(Number), end: expect.any(Number) } });
        }
      }
    },
  );

  test.skipIf(!existsSync(DEWLAB_MODULES))(
    "each range holds exactly the ids parsed for it",
    () => {
      for (const name of readdirSync(DEWLAB_MODULES).filter((one) => one.endsWith(".yaml"))) {
        const content = readFileSync(join(DEWLAB_MODULES, name), "utf8");
        const module = parseModuleFile(`modules/${name}`, content);
        if (!module) continue;
        const lines = content.split("\n");
        for (const series of module.contents) {
          const range = series.tutorialsRange!;
          expect(lines.slice(range.start, range.end)).toEqual(
            series.tutorials.map((id) => `${series.indent}- ${id}`),
          );
        }
      }
    },
  );
});

describe("scanContentsBlock, through parseModuleFile", () => {
  const withMixed = [
    "title: OOP",
    "card: Classes and objects.",
    "contents:",
    "- title: Programming with objects",
    "  tutorials:",
    "  - objects-and-classes",
    "  - one-class-many-methods",
    "mixed:",
    "- mixed-programming-with-objects",
    "",
  ].join("\n");

  test("the block ends where the next top-level key begins, not at the end of the file", () => {
    // Two of dewlab's six real module files carry `mixed:` after
    // `contents:`, so the block genuinely ends mid-file. Appending past
    // it would write a series into the mixed list.
    const module = parseModuleFile("modules/oop.yaml", withMixed)!;
    expect(module.contentsRange).toEqual({ start: 3, end: 7 });
    expect(withMixed.split("\n")[7]).toBe("mixed:");
  });

  test("the entry and inner indents are read, not assumed", () => {
    const module = parseModuleFile("modules/oop.yaml", withMixed)!;
    // The dash sits at column 0 in every real module file, with the
    // `tutorials:` under it indented two.
    expect(module.entryIndent).toBe("");
    expect(module.innerIndent).toBe("  ");
  });

  test("a module whose entries are indented keeps that indent", () => {
    const indented = ["title: A", "contents:", "  - title: One", "    tutorials:", "    - a", ""].join("\n");
    const module = parseModuleFile("modules/a.yaml", indented)!;
    expect(module.entryIndent).toBe("  ");
    expect(module.innerIndent).toBe("  ");
  });

  test("extra spaces after the dash widen the inner indent, because YAML says they do", () => {
    // A mapping under `-` starts at the column after the dash and its
    // spaces, and every later key has to line up with it — so this is
    // measured off the dash rather than assumed to be two.
    const wide = ["title: A", "contents:", "-   title: One", "    tutorials:", "    - a", ""].join("\n");
    const module = parseModuleFile("modules/a.yaml", wide)!;
    expect(module.entryIndent).toBe("");
    expect(module.innerIndent).toBe("    ");
  });

  test("a module with no series yet offers an empty range where the first one goes", () => {
    const empty = ["title: A", "contents:", ""].join("\n");
    const module = parseModuleFile("modules/a.yaml", empty)!;
    expect(module.contents).toEqual([]);
    expect(module.contentsRange).toEqual({ start: 2, end: 2 });
  });

  test("a flow contents list offers no range to append to", () => {
    const flow = ["title: A", "contents: []", ""].join("\n");
    const module = parseModuleFile("modules/a.yaml", flow)!;
    expect(module.contentsRange).toBeNull();
  });
});
