// The teaching blocks (PEDAGOGICAL_STYLE_GUIDE §6) — the problem, its
// stepped hint, and the answer behind a fold beside it.
//
// dewlab styles exactly two folds: `check_folds` accepts `dl-hint` and
// `dl-answer` and fails the build on anything else. This editor could
// write the first and not the second, so an answer — the whole point of
// a practice page — could not be inserted at all. What is checked here is
// the markdown that lands, because that markdown is what dewlab's build
// reads.
//
// They were offered only on a page whose front matter said
// `practice_for`, and are offered everywhere now. §6 is a rule about how
// to teach, which an author applies; it is not a rule the editor is in a
// position to enforce by withholding the block from a page it has
// decided is the wrong kind.

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

const TUTORIAL = ["---", "title: First Steps", "year: 2026", "version: 2026.09.15.1", "---", "", "Words.", ""].join("\n");
const PRACTICE = [
  "---",
  "title: First Steps — Practice",
  "year: 2026",
  "version: 2026.09.15.1",
  "practice_for: first-steps",
  "---",
  "",
  "Words.",
  "",
].join("\n");

async function mount(page: Page, source: string) {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
  await page.evaluate((s) => (window as unknown as { __dewnote: { mount(x: string): void } }).__dewnote.mount(s), source);
}

async function getSource(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __dewnote: { getSource(): string } }).__dewnote.getSource());
}

async function menuLabels(page: Page, blockIndex: number): Promise<string[]> {
  await openAddMenu(page, blockIndex);
  return page.locator(".dn-add-menu .dn-block-menu-label").allInnerTexts();
}

const EVERY_KIND = [
  "Paragraph",
  "Link",
  "Image",
  "Code block",
  "Card",
  "Code cell",
  "SQL cell",
  "Site playground",
  "Math",
  "Hint",
  "Staged hint",
  "Answer",
  "Practice problem",
  "Multiple choice",
  "Fill in the blank",
];

test("the same menu on a tutorial and on a practice page", async ({ page }) => {
  // What a document is is the author's business, and front matter is
  // not a good enough guess at it: a problem set being written has no
  // `practice_for` until somebody types one, and a tutorial can end on
  // a worked answer without becoming a practice page.
  await mount(page, TUTORIAL);
  expect(await menuLabels(page, 1)).toEqual(EVERY_KIND);

  await mount(page, PRACTICE);
  expect(await menuLabels(page, 1)).toEqual(EVERY_KIND);
});

test("the menu is grouped, so eight kinds read as three short lists", async ({ page }) => {
  await mount(page, TUTORIAL);
  await openAddMenu(page, 1);
  await expect(page.locator(".dn-add-menu .dn-block-menu-group")).toHaveText(["Write", "Run", "Teach"]);
});

test("searching the menu narrows it, and an empty search says so", async ({ page }) => {
  await mount(page, TUTORIAL);
  await openAddMenu(page, 1);
  await page.locator(".dn-add-search").fill("prob");
  await expect(page.locator(".dn-add-menu .dn-block-menu-label")).toHaveText(["Practice problem"]);
  await expect(page.locator(".dn-add-empty")).toBeHidden();

  await page.locator(".dn-add-search").fill("zzz");
  await expect(page.locator(".dn-add-menu .dn-block-menu-label")).toHaveCount(0);
  await expect(page.locator(".dn-add-empty")).toBeVisible();
});

test("the search field takes Enter, so a kind is two letters away from the '+' button", async ({ page }) => {
  await mount(page, TUTORIAL);
  await openAddMenu(page, 1);
  await page.locator(".dn-add-search").fill("an");
  await page.locator(".dn-add-search").press("Enter");
  expect(await getSource(page)).toContain('<details class="dl-answer">');
});

test("a practice problem lands as the whole §6 form, in order", async ({ page }) => {
  await mount(page, PRACTICE);
  await openAddMenu(page, 1);
  await blockMenuItem(page, ".dn-add-menu", "Practice problem").click();

  const source = await getSource(page);
  // The problem, then the hint, then the answer — "two folds, opened in
  // order, so a stuck student gets a route rather than the answer".
  const problem = source.indexOf("The problem, written as a question.");
  const hint = source.indexOf('class="dl-hint"');
  const answer = source.indexOf('class="dl-answer"');
  expect(problem).toBeGreaterThan(-1);
  expect(problem).toBeLessThan(hint);
  expect(hint).toBeLessThan(answer);

  // The two prompts §6 says matter as much as the steps, so an author
  // deletes them deliberately rather than having to remember them.
  expect(source).toContain("**Think about:**");
  expect(source).toContain("**Try this next:**");
  expect(source).toContain("<summary>stuck? here are some steps</summary>");
});

test("both folds carry a class dewlab styles, which is what its build checks", async ({ page }) => {
  await mount(page, PRACTICE);
  await openAddMenu(page, 1);
  await blockMenuItem(page, ".dn-add-menu", "Practice problem").click();

  const source = await getSource(page);
  // check_folds: "a fold names no style ... use class="dl-hint" for
  // steps or class="dl-answer" for an answer". Every <details> written
  // here has to satisfy it or the page stops building.
  const details = [...source.matchAll(/<details[^>]*>/g)].map((m) => m[0]);
  expect(details.length).toBe(2);
  for (const tag of details) {
    expect(tag, `${tag} names a fold dewlab styles`).toMatch(/class="dl-(hint|answer)"/);
  }
});

test("an answer on its own, for a problem that already exists", async ({ page }) => {
  await mount(page, PRACTICE);
  await openAddMenu(page, 1);
  await blockMenuItem(page, ".dn-add-menu", "Answer").click();

  const source = await getSource(page);
  expect(source).toContain('<details class="dl-answer"><summary>answer</summary>');
  expect(source).toContain("The answer, with the working.");
  expect(source).not.toContain("dl-hint");
});

test("the slash menu offers them on an ordinary tutorial too", async ({ page }) => {
  await mount(page, TUTORIAL);
  // A fresh paragraph, then "/" — the slash menu only offers itself to a
  // block that is nothing else yet.
  await pointAt(page, 1);
  await page.locator(".dn-add-btn").click();
  await blockMenuItem(page, ".dn-add-menu", "Paragraph").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("/pr");

  const items = page.locator(".dn-slash-menu .dn-block-menu-label");
  await expect(items).toHaveText(["Site playground", "Practice problem"]);
  await expect(page.locator(".dn-slash-menu .dn-block-menu-item.is-selected .dn-block-menu-label")).toHaveText("Practice problem");
});
