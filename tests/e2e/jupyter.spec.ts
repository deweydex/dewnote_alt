// Step 6's second slice (src/jupyter.ts) — drives the real built app for
// both directions: Export ipynb writes a real .ipynb download, and
// Import ipynb reads one back through the file bar's own `<input
// type=file>` fallback (a real file chooser, not a mocked one — Playwright
// can drive that the same way it drives the markdown Open button).

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

const SOURCE = "---\ntitle: A Rule\n---\n\n# A Rule\n\nWhere it lives.\n\n```python exec\nid: first\n1 + 1\n```\n";

test.beforeEach(async ({ page }) => {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
});


async function openFileMenuThen(page: Page, selector: string) {
  const panel = page.locator(".dn-transfer-panel");
  if (!(await panel.isVisible())) {
    await page.locator(".dn-file-transfer-toggle").click();
  }
  await page.locator(selector).click();
}

test("Export ipynb downloads a real notebook with the exec cell as a code cell", async ({ page }) => {
  await dropFile(page, "a-rule.md", SOURCE);

  const [download] = await Promise.all([page.waitForEvent("download"), openFileMenuThen(page, ".dn-file-export-ipynb")]);
  expect(download.suggestedFilename()).toBe("a-rule.ipynb");

  const savedPath = await download.path();
  const notebook = JSON.parse(readFileSync(savedPath as string, "utf-8"));
  expect(notebook.nbformat).toBe(4);
  const codeCell = notebook.cells.find((c: { cell_type: string }) => c.cell_type === "code");
  expect(codeCell.id).toBe("first");
  expect(codeCell.source).toBe("1 + 1");
});

test("Import ipynb round-trips a notebook exported from dewnote back to the original markdown", async ({ page }) => {
  await dropFile(page, "a-rule.md", SOURCE);
  const [download] = await Promise.all([page.waitForEvent("download"), openFileMenuThen(page, ".dn-file-export-ipynb")]);
  const notebookPath = await download.path();
  // download.path() is a temp file under a generated name — setFiles must
  // be given the real "a-rule.ipynb" name explicitly, since the file bar
  // reads .name off the chosen File to derive the imported document's own
  // filename.
  const notebookBytes = readFileSync(notebookPath as string);

  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), openFileMenuThen(page, ".dn-file-import-ipynb")]);
  await chooser.setFiles({ name: "a-rule.ipynb", mimeType: "application/x-ipynb+json", buffer: notebookBytes });

  await expect(page.locator("h1")).toHaveText("A Rule");
  await expect(page.locator(".dn-block-fence .cm-content")).toContainText("1 + 1");
  await expect(page.locator(".dn-file-name")).toHaveText("a-rule.md");
});
