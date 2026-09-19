// A runnable fence's own header bar (decision 27): id/hint/expect/name
// render as a compact form instead of raw ```python exec/id:/hint: text,
// and the fence's own live editor holds only the code beneath them. Pure
// DOM — no Pyodide worker involved (Run itself is untested here, same
// boundary settings.spec.ts and frontmatter-form.spec.ts already draw) —
// so this belongs in the suite that runs everywhere, driving the real
// built page rather than a mock (decision 9).

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

async function mount(page: Page, source: string) {
  await page.evaluate((src) => (window as any).__dewnote.mount(src), source);
}

async function getSource(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__dewnote.getSource());
}

const TWO_CELLS = `First cell.

\`\`\`python exec
id: first-cell
1 + 1
\`\`\`

Second cell.

\`\`\`python exec
id: second-cell
2 + 2
\`\`\`
`;

const WITH_ALL_HEADERS = `\`\`\`python exec
id: filter-evening
hint: Try printing readings["evening"] > 14 on its own first.
expect: len(readings) > 0
name: readings
readings[readings["evening"] > 14]
\`\`\`
`;

test.beforeEach(async ({ page }) => {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
});

test("a runnable cell shows a language label and an id field, not raw fence text", async ({ page }) => {
  await mount(page, TWO_CELLS);
  const cell = page.locator(".dn-block-fence").first();

  await expect(cell.locator(".dn-cell-lang")).toHaveText("Python");
  await expect(cell.locator('.dn-cell-header-field:has(.dn-cell-header-label:text("id")) input')).toHaveValue(
    "first-cell",
  );
  // The raw header syntax is gone from the editable code area — only
  // the real code shows there now.
  await expect(cell.locator(".cm-content")).toHaveText("1 + 1");
  await expect(cell.locator(".cm-content")).not.toContainText("```");
  await expect(cell.locator(".cm-content")).not.toContainText("id:");
});

test("mounting and reading straight back round-trips byte for byte, no edit made", async ({ page }) => {
  await mount(page, WITH_ALL_HEADERS);
  expect(await getSource(page)).toBe(WITH_ALL_HEADERS);
});

test("editing the code itself commits normally, header lines untouched", async ({ page }) => {
  await mount(page, TWO_CELLS);
  const cell = page.locator(".dn-block-fence").first();
  await cell.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" + 1");
  await page.locator("body").click({ position: { x: 5, y: 5 } });

  const source = await getSource(page);
  expect(source).toContain("id: first-cell\n1 + 1 + 1\n");
});

test("hint starts hidden behind a + button; adding, editing, and clearing it all work", async ({ page }) => {
  await mount(page, TWO_CELLS);
  const cell = page.locator(".dn-block-fence").first();

  await expect(cell.locator(".dn-cell-header-field", { hasText: "hint" })).toHaveCount(0);
  await cell.locator(".dn-cell-header-add", { hasText: "hint" }).click();

  const hintInput = cell.locator('.dn-cell-header-field:has(.dn-cell-header-label:text("hint")) input');
  await expect(hintInput).toBeFocused();
  await hintInput.fill("Try it.");
  await hintInput.blur();
  expect(await getSource(page)).toContain("id: first-cell\nhint: Try it.\n1 + 1\n");

  // Clearing it removes the line entirely, and the + button comes back.
  await cell.locator('.dn-cell-header-field:has(.dn-cell-header-label:text("hint")) .dn-cell-header-clear').click();
  expect(await getSource(page)).not.toContain("hint:");
  await expect(cell.locator(".dn-cell-header-add", { hasText: "hint" })).toBeVisible();
});

test("adding an optional field and leaving it empty reverts to the + button on blur", async ({ page }) => {
  await mount(page, TWO_CELLS);
  const cell = page.locator(".dn-block-fence").first();
  await cell.locator(".dn-cell-header-add", { hasText: "hint" }).click();
  await cell.locator('.dn-cell-header-field:has(.dn-cell-header-label:text("hint")) input').blur();

  await expect(cell.locator(".dn-cell-header-field", { hasText: "hint" })).toHaveCount(0);
  await expect(cell.locator(".dn-cell-header-add", { hasText: "hint" })).toBeVisible();
  expect(await getSource(page)).not.toContain("hint:");
});

test("editing the code below a just-added hint doesn't lose the hint or the code", async ({ page }) => {
  // The header bar's own commit path patches only itself, leaving the
  // code's live editor untouched — checked here by actually typing in
  // the code editor right after a header edit, not just asserting the
  // final source.
  await mount(page, TWO_CELLS);
  const cell = page.locator(".dn-block-fence").first();
  await cell.locator(".dn-cell-header-add", { hasText: "hint" }).click();
  const hintInput = cell.locator('.dn-cell-header-field:has(.dn-cell-header-label:text("hint")) input');
  await hintInput.fill("A hint.");
  await hintInput.blur();

  await cell.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" + 1");
  await page.locator("body").click({ position: { x: 5, y: 5 } });

  expect(await getSource(page)).toContain("id: first-cell\nhint: A hint.\n1 + 1 + 1\n");
});

test("renaming an id asks for confirmation and applies it when accepted", async ({ page }) => {
  await mount(page, TWO_CELLS);
  page.on("dialog", (dialog) => dialog.accept());

  const cell = page.locator(".dn-block-fence").first();
  const idInput = cell.locator('.dn-cell-header-field:has(.dn-cell-header-label:text("id")) input');
  await idInput.fill("renamed-cell");
  await idInput.blur();

  expect(await getSource(page)).toContain("id: renamed-cell\n");
  expect(await getSource(page)).not.toContain("id: first-cell\n");
});

test("declining the rename confirmation leaves the old id in place", async ({ page }) => {
  await mount(page, TWO_CELLS);
  page.on("dialog", (dialog) => dialog.dismiss());

  const cell = page.locator(".dn-block-fence").first();
  const idInput = cell.locator('.dn-cell-header-field:has(.dn-cell-header-label:text("id")) input');
  await idInput.fill("renamed-cell");
  await idInput.blur();

  expect(await getSource(page)).toContain("id: first-cell\n");
  await expect(idInput).toHaveValue("first-cell");
});

test("renaming to an id another cell already uses is refused with an alert, not applied", async ({ page }) => {
  await mount(page, TWO_CELLS);
  let alertMessage = "";
  page.on("dialog", (dialog) => {
    alertMessage = dialog.message();
    dialog.accept();
  });

  const cell = page.locator(".dn-block-fence").first();
  const idInput = cell.locator('.dn-cell-header-field:has(.dn-cell-header-label:text("id")) input');
  await idInput.fill("second-cell");
  await idInput.blur();

  expect(alertMessage).toContain("second-cell");
  const source = await getSource(page);
  expect(source).toContain("id: first-cell\n");
  expect((source.match(/id: second-cell/g) ?? []).length).toBe(1);
});

test("clearing id to empty is refused — id is required and never removable", async ({ page }) => {
  await mount(page, TWO_CELLS);
  const cell = page.locator(".dn-block-fence").first();
  const idInput = cell.locator('.dn-cell-header-field:has(.dn-cell-header-label:text("id")) input');
  await idInput.fill("");
  await idInput.blur();

  expect(await getSource(page)).toContain("id: first-cell\n");
  await expect(idInput).toHaveValue("first-cell");
  await expect(cell.locator(".dn-cell-header-field", { hasText: "id" }).locator(".dn-cell-header-clear")).toHaveCount(
    0,
  );
});

test("a sql exec cell gets the same header treatment, labelled SQL", async ({ page }) => {
  await mount(page, "```sql exec\nid: total-readings\nselect count(*) from readings;\n```\n");
  const cell = page.locator(".dn-block-fence").first();
  await expect(cell.locator(".dn-cell-lang")).toHaveText("SQL");
  await expect(cell.locator(".cm-content")).toHaveText("select count(*) from readings;");
});

test("a non-exec fence is unaffected — still the plain raw editor", async ({ page }) => {
  await mount(page, "```python\nprint('illustrative, not exec')\n```\n");
  const cell = page.locator(".dn-block-fence").first();
  await expect(cell.locator(".dn-cell-header")).toHaveCount(0);
  await expect(cell.locator(".cm-content")).toContainText("```python");
});
