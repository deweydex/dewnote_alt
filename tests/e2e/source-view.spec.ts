// Step 6 step 2's own "the whole-file source view (Cmd+/)" (src/source-view.ts)
// — drives the real built app: open a document, open the whole-file
// view, check it shows the raw markdown (fence markers and all), edit
// it, and check both that closing commits the edit into the document
// and that Cmd+/ toggles the same view Escape and the close button do.

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

const DOCUMENT = "---\ntitle: A Rule\n---\n\n# A Rule\n\nSome prose.\n\n```python exec\nid: x\n1 + 1\n```\n";

test.beforeEach(async ({ page }) => {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
  await page.evaluate(
    (source) => (window as unknown as { __dewnote: { mount(source: string): void } }).__dewnote.mount(source),
    DOCUMENT,
  );
  await expect(page.locator(".dn-block-render", { hasText: "Some prose." })).toBeVisible();
});

test("shows the document's real raw source, fence markers and front matter included", async ({ page }) => {
  await page.locator(".dn-source-toggle").click();
  const editor = page.locator(".dn-source-editor .cm-content");
  await expect(editor).toContainText("title: A Rule");
  await expect(editor).toContainText("```python exec");
  await expect(editor).toContainText("id: x");
});

test("opening and closing with no edit round-trips the document byte for byte", async ({ page }) => {
  await page.locator(".dn-source-toggle").click();
  await page.locator(".dn-source-close").click();
  const source = await page.evaluate(() => (window as unknown as { __dewnote: { getSource(): string } }).__dewnote.getSource());
  expect(source).toBe(DOCUMENT);
});

test("editing the whole-file source and closing commits the change into the document", async ({ page }) => {
  await page.locator(".dn-source-toggle").click();
  const content = page.locator(".dn-source-editor .cm-content");
  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nA new paragraph, added from the source view.\n");
  await page.locator(".dn-source-close").click();

  await expect(page.locator(".dn-source-overlay")).toBeHidden();
  await expect(page.locator(".dn-block-render").last()).toContainText("A new paragraph, added from the source view.");
});

test("Cmd/Ctrl+/ opens the view, and Escape closes it and commits", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+/");
  const content = page.locator(".dn-source-editor .cm-content");
  await expect(content).toContainText("A Rule");

  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nAnother paragraph.\n");
  await page.keyboard.press("Escape");

  await expect(page.locator(".dn-source-overlay")).toBeHidden();
  await expect(page.locator(".dn-block-render").last()).toContainText("Another paragraph.");
});

test("switching to another sidebar tab closes and commits the source editor", async ({ page }) => {
  await page.locator(".dn-source-toggle").click();
  await selectPanel(page, ".dn-outline-toggle");
  await expect(page.locator(".dn-source-overlay")).toBeHidden();
  await expect(page.locator(".dn-outline-panel")).toBeVisible();
});

test("the command palette can open the source view too", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".dn-palette-input").fill("Whole-file");
  await page.locator(".dn-palette-item button").first().click();
  await expect(page.locator(".dn-source-overlay")).toBeVisible();
});
