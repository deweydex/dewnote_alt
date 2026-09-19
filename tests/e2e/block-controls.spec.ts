// The one block-control cluster, and the bottom bar on a narrow screen.
//
// What's checked here is mostly *absence*: that there is one set of
// controls rather than one per block, that a document at rest carries no
// chrome at all, and that nothing overlaps anything. Those are the
// properties the old design failed, and they are invisible to a test
// that only asserts a button works.

import { test as base, expect, devices, chromium, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { arm, pointAt } from "./block-controls.ts";

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

async function mount(page: Page, source: string) {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
  await page.evaluate((src) => (window as unknown as { __dewnote: { mount(s: string): void } }).__dewnote.mount(src), source);
}

test("a six-block document has one set of controls, not six", async ({ page }) => {
  // The shape this replaced built a "+" gap *and* a full copy of the
  // six-item add menu above every block, plus a toolbar beside each —
  // over fifty buttons for six blocks.
  await mount(page, "One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.\n\nSix.\n");
  await expect(page.locator(".dn-block")).toHaveCount(6);
  await expect(page.locator(".dn-block-controls")).toHaveCount(1);
  await expect(page.locator(".dn-add-btn")).toHaveCount(1);
  await expect(page.locator(".dn-block-grip")).toHaveCount(1);
  await expect(page.locator(".dn-add-menu")).toHaveCount(1);
});

test("a document nobody is pointing at carries no chrome at all", async ({ page }) => {
  await mount(page, "One.\n\nTwo.\n");
  await expect(page.locator(".dn-block-controls")).toBeHidden();
});

test("the controls follow the pointer from block to block", async ({ page }) => {
  await mount(page, "One.\n\nTwo.\n\nThree.\n");
  const blocks = page.locator(".dn-block");
  const controls = page.locator(".dn-block-controls");

  await pointAt(page, 0);
  await expect(controls).toHaveAttribute("data-index", "0");
  await pointAt(page, 2);
  await expect(controls).toHaveAttribute("data-index", "2");

  // And it actually ends up beside that block. Polled rather than read
  // once: the cluster glides between blocks, so its position right after
  // it moves is mid-transition.
  const thirdBox = (await blocks.nth(2).boundingBox())!;
  await expect
    .poll(async () => Math.abs((await controls.boundingBox())!.y - thirdBox.y), { timeout: 2000 })
    .toBeLessThan(40);
});

test("the controls sit outside the text, not on top of it", async ({ page }) => {
  await mount(page, "One.\n\nTwo.\n");
  await pointAt(page, 1);
  const controls = (await page.locator(".dn-block-controls").boundingBox())!;
  const text = (await page.locator(".dn-block-render").nth(1).boundingBox())!;
  expect(controls.x + controls.width).toBeLessThanOrEqual(text.x + 1);
});

test("delete is not in the resting set — a block has to be armed first", async ({ page }) => {
  await mount(page, "One.\n\nTwo.\n");
  await pointAt(page, 0);
  await expect(page.locator(".dn-block-delete")).toBeHidden();

  await arm(page, 0);
  await expect(page.locator(".dn-block-delete")).toBeVisible();
});

test("on a narrow screen the rail is a labelled bottom bar that fits, and nothing overlaps the text", async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  await page.goto(BUILT_APP);
  await page.locator(".dn-block").first().waitFor();

  const geo = await page.evaluate(() => {
    const rail = document.querySelector(".dn-icon-rail")!;
    const railBox = rail.getBoundingClientRect();
    const text = document.querySelector(".dn-block-prose")!.getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      pageOverflow: document.documentElement.scrollWidth,
      railFits: rail.scrollWidth <= rail.clientWidth,
      railIsAtBottom: railBox.bottom >= window.innerHeight - 1,
      // The text column ends before the rail begins, in both axes — the
      // old right-hand rail sat on top of it.
      textClearOfRail: text.bottom <= railBox.top,
      labels: [...rail.querySelectorAll("button")].map((b) => (b as HTMLElement).dataset["label"]),
      smallest: Math.min(...[...rail.querySelectorAll("button")].map((b) => b.getBoundingClientRect().height)),
    };
  });

  expect(geo.pageOverflow, "the page never scrolls sideways").toBe(geo.viewport);
  expect(geo.railFits, "all four launchers fit without the bar scrolling").toBe(true);
  expect(geo.railIsAtBottom).toBe(true);
  expect(geo.textClearOfRail).toBe(true);
  // Every glyph carries a word — a row of bare glyphs is a memory test,
  // and there is no tooltip to hover on a phone.
  expect(geo.labels).toEqual(["Workspace", "Review", "Source", "Settings"]);
  expect(geo.smallest, "touch targets stay finger-sized").toBeGreaterThanOrEqual(44);

  await browser.close();
});

test("a phone gets a phone's measure, and nothing fixed sits on top of the document", async () => {
  // Before this the desktop gutter of 3rem a side ate 104px of a 390px
  // screen and left the text at 32 characters a line, where reading
  // wants 45 and up; the fixed file bar, grown taller for touch, also
  // sat on the first block.
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  await page.goto(BUILT_APP);
  await page.locator(".dn-block").first().waitFor();

  const geo = await page.evaluate(() => {
    const prose = document.querySelector(".dn-block-prose .dn-block-render")!;
    const box = prose.getBoundingClientRect();
    const probe = document.createElement("span");
    probe.style.font = getComputedStyle(prose).font;
    probe.style.position = "absolute";
    probe.style.whiteSpace = "pre";
    probe.textContent = "x".repeat(100);
    document.body.appendChild(probe);
    const per100 = probe.getBoundingClientRect().width;
    probe.remove();
    const bar = document.querySelector(".dn-file-bar")!.getBoundingClientRect();
    const first = document.querySelector(".dn-block")!.getBoundingClientRect();
    return {
      charsPerLine: Math.round((box.width / per100) * 100),
      firstBlockClearOfFileBar: first.top >= bar.bottom,
    };
  });

  // Not a precise number — a range that means "reads like a reading app
  // rather than a column of six words".
  expect(geo.charsPerLine).toBeGreaterThanOrEqual(38);
  expect(geo.charsPerLine).toBeLessThanOrEqual(60);
  expect(geo.firstBlockClearOfFileBar).toBe(true);

  await browser.close();
});
