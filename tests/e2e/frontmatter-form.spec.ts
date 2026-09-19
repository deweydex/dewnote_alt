// The front-matter form (decision 11): a dewlab or dewstack document's
// front matter gets a per-field form instead of raw YAML, built from
// src/frontmatter-fields.ts's own dialect field lists. This is pure DOM —
// no Pyodide worker involved — so, like surface.spec.ts, it belongs in
// the suite that runs everywhere and drives the real built page rather
// than a mock (decision 9).

import { test as base, expect, type Page } from "@playwright/test";
import { selectPanel } from "./panel-helpers.ts";
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

const DEWLAB_DOC = `---
title: Filtering rows
slug: filter-evening
module: pandas-basics
module_title: Pandas basics
year: "2026"
series: core
version: 2026.09.04.1
packages: [sympy]
---

# Filtering rows

Body text.
`;

const DEWSTACK_DOC = `---
title: A page
slug: a-page
module: web-basics
module_title: Web basics
series: core
version: 2026.09.04.1
---

Body text.
`;

test.beforeEach(async ({ page }) => {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
});

test("clicking a dewlab document's front matter opens a form, not raw YAML", async ({ page }) => {
  await mount(page, DEWLAB_DOC);
  await page.locator(".dn-block-frontmatter .dn-block-render").click();

  const form = page.locator(".dn-frontmatter-form");
  await expect(form).toBeVisible();
  await expect(page.locator(".dn-block-frontmatter .cm-editor")).toHaveCount(0);

  for (const label of ["Title", "Year", "Version"]) {
    await expect(
      form.locator(".dn-frontmatter-row").filter({ has: page.locator(".dn-frontmatter-label", { hasText: new RegExp(`^${label}$`) }) }).locator('input[type="text"]'),
    ).toBeVisible();
  }
  // packages is a list — no row for it, only the raw fallback covers it.
  await expect(form.locator(".dn-frontmatter-row", { hasText: "packages" })).toHaveCount(0);

  // Placement is not front matter any more: the id comes from the path
  // and the module listing from modules/*.yaml, so a row for any of
  // these would offer to set something dewlab's build ignores.
  for (const gone of ["Slug", "Module", "Module title", "Series"]) {
    await expect(
      form.locator(".dn-frontmatter-row").filter({ has: page.locator(".dn-frontmatter-label", { hasText: new RegExp(`^${gone}$`) }) }),
    ).toHaveCount(0);
  }
});

test("editing a required field commits on change, touching only that line", async ({ page }) => {
  await mount(page, DEWLAB_DOC);
  await page.locator(".dn-block-frontmatter .dn-block-render").click();

  const titleInput = page
    .locator(".dn-frontmatter-row")
    .filter({ has: page.locator(".dn-frontmatter-label", { hasText: /^Title$/ }) })
    .locator('input[type="text"]');
  await titleInput.fill("Filtering evening rows");
  await titleInput.blur();

  const source = await getSource(page);
  expect(source).toContain("title: Filtering evening rows\n");
  expect(source).toContain('year: "2026"\n');
  expect(source).toContain("packages: [sympy]\n");
  expect(source).toContain("Body text.\n");
});

test("status starts hidden behind a + button, and adding it shows a live/archived select for dewlab", async ({
  page,
}) => {
  await mount(page, DEWLAB_DOC);
  await page.locator(".dn-block-frontmatter .dn-block-render").click();

  const form = page.locator(".dn-frontmatter-form");
  await expect(form.locator(".dn-frontmatter-row", { hasText: "Status" })).toHaveCount(0);

  await form.locator(".dn-frontmatter-add-field", { hasText: "Status" }).click();
  const statusRow = form.locator(".dn-frontmatter-row", { hasText: "Status" });
  await expect(statusRow).toBeVisible();
  const select = statusRow.locator("select");
  await expect(select).toHaveValue("live");
  await expect(select.locator("option")).toHaveText(["Live", "Archived"]);

  await select.selectOption("archived");
  expect(await getSource(page)).toContain("status: archived\n");
});

test("clearing an optional field removes its line entirely", async ({ page }) => {
  const withStatus = DEWLAB_DOC.replace("packages: [sympy]\n", "packages: [sympy]\nstatus: live\n");
  await mount(page, withStatus);
  await page.locator(".dn-block-frontmatter .dn-block-render").click();

  const statusRow = page.locator(".dn-frontmatter-row", { hasText: "Status" });
  await statusRow.locator(".dn-frontmatter-clear").click();

  expect(await getSource(page)).not.toContain("status:");
  await expect(page.locator(".dn-frontmatter-row", { hasText: "Status" })).toHaveCount(0);
});

test("dewstack's status field offers live/draft, not live/archived", async ({ page }) => {
  await mount(page, DEWSTACK_DOC);
  await page.locator(".dn-block-frontmatter .dn-block-render").click();
  await page.locator(".dn-frontmatter-add-field", { hasText: "Status" }).click();

  const select = page.locator('.dn-frontmatter-row:has-text("Status") select');
  await expect(select.locator("option")).toHaveText(["Live", "Draft"]);
});

test("Edit raw YAML falls back to the plain source editor, and Done returns to the form", async ({ page }) => {
  await mount(page, DEWLAB_DOC);
  await page.locator(".dn-block-frontmatter .dn-block-render").click();

  await page.locator(".dn-frontmatter-raw-toggle").click();
  await expect(page.locator(".dn-frontmatter-form")).toHaveCount(0);
  const rawEditor = page.locator(".dn-block-frontmatter .cm-content");
  await expect(rawEditor).toBeVisible();
  await expect(rawEditor).toContainText("packages: [sympy]");

  // Editing the raw text still commits through the ordinary blur path.
  await rawEditor.click();
  await page.keyboard.press("End");
  await page.keyboard.type("\ncovers: {}");
  await page.locator(".dn-block-frontmatter").blur();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  expect(await getSource(page)).toContain("covers: {}");
});

test("Done collapses the form back to the one-line summary", async ({ page }) => {
  await mount(page, DEWLAB_DOC);
  await page.locator(".dn-block-frontmatter .dn-block-render").click();
  await expect(page.locator(".dn-frontmatter-form")).toBeVisible();

  await page.locator(".dn-frontmatter-done").click();
  await expect(page.locator(".dn-frontmatter-form")).toHaveCount(0);
  await expect(page.locator(".dn-frontmatter-summary")).toBeVisible();
});

test("plain markdown's front matter has no dialect field list, so it opens straight to raw YAML", async ({
  page,
}) => {
  await mount(page, "---\ntitle: A note\ncreated: \"2026-01-01T00:00:00Z\"\n---\n\nBody.\n");
  await page.locator(".dn-block-frontmatter .dn-block-render").click();

  await expect(page.locator(".dn-frontmatter-form")).toHaveCount(0);
  await expect(page.locator(".dn-block-frontmatter .cm-content")).toContainText("created:");
});

// Decision 11's own "module and series are a picker over the index, not
// free text" — file-index.ts's distinctValues, once a folder is open,
// drives a plain <datalist> on each field's own text input. Stubs
// window.showDirectoryPicker the same way folder-panel.spec.ts does,
// since Playwright has no scriptable equivalent of the OS picker.
// dewstack, not dewlab: dewlab's form has no module or series row any
// more (placement moved to modules/), but dewstack still places a
// tutorial from its own front matter, and decision 11's picker over the
// shared index is exactly what those two rows are for.
test("dewstack's module and series offer autocomplete suggestions once a folder's own index exists", async ({ page }) => {
  await page.addInitScript(() => {
    function fakeFileHandle(name: string, content: string) {
      return {
        kind: "file",
        name,
        async getFile() {
          return { text: async () => content };
        },
      };
    }
    function fakeDirHandle(name: string, entries: Record<string, unknown>) {
      return {
        kind: "directory",
        name,
        async *entries() {
          for (const [key, value] of Object.entries(entries)) yield [key, value];
        },
      };
    }
    const root = fakeDirHandle("tutorials", {
      "first.md": fakeFileHandle(
        "first.md",
        "---\ntitle: First\nslug: first\nmodule: pandas-basics\nmodule_title: Pandas basics\nyear: \"2026\"\nseries: core\nversion: 2026.09.04.1\n---\n\nBody.\n",
      ),
      "second.md": fakeFileHandle(
        "second.md",
        "---\ntitle: Second\nslug: second\nmodule: sql-basics\nmodule_title: SQL basics\nyear: \"2026\"\nseries: advanced\nversion: 2026.09.04.1\n---\n\nBody.\n",
      ),
    });
    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = async () => root;
  });
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();

  await selectPanel(page, ".dn-folder-toggle");
  await page.locator(".dn-folder-open").click();
  await expect(page.locator(".dn-folder-file")).toHaveCount(2);
  await page.locator(".dn-folder-close").click();

  // A document mounted independently of the folder still sees the same
  // shared index — file-index.ts is a module-level singleton in app.ts,
  // not something threaded through a particular open file.
  await mount(page, DEWSTACK_DOC);
  await page.locator(".dn-block-frontmatter .dn-block-render").click();

  const moduleInput = page
    .locator(".dn-frontmatter-row")
    .filter({ has: page.locator(".dn-frontmatter-label", { hasText: /^Module$/ }) })
    .locator('input[type="text"]');
  const moduleListId = await moduleInput.getAttribute("list");
  expect(moduleListId).toBeTruthy();
  const moduleOptions = await page.locator(`datalist#${moduleListId} option`).evaluateAll((els) =>
    els.map((el) => (el as HTMLOptionElement).value),
  );
  expect(moduleOptions).toEqual(["pandas-basics", "sql-basics"]);

  const seriesInput = page
    .locator(".dn-frontmatter-row")
    .filter({ has: page.locator(".dn-frontmatter-label", { hasText: /^Series$/ }) })
    .locator('input[type="text"]');
  const seriesListId = await seriesInput.getAttribute("list");
  const seriesOptions = await page.locator(`datalist#${seriesListId} option`).evaluateAll((els) =>
    els.map((el) => (el as HTMLOptionElement).value),
  );
  expect(seriesOptions).toEqual(["advanced", "core"]);

  // The datalist suggests; it never restricts — typing a brand-new value
  // still commits normally (decision 11's own "new" escape hatch).
  await moduleInput.fill("brand-new-module");
  await moduleInput.blur();
  expect(await getSource(page)).toContain("module: brand-new-module\n");
});

// decision 33: practice_for is the one optional *text* field in either
// dialect's list, so it's the only thing exercising the "+ field" reveal
// path status's own tests (above) never touch — a select field commits
// a real default the instant it's added; a text field has nothing to
// seed itself with, so "+" only reveals an empty row.
test("practice_for starts hidden behind a + button, and adding it reveals an empty, focused row", async ({ page }) => {
  await mount(page, DEWLAB_DOC);
  await page.locator(".dn-block-frontmatter .dn-block-render").click();

  const form = page.locator(".dn-frontmatter-form");
  await expect(form.locator(".dn-frontmatter-row", { hasText: "Practice for" })).toHaveCount(0);

  await form.locator(".dn-frontmatter-add-field", { hasText: "Practice for" }).click();
  const row = form.locator(".dn-frontmatter-row", { hasText: "Practice for" });
  await expect(row).toBeVisible();
  const input = row.locator('input[type="text"]');
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();

  // Nothing has actually been written yet — revealing the row is not
  // the same as committing a value to it.
  expect(await getSource(page)).not.toContain("practice_for");
});

test("clearing a revealed-but-empty practice_for row collapses it back to the + button, with nothing ever committed", async ({
  page,
}) => {
  await mount(page, DEWLAB_DOC);
  await page.locator(".dn-block-frontmatter .dn-block-render").click();
  const form = page.locator(".dn-frontmatter-form");
  await form.locator(".dn-frontmatter-add-field", { hasText: "Practice for" }).click();

  await form.locator(".dn-frontmatter-row", { hasText: "Practice for" }).locator(".dn-frontmatter-clear").click();

  await expect(form.locator(".dn-frontmatter-row", { hasText: "Practice for" })).toHaveCount(0);
  await expect(form.locator(".dn-frontmatter-add-field", { hasText: "Practice for" })).toBeVisible();
  expect(await getSource(page)).not.toContain("practice_for");
});

test("typing a practice_for value commits it, and clearing it afterward removes the line and re-collapses", async ({
  page,
}) => {
  await mount(page, DEWLAB_DOC);
  await page.locator(".dn-block-frontmatter .dn-block-render").click();
  const form = page.locator(".dn-frontmatter-form");
  await form.locator(".dn-frontmatter-add-field", { hasText: "Practice for" }).click();

  const row = form.locator(".dn-frontmatter-row", { hasText: "Practice for" });
  await row.locator('input[type="text"]').fill("filter-morning");
  await row.locator('input[type="text"]').blur();
  expect(await getSource(page)).toContain("practice_for: filter-morning\n");

  await row.locator(".dn-frontmatter-clear").click();
  expect(await getSource(page)).not.toContain("practice_for");
  await expect(form.locator(".dn-frontmatter-row", { hasText: "Practice for" })).toHaveCount(0);
});

test("practice_for offers autocomplete over every real id in the open folder's index", async ({ page }) => {
  await page.addInitScript(() => {
    function fakeFileHandle(name: string, content: string) {
      return {
        kind: "file",
        name,
        async getFile() {
          return { text: async () => content };
        },
      };
    }
    function fakeDirHandle(name: string, entries: Record<string, unknown>) {
      return {
        kind: "directory",
        name,
        async *entries() {
          for (const [key, value] of Object.entries(entries)) yield [key, value];
        },
      };
    }
    // dewlab's own layout: the id is the folder, and the folder is the
    // file's stem. Nothing in the front matter names it.
    const root = fakeDirHandle("tutorials", {
      "filter-morning": fakeDirHandle("filter-morning", {
        "filter-morning.md": fakeFileHandle(
          "filter-morning.md",
          "---\ntitle: First\nyear: \"2026\"\nversion: 2026.09.04.1\n---\n\nBody.\n",
        ),
      }),
      "filter-evening": fakeDirHandle("filter-evening", {
        "filter-evening.md": fakeFileHandle(
          "filter-evening.md",
          "---\ntitle: Second\nyear: \"2026\"\nversion: 2026.09.04.1\n---\n\nBody.\n",
        ),
      }),
    });
    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = async () => root;
  });
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();

  await selectPanel(page, ".dn-folder-toggle");
  await page.locator(".dn-folder-open").click();
  await expect(page.locator(".dn-folder-file")).toHaveCount(2);
  await page.locator(".dn-folder-close").click();

  await mount(page, DEWLAB_DOC);
  await page.locator(".dn-block-frontmatter .dn-block-render").click();
  const form = page.locator(".dn-frontmatter-form");
  await form.locator(".dn-frontmatter-add-field", { hasText: "Practice for" }).click();

  const input = form.locator(".dn-frontmatter-row", { hasText: "Practice for" }).locator('input[type="text"]');
  const listId = await input.getAttribute("list");
  expect(listId).toBeTruthy();
  const options = await page
    .locator(`datalist#${listId} option`)
    .evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value));
  expect(options).toEqual(["filter-evening", "filter-morning"]);
});
