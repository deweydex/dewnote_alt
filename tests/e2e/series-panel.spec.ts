// The placement view (src/modules.ts, src/series-panel.ts) — drives the
// real built app: seed module data and a file index the same way
// link-picker.spec.ts and link-check.spec.ts do, open the rail, and check
// it groups by module then series, keeps each module file's own order,
// prefers an indexed title over a bare id, and names both halves of a
// placement that doesn't line up.

import { test as base, expect } from "@playwright/test";
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

type IndexEntry = {
  path: string;
  id?: string;
  title?: string;
  status?: string;
  version?: string;
  modules?: string[];
};
type ModuleSeed = {
  id: string;
  path: string;
  title: string;
  contents: { title: string; tutorials: string[]; tutorialsRange: null; indent: string }[];
};
type TestHook = {
  setFileIndex(index: IndexEntry[]): void;
  setModules(modules: ModuleSeed[]): void;
};

test.beforeEach(async ({ page }) => {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
});

test("groups by module then series, in the module file's own order, preferring an indexed title over the bare id", async ({ page }) => {
  await page.evaluate(() => {
    const hook = window as unknown as { __dewnote: TestHook };
    hook.__dewnote.setFileIndex([
      {
        path: "tutorials/first-steps/first-steps.md",
        id: "first-steps",
        title: "First Steps",
        modules: ["computational-methods"],
      },
    ]);
    hook.__dewnote.setModules([
      {
        id: "computational-methods",
        path: "modules/computational-methods.yaml",
        title: "Computational Methods",
        contents: [
          {
            title: "Python fundamentals",
            tutorials: ["first-steps", "working-with-tables"],
            tutorialsRange: null,
            indent: "  ",
          },
        ],
      },
    ]);
  });

  await selectPanel(page, ".dn-series-toggle");
  await expect(page.locator(".dn-series-module-title")).toHaveText("Computational Methods");
  await expect(page.locator(".dn-series-series-title")).toHaveText("Python fundamentals");

  const items = page.locator(".dn-series-list li");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveText("First Steps");
  // A module listing an id with no file behind it — dewlab's own build
  // stops on this, so the panel names it rather than showing a bare id.
  await expect(items.nth(1)).toHaveText("working-with-tables — no file");
});

test("with several versions of one tutorial indexed, the list shows the live one's title", async ({ page }) => {
  await page.evaluate(() => {
    const hook = window as unknown as { __dewnote: TestHook };
    // A frozen release carries the id of the folder it sits in, the same
    // as the live file beside it — so an id is still several files.
    hook.__dewnote.setFileIndex([
      {
        path: "tutorials/filtering/v2026.01.01.1.md",
        id: "filtering",
        title: "Filtering (old draft title)",
        status: "archived",
        version: "2026.01.01.1",
        modules: ["data"],
      },
      {
        path: "tutorials/filtering/filtering.md",
        id: "filtering",
        title: "Filtering",
        status: "live",
        version: "2026.06.01.1",
        modules: ["data"],
      },
    ]);
    hook.__dewnote.setModules([
      {
        id: "data",
        path: "modules/data.yaml",
        title: "Data",
        contents: [
          { title: "A series", tutorials: ["filtering"], tutorialsRange: null, indent: "  " },
        ],
      },
    ]);
  });

  await selectPanel(page, ".dn-series-toggle");
  await expect(page.locator(".dn-series-list li")).toHaveText("Filtering");
});

test("several modules each get their own section, in index.yaml's order rather than alphabetically", async ({ page }) => {
  await page.evaluate(() => {
    const hook = window as unknown as { __dewnote: TestHook };
    hook.__dewnote.setModules([
      {
        id: "web-authoring",
        path: "modules/web-authoring.yaml",
        title: "Web Authoring",
        contents: [
          { title: "First site", tutorials: ["a-form"], tutorialsRange: null, indent: "  " },
        ],
      },
      {
        id: "computational-methods",
        path: "modules/computational-methods.yaml",
        title: "Computational Methods",
        contents: [
          { title: "Python fundamentals", tutorials: ["first-steps"], tutorialsRange: null, indent: "  " },
        ],
      },
    ]);
  });

  await selectPanel(page, ".dn-series-toggle");
  const modules = page.locator(".dn-series-module-title");
  await expect(modules).toHaveCount(2);
  // The order modules.ts handed over, which is index.yaml's — a module's
  // place in the list is a real decision, not something to re-sort.
  await expect(modules.nth(0)).toHaveText("Web Authoring");
  await expect(modules.nth(1)).toHaveText("Computational Methods");
});

test("a tutorial no module lists is shown under its own heading, not treated as an error", async ({ page }) => {
  await page.evaluate(() => {
    const hook = window as unknown as { __dewnote: TestHook };
    hook.__dewnote.setFileIndex([
      {
        path: "tutorials/listed/listed.md",
        id: "listed",
        title: "Listed",
        modules: ["a-module"],
      },
      // Published but on no module — a real, buildable state in dewlab.
      { path: "tutorials/loose/loose.md", id: "loose", title: "Loose", modules: [] },
    ]);
    hook.__dewnote.setModules([
      {
        id: "a-module",
        path: "modules/a-module.yaml",
        title: "A Module",
        contents: [
          { title: "A series", tutorials: ["listed"], tutorialsRange: null, indent: "  " },
        ],
      },
    ]);
  });

  await selectPanel(page, ".dn-series-toggle");
  const unlisted = page.locator(".dn-series-unlisted");
  await expect(unlisted.locator("h3")).toHaveText("On no module");
  await expect(unlisted.locator(".dn-series-list li")).toHaveText("Loose");
});

test("without module files read at all, nothing is reported as unlisted", async ({ page }) => {
  await page.evaluate(() => {
    const hook = window as unknown as { __dewnote: TestHook };
    // No `modules` key: never cross-referenced, which is not the same as
    // being on no module. A folder with no modules/ directory shouldn't
    // report every tutorial in it.
    hook.__dewnote.setFileIndex([
      { path: "tutorials/loose/loose.md", id: "loose", title: "Loose" },
    ]);
    hook.__dewnote.setModules([]);
  });

  await selectPanel(page, ".dn-series-toggle");
  await expect(page.locator(".dn-series-unlisted")).toHaveCount(0);
  await expect(page.locator(".dn-series-empty")).toBeVisible();
});

test("with no module data at all, the panel says so instead of showing nothing", async ({ page }) => {
  await selectPanel(page, ".dn-series-toggle");
  await expect(page.locator(".dn-series-empty")).toBeVisible();
});

test("the command palette can open the modules rail too", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".dn-palette-input").fill("Modules");
  await page.locator(".dn-palette-item button").first().click();
  await expect(page.locator(".dn-series-panel")).toBeVisible();
});
