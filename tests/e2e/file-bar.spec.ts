// The file bar (src/file-bar.ts, src/store.ts) is step 4's first slice —
// until it existed, the built app could edit only its in-memory starter
// document, with no way in or out except the __dewnote test hook every
// other spec in this folder uses. This drives the real thing: dropping a
// file onto the page opens it, Save writes a download when there is no
// writable handle (the `<input>`/drop fallback path, decision 5's "every
// browser but Chrome/Edge" case), and the dirty indicator and title
// track edits the way a save-aware editor should.

import { test as base, expect, type Page } from "@playwright/test";
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

test.beforeEach(async ({ page }) => {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
});

test("the dewnote wordmark and current filename remain visible without overlapping", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const brand = page.locator(".dn-file-bar > .dn-brand");
  const mark = brand.locator("svg");
  const word = brand.locator(".dn-brand-name");
  await expect(brand).toBeVisible();
  await expect(word).toHaveText("dewnote");
  await expect(page.locator(".dn-file-name")).toBeVisible();
  await expect(page.locator(".dn-file-name")).toHaveText("Untitled");
  const [markBox, wordBox] = await Promise.all([mark.boundingBox(), word.boundingBox()]);
  expect(markBox).not.toBeNull();
  expect(wordBox).not.toBeNull();
  expect(markBox!.x + markBox!.width).toBeLessThanOrEqual(wordBox!.x);
});

/** Simulates a drop of one markdown file onto the page. Chromium builds a
 * real DataTransfer with a real File in-page for a scripted drag, so no
 * OS-level drag is needed to exercise `openDroppedItem`. */
async function dropFile(page: Page, name: string, content: string) {
  const dataTransfer = await page.evaluateHandle(
    ([n, c]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([c], n, { type: "text/markdown" }));
      return dt;
    },
    [name, content] as const,
  );
  await page.dispatchEvent("body", "dragover", { dataTransfer });
  await page.dispatchEvent("body", "drop", { dataTransfer });
}

test("dropping a file opens it, renders it, and updates the filename", async ({ page }) => {
  await dropFile(
    page,
    "a-rule-and-where-it-lives.md",
    "---\ntitle: A Rule\n---\n\n# A Rule\n\nDropped content.\n",
  );
  await expect(page.locator("h1")).toHaveText("A Rule");
  await expect(page.locator(".dn-file-name")).toHaveText("a-rule-and-where-it-lives.md");
  await expect(page).toHaveTitle(/a-rule-and-where-it-lives\.md — dewnote/);
  // Opening is not an edit: the polling dirty tracker must adopt the new
  // source instead of comparing it with the previous Untitled document.
  await page.waitForTimeout(650);
  await expect(page.locator(".dn-file-status")).toHaveText("downloaded");
  await expect(page).not.toHaveTitle(/ • — dewnote/);
});

test("editing marks the document dirty, and Save clears it and downloads", async ({ page }) => {
  await dropFile(page, "draft.md", "# Draft\n\nOriginal.\n");
  await expect(page.locator(".dn-file-status")).toHaveText("downloaded");

  await page.locator(".dn-block-render").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" More.");
  // Losing focus on the live editor is what commits the edit; clicking
  // elsewhere on the page is the ordinary way a reader does that.
  await page.locator("body").click({ position: { x: 5, y: 5 } });

  await expect(page.locator(".dn-file-status")).toHaveText("unsaved", { timeout: 2000 });
  await expect(page).toHaveTitle(/^draft\.md • — dewnote/);

  await page.locator(".dn-file-export-menu-toggle").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator(".dn-file-save").click()]);
  expect(download.suggestedFilename()).toBe("draft.md");
  await expect(page.locator(".dn-file-status")).toHaveText("downloaded");
});

test("Cmd/Ctrl+S saves without the browser's own save-page dialog", async ({ page }) => {
  await dropFile(page, "shortcut.md", "# Shortcut\n\nBody.\n");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.keyboard.press(process.platform === "darwin" ? "Meta+S" : "Control+S"),
  ]);
  expect(download.suggestedFilename()).toBe("shortcut.md");
});
