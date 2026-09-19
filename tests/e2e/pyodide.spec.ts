// Runs real Python (and real SQL, via Pyodide's own sqlite3), in a real
// browser, through the actual single-file build's Worker + Blob-URL +
// CDN-loaded Pyodide chain — decision 9's reasoning applies at full
// force here: nothing before this test (not typecheck, not a unit test
// stubbing pyodide.code — or, for SQL, running dewnote_sql_tools.py
// directly under plain CPython's own sqlite3) has exercised any of the
// Worker/Blob-URL/real-Pyodide machinery this feature actually depends
// on. A cold Pyodide boot plus whatever a given cell's own imports need
// (numpy, pandas, matplotlib — loaded on demand by loadPackagesFromImports;
// sqlite3, loaded on demand by the first SQL cell — neither eagerly at
// boot, see worker-source.ts) takes real seconds over a real network,
// hence the generous timeouts.
//
// One test, one page, one cold boot: mounting a second document into an
// already-loaded page (this file's `mount`, same as surface.spec.ts's)
// swaps the DOM but not the running Pyodide worker underneath it, so
// splitting these scenarios into separate tests would just pay for a
// fresh multi-second boot per scenario for no extra coverage.

import { test as base, expect, type Page } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_APP = "file://" + resolve(HERE, "../../dist/index.html") + "?legacy=1";
const COLD_BOOT_TIMEOUT = 150_000;

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

test("a real exec cell runs in a real browser: output, errors, and shared state", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();

  await test.step("print() and a trailing expression both appear as real Pyodide output", async () => {
    await mount(page, '```python exec\nid: hello\nprint("hello from pyodide")\n1 + 1\n```\n');
    const cell = page.locator(".dn-block-fence");
    await cell.locator(".dn-cell-run").click();

    const output = cell.locator(".dn-cell-output");
    await expect(output).toContainText("hello from pyodide", { timeout: COLD_BOOT_TIMEOUT });
    await expect(output.locator(".dn-repr")).toHaveText("2");
    await expect(cell.locator(".dn-cell-run")).toHaveText("Run");
  });

  await test.step("an uncaught exception renders a trimmed traceback, not this app's own plumbing", async () => {
    await mount(page, "```python exec\nid: boom\n1 / 0\n```\n");
    const errorOutput = page.locator(".dn-block-fence .dn-cell-output .dn-error");
    await page.locator(".dn-block-fence .dn-cell-run").click();

    await expect(errorOutput).toContainText("ZeroDivisionError", { timeout: COLD_BOOT_TIMEOUT });
    await expect(errorOutput).toContainText("<cell boom>");
    await expect(errorOutput).not.toContainText("eval_code_async");
  });

  await test.step("two cells share one namespace, like a notebook", async () => {
    await mount(page, "```python exec\nid: setup\ntotal = 40\n```\n\n```python exec\nid: reader\nprint(total + 2)\n```\n");
    const cells = page.locator(".dn-block-fence");
    await cells.nth(0).locator(".dn-cell-run").click();
    await expect(cells.nth(0).locator(".dn-cell-run")).toHaveText("Run");

    await cells.nth(1).locator(".dn-cell-run").click();
    await expect(cells.nth(1).locator(".dn-cell-output")).toContainText("42");
  });

  await test.step("Stop recovers an infinite loop — terminate-and-restart, since file:// has no cross-origin isolation", async () => {
    // canStop()'s SharedArrayBuffer path never applies under file://, so
    // this exercises pyodide-engine.ts's other branch: worker.terminate()
    // and a fresh interpreter next run. The Run button, not the loop
    // itself, is the thing this test can observe finishing.
    await mount(page, "```python exec\nid: loop\nwhile True:\n    pass\n```\n");
    const cell = page.locator(".dn-block-fence");
    await cell.locator(".dn-cell-run").click();
    await expect(cell.locator(".dn-cell-stop")).toBeEnabled({ timeout: COLD_BOOT_TIMEOUT });

    await cell.locator(".dn-cell-stop").click();
    await expect(cell.locator(".dn-cell-run")).toHaveText("Run", { timeout: 30_000 });
    await expect(cell.locator(".dn-cell-output .dn-error")).toContainText("restarted");

    // The interpreter really did restart, not just recover cosmetically:
    // a cell that depended on the loop cell's own state would find it
    // gone, but a fresh cell still runs.
    await mount(page, '```python exec\nid: after\nprint("back")\n```\n');
    await page.locator(".dn-block-fence .dn-cell-run").click();
    await expect(page.locator(".dn-cell-output")).toContainText("back", { timeout: COLD_BOOT_TIMEOUT });
  });

  await test.step("a SQL cell creates a table, a second cell sharing its name queries it, and Reset drops it", async () => {
    await mount(
      page,
      "```sql cell=products\nCREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT);\nINSERT INTO products (name) VALUES ('Mug'), ('Notebook');\n```\n\n```sql cell=products\nSELECT name FROM products ORDER BY name;\n```\n",
    );
    const cells = page.locator(".dn-block-fence");

    await cells.nth(0).locator(".dn-sql-run").click();
    // sqlite3 loads on this cold path too (its own loadPackage call,
    // separate from loadPackagesFromImports), so the same generous
    // timeout applies even though the interpreter itself is already booted.
    await expect(cells.nth(0).locator(".dn-sql-output")).toContainText("2 row(s) affected", {
      timeout: COLD_BOOT_TIMEOUT,
    });

    await cells.nth(1).locator(".dn-sql-run").click();
    const secondOutput = cells.nth(1).locator(".dn-sql-output");
    await expect(secondOutput.locator("table")).toBeVisible();
    await expect(secondOutput).toContainText("Mug");
    await expect(secondOutput).toContainText("Notebook");

    await cells.nth(0).locator(".dn-sql-reset").click();
    await expect(cells.nth(0).locator(".dn-sql-output")).toBeEmpty();

    await cells.nth(1).locator(".dn-sql-run").click();
    await expect(cells.nth(1).locator(".dn-sql-output .dn-error")).toContainText("no such table");
  });

  await test.step("a SQL error renders as dn-error, and NULL/HTML values are handled safely", async () => {
    await mount(page, "```sql cell=bad\nSELECT * FROM nope;\n```\n");
    await page.locator(".dn-block-fence .dn-sql-run").click();
    await expect(page.locator(".dn-sql-output .dn-error")).toContainText("no such table");

    await mount(
      page,
      "```sql cell=escaping\nCREATE TABLE t (label TEXT, note TEXT);\nINSERT INTO t VALUES ('<b>hi</b>', NULL);\nSELECT label, note FROM t;\n```\n",
    );
    await page.locator(".dn-block-fence .dn-sql-run").click();
    const output = page.locator(".dn-sql-output");
    await expect(output.locator("td").first()).toHaveText("<b>hi</b>");
    await expect(output.locator("b")).toHaveCount(0); // escaped, never rendered as a real tag
  });

  await test.step("an exec cell reads a SQL cell's table with read_sql, as a real pandas DataFrame", async () => {
    await mount(
      page,
      "```sql cell=inventory\nCREATE TABLE inventory (item TEXT, qty INTEGER);\nINSERT INTO inventory VALUES ('Mug', 4), ('Notebook', 9);\n```\n\n```python exec\nid: reader\ndf = read_sql('inventory', 'SELECT item, qty FROM inventory ORDER BY item')\ndf\n```\n",
    );
    await page.locator(".dn-block-fence .dn-sql-run").click();
    await expect(page.locator(".dn-sql-output")).toContainText("2 row(s) affected", { timeout: COLD_BOOT_TIMEOUT });

    const pyCell = page.locator(".dn-block-fence").nth(1);
    await pyCell.locator(".dn-cell-run").click();
    const output = pyCell.locator(".dn-cell-output");
    // pandas loads on this path too (read_sql's own dependency, not
    // something the cell's own code imports for loadPackagesFromImports
    // to see), hence the generous timeout despite everything else
    // already being booted.
    await expect(output.locator("table")).toBeVisible({ timeout: COLD_BOOT_TIMEOUT });
    await expect(output).toContainText("Mug");
    await expect(output).toContainText("Notebook");
  });

  await test.step("a sql exec cell runs against the one shared db, and a python exec cell after it sees the same connection", async () => {
    // Plan §8 item 1's own "done when": dewlab's sql exec (DIALECTS.md
    // §1), not dewstack's `sql cell=name` — one page-wide connection
    // every exec cell shares, not a per-name one. wrapSqlExecCode
    // (cell.ts) is what turns the fence's raw SQL into the Python
    // app.ts actually sends; this only ever exercises that through the
    // real Run button, never by calling it directly.
    await mount(
      page,
      "```sql exec\nid: seed\nCREATE TABLE widgets (name TEXT);\nINSERT INTO widgets VALUES ('gizmo'), ('gadget');\n```\n\n```python exec\nid: reader\nimport pandas as pd\npd.read_sql('SELECT name FROM widgets ORDER BY name', db)\n```\n",
    );
    const cells = page.locator(".dn-block-fence");

    await cells.nth(0).locator(".dn-cell-run").click();
    await expect(cells.nth(0).locator(".dn-cell-output")).toContainText("2 rows affected", {
      timeout: COLD_BOOT_TIMEOUT,
    });

    await cells.nth(1).locator(".dn-cell-run").click();
    const output = cells.nth(1).locator(".dn-cell-output");
    await expect(output.locator("table")).toBeVisible({ timeout: COLD_BOOT_TIMEOUT });
    await expect(output).toContainText("gadget");
    await expect(output).toContainText("gizmo");
  });

  await test.step("a sql exec SELECT's own result renders as a real table, the same trailing-value path any other cell's DataFrame takes", async () => {
    await mount(page, "```sql exec\nid: query\nCREATE TABLE t (n INTEGER);\nINSERT INTO t VALUES (1), (2), (3);\nSELECT * FROM t;\n```\n");
    await page.locator(".dn-block-fence .dn-cell-run").click();
    const output = page.locator(".dn-cell-output");
    await expect(output.locator("table")).toBeVisible({ timeout: COLD_BOOT_TIMEOUT });
    await expect(output).toContainText("1");
    await expect(output).toContainText("3");
  });

  await test.step("Run saves a persist cell's script, and Reset clears it", async () => {
    // The banner itself (shown/hidden, and what clicking it does to the
    // editor) is pure DOM/localStorage and covered without any Pyodide
    // dependency in tests/e2e/surface.spec.ts. This step only covers the
    // two things that do touch the interpreter: Run writing the saved
    // entry, and Reset clearing it.
    await page.evaluate(() => localStorage.removeItem("dewnote-sql:persisted"));
    await mount(page, "```sql cell=persisted persist\nCREATE TABLE t (x INTEGER);\n```\n");

    await page.locator(".dn-sql-run").click();
    await expect(page.locator(".dn-sql-output")).toContainText("0 row(s) affected", { timeout: COLD_BOOT_TIMEOUT });
    expect(await page.evaluate(() => localStorage.getItem("dewnote-sql:persisted"))).toBe(
      "CREATE TABLE t (x INTEGER);",
    );

    await page.locator(".dn-sql-reset").click();
    await expect(page.locator(".dn-sql-output")).toBeEmpty();
    expect(await page.evaluate(() => localStorage.getItem("dewnote-sql:persisted"))).toBeNull();
  });
});
