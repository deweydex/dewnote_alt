// Step 6's first slice (src/export-html.ts) — drives the real built app
// to prove the one thing a unit test can't: that collectPageCss() reads
// something real off the live page. dist/index.html is decision 14's own
// single-file build, its whole stylesheet inlined into one <style> tag,
// so a real Export click here either carries that CSS into the
// downloaded page or it doesn't — worth checking directly rather than
// trusting the browser-only half of export-html.ts by inspection alone.

import { test as base, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

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

test.beforeEach(async ({ page }) => {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
});


async function openFileMenuThen(page: import("@playwright/test").Page, selector: string) {
  await page.locator(".dn-file-export-menu-toggle").click();
  await page.locator(selector).click();
}

test("Export HTML downloads a standalone page with real content and the live stylesheet inlined", async ({ page }) => {
  await dropFile(
    page,
    "a-rule.md",
    "---\ntitle: A Rule\n---\n\n# A Rule\n\nWhere it lives.\n\n```python exec\nid: first\nprint('hi')\n```\n",
  );
  await expect(page.locator("h1")).toHaveText("A Rule");

  const [download] = await Promise.all([page.waitForEvent("download"), openFileMenuThen(page, ".dn-file-export-html")]);
  expect(download.suggestedFilename()).toBe("a-rule.html");

  const savedPath = await download.path();
  expect(savedPath).not.toBeNull();
  const html = readFileSync(savedPath as string, "utf-8");

  expect(html.startsWith("<!doctype html>")).toBe(true);
  expect(html).toContain("<title>A Rule</title>");
  expect(html).toContain('<div class="dn-page">');
  expect(html).toContain("<h1>A Rule</h1>");
  expect(html).toContain("<p>Where it lives.</p>");
  expect(html).toContain('<pre><code class="language-python">print(\'hi\')</code></pre>');
  expect(html).not.toContain("id: first");

  // The live page's own stylesheet — decision 14's single-file build
  // inlines it into a <style> tag — carried into the export, not a blank
  // or missing one.
  const styleMatch = /<style>([\s\S]*)<\/style>/.exec(html);
  expect(styleMatch).not.toBeNull();
  expect(styleMatch![1]!.length).toBeGreaterThan(1000);
  expect(styleMatch![1]).toContain(".dn-page");
});
