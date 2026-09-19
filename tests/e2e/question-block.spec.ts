// The two ```question kinds (planning/QUESTION_BLOCKS.md, dewlab's own
// build.py parse_question()/render_question()) — multiple-choice and
// fill-in-the-blank, offered by the block menu the same way every other
// kind is, since decision 45 already settled that nothing here should
// be hidden by context.

import { test as base, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { blockMenuItem, openAddMenu, pointAt } from "./block-controls.ts";

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

const TUTORIAL = ["---", "title: Counting Carefully", "year: 2026", "version: 2026.09.15.1", "---", "", "Words.", ""].join("\n");

async function mount(page: Page, source: string) {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
  await page.evaluate((s) => (window as unknown as { __dewnote: { mount(x: string): void } }).__dewnote.mount(s), source);
}

async function getSource(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __dewnote: { getSource(): string } }).__dewnote.getSource());
}

test("Multiple choice lands as a ```question fence dewlab's build already accepts", async ({ page }) => {
  await mount(page, TUTORIAL);
  await openAddMenu(page, 1);
  await blockMenuItem(page, ".dn-add-menu", "Multiple choice").click();

  const source = await getSource(page);
  expect(source).toContain("```question\n");
  expect(source).toContain("type: multiple-choice\n");
  expect(source).toContain("correct: 1\n");
  expect(source).toMatch(/id: new-question-\d+\n/);
  // Two wrong options, one right one, in that order — the template's
  // own shape, not just its presence.
  const fenceStart = source.indexOf("```question");
  const fenceEnd = source.indexOf("```", fenceStart + 3);
  const fence = source.slice(fenceStart, fenceEnd);
  expect(fence.indexOf("The right answer.")).toBeLessThan(fence.indexOf("A wrong answer."));

  // The cursor lands on the prompt, selected, ready to type over — the
  // same "select the placeholder words" treatment every other template
  // with real placeholder text gets.
  await expect(page.locator(".dn-block-fence .cm-content").last()).toBeVisible();
});

test("Fill in the blank lands as a sentence with a real {gap} in it", async ({ page }) => {
  await mount(page, TUTORIAL);
  await openAddMenu(page, 1);
  await blockMenuItem(page, ".dn-add-menu", "Fill in the blank").click();

  const source = await getSource(page);
  expect(source).toContain("```question\n");
  expect(source).toContain("type: fill-in-the-blank\n");
  expect(source).toMatch(/id: new-question-\d+\n/);
  expect(source).toContain("{this}");
  expect(source).not.toContain("correct:");
});

test("a question's id shares the same new-question-N counter as any question already on the page", async ({ page }) => {
  await mount(page, TUTORIAL);
  await openAddMenu(page, 1);
  await blockMenuItem(page, ".dn-add-menu", "Multiple choice").click();
  await openAddMenu(page, 2);
  await blockMenuItem(page, ".dn-add-menu", "Fill in the blank").click();

  const source = await getSource(page);
  expect(source).toContain("id: new-question-1");
  expect(source).toContain("id: new-question-2");
});

test("a question's id also avoids colliding with a cell's — one saved-answer namespace", async ({ page }) => {
  await mount(page, TUTORIAL.replace("Words.", '```python exec\nid: new-question-1\nprint(1)\n```\n\nWords.'));
  await openAddMenu(page, 2);
  await blockMenuItem(page, ".dn-add-menu", "Multiple choice").click();

  const source = await getSource(page);
  expect(source).toContain("id: new-question-2");
});

test("both kinds are reachable through the slash menu, searched by a name outside their label", async ({ page }) => {
  await mount(page, TUTORIAL);
  await pointAt(page, 1);
  await page.locator(".dn-add-btn").click();
  await blockMenuItem(page, ".dn-add-menu", "Paragraph").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("/quiz");

  const labels = page.locator(".dn-slash-menu .dn-block-menu-label");
  await expect(labels).toHaveText(["Multiple choice", "Fill in the blank"]);
});

test("the multiple-choice preview shows the correct option marked, no Check button", async ({ page }) => {
  await mount(page, TUTORIAL);
  await openAddMenu(page, 1);
  await blockMenuItem(page, ".dn-add-menu", "Multiple choice").click();
  // Blur commits the fence's own text — the preview updates "once it
  // commits", not per keystroke (card-fence.spec.ts's own pattern);
  // clicking the still-visible "Words." block is what blurs it.
  await page.locator(".dn-block").filter({ hasText: "Words." }).click();

  const preview = page.locator(".dn-question-preview .dl-question");
  await expect(preview).toBeVisible();
  await expect(preview.locator(".dl-question-option")).toHaveCount(3);
  await expect(preview.locator('.dl-question-option[data-correct="true"]')).toHaveText("The right answer.");
  await expect(page.locator(".dl-question-check")).toHaveCount(0);
});

test("the fill-in-the-blank preview shows the expected word inline", async ({ page }) => {
  await mount(page, TUTORIAL);
  await openAddMenu(page, 1);
  await blockMenuItem(page, ".dn-add-menu", "Fill in the blank").click();
  await page.locator(".dn-block").filter({ hasText: "Words." }).click();

  const preview = page.locator(".dn-question-preview .dl-question");
  await expect(preview).toBeVisible();
  await expect(preview.locator(".dn-question-gap")).toHaveText("this");
});
