// Plan §8 item 3: dewlab's own native html site/css site/js site cells
// (DIALECTS.md §1) — drives the real built app. No network dependency
// (unlike pyodide.spec.ts): the sandboxed iframe's own srcdoc is static
// HTML/CSS/JS this test builds, nothing fetched from a CDN, so this runs
// in the same suite as everything else rather than the network-gated one.

import { test as base, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_APP = "file://" + resolve(HERE, "../../dist/index.html") + "?legacy=1";

// A js site pane's own uncaught error (one test below throws one on
// purpose, to check the console relay) still reaches the *browser's*
// devtools console too, from inside the sandboxed frame — Playwright's
// page.on("console") aggregates every frame's console, not just the top
// one. Expected there, the same "real, named noise" repo-panel.spec.ts
// already filters its own expected 404/409s out of.
const EXPECTED_CONSOLE_NOISE = /boom/;

const test = base.extend<{ failOnConsoleErrors: void }>({
  failOnConsoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => {
        if (!EXPECTED_CONSOLE_NOISE.test(String(e))) errors.push(String(e));
      });
      page.on("console", (msg) => {
        if (msg.type() === "error" && !EXPECTED_CONSOLE_NOISE.test(msg.text())) errors.push(msg.text());
      });
      await use();
      expect(errors, `console/page errors:\n${errors.join("\n")}`).toEqual([]);
    },
    { auto: true },
  ],
});

async function mount(page: import("@playwright/test").Page, source: string) {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
  await page.evaluate((src) => (window as unknown as { __dewnote: { mount(source: string): void } }).__dewnote.mount(src), source);
}

const HTML_CSS_SOURCE =
  "```html site\nid: hero-markup\nsite: hero\n<button id=\"btn\">Hover me</button>\n```\n\n```css site\nid: hero-style\nsite: hero\n#btn { color: red; }\n```\n";

test("two consecutive panes sharing a site: name render one live preview with both applied", async ({ page }) => {
  await mount(page, HTML_CSS_SOURCE);

  // Both fences are still separate, fully editable live editors.
  await expect(page.locator(".dn-block-fence")).toHaveCount(2);
  await expect(page.locator(".dn-block-fence").nth(0).locator(".cm-content")).toContainText("Hover me");
  await expect(page.locator(".dn-block-fence").nth(1).locator(".cm-content")).toContainText("color: red");

  // Exactly one shared preview, hosted after the last pane, not one per pane.
  await expect(page.locator(".dn-site-preview")).toHaveCount(1);

  const frame = page.frameLocator(".dn-site-frame");
  await expect(frame.locator("#btn")).toHaveText("Hover me");
  await expect(frame.locator("#btn")).toHaveCSS("color", "rgb(255, 0, 0)");
});

test("editing the HTML pane and blurring rebuilds the shared preview live", async ({ page }) => {
  await mount(page, HTML_CSS_SOURCE);

  const htmlPane = page.locator(".dn-block-fence").first();
  // Click the body line itself, not just anywhere in the editor — a
  // plain click on .cm-content can land on the first (header) line,
  // and "End" only moves to the end of whichever line the click landed
  // on, not the end of the fence. Typed after the closing </button>, so
  // this ends up as sibling text in the body, not inside the button
  // itself — a deliberately simple edit, not a claim about exactly
  // where text lands relative to a tag.
  await htmlPane.locator(".cm-line", { hasText: "Hover me" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Edited");
  await page.locator("body").click({ position: { x: 5, y: 5 } }); // blur

  // Editing a site pane forces a full render() (app.ts's own commit()),
  // which tears down and recreates the preview's iframe element as a new
  // DOM node — a frameLocator resolved before that point can be left
  // pointing at the detached frame, so this checks the freshly rebuilt
  // srcdoc directly rather than drilling into frame content across that
  // teardown.
  await expect(page.locator(".dn-site-frame")).toHaveAttribute("srcdoc", /Edited/);
  const frame = page.frameLocator(".dn-site-frame");
  await expect(frame.locator("body")).toContainText("Hover me Edited");
});

test("a js site pane never runs until Run is clicked, and its console relays to the page", async ({ page }) => {
  await mount(
    page,
    "```html site\nid: a\nsite: widget\n<div id=\"out\"></div>\n```\n\n```js site\nid: b\nsite: widget\nconsole.log('ran');\ndocument.getElementById('out').textContent = 'done';\n```\n",
  );

  const frame = page.frameLocator(".dn-site-frame");
  // Live on mount (HTML/CSS only) — the JS pane's own code has not run yet.
  await expect(frame.locator("#out")).toHaveText("");
  await expect(page.locator(".dn-site-console-line")).toHaveCount(0);

  await page.locator(".dn-site-run").click();
  await expect(frame.locator("#out")).toHaveText("done");
  await expect(page.locator(".dn-site-console-line")).toHaveText("ran");
});

test("an uncaught error in a js site pane relays to the console as an error line", async ({ page }) => {
  await mount(page, "```js site\nid: a\nsite: broken\nthrow new Error('boom');\n```\n");
  await page.locator(".dn-site-run").click();
  await expect(page.locator(".dn-site-console-error")).toContainText("boom");
});

test("panes with no site: value at all still group when consecutive, and get their own preview", async ({ page }) => {
  await mount(page, "```html site\n<p>No site name here.</p>\n```\n");
  await expect(page.locator(".dn-site-preview")).toHaveCount(1);
  const frame = page.frameLocator(".dn-site-frame");
  await expect(frame.locator("p")).toHaveText("No site name here.");
});

test("the fence's own raw text round-trips byte for byte through the mounted DOM, headers included", async ({ page }) => {
  await mount(page, HTML_CSS_SOURCE);
  const source = await page.evaluate(() => (window as unknown as { __dewnote: { getSource(): string } }).__dewnote.getSource());
  expect(source).toBe(HTML_CSS_SOURCE);
});
