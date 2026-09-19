// Plan §8 item 2: dewlab's own staged-hint fence (DIALECTS.md §1) —
// drives the real built app. The fence itself stays a live editor like
// any other (plan §5.1, decision 15: a fence never gets a rendered/
// blurred state), so this checks the read-only preview shown alongside
// it, not a render/edit toggle.

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

test.beforeEach(async ({ page }) => {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
});

test("a staged-hint fence stays a live editor and shows its own read-only preview beside it", async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __dewnote: { mount(source: string): void } }).__dewnote.mount(
      "```hint\nafter: 3 errors\ntitle: Slow down a moment\n\nCheck your *column names*.\n```\n",
    );
  });

  // The fence's own text is still fully editable, headers included — the
  // same "always live" rule every other fence kind already gets.
  await expect(page.locator(".dn-block-fence .cm-content")).toContainText("title: Slow down a moment");

  const preview = page.locator(".dn-hint-preview details");
  await expect(preview).toBeVisible();
  await expect(preview.locator("summary")).toHaveText("Slow down a moment");
  await expect(preview.locator("em")).toHaveText("column names");
  // Open, not hidden — dewnote has no reader-side trigger to gate a
  // reveal on, so showing it plainly is the honest choice.
  await expect(preview).toHaveAttribute("open", "");
});

test("with no header lines at all, the preview still shows dewlab's own default title", async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __dewnote: { mount(source: string): void } }).__dewnote.mount("```hint\nJust the body.\n```\n");
  });

  await expect(page.locator(".dn-hint-preview summary")).toHaveText("Let’s slow down a moment…");
});
