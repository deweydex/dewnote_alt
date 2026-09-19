// Step 8's outline rail (src/outline-panel.ts) — drives the real built
// app: open a document with a few headings, open the rail, and check
// both that every heading is listed and that clicking one scrolls its
// block into view.

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

const DOCUMENT = [
  "# Top\n\n",
  "Intro prose.\n\n",
  "## Middle\n\n",
  Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i}.`).join("\n\n") + "\n\n",
  "### Bottom\n\n",
  "The end.\n",
].join("");

test.beforeEach(async ({ page }) => {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
  await page.evaluate(
    (source) => (window as unknown as { __dewnote: { mount(source: string): void } }).__dewnote.mount(source),
    DOCUMENT,
  );
  await expect(page.locator(".dn-block-render").first()).toContainText("Top");
});

test("lists every heading, and clicking one scrolls its block into view", async ({ page }) => {
  await selectPanel(page, ".dn-outline-toggle");

  const items = page.locator(".dn-outline-item button");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveText("Top");
  await expect(items.nth(1)).toHaveText("Middle");
  await expect(items.nth(2)).toHaveText("Bottom");

  const bottomBlock = page.locator('.dn-block:has-text("Bottom")').first();
  await expect(bottomBlock).not.toBeInViewport();

  await items.nth(2).click();
  await expect(bottomBlock).toBeInViewport();
});

test("re-opening the rail after an edit reflects the new heading", async ({ page }) => {
  await selectPanel(page, ".dn-outline-toggle");
  await expect(page.locator(".dn-outline-item button")).toHaveCount(3);
  await page.locator(".dn-outline-close").click();

  await page.evaluate(() => {
    const hook = window as unknown as { __dewnote: { mount(source: string): void; getSource(): string } };
    hook.__dewnote.mount(hook.__dewnote.getSource() + "\n#### A new heading\n");
  });

  await selectPanel(page, ".dn-outline-toggle");
  await expect(page.locator(".dn-outline-item button")).toHaveCount(4);
  await expect(page.locator(".dn-outline-item button").last()).toHaveText("A new heading");
});
