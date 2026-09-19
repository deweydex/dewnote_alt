// The settings panel touches no Pyodide worker for anything a reader
// actually clicks here — restartInterpreter() is a no-op with nothing
// booted, and the Pyodide-source field only calls setPyodideBase(), a
// plain in-memory assignment — so, like tests/e2e/surface.spec.ts, this
// needs no real network and belongs in the suite that runs everywhere.

import { test as base, expect, type Page } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

async function rootStyle(page: Page, property: string): Promise<string> {
  return page.evaluate((prop) => document.documentElement.style.getPropertyValue(prop), property);
}

test.beforeEach(async ({ page }) => {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
});

test("the panel is closed by default and opens/closes on the toggle", async ({ page }) => {
  await expect(page.locator(".dn-settings-panel")).toBeHidden();
  await page.locator(".dn-settings-toggle").click();
  await expect(page.locator(".dn-settings-panel")).toBeVisible();
  await expect(page.locator(".dn-settings-toggle")).toHaveAttribute("aria-expanded", "true");
  await page.locator(".dn-settings-close").click();
  await expect(page.locator(".dn-settings-panel")).toBeHidden();
  await expect(page.locator(".dn-settings-toggle")).toHaveAttribute("aria-expanded", "false");
});

test("changing text size and theme writes real CSS to <html>, at the default it writes nothing", async ({ page }) => {
  // At the default, every property this settings shape controls is
  // absent — settings.ts's own "a default value removes the property"
  // rule (dewstack's own pattern), checked here, not just in cell.test.ts.
  expect(await rootStyle(page, "--dl-font-size")).toBe("");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");

  await page.locator(".dn-settings-toggle").click();
  await page.locator(".dn-settings-panel select").first().selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const textSize = page.locator('.dn-settings-row:has-text("Text size") input[type="range"]');
  await textSize.fill("22");
  await textSize.dispatchEvent("input");
  expect(await rootStyle(page, "--dl-font-size")).toBe("22px");
});

test("every sidebar button is labelled and the rail can show icons, labels, or both", async ({ page }) => {
  const buttons = page.locator(".dn-icon-rail > button");
  expect(await buttons.count()).toBeGreaterThan(1);
  for (let at = 0; at < await buttons.count(); at += 1) {
    await expect(buttons.nth(at)).toHaveAttribute("data-label", /\S/);
  }

  const first = buttons.first();
  const pseudo = () => first.evaluate((el) => getComputedStyle(el, "::after").content);
  expect(await pseudo()).not.toBe("none");
  const restingShape = await first.evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return { width: box.width, height: box.height, radius: style.borderRadius, direction: style.flexDirection };
  });
  expect(restingShape.width).toBe(restingShape.height);
  expect(restingShape.width).toBeGreaterThanOrEqual(44);
  expect(restingShape.radius).toBe("50%");
  expect(restingShape.direction).toBe("column");

  await page.locator(".dn-settings-toggle").click();
  const display = page.locator('.dn-settings-row:has-text("Sidebar buttons") select');
  await display.selectOption("icons");
  await expect(page.locator("html")).toHaveAttribute("data-rail-display", "icons");
  expect(await first.evaluate((el) => getComputedStyle(el, "::after").display)).toBe("none");

  await display.selectOption("labels");
  await expect(page.locator("html")).toHaveAttribute("data-rail-display", "labels");
  expect(await first.evaluate((el) => getComputedStyle(el).fontSize)).toBe("0px");

  await display.selectOption("icons-and-labels");
  await expect(page.locator("html")).not.toHaveAttribute("data-rail-display");
  expect(await pseudo()).not.toBe("none");
});

test("a setting survives a reload, and Reset puts everything back", async ({ page }) => {
  await page.locator(".dn-settings-toggle").click();
  const textSize = page.locator('.dn-settings-row:has-text("Text size") input[type="range"]');
  await textSize.fill("20");
  await textSize.dispatchEvent("input");
  expect(await rootStyle(page, "--dl-font-size")).toBe("20px");

  await page.reload();
  await expect(page.locator(".dn-block").first()).toBeVisible();
  expect(await rootStyle(page, "--dl-font-size")).toBe("20px");

  await page.locator(".dn-settings-toggle").click();
  await page.locator(".dn-settings-reset").click();
  expect(await rootStyle(page, "--dl-font-size")).toBe("");
  await expect(page.locator('.dn-settings-row:has-text("Text size") input[type="range"]')).toHaveValue("18");
});

test("tinted cells off flattens a cell's background to the page background", async ({ page }) => {
  // color-mix()'s own output serialises as color(srgb ...), not the
  // plain rgb() the untinted value started as, even at 0% (numerically
  // identical, different string) — canvas fillStyle round-trips a
  // color() string right back to itself rather than collapsing it to
  // rgb(), so comparing computed-style strings isn't reliable here.
  // Rasterising a real pixel is: any valid CSS colour, in any
  // serialisation, becomes the same concrete 8-bit RGBA once drawn.
  const normalize = (page: Page, color: string) =>
    page.evaluate((c) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    }, color);

  // .dn-cell-box, not .dn-block-source directly: a runnable fence's own
  // tinted background lives on the box wrapping both its header bar and
  // its (deliberately transparent) code editor now (decision 27), not on
  // .dn-block-source itself.
  const fenceSource = page.locator(".dn-block-fence .dn-cell-box");
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const tintedCellBg = await fenceSource.evaluate((el) => getComputedStyle(el).backgroundColor);
  // Confirms the test can actually tell tinted from untinted before
  // trusting the "now equal" assertion below — a cell really is a
  // different colour from the page by default.
  expect(await normalize(page, tintedCellBg)).not.toEqual(await normalize(page, bodyBg));

  await page.locator(".dn-settings-toggle").click();
  await page.locator('.dn-settings-row:has-text("Tinted cells") input[type="checkbox"]').uncheck();
  const untintedCellBg = await fenceSource.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await normalize(page, untintedCellBg)).toEqual(await normalize(page, bodyBg));
});

test("restarting the interpreter and setting a custom Pyodide source touch no network at all", async ({ page }) => {
  // Both are plain, synchronous JS with nothing booted yet — this is the
  // one real assertion that matters: neither click throws, hangs, or
  // trips the failOnConsoleErrors fixture (a real Pyodide fetch, by
  // contrast, fails loudly in this sandbox — see tests/e2e/pyodide.spec.ts).
  await page.locator(".dn-settings-toggle").click();
  await page.locator('input[placeholder="Default (jsDelivr)"]').fill("https://example.com/pyodide/");
  await page.locator('input[placeholder="Default (jsDelivr)"]').blur();
  await page.locator(".dn-settings-restart").click();
  await expect(page.locator(".dn-settings-panel")).toBeVisible();
});
