// Writing a module file back (src/module-writer.ts through
// src/series-panel.ts) — drag a tutorial within its series, drag it into
// a sibling series, add one, take one off.
//
// Against the fake folder folder-panel.spec.ts established rather than
// through a test hook, because the wiring is most of what could be wrong
// here: series-panel.ts asks active-store.ts, which asks whichever store
// registered itself, which reads and writes a real handle. Every test
// below reads the bytes that actually reached that handle.
//
// The module file carries a folded `card:` and a `description:` that
// runs over two lines on purpose. They are the reason modules.ts records
// line ranges instead of re-dumping the YAML, so every write here is
// checked for having left them exactly as they were.

import { test as base, expect, type Page } from "@playwright/test";
import { selectPanel } from "./panel-helpers.ts";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_APP = "file://" + resolve(HERE, "../../dist/index.html") + "?legacy=1";

const test = base.extend<{ failOnConsoleErrors: void }>({
  failOnConsoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      await use();
      expect(errors, `console/page errors:\n${errors.join("\n")}`).toEqual([]);
    },
    { auto: true },
  ],
});

const MODULE_YAML = [
  "title: Computational Methods",
  "code: 5N0554 · QQI Level 5",
  "card: We work through matrices, simulation, algorithms and debugging, in Python.",
  "description: This module is Computational Methods and Problem Solving (5N0554).",
  "  We work through matrices, simulation, algorithms and debugging, in Python.",
  "contents:",
  "- title: Python fundamentals",
  "  tutorials:",
  "  - first-steps",
  "  - working-with-tables",
  "- title: Matrices",
  "  tutorials:",
  "  - grid-of-numbers",
  "",
].join("\n");

const FLOW_YAML = ["title: Web Authoring", "contents:", "- title: First site", "  tutorials: [a-form]", ""].join("\n");

function tutorial(title: string): string {
  return `---\ntitle: ${title}\nyear: 2026\nversion: 2026.09.01.1\n---\n\n# ${title}\n`;
}

/** The same fake tree folder-panel.spec.ts uses, with a module file
 * worth writing into and four tutorials to move around in it. */
async function stubDirectoryPicker(page: Page) {
  await page.addInitScript(
    ({ module, flow, files }: { module: string; flow: string; files: Record<string, string> }) => {
      const writes: Record<string, string> = {};

      function fakeFileHandle(name: string, content: string) {
        return {
          kind: "file",
          name,
          async getFile() {
            return { text: async () => writes[name] ?? content };
          },
          async createWritable() {
            return {
              async write(next: string) {
                writes[name] = next;
              },
              async close() {},
            };
          },
        };
      }

      function fakeDirHandle(name: string, entries: Record<string, unknown>) {
        return {
          kind: "directory",
          name,
          async *entries() {
            for (const [key, value] of Object.entries(entries)) yield [key, value];
          },
          async getDirectoryHandle(childName: string, options?: { create?: boolean }) {
            let child = entries[childName];
            if (!child) {
              if (!options?.create) throw new Error(`"${childName}" not found`);
              child = fakeDirHandle(childName, {});
              entries[childName] = child;
            }
            return child;
          },
          async getFileHandle(childName: string, options?: { create?: boolean }) {
            let child = entries[childName];
            if (!child) {
              if (!options?.create) throw new Error(`"${childName}" not found`);
              child = fakeFileHandle(childName, "");
              entries[childName] = child;
            }
            return child;
          },
        };
      }

      const tutorialDirs: Record<string, unknown> = {};
      for (const [id, content] of Object.entries(files)) {
        tutorialDirs[id] = fakeDirHandle(id, { [`${id}.md`]: fakeFileHandle(`${id}.md`, content) });
      }

      const root = fakeDirHandle("dewlab", {
        modules: fakeDirHandle("modules", {
          "computational-methods.yaml": fakeFileHandle("computational-methods.yaml", module),
          "web-authoring.yaml": fakeFileHandle("web-authoring.yaml", flow),
        }),
        tutorials: fakeDirHandle("tutorials", tutorialDirs),
      });

      (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = async () => root;
      (window as unknown as { __testWritten(name: string): string | null }).__testWritten = (name) => writes[name] ?? null;
    },
    {
      module: MODULE_YAML,
      flow: FLOW_YAML,
      files: {
        "first-steps": tutorial("First Steps"),
        "working-with-tables": tutorial("Working With Tables"),
        "grid-of-numbers": tutorial("Grid of Numbers"),
        "a-loose-one": tutorial("A Loose One"),
      },
    },
  );
}

/** Opens the folder and then the modules rail, waiting for the index to
 * have caught up — a tutorial's title only appears once the front-matter
 * index has read it, and the rail renders before that finishes. */
async function openRail(page: Page) {
  await selectPanel(page, ".dn-folder-toggle");
  await page.locator(".dn-folder-open").click();
  await expect(page.locator(".dn-folder-status")).toContainText("module files");
  await page.locator(".dn-folder-close").click();
  await selectPanel(page, ".dn-series-toggle");
  await expect(page.locator(".dn-series-block").first().locator(".dn-series-link").first()).toHaveText("First Steps");
}

function written_(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as { __testWritten(name: string): string | null }).__testWritten("computational-methods.yaml"));
}

/** The bytes a write must not touch: everything but the `- id` lines. */
const PROSE = [
  "title: Computational Methods",
  "code: 5N0554 · QQI Level 5",
  "card: We work through matrices, simulation, algorithms and debugging, in Python.",
  "description: This module is Computational Methods and Problem Solving (5N0554).",
  "  We work through matrices, simulation, algorithms and debugging, in Python.",
  "contents:",
  "- title: Python fundamentals",
  "  tutorials:",
  "- title: Matrices",
  "  tutorials:",
];

function prose(content: string): string[] {
  return content.split("\n").filter((line) => !/^\s*-\s+[a-z0-9-]+\s*$/.test(line) && line !== "");
}

test.beforeEach(async ({ page }) => {
  await stubDirectoryPicker(page);
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
});

test("dragging a tutorial up its own series rewrites only the id lines", async ({ page }) => {
  await openRail(page);
  const list = page.locator(".dn-series-list").first();
  await expect(list.locator("li")).toHaveCount(2);

  // Aim at the very top of the first row, so the drop lands before it
  // rather than after — the drop index is read from where the pointer
  // actually is, not from which row it happened to be over.
  await list.locator("li").nth(1).locator(".dn-series-grip").dragTo(list.locator("li").nth(0), { targetPosition: { x: 5, y: 1 } });

  await expect(page.locator(".dn-series-status")).toContainText("Moved Working With Tables");
  const after = await written_(page);
  expect(after).not.toBeNull();
  expect(after).toContain("  tutorials:\n  - working-with-tables\n  - first-steps\n");
  expect(prose(after!)).toEqual(PROSE);
});

test("dragging a tutorial into a sibling series takes it out of one and puts it in the other", async ({ page }) => {
  await openRail(page);
  const matrices = page.locator(".dn-series-list").nth(1);
  await page.locator(".dn-series-list").first().locator("li").nth(0).locator(".dn-series-grip").dragTo(matrices, { targetPosition: { x: 5, y: 1 } });

  await expect(page.locator(".dn-series-status")).toContainText('into "Matrices"');
  const after = await written_(page);
  expect(after).toContain("- title: Python fundamentals\n  tutorials:\n  - working-with-tables\n");
  expect(after).toContain("- title: Matrices\n  tutorials:\n  - first-steps\n  - grid-of-numbers\n");
  expect(prose(after!)).toEqual(PROSE);

  // And the rail redraws from what was written, without reopening it.
  await expect(page.locator(".dn-series-list").first().locator("li")).toHaveCount(1);
  await expect(matrices.locator("li")).toHaveCount(2);
});

test("adding offers only tutorials this module doesn't already list, and lists the one picked", async ({ page }) => {
  await openRail(page);
  await page.locator(".dn-series-add-toggle").first().click();

  // Three of the four indexed tutorials are already on this module, so
  // exactly one is on offer — dewlab's build fails on a module that
  // lists a tutorial twice, so offering one would offer a broken file.
  const offered = page.locator(".dn-series-add-item");
  await expect(offered).toHaveCount(1);
  await expect(offered).toHaveText("A Loose One");
  await offered.click();

  await expect(page.locator(".dn-series-status")).toContainText('Added A Loose One to "Python fundamentals"');
  const after = await written_(page);
  expect(after).toContain("  tutorials:\n  - first-steps\n  - working-with-tables\n  - a-loose-one\n");
  expect(prose(after!)).toEqual(PROSE);
});

test("taking a tutorial off a module unlists it and leaves the file, which turns up under 'On no module'", async ({ page }) => {
  await openRail(page);
  await expect(page.locator(".dn-series-unlisted .dn-series-list li")).toHaveText("A Loose One");

  await page.locator(".dn-series-list").first().locator("li").nth(0).locator(".dn-series-remove").click();

  await expect(page.locator(".dn-series-status")).toContainText("still there, on no module");
  const after = await written_(page);
  expect(after).toContain("- title: Python fundamentals\n  tutorials:\n  - working-with-tables\n");
  expect(after).not.toContain("first-steps");
  expect(prose(after!)).toEqual(PROSE);

  // The index is rebuilt from the folder after the write, so the
  // tutorial reappears where an unplaced tutorial belongs rather than
  // vanishing from the rail entirely.
  await expect(page.locator(".dn-series-unlisted .dn-series-list li")).toHaveText(["First Steps", "A Loose One"]);
});

test.describe("new series", () => {
  test.beforeEach(async ({ page }) => {
    await stubDirectoryPicker(page);
    await page.goto(BUILT_APP);
    await expect(page.locator(".dn-block").first()).toBeVisible();
    await openRail(page);
  });

  test("appends a series with nothing in it, which can then be added to", async ({ page }) => {
    const module = page.locator(".dn-series-module", { hasText: "Computational Methods" });
    await module.locator(".dn-series-add-toggle", { hasText: "New series" }).click();
    await module.locator(".dn-series-new-title").fill("Text Generation");
    await module.locator(".dn-series-new-create").click();

    await expect(page.locator(".dn-series-status")).toContainText("no tutorials yet");
    const written = await written_(page);
    expect(written).toContain("- title: Text Generation\n  tutorials:\n");
    expect(prose(written!)).toEqual([...PROSE, "- title: Text Generation", "  tutorials:"]);

    // It is a real series straight away: shown, and with its own "Add a
    // tutorial" row rather than being read-only until the file is
    // reopened.
    const block = module.locator(".dn-series-block", { hasText: "Text Generation" });
    await expect(block.locator(".dn-series-series-title")).toHaveText("Text Generation");
    await expect(block.locator(".dn-series-add-toggle", { hasText: "Add a tutorial" })).toBeVisible();
  });

  test("a title the module already has, however it is punctuated, is refused rather than written", async ({ page }) => {
    // dewlab's read_module fails the build on two series whose titles
    // normalise the same, so this is the file staying buildable.
    const module = page.locator(".dn-series-module", { hasText: "Computational Methods" });
    await module.locator(".dn-series-add-toggle", { hasText: "New series" }).click();
    await module.locator(".dn-series-new-title").fill("matrices!");
    await module.locator(".dn-series-new-create").click();

    await expect(page.locator(".dn-series-status")).toContainText("the same section");
    expect(await written_(page), "nothing was written").toBeNull();
  });
});

test("a series written as a flow list is shown, and says why it can't be edited here", async ({ page }) => {
  await openRail(page);
  const flowBlock = page.locator(".dn-series-module", { hasText: "Web Authoring" }).locator(".dn-series-block");
  await expect(flowBlock.locator(".dn-series-series-title")).toHaveText("First site");
  await expect(flowBlock.locator(".dn-series-readonly")).toContainText("can't rewrite safely");
  // Shown, opened and read like any other — just not written.
  await expect(flowBlock.locator(".dn-series-list li")).toHaveCount(1);
  await expect(flowBlock.locator(".dn-series-grip")).toHaveCount(0);
  await expect(flowBlock.locator(".dn-series-add-toggle")).toHaveCount(0);
});

test("with no folder or repository open, the rail is read-only rather than offering a drag it couldn't honour", async ({ page }) => {
  await page.evaluate(() => {
    (
      window as unknown as {
        __dewnote: { setModules(modules: unknown[]): void; setFileIndex(index: unknown[]): void };
      }
    ).__dewnote.setModules([
      {
        id: "a-module",
        path: "modules/a-module.yaml",
        title: "A Module",
        contents: [{ title: "A series", tutorials: ["listed"], tutorialsRange: { start: 3, end: 4 }, indent: "  " }],
      },
    ]);
  });

  await selectPanel(page, ".dn-series-toggle");
  await expect(page.locator(".dn-series-list li")).toHaveCount(1);
  await expect(page.locator(".dn-series-grip")).toHaveCount(0);
  await expect(page.locator(".dn-series-remove")).toHaveCount(0);
  await expect(page.locator(".dn-series-add-toggle")).toHaveCount(0);
});
