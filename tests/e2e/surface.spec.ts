// Drives the real single-file build (dist/index.html, from `bun run
// build`) in an actual browser — decision 9's reasoning applies here
// directly: dewlab's own Milkdown traps were invisible from the API and
// found only by clicking through the real editor, not by asserting
// against a mock. Every test remounts a fresh document into the same
// already-loaded page through the window.__dewnote hook main.ts exposes
// for exactly this, rather than needing a second build or harness page.

import { addBlockAfter, arm, deleteBlock, pointAt } from "./block-controls.ts";
import { test as base, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_APP = "file://" + resolve(HERE, "../../dist/index.html") + "?legacy=1";

// An auto fixture, not a beforeEach/afterEach pair: the array it pushes
// into stays live across the whole test (setup through teardown), so an
// error thrown by an interaction in the test body itself is caught too,
// not just one from the initial page load.
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
  await page.evaluate((src) => (window as any).__dewnote.mount(src), source);
}

async function getSource(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__dewnote.getSource());
}

test.beforeEach(async ({ page }) => {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
});

test("the starter document renders — heading, cell, and hint fold all visible", async ({ page }) => {
  await expect(page.locator("h1")).toHaveText("Untitled");
  await expect(page.locator(".dn-block-fence .cm-content")).toContainText("1 + 1");
  await expect(page.locator(".dn-block-fold summary")).toHaveText("hint");
  await expect(page.locator(".dn-block-fold")).toContainText("the same one dewlab uses");
});

test("clicking a paragraph edits in place, and blurring commits the Markdown source", async ({ page }) => {
  await mount(page, "First **bold** paragraph.\n\nSecond paragraph, untouched.\n");

  const first = page.locator(".dn-block-render").first();
  await first.click();

  const source = page.locator(".dn-block-source .cm-content").first();
  await expect(source).toContainText("First bold paragraph.");
  expect(await getSource(page)).toContain("First **bold** paragraph.");

  await page.keyboard.press("End");
  await page.keyboard.type(" Edited.");
  await page.locator("body").click({ position: { x: 5, y: 5 } }); // blur

  await expect(page.locator(".dn-block-render").first().locator("strong")).toHaveText("bold");
  const finalSource = await getSource(page);
  expect(finalSource).toContain("First **bold** paragraph. Edited.");
  expect(finalSource).toContain("Second paragraph, untouched.\n");
});

test("prose edits inline rather than becoming a code-looking scrolling box", async ({ page }) => {
  await mount(page, "Answers are hidden. Indexing and slicing reward being tried rather than reasoned about.\n");
  await page.locator(".dn-block-render").click();

  const source = page.locator(".dn-block-prose-source");
  await expect(source).toBeVisible();
  const look = await source.evaluate((el) => {
    const style = getComputedStyle(el);
    const content = el.querySelector<HTMLElement>(".cm-content")!;
    const scroller = el.querySelector<HTMLElement>(".cm-scroller")!;
    return {
      background: style.backgroundColor,
      borderStyle: style.borderStyle,
      family: getComputedStyle(content).fontFamily,
      wraps: scroller.scrollWidth <= scroller.clientWidth,
    };
  });
  expect(look.background).toBe("rgba(0, 0, 0, 0)");
  expect(look.borderStyle).toBe("none");
  expect(look.family).toContain("Georgia");
  expect(look.wraps).toBe(true);
});

test("plain prose keeps its baseline and following content fixed while editing", async ({ page }) => {
  await mount(page, "A plain paragraph that wraps across the available line width without changing its place.\n\nThe next paragraph stays put.\n");
  const first = page.locator(".dn-block").first();
  const second = page.locator(".dn-block").nth(1);
  const before = await first.locator(".dn-block-render p").evaluate((element) => {
    const range = document.createRange();
    const text = element.firstChild!;
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const glyph = range.getBoundingClientRect();
    return { x: glyph.x, y: glyph.y, blockHeight: element.closest(".dn-block")!.getBoundingClientRect().height };
  });
  const nextBefore = await second.evaluate((element) => element.getBoundingClientRect().y);

  await first.locator(".dn-block-render").click();

  const after = await first.locator(".cm-line").first().evaluate((element) => {
    const range = document.createRange();
    const text = element.firstChild!;
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const glyph = range.getBoundingClientRect();
    return { x: glyph.x, y: glyph.y, blockHeight: element.closest(".dn-block")!.getBoundingClientRect().height };
  });
  const nextAfter = await second.evaluate((element) => element.getBoundingClientRect().y);

  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(after.blockHeight - before.blockHeight)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(nextAfter - nextBefore)).toBeLessThanOrEqual(0.5);
});

test("inactive inline Markdown stays folded instead of reflowing the paragraph", async ({ page }) => {
  await mount(page, "Read **carefully** and use [the guide](https://example.com/a/very/long/url/that/used/to/reflow/the/whole/paragraph) before continuing with the exercise.\n\nFollowing paragraph.\n");
  const first = page.locator(".dn-block").first();
  const second = page.locator(".dn-block").nth(1);
  const beforeHeight = await first.evaluate((element) => element.getBoundingClientRect().height);
  const nextBefore = await second.evaluate((element) => element.getBoundingClientRect().y);

  await first.locator(".dn-block-render").click();

  await expect(first.locator(".cm-content")).not.toContainText("https://example.com");
  await expect(first.locator(".dn-md-strong")).toHaveText("carefully");
  await expect(first.locator(".dn-md-link")).toHaveText("the guide");
  const afterHeight = await first.evaluate((element) => element.getBoundingClientRect().height);
  const nextAfter = await second.evaluate((element) => element.getBoundingClientRect().y);
  expect(Math.abs(afterHeight - beforeHeight)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(nextAfter - nextBefore)).toBeLessThanOrEqual(0.5);
});

test("an answer summary opens the rendered fold; editing exposes its body, not its HTML wrapper", async ({ page }) => {
  const source = '<details class="dl-answer"><summary>answer</summary>\n\nThe **answer** is 4.\n\n</details>\n';
  await mount(page, source);

  const details = page.locator(".dn-block-fold details");
  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open", "");
  await expect(details.locator("strong")).toHaveText("answer");
  await expect(page.locator(".dn-block-fold .cm-editor")).toHaveCount(0);

  await details.locator("p").click();
  await expect(page.locator(".dn-fold-editor summary")).toHaveText("answer");
  const body = page.locator(".dn-fold-body-source .cm-content");
  await expect(body).toContainText("The **answer** is 4.");
  await expect(body).not.toContainText("<details");
  await expect(body).not.toContainText("</details>");

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Exactly.");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  expect(await getSource(page)).toBe(
    '<details class="dl-answer"><summary>answer</summary>\n\nThe **answer** is 4. Exactly.\n\n</details>\n',
  );
});

test("Python cells show syntax colours and a visible caret on the dark theme", async ({ page }) => {
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await mount(page, "```python exec\nid: indexing-and-slicing-1\nxs = [10, 20]\nprint(xs[0])\n```\n");

  const code = page.locator(".dn-cell-code .cm-content");
  await code.click();
  const colours = await code.locator("span").evaluateAll((spans) =>
    [...new Set(spans.map((span) => getComputedStyle(span).color))],
  );
  expect(colours.length).toBeGreaterThan(1);

  await expect(page.locator(".dn-cell-code .cm-editor")).toHaveClass(/cm-focused/);
  const caret = await code.evaluate((el) => getComputedStyle(el).caretColor);
  expect(caret).not.toBe("auto");
  expect(caret).not.toBe("rgba(0, 0, 0, 0)");
});

test("editing one fence and then focusing a second preserves both, not just the last one focused", async ({
  page,
}) => {
  const doc = "```python exec\nid: a\n1\n```\n\n```python exec\nid: b\n2\n```\n";
  await mount(page, doc);

  const cells = page.locator(".dn-block-fence .cm-content");
  await expect(cells).toHaveCount(2);

  await cells.nth(0).click();
  await page.keyboard.press("End");
  await page.keyboard.type("11");

  await cells.nth(1).click(); // blurs the first, committing it, before this one is edited
  await page.keyboard.press("End");
  await page.keyboard.type("22");

  await page.locator("body").click({ position: { x: 5, y: 5 } }); // blur the second

  const finalSource = await getSource(page);
  expect(finalSource).toContain("id: a\n111\n");
  expect(finalSource).toContain("id: b\n222\n");
});

test("delete removes exactly the targeted block", async ({ page }) => {
  await mount(page, "One.\n\nTwo.\n\nThree.\n");
  // Two steps: delete isn't in the resting control set, so a block has
  // to be armed before it can go.
  await deleteBlock(page, 1);

  const finalSource = await getSource(page);
  expect(finalSource).toBe("One.\n\nThree.\n");
});

test("a fence can be deleted like any other block, not just a prose one", async ({ page }) => {
  // A fence doesn't own a trailing blank line the way a prose block does
  // (blocks.ts), so the blank line between it and "Three." is its own
  // separate block — deleting only the fence correctly leaves that
  // blank-line block behind rather than collapsing the gap. Byte-precise
  // deletion, checked directly rather than assumed: three newlines
  // between "One." and "Three." after this, not two.
  await mount(page, "One.\n\n```python exec\nid: a\n1\n```\n\nThree.\n");
  await deleteBlock(page, 1);

  const finalSource = await getSource(page);
  expect(finalSource).toBe("One.\n\n\nThree.\n");
});

test("the orphan blank-line block a fence leaves behind is hoverable and deletable, not an invisible dead spot", async ({
  page,
}) => {
  // render-block.ts's BLANK_LINE_PREVIEW is the fix: without it this block
  // renders to zero height and there is nothing for a mouse to hover to
  // reach its own delete button, even though it is a real, addressable
  // block in the document (PLAN.md §6 step 2's own "still open" note).
  await mount(page, "```python exec\nid: a\n1\n```\n\nAfter.\n");
  const blank = page.locator(".dn-block-prose").first();
  const box = await blank.boundingBox();
  expect(box?.height).toBeGreaterThan(0);

  // The blank block is index 1 — the fence, then the blank line it left
  // behind. Deleting it still means arming it first.
  await deleteBlock(page, 1);

  const finalSource = await getSource(page);
  expect(finalSource).toBe("```python exec\nid: a\n1\n```\nAfter.\n");
});

test("the grip arms a block, and arrow keys reorder it while armed", async ({ page }) => {
  await mount(page, "One.\n\nTwo.\n\nThree.\n");
  const blocks = page.locator(".dn-block");
  // One grip, wherever the controls currently are — not one per block.
  const grip = page.locator(".dn-block-grip");

  await pointAt(page, 1);
  await expect(grip).toHaveAttribute("aria-pressed", "false");
  await grip.click();
  await expect(grip).toHaveAttribute("aria-pressed", "true");
  await expect(blocks.nth(1)).toHaveClass(/is-armed/);

  await grip.press("ArrowUp");
  expect(await getSource(page)).toBe("Two.\n\nOne.\n\nThree.\n");
  // moveBlock re-arms the block at its new position and refocuses the grip.
  await expect(blocks.nth(0)).toHaveClass(/is-armed/);
  await expect(grip).toBeFocused();

  await grip.press("ArrowDown");
  expect(await getSource(page)).toBe("One.\n\nTwo.\n\nThree.\n");

  await grip.press("Escape");
  await expect(blocks.nth(1)).not.toHaveClass(/is-armed/);
});

test("clicking outside the armed block disarms it", async ({ page }) => {
  await mount(page, "One.\n\nTwo.\n");
  const blocks = page.locator(".dn-block");
  await arm(page, 0);

  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect(blocks.nth(0)).not.toHaveClass(/is-armed/);
});

test("dragging a block by its grip drops it in just before the target", async ({ page }) => {
  // Arming is no longer a precondition for dragging. It was, because the
  // whole block used to be the draggable element and a stray drag would
  // have fought text selection; the grip is a deliberate handle, so it
  // drags directly.
  await mount(page, "One.\n\nTwo.\n\nThree.\n");
  const blocks = page.locator(".dn-block");
  await pointAt(page, 0);
  await page.locator(".dn-block-grip").dragTo(blocks.nth(2));
  expect(await getSource(page)).toBe("Two.\n\nOne.\n\nThree.\n");
});

test("front matter never gets move controls, and nothing can be moved above it", async ({ page }) => {
  // No blank line between the closing "---" and "One." — with one there,
  // extractFrontMatter's own trailing blank line and the gap's own blank
  // line would be two different things, and the gap would parse as its
  // own orphan prose block sitting between front matter and "One."
  // (checked directly; a fence leaves the same kind of orphan behind
  // when it isn't followed immediately by more content — see the delete
  // test above). That would make "One." adjacent to the orphan block,
  // not to front matter, and moving it up would swap two ordinary
  // blocks rather than test the constraint this test is actually for.
  await mount(page, "---\ntitle: A doc\n---\nOne.\n\nTwo.\n");
  const frontMatterBlock = page.locator(".dn-block-frontmatter");

  // Pointing at front matter brings the controls, but with no grip: it
  // stays first, so there is nothing to drag it by. The "+" is still
  // there, and is how the top of the body is reached.
  await pointAt(page, 0);
  await expect(page.locator(".dn-add-btn")).toBeVisible();
  await expect(page.locator(".dn-block-grip")).toBeHidden();
  await expect(page.locator(".dn-block-delete")).toBeHidden();

  // "One." can still be dragged, but dropping it onto front matter — or
  // anywhere above it — clamps to right after front matter, per
  // moveBlockTo's own minIndex rule, so nothing actually moves here.
  await pointAt(page, 1);
  await page.locator(".dn-block-grip").dragTo(frontMatterBlock);
  expect(await getSource(page)).toBe("---\ntitle: A doc\n---\nOne.\n\nTwo.\n");
});

test("the add control offers more than a paragraph — a code cell is live and focused as soon as it's added", async ({
  page,
}) => {
  await mount(page, "One.\n\nTwo.\n");
  await addBlockAfter(page, 0, "Code cell");

  const finalSource = await getSource(page);
  expect(finalSource).toContain("```python exec\nid: new-cell-1\n");
  // The new cell is a live editor already focused, not a second click away.
  await page.keyboard.type("42");
  expect(await getSource(page)).toContain("id: new-cell-1\n42\n");
});

test("the add control inserts a new paragraph between the two blocks it sits between", async ({ page }) => {
  await mount(page, "One.\n\nThree.\n");
  await addBlockAfter(page, 0, "Paragraph");

  const finalSource = await getSource(page);
  expect(finalSource).toBe("One.\n\nNew paragraph.\n\nThree.\n");
});

test("a real dewlab tutorial round-trips byte for byte through the mounted DOM, untouched", async ({ page }) => {
  const fixturePath = join(HERE, "../../fixtures/dewlab/computational-methods__three-ways-to-make-change.md");
  const original = readFileSync(fixturePath, "utf8");
  await mount(page, original);
  const roundTripped = await getSource(page);
  expect(roundTripped).toBe(original);
});

// A SQL cell's persist restore is pure DOM/localStorage — it never calls
// pyodide-engine.ts (only Run and Reset do), so unlike tests/e2e/pyodide.spec.ts
// this needs no real network and belongs in the suite that runs everywhere.
test.describe("a persisted SQL cell's Restore banner", () => {
  test("appears only for a persist cell with a saved script, and never otherwise", async ({ page }) => {
    await page.evaluate(() => localStorage.setItem("dewnote-sql:totals", "SELECT 2;"));

    await mount(page, "```sql cell=totals persist\nSELECT 1;\n```\n");
    await expect(page.locator(".dn-sql-restore")).toBeVisible();

    // A different cell name never sees another cell's saved script.
    await mount(page, "```sql cell=other persist\nSELECT 1;\n```\n");
    await expect(page.locator(".dn-sql-restore")).toBeHidden();

    // No persist flag at all, even with a saved entry sitting there.
    await mount(page, "```sql cell=totals\nSELECT 1;\n```\n");
    await expect(page.locator(".dn-sql-restore")).toBeHidden();
  });

  test("replaces only the fence's body, keeping the opening and closing lines exactly as authored", async ({
    page,
  }) => {
    await page.evaluate(() => localStorage.setItem("dewnote-sql:totals", "SELECT 'saved';"));
    await mount(page, "```sql cell=totals persist\nSELECT 'authored';\n```\n");

    await page.locator(".dn-sql-restore-button").click();
    await expect(page.locator(".dn-sql-restore")).toBeHidden();
    await expect(page.locator(".dn-block-fence .cm-content")).toContainText("SELECT 'saved';");
    await expect(page.locator(".dn-block-fence .cm-content")).not.toContainText("authored");

    // Blurring commits it like any other edit — the info string (and its
    // own persist flag) is untouched, only the SQL script changed.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    expect(await getSource(page)).toBe("```sql cell=totals persist\nSELECT 'saved';\n```\n");
  });
});
