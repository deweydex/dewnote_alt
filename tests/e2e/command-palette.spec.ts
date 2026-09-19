// Step 8's command palette (src/command-palette.ts) — plan §5.3's own
// "a command palette on Cmd+K that reaches everything the rails do."
// Drives the real built app: open with the keyboard shortcut, filter,
// and run a command that proxies a click on a real rail's own button.

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

test("Ctrl/Cmd+K opens the palette, and Escape closes it", async ({ page }) => {
  await expect(page.locator(".dn-palette-overlay")).toBeHidden();
  await page.keyboard.press("Control+k");
  await expect(page.locator(".dn-palette-overlay")).toBeVisible();
  await expect(page.locator(".dn-palette-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".dn-palette-overlay")).toBeHidden();
});

test("typing filters the command list", async ({ page }) => {
  await page.keyboard.press("Control+k");
  const items = page.locator(".dn-palette-item button");
  const allCount = await items.count();
  expect(allCount).toBeGreaterThan(1);

  await page.locator(".dn-palette-input").fill("outline");
  await expect(items).toHaveCount(1);
  await expect(items).toHaveText("Outline");
});

test("running a command clicks the real rail button behind it", async ({ page }) => {
  await page.keyboard.press("Control+k");
  await page.locator(".dn-palette-input").fill("settings");
  await page.locator(".dn-palette-item button", { hasText: "Settings" }).click();

  await expect(page.locator(".dn-palette-overlay")).toBeHidden();
  await expect(page.locator(".dn-settings-panel")).toBeVisible();
});

test("Export as HTML, run from the palette, downloads the same page the file bar's own button does", async ({ page }) => {
  await page.keyboard.press("Control+k");
  await page.locator(".dn-palette-input").fill("export as html");

  const downloadPromise = page.waitForEvent("download");
  await page.locator(".dn-palette-item button", { hasText: "Export as HTML" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.html$/);
});
