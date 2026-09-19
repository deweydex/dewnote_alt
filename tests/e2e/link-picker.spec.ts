// Step 8's link picker (src/link-picker.ts, backed by src/file-index.ts) —
// plan §6's own note that it "has the same multi-file dependency as the
// front-matter picker." Drives the real built app: seed a file index
// through the same window.__dewnote test hook other specs use to mount a
// document, open the picker from the add menu, and check both the
// indexed-entry path and the custom-link fallback.

import { addBlockAfter, deleteBlock, openAddMenu, pointAt } from "./block-controls.ts";
import { test as base, expect } from "@playwright/test";
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
  getSource(): string;
  setFileIndex(index: { path: string; title?: string; id?: string }[]): void;
};

async function mount(page: import("@playwright/test").Page, source: string) {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
  await page.evaluate((src) => (window as unknown as { __dewnote: TestHook }).__dewnote.mount(src), source);
}

async function getSource(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __dewnote: TestHook }).__dewnote.getSource());
}

async function openLinkPicker(page: import("@playwright/test").Page, blockIndex: number) {
  await addBlockAfter(page, blockIndex, "Link");
}

test("picking an indexed entry inserts a tutorial: link built from its id", async ({ page }) => {
  await mount(page, "One.\n\nTwo.\n");
  await page.evaluate(() => {
    (window as unknown as { __dewnote: TestHook }).__dewnote.setFileIndex([
      { path: "tutorials/filter-evening/filter-evening.md", title: "Filtering evening readings", id: "filter-evening" },
      { path: "notes/loose.md", title: "Has no id" },
    ]);
  });

  await openLinkPicker(page, 0);
  await expect(page.locator(".dn-link-item button")).toHaveCount(2);

  await page.locator(".dn-link-search").fill("filtering");
  await expect(page.locator(".dn-link-item button")).toHaveCount(1);
  await page.locator(".dn-link-item button", { hasText: "Filtering evening readings" }).click();

  const source = await getSource(page);
  expect(source).toContain("[Filtering evening readings](tutorial:filter-evening)");
  expect(source.indexOf("One.")).toBeLessThan(source.indexOf("[Filtering"));
  expect(source.indexOf("[Filtering")).toBeLessThan(source.indexOf("Two."));
});

test("an indexed entry with no id falls back to its path", async ({ page }) => {
  await mount(page, "One.\n");
  await page.evaluate(() => {
    (window as unknown as { __dewnote: TestHook }).__dewnote.setFileIndex([{ path: "notes/loose.md", title: "Has no id" }]);
  });

  await openLinkPicker(page, 0);
  await page.locator(".dn-link-item button", { hasText: "Has no id" }).click();

  const source = await getSource(page);
  expect(source).toContain("[Has no id](notes/loose.md)");
});

test("with no index yet, a custom link can still be inserted directly", async ({ page }) => {
  await mount(page, "One.\n");

  await openLinkPicker(page, 0);
  await expect(page.locator(".dn-link-item")).toHaveCount(0);
  await expect(page.locator(".dn-link-hint")).toContainText("No indexed tutorials yet");

  await page.locator(".dn-link-text").fill("dewlab");
  await page.locator(".dn-link-url").fill("https://dewlab.example/");
  await page.locator(".dn-link-insert").click();

  const source = await getSource(page);
  expect(source).toContain("[dewlab](https://dewlab.example/)");
});

test("the list is the indexed files themselves — a module a tutorial is on is not an item", async ({ page }) => {
  // `module:` and `series:` items used to sit alongside the tutorials
  // here, one per distinct value in the index. They are gone with the
  // schemes themselves (DECISIONS.md 36), so two tutorials that share a
  // module are two items, not two plus the module.
  await mount(page, "One.\n\nTwo.\n");
  await page.evaluate(() => {
    (
      window as unknown as {
        __dewnote: TestHook & { setFileIndex(index: { path: string; title?: string; id?: string; modules?: string[] }[]): void };
      }
    ).__dewnote.setFileIndex([
      { path: "tutorials/filtering/filtering.md", title: "Filtering Rows", id: "filtering", modules: ["computational-methods"] },
      { path: "tutorials/grouping/grouping.md", title: "Grouping Rows", id: "grouping", modules: ["computational-methods"] },
    ]);
  });

  await openLinkPicker(page, 0);
  await expect(page.locator(".dn-link-item button")).toHaveCount(2);
  await expect(page.locator(".dn-link-item-kind")).toHaveCount(0);

  // The module name matches nothing: it names no item, and searching it
  // leaves the author with the custom-link row rather than a badged
  // entry that would insert a link no build resolves.
  await page.locator(".dn-link-search").fill("computational");
  await expect(page.locator(".dn-link-item button")).toHaveCount(0);
  await expect(page.locator(".dn-link-empty")).toBeVisible();
});

test("search is case-insensitive, and matches a file's path as well as its title", async ({ page }) => {
  await mount(page, "One.\n");
  await page.evaluate(() => {
    (window as unknown as { __dewnote: TestHook }).__dewnote.setFileIndex([
      { path: "tutorials/filtering/filtering.md", title: "Filtering Rows", id: "filtering" },
      { path: "tutorials/web-basics/web-basics.md", title: "Web Basics", id: "web-basics" },
    ]);
  });

  await openLinkPicker(page, 0);
  await expect(page.locator(".dn-link-item button")).toHaveCount(2);

  await page.locator(".dn-link-search").fill("FILTERING");
  await expect(page.locator(".dn-link-item button")).toHaveCount(1);
  await expect(page.locator(".dn-link-item button")).toHaveText("Filtering Rows");

  // An author who knows the id but not the title finds it too: the id
  // is in the path, and the path is searched.
  await page.locator(".dn-link-search").fill("web-basics");
  await expect(page.locator(".dn-link-item button")).toHaveCount(1);
  await expect(page.locator(".dn-link-item button")).toHaveText("Web Basics");
});

test("Escape cancels the picker without inserting anything", async ({ page }) => {
  await mount(page, "One.\n");
  await openLinkPicker(page, 0);
  await expect(page.locator(".dn-link-overlay")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".dn-link-overlay")).toHaveCount(0);
  expect(await getSource(page)).toBe("One.\n");
});
