// Step 5's "link checking against real ids" (src/link-check.ts) —
// drives the real built app: seed a file index the same way
// link-picker.spec.ts does, mount a document with both a real and a
// broken tutorial: link, and check the report names only the broken one.

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

type TestHook = {
  mount(source: string): void;
  setFileIndex(index: { path: string; id?: string; title?: string }[]): void;
};

test.beforeEach(async ({ page }) => {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
});

test("reports a tutorial: link whose id isn't in the index, and clears once fixed", async ({ page }) => {
  await page.evaluate(() => {
    const hook = window as unknown as { __dewnote: TestHook };
    hook.__dewnote.setFileIndex([{ path: "tutorials/filtering/filtering.md", id: "filtering", title: "Filtering" }]);
    hook.__dewnote.mount("See [filtering](tutorial:filtering) and [sorting](tutorial:sorting).\n");
  });

  await selectPanel(page, ".dn-linkcheck-toggle");
  await page.locator(".dn-linkcheck-run").click();

  const report = page.locator(".dn-linkcheck-report li");
  await expect(report).toHaveCount(1);
  await expect(report).toContainText("sorting");
  await expect(report).toContainText("tutorial:sorting");
});

test("with every link resolving, the report says so instead of listing nothing silently", async ({ page }) => {
  await page.evaluate(() => {
    const hook = window as unknown as { __dewnote: TestHook };
    hook.__dewnote.setFileIndex([{ path: "tutorials/filtering/filtering.md", id: "filtering", title: "Filtering" }]);
    hook.__dewnote.mount("See [filtering](tutorial:filtering) for more.\n");
  });

  await selectPanel(page, ".dn-linkcheck-toggle");
  await page.locator(".dn-linkcheck-run").click();

  await expect(page.locator(".dn-linkcheck-report li")).toHaveText("No broken links found.");
});

// `module:` and `series:` were checked here once, against distinct index
// values. Neither was ever a scheme either site's build resolved, so
// both are gone and a link using one is now left alone like any other
// unknown scheme — reporting it as broken was as wrong as clearing it,
// since the link would have shipped as literal text either way.
test("a module: or series: link is left alone, like any other link this doesn't own", async ({ page }) => {
  await page.evaluate(() => {
    const hook = window as unknown as { __dewnote: TestHook };
    hook.__dewnote.setFileIndex([
      { path: "tutorials/filtering/filtering.md", id: "filtering", title: "Filtering" },
    ]);
    hook.__dewnote.mount(
      "See the [module](module:computational-methods), the [series](series:core), and [the real thing](tutorial:filtering).\n",
    );
  });

  await selectPanel(page, ".dn-linkcheck-toggle");
  await page.locator(".dn-linkcheck-run").click();

  await expect(page.locator(".dn-linkcheck-report li")).toHaveText("No broken links found.");
});

// A frozen release and the live file beside it share one id, so a link
// to it resolves once rather than being reported as ambiguous.
test("a tutorial with several versions indexed still resolves by its one id", async ({ page }) => {
  await page.evaluate(() => {
    const hook = window as unknown as { __dewnote: TestHook };
    hook.__dewnote.setFileIndex([
      { path: "tutorials/first-steps/first-steps.md", id: "first-steps", title: "First Steps" },
      { path: "tutorials/first-steps/v2026.08.23.1.md", id: "first-steps", title: "First Steps" },
    ]);
    hook.__dewnote.mount("See [first steps](tutorial:first-steps).\n");
  });

  await selectPanel(page, ".dn-linkcheck-toggle");
  await page.locator(".dn-linkcheck-run").click();

  await expect(page.locator(".dn-linkcheck-report li")).toHaveText("No broken links found.");
});

test("the command palette can open the link checker too", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".dn-palette-input").fill("Check links");
  await page.locator(".dn-palette-item button").first().click();
  await expect(page.locator(".dn-linkcheck-panel")).toBeVisible();
});
