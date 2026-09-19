// The splice itself, and the three things a reader does with it. The
// property that matters most in every one of these is what *didn't*
// change: a module file's prose is student-facing text on dewlab's front
// page, and the whole reason modules.ts records line ranges is that a
// round trip through a YAML dumper would refold and requote it.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseModuleFile, type Module } from "./modules.ts";
import { addSeries, addTutorial, idsListedBy, moveSeries, moveTutorial, renameSeries, removeTutorial, seriesKey, writeModuleFile } from "./module-writer.ts";

/** A module file shaped like dewlab's real ones: a folded `card:`, a
 * `description:` that runs over two lines, and series whose items carry
 * the same indent as their own key. */
const MODULE = [
  "title: Computational Methods",
  "code: 5N0554 · QQI Level 5",
  "status: beta",
  "card: We work through matrices, simulation, algorithms and debugging, in Python.",
  "description: This module is Computational Methods and Problem Solving (5N0554).",
  "  We work through matrices, simulation, algorithms and debugging, in Python.",
  "contents:",
  "- title: Python fundamentals",
  "  tutorials:",
  "  - first-steps-cm",
  "  - working-with-tables",
  "- title: Matrices",
  "  tutorials:",
  "  - grid-of-numbers",
  "  - multiplying-grids",
  "  - undoing-it",
  "",
].join("\n");

function module(content = MODULE, path = "modules/computational-methods.yaml"): Module {
  const parsed = parseModuleFile(path, content);
  if (!parsed) throw new Error("fixture no longer parses");
  return parsed;
}

function expectOk(result: { ok: boolean } & Record<string, unknown>): string {
  expect(result.ok, `refused: ${String(result["reason"] ?? "")}`).toBe(true);
  return result["content"] as string;
}

/** Everything in the file except the lines under a `tutorials:` key —
 * the bytes a write is supposed to leave alone. */
function prose(content: string): string[] {
  const lines = content.split("\n");
  const kept: string[] = [];
  let inList = false;
  for (const line of lines) {
    if (/^\s*tutorials\s*:\s*$/.test(line)) {
      inList = true;
      kept.push(line);
      continue;
    }
    if (inList) {
      if (/^\s*-\s+\S+\s*$/.test(line)) continue;
      inList = false;
    }
    kept.push(line);
  }
  return kept;
}

describe("writeModuleFile", () => {
  test("a reordered series rewrites its own lines and nothing else", () => {
    const one = module();
    const written = expectOk(writeModuleFile(MODULE, [{ series: one.contents[1]!, tutorials: ["undoing-it", "grid-of-numbers", "multiplying-grids"] }]));

    expect(module(written).contents[1]!.tutorials).toEqual(["undoing-it", "grid-of-numbers", "multiplying-grids"]);
    // The folded card, the two-line description and the other series all
    // come back byte for byte.
    expect(prose(written)).toEqual(prose(MODULE));
    expect(module(written).contents[0]!.tutorials).toEqual(["first-steps-cm", "working-with-tables"]);
  });

  test("two series in one file are both written, and neither shifts the other", () => {
    const one = module();
    // The first series grows by one line and the second shrinks by two,
    // so a top-down splice would write the second one into the wrong
    // place entirely.
    const written = expectOk(
      writeModuleFile(MODULE, [
        { series: one.contents[0]!, tutorials: ["first-steps-cm", "working-with-tables", "a-third"] },
        { series: one.contents[1]!, tutorials: ["undoing-it"] },
      ]),
    );

    const after = module(written);
    expect(after.contents[0]!.tutorials).toEqual(["first-steps-cm", "working-with-tables", "a-third"]);
    expect(after.contents[1]!.tutorials).toEqual(["undoing-it"]);
    expect(prose(written)).toEqual(prose(MODULE));
  });

  test("emptying a series leaves a bare tutorials: key, which reads back as an empty series", () => {
    // dewlab's own read_module() maps a `tutorials:` with nothing under
    // it to [], so removing the last tutorial from a series is a real
    // state rather than a file that stops building.
    const one = module();
    const written = expectOk(writeModuleFile(MODULE, [{ series: one.contents[1]!, tutorials: [] }]));

    expect(written).toContain("- title: Matrices\n  tutorials:\n");
    const after = module(written);
    expect(after.contents[1]!.tutorials).toEqual([]);
    // And the now-empty range can be written into again.
    const refilled = expectOk(writeModuleFile(written, [{ series: after.contents[1]!, tutorials: ["back-again"] }]));
    expect(module(refilled).contents[1]!.tutorials).toEqual(["back-again"]);
  });

  test("writing no edits at all returns the file untouched", () => {
    expect(expectOk(writeModuleFile(MODULE, []))).toBe(MODULE);
  });

  test("a series with no writable range is refused, and nothing is written", () => {
    const flow = MODULE.replace("  tutorials:\n  - grid-of-numbers\n  - multiplying-grids\n  - undoing-it\n", "  tutorials: [grid-of-numbers, undoing-it]\n");
    const one = module(flow);
    expect(one.contents[1]!.tutorialsRange).toBeNull();

    const result = writeModuleFile(flow, [{ series: one.contents[1]!, tutorials: ["undoing-it"] }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Matrices");
  });

  test("two edits to the same series are refused rather than applied twice", () => {
    const one = module();
    const result = writeModuleFile(MODULE, [
      { series: one.contents[0]!, tutorials: ["a"] },
      { series: one.contents[0]!, tutorials: ["b"] },
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("moveTutorial", () => {
  test("within a series, an index is read against the list with the tutorial already taken out", () => {
    // "working-with-tables" is at 1 of 2; dragging it to the front is
    // index 0, and the list it lands in is the one-item list left behind.
    const written = expectOk(moveTutorial(module(), MODULE, { series: 0, index: 1 }, { series: 0, index: 0 }));
    expect(module(written).contents[0]!.tutorials).toEqual(["working-with-tables", "first-steps-cm"]);
  });

  test("dragging the middle of three to the end lands it last, not second", () => {
    const written = expectOk(moveTutorial(module(), MODULE, { series: 1, index: 1 }, { series: 1, index: 2 }));
    expect(module(written).contents[1]!.tutorials).toEqual(["grid-of-numbers", "undoing-it", "multiplying-grids"]);
  });

  test("a drag into a sibling series takes it out of one and puts it in the other, in one write", () => {
    const written = expectOk(moveTutorial(module(), MODULE, { series: 1, index: 0 }, { series: 0, index: 1 }));
    const after = module(written);
    expect(after.contents[0]!.tutorials).toEqual(["first-steps-cm", "grid-of-numbers", "working-with-tables"]);
    expect(after.contents[1]!.tutorials).toEqual(["multiplying-grids", "undoing-it"]);
    expect(prose(written)).toEqual(prose(MODULE));
  });

  test("dropping past the end of a series lands at the end rather than refusing", () => {
    const written = expectOk(moveTutorial(module(), MODULE, { series: 1, index: 0 }, { series: 0, index: 99 }));
    expect(module(written).contents[0]!.tutorials).toEqual(["first-steps-cm", "working-with-tables", "grid-of-numbers"]);
  });

  test("a stale index — the module changed underneath — is refused, not written at a guess", () => {
    const result = moveTutorial(module(), MODULE, { series: 1, index: 7 }, { series: 1, index: 0 });
    expect(result.ok).toBe(false);
    const gone = moveTutorial(module(), MODULE, { series: 9, index: 0 }, { series: 0, index: 0 });
    expect(gone.ok).toBe(false);
  });
});

describe("addTutorial", () => {
  test("adds at a position, or at the end when none is given", () => {
    const atEnd = expectOk(addTutorial(module(), MODULE, 0, "new-one"));
    expect(module(atEnd).contents[0]!.tutorials).toEqual(["first-steps-cm", "working-with-tables", "new-one"]);

    const atFront = expectOk(addTutorial(module(), MODULE, 0, "new-one", 0));
    expect(module(atFront).contents[0]!.tutorials).toEqual(["new-one", "first-steps-cm", "working-with-tables"]);
  });

  test("an id the module already lists elsewhere is refused, and the reason names where it sits", () => {
    // dewlab's read_module() fails the build on this — "A tutorial sits
    // in one place on a module" — so writing it would hand somebody a
    // file that no longer builds.
    const result = addTutorial(module(), MODULE, 0, "undoing-it");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Matrices");
      expect(result.reason).toContain("undoing-it");
    }
  });

  test("adding to an empty series works, since its range is a real empty range", () => {
    const emptied = expectOk(writeModuleFile(MODULE, [{ series: module().contents[1]!, tutorials: [] }]));
    const written = expectOk(addTutorial(module(emptied), emptied, 1, "first-one"));
    expect(module(written).contents[1]!.tutorials).toEqual(["first-one"]);
  });
});

describe("removeTutorial", () => {
  test("unlists one tutorial and leaves the rest in order", () => {
    const written = expectOk(removeTutorial(module(), MODULE, 1, "multiplying-grids"));
    expect(module(written).contents[1]!.tutorials).toEqual(["grid-of-numbers", "undoing-it"]);
    expect(prose(written)).toEqual(prose(MODULE));
  });

  test("removing the only tutorial leaves the series, not a hole in the file", () => {
    const one = expectOk(removeTutorial(module(), MODULE, 0, "first-steps-cm"));
    const two = expectOk(removeTutorial(module(one), one, 0, "working-with-tables"));
    const after = module(two);
    expect(after.contents).toHaveLength(2);
    expect(after.contents[0]!.title).toBe("Python fundamentals");
    expect(after.contents[0]!.tutorials).toEqual([]);
  });

  test("an id the series doesn't list is refused", () => {
    const result = removeTutorial(module(), MODULE, 0, "undoing-it");
    expect(result.ok).toBe(false);
  });
});

describe("idsListedBy", () => {
  test("every id on the module, across its series", () => {
    expect([...idsListedBy(module())].sort()).toEqual(["first-steps-cm", "grid-of-numbers", "multiplying-grids", "undoing-it", "working-with-tables"]);
  });
});

describe("seriesKey", () => {
  test("dewlab's own normalisation, which is what makes two titles collide", () => {
    expect(seriesKey("Python fundamentals")).toBe("python-fundamentals");
    expect(seriesKey("Python  Fundamentals!")).toBe("python-fundamentals");
    expect(seriesKey("  Matrices  ")).toBe("matrices");
    expect(seriesKey("!!!")).toBe("");
  });
});

describe("addSeries", () => {
  test("appends to the end of contents:, with an empty tutorials key ready to drop into", () => {
    const written = expectOk(addSeries(module(), MODULE, "Text Generation"));
    const after = module(written);
    expect(after.contents.map((s) => s.title)).toEqual(["Python fundamentals", "Matrices", "Text Generation"]);
    expect(after.contents[2]!.tutorials).toEqual([]);
    // An empty block key, not `tutorials: []` — a flow list is exactly
    // what modules.ts refuses to rewrite, so writing one would hand back
    // a series nothing could ever be dragged into.
    expect(written).toContain("- title: Text Generation\n  tutorials:\n");
    expect(after.contents[2]!.tutorialsRange).not.toBeNull();
    // And the prose above is untouched, as always.
    expect(prose(written).slice(0, 6)).toEqual(prose(MODULE).slice(0, 6));
  });

  test("the new series can be added to immediately", () => {
    const written = expectOk(addSeries(module(), MODULE, "Text Generation"));
    const filled = expectOk(addTutorial(module(written), written, 2, "a-chain-reads-a-book"));
    expect(module(filled).contents[2]!.tutorials).toEqual(["a-chain-reads-a-book"]);
  });

  test("a title that normalises to one the module already has is refused, and the reason names it", () => {
    // dewlab's read_module fails the build on two series whose keys
    // match, so a near-duplicate is as broken as an exact one — and far
    // harder to spot by eye.
    const exact = addSeries(module(), MODULE, "Matrices");
    expect(exact.ok).toBe(false);
    if (!exact.ok) expect(exact.reason).toContain("already has a series called");

    const near = addSeries(module(), MODULE, "matrices!");
    expect(near.ok).toBe(false);
    if (!near.ok) {
      expect(near.reason).toContain("Matrices");
      expect(near.reason).toContain("the same section");
    }
  });

  test("a blank title, or one with no letters or digits, is refused", () => {
    expect(addSeries(module(), MODULE, "   ").ok).toBe(false);
    const punctuation = addSeries(module(), MODULE, "!!!");
    expect(punctuation.ok).toBe(false);
    if (!punctuation.ok) expect(punctuation.reason).toContain("no letters or digits");
  });

  test("a module written as a flow list offers nowhere to append, and says so", () => {
    const flow = "title: A module\ncontents: []\n";
    const parsed = parseModuleFile("modules/a.yaml", flow)!;
    expect(parsed.contentsRange).toBeNull();
    const result = addSeries(parsed, flow, "Anything");
    expect(result.ok).toBe(false);
  });

  test("a module with more keys after contents: gets the series before them, not after", () => {
    // Two of dewlab's six real module files carry `mixed:` after
    // `contents:`. Appending past it would put a series into the mixed
    // problem-set list, which dewlab reads as a list of ids.
    const withMixed = [
      "title: OOP",
      "contents:",
      "- title: Programming with objects",
      "  tutorials:",
      "  - objects-and-classes",
      "mixed:",
      "- mixed-programming-with-objects",
      "",
    ].join("\n");
    const written = expectOk(addSeries(parseModuleFile("modules/oop.yaml", withMixed)!, withMixed, "Inheritance"));
    expect(written).toBe(
      [
        "title: OOP",
        "contents:",
        "- title: Programming with objects",
        "  tutorials:",
        "  - objects-and-classes",
        "- title: Inheritance",
        "  tutorials:",
        "mixed:",
        "- mixed-programming-with-objects",
        "",
      ].join("\n"),
    );
  });

  test("a module with no series yet takes its first one", () => {
    const empty = "title: A module\ncontents:\n";
    const written = expectOk(addSeries(parseModuleFile("modules/a.yaml", empty)!, empty, "Getting started"));
    expect(module(written, "modules/a.yaml").contents.map((s) => s.title)).toEqual(["Getting started"]);
  });
});

describe("editing series", () => {
  test("moves a complete series, including its tutorials, without touching descriptor prose", () => {
    const written = expectOk(moveSeries(module(), MODULE, 1, 0));
    const after = module(written);
    expect(after.contents.map((series) => series.title)).toEqual(["Matrices", "Python fundamentals"]);
    expect(after.contents[0]!.tutorials).toEqual(["grid-of-numbers", "multiplying-grids", "undoing-it"]);
    expect(written.split("\n").slice(0, 7)).toEqual(MODULE.split("\n").slice(0, 7));
  });

  test("renames one series with YAML-safe quoting and keeps its tutorial list", () => {
    const written = expectOk(renameSeries(module(), MODULE, 0, "Python: first steps"));
    const after = module(written);
    expect(after.contents[0]!.title).toBe("Python: first steps");
    expect(after.contents[0]!.tutorials).toEqual(["first-steps-cm", "working-with-tables"]);
  });

  test("refuses a renamed series that collides after dewlab normalises it", () => {
    expect(renameSeries(module(), MODULE, 0, "matrices!").ok).toBe(false);
  });
});

// The same property against dewlab's real module files, which is where
// the folded scalars and the wrapped single-quoted prose actually live.
// Skipped when there's no sibling checkout, the same shape modules.test.ts
// and full-corpus.test.ts both use — the directory is read inside each
// test body rather than in the describe callback, which bun evaluates
// even for a describe every test in it is skipped in.
const DEWLAB_MODULES = "../dewlab/modules";
const havePath = () => existsSync(DEWLAB_MODULES);

function moduleFilesOnDisk(): { path: string; content: string }[] {
  return readdirSync(DEWLAB_MODULES)
    .filter((name) => name.endsWith(".yaml") && name !== "index.yaml" && name !== "redirects.yaml")
    .map((name) => ({ path: `modules/${name}`, content: readFileSync(join(DEWLAB_MODULES, name), "utf-8") }));
}

describe(`real module files: ${DEWLAB_MODULES}${havePath() ? "" : " (not checked out — skipped)"}`, () => {
  test.skipIf(!havePath())("reversing every series in a real module rewrites only the id lines", () => {
    const files = moduleFilesOnDisk();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const parsed = parseModuleFile(file.path, file.content);
      expect(parsed, file.path).not.toBeNull();
      const edits = parsed!.contents.map((series) => ({ series, tutorials: [...series.tutorials].reverse() }));
      const written = expectOk(writeModuleFile(file.content, edits));

      // Same number of lines, same everything that isn't an id.
      expect(written.split("\n"), file.path).toHaveLength(file.content.split("\n").length);
      expect(prose(written), file.path).toEqual(prose(file.content));

      const after = parseModuleFile(file.path, written);
      expect(after, file.path).not.toBeNull();
      for (const [at, series] of parsed!.contents.entries()) {
        expect(after!.contents[at]!.tutorials, `${file.path} — ${series.title}`).toEqual([...series.tutorials].reverse());
      }
    }
  });

  test.skipIf(!havePath())("a series appended to every real module lands inside contents:, and nothing else moves", () => {
    for (const file of moduleFilesOnDisk()) {
      const parsed = parseModuleFile(file.path, file.content)!;
      expect(parsed.contentsRange, `${file.path} offers somewhere to append`).not.toBeNull();

      const written = expectOk(addSeries(parsed, file.content, "A Brand New Series"));
      const after = parseModuleFile(file.path, written)!;

      // Last, and empty.
      expect(after.contents.map((s) => s.title).slice(-1), file.path).toEqual(["A Brand New Series"]);
      expect(after.contents[after.contents.length - 1]!.tutorials, file.path).toEqual([]);
      // Every series that was there is unchanged, in order.
      expect(after.contents.slice(0, -1).map((s) => s.title), file.path).toEqual(parsed.contents.map((s) => s.title));
      for (const [at, series] of parsed.contents.entries()) {
        expect(after.contents[at]!.tutorials, `${file.path} — ${series.title}`).toEqual(series.tutorials);
      }
      // The strongest form of "nothing else moved": take out the two
      // lines it added and the file is what it was, byte for byte —
      // including `mixed:`, which two of these files carry after
      // `contents:`, and every folded and quoted scalar above.
      const lines = written.split("\n");
      const at = lines.indexOf("- title: A Brand New Series");
      expect(at, `${file.path}: the entry was written at the module's own indent`).toBeGreaterThan(-1);
      expect(lines[at + 1], file.path).toBe("  tutorials:");
      lines.splice(at, 2);
      expect(lines.join("\n"), file.path).toBe(file.content);
    }
  });

  test.skipIf(!havePath())("a mixed: key after contents: still follows the new series, not precedes it", () => {
    const withMixed = moduleFilesOnDisk().filter((file) => /^mixed:/m.test(file.content));
    expect(withMixed.length, "dewlab has module files with a mixed: key").toBeGreaterThan(0);
    for (const file of withMixed) {
      const written = expectOk(addSeries(parseModuleFile(file.path, file.content)!, file.content, "Appended"));
      const lines = written.split("\n");
      const newSeries = lines.findIndex((line) => line.includes("- title: Appended"));
      const mixed = lines.findIndex((line) => /^mixed:/.test(line));
      expect(newSeries, file.path).toBeGreaterThan(-1);
      expect(newSeries, `${file.path}: the series sits before mixed:`).toBeLessThan(mixed);
    }
  });

  test.skipIf(!havePath())("reversing twice is the file it started as, byte for byte", () => {
    const files = moduleFilesOnDisk();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const reversed = (content: string) =>
        expectOk(writeModuleFile(content, parseModuleFile(file.path, content)!.contents.map((series) => ({ series, tutorials: [...series.tutorials].reverse() }))));
      expect(reversed(reversed(file.content)), file.path).toBe(file.content);
    }
  });
});
