// dewlab's own ```card fence (DIALECTS.md §1, build.py's parse_card()/
// render_card()) — drives the real built app. The fence itself stays a
// live editor like any other (plan §5.1, decision 15: a fence never gets
// a rendered/blurred state), so this checks the read-only preview shown
// alongside it, not a render/edit toggle. Not a cell: dewlab's own
// Cell/CELL_TYPES already reserve that word for something that runs, so
// this stays a card throughout — see cell.ts's own header comment.

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

test("a card fence stays a live editor and shows its own .dl-module-card preview beside it", async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __dewnote: { mount(source: string): void } }).__dewnote.mount(
      "```card\nurl: computational-methods.html\nstatus: beta\nmeta: 5N0554 · QQI Level 5\n### Computational Methods\nWe work through *matrices*.\n```\n",
    );
  });

  // The fence's own text is still fully editable, headers included — the
  // same "always live" rule every other fence kind already gets.
  await expect(page.locator(".dn-block-fence .cm-content")).toContainText("status: beta");

  const card = page.locator(".dn-card-preview .dl-module-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("href", "computational-methods.html");
  await expect(card.locator("h3")).toContainText("Computational Methods");
  await expect(card.locator(".dl-module-card-badge")).toHaveText("Beta");
  await expect(card.locator(".dl-module-card-meta")).toHaveText("5N0554 · QQI Level 5");
  await expect(card.locator("p em")).toHaveText("matrices");
});

test("a wide card with no status or meta shows neither, and gets the wide class", async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __dewnote: { mount(source: string): void } }).__dewnote.mount(
      "```card\nurl: features.html\nwide: true\n### What dewlab can do\n```\n",
    );
  });

  const card = page.locator(".dn-card-preview .dl-module-card");
  await expect(card).toHaveClass(/dl-module-card-wide/);
  await expect(card.locator(".dl-module-card-badge")).toHaveCount(0);
  await expect(card.locator(".dl-module-card-meta")).toHaveCount(0);
});

test("editing the fence's text updates the preview once it commits", async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __dewnote: { mount(source: string): void } }).__dewnote.mount(
      "```card\nurl: a.html\n### Original Heading\n```\n\nAfter.\n",
    );
  });

  await expect(page.locator(".dn-card-preview .dl-module-card h3")).toContainText("Original Heading");

  // Select the heading line itself and retype it — clicking then Home,
  // Shift+End selects exactly that line's text without touching the
  // fence markers or the header line above it (site-cell.spec.ts's own
  // pattern for editing one line of a fence in place).
  await page.locator(".dn-block-fence .cm-line", { hasText: "Original Heading" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.type("### Changed Heading");
  await page.locator(".dn-block").filter({ hasText: "After." }).click(); // blur, commits the edit

  await expect(page.locator(".dn-card-preview .dl-module-card h3")).toContainText("Changed Heading");
});
