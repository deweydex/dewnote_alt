// The folder rail (src/folder-panel.ts, src/folder-store.ts) — the rest
// of step 4. Playwright can't drive the OS's own directory-picker dialog
// the way it can synthesize a dropped File (there's no scriptable
// equivalent of setInputFiles for showDirectoryPicker), so this stubs
// `window.showDirectoryPicker` itself before navigation with a plain JS
// object matching the shape folder-store.ts actually calls: `.name`,
// `.entries()`, and per file a `getFile()`/`createWritable()` pair —
// real interaction with the real built app and the real editor, just
// with the one API neither Playwright nor this sandbox can reach
// stubbed at the boundary, the same principle repo-panel.spec.ts
// applies to GitHub's REST API via page.route.

import { addBlockAfter } from "./block-controls.ts";
import { selectPanel } from "./panel-helpers.ts";
import { test as base, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

/** Installs a fake `showDirectoryPicker` before the app's own module
 * script runs, so `supportsDirectoryPicker()` sees it and the real
 * walk/read/write calls in folder-store.ts run against this fake tree
 * instead of a real filesystem. */
async function stubDirectoryPicker(page: Page) {
  await page.addInitScript(() => {
    const writes: Record<string, string> = {};

    function fakeFileHandle(name: string, content: string) {
      return {
        kind: "file",
        name,
        async getFile() {
          return { text: async () => writes[name] ?? content };
        },
        async createWritable() {
          return {
            async write(next: string) {
              writes[name] = next;
            },
            async close() {},
          };
        },
      };
    }

    // getDirectoryHandle/getFileHandle mutate the same `entries` record
    // `entries()` itself iterates — so a file or directory created
    // through one is visible through the other on the very next walk,
    // the same as a real filesystem, letting createFile's own directory-
    // creation-on-demand and the "already exists" check below be
    // exercised for real rather than assumed to work against the fake.
    function fakeDirHandle(name: string, entries: Record<string, unknown>) {
      return {
        kind: "directory",
        name,
        async *entries() {
          for (const [key, value] of Object.entries(entries)) yield [key, value];
        },
        async getDirectoryHandle(childName: string, options?: { create?: boolean }) {
          let child = entries[childName];
          if (!child) {
            if (!options?.create) throw new Error(`"${childName}" not found`);
            child = fakeDirHandle(childName, {});
            entries[childName] = child;
          }
          return child;
        },
        async getFileHandle(childName: string, options?: { create?: boolean }) {
          let child = entries[childName];
          if (!child) {
            if (!options?.create) throw new Error(`"${childName}" not found`);
            child = fakeFileHandle(childName, "");
            entries[childName] = child;
          }
          return child;
        },
      };
    }

    // A real `Object.entries` re-walked on every `entries()` call, not a
    // snapshot taken once — so a file added to it after the folder is
    // first opened is genuinely invisible until the next walk, the same
    // as a real filesystem, letting the Refresh test below simulate a
    // change made outside dewnote between an open and a refresh.
    const contentEntries: Record<string, unknown> = {
      "a-rule.md": fakeFileHandle("a-rule.md", "---\ntitle: A Rule\nslug: a-rule\n---\n\n# A Rule\n\nWhere it lives.\n"),
    };

    const root = fakeDirHandle("tutorials", {
      "README.md": fakeFileHandle("README.md", "# Read Me\n\nTop level.\n"),
      modules: fakeDirHandle("modules", {
        "a-module.yaml": fakeFileHandle(
          "a-module.yaml",
          "title: A Module\ncontents:\n- title: A Series\n  tutorials:\n  - a-rule\n",
        ),
      }),
      content: fakeDirHandle("content", contentEntries),
    });

    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = async () => root;
    (window as unknown as { __testAddFile(name: string, content: string): void }).__testAddFile = (name, content) => {
      contentEntries[name] = fakeFileHandle(name, content);
    };
  });
}

test.beforeEach(async ({ page }) => {
  await stubDirectoryPicker(page);
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
});

test("the folder toggle is enabled once a directory picker exists", async ({ page }) => {
  await expect(page.locator(".dn-folder-toggle")).toBeEnabled();
});

test("opening a folder lists its markdown files recursively, and search filters them", async ({ page }) => {
  await selectPanel(page, ".dn-folder-toggle");
  await page.locator(".dn-folder-open").click();

  await expect(page.locator(".dn-folder-status").first()).toHaveText('2 markdown files, 1 module file, in "tutorials".');
  const items = page.locator(".dn-folder-file");
  await expect(items).toHaveCount(3);

  await page.locator(".dn-folder-search").fill("content");
  await expect(page.locator(".dn-folder-file")).toHaveCount(1);
  await expect(page.locator(".dn-folder-file")).toHaveText("content/a-rule.md");
});

// Step 4's own follow-up, raised alongside the series view: there is no
// browser API that watches a local folder for changes, so seeing what
// changed outside dewnote means asking for it — Refresh re-walks the
// already-open folder without reopening the OS picker.
test("Refresh re-scans the open folder, picking up a file added outside dewnote, without reopening the picker", async ({ page }) => {
  await selectPanel(page, ".dn-folder-toggle");
  await expect(page.locator(".dn-folder-refresh")).toBeDisabled();

  await page.locator(".dn-folder-open").click();
  await expect(page.locator(".dn-folder-file")).toHaveCount(3);
  await expect(page.locator(".dn-folder-refresh")).toBeEnabled();

  await page.evaluate(() => {
    (window as unknown as { __testAddFile(name: string, content: string): void }).__testAddFile(
      "new-page.md",
      "# New Page\n\nAdded after opening.\n",
    );
  });

  // Not visible yet — the folder was only walked once, on open.
  await expect(page.locator(".dn-folder-file")).toHaveCount(3);

  await page.locator(".dn-folder-refresh").click();
  await expect(page.locator(".dn-folder-status").first()).toHaveText('3 markdown files, 1 module file, in "tutorials".');
  await expect(page.locator(".dn-folder-file")).toHaveCount(4);
  await expect(page.locator(".dn-folder-file", { hasText: "new-page.md" })).toBeVisible();
});

// A module file is just another file in the browsable list — opening one
// hands it to the same editor and Save path every markdown file already
// gets, so hand-editing a module needs no UI this repo doesn't already
// have. That stays true now the panel can show modules: the panel reads
// them, and this is still the way to edit one by hand.
test("a module file opens and saves through the ordinary file bar, same as any markdown file", async ({ page }) => {
  await selectPanel(page, ".dn-folder-toggle");
  await page.locator(".dn-folder-open").click();
  await page.locator(".dn-folder-file", { hasText: "modules/a-module.yaml" }).click();

  await expect(page.locator(".dn-file-name")).toHaveText("modules/a-module.yaml");
  await expect(page.locator(".dn-file-status")).toHaveText("saved");

  await page.keyboard.press("ControlOrMeta+/");
  const editor = page.locator(".dn-source-editor .cm-content");
  await expect(editor).toContainText("title: A Module");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("  - a-new-tutorial\n");
  await page.locator(".dn-source-close").click();

  await expect(page.locator(".dn-file-status")).toHaveText("unsaved");
  await page.locator(".dn-file-export-menu-toggle").click();
  await page.locator(".dn-file-save").click();
  await expect(page.locator(".dn-file-status")).toHaveText("saved");
});

test("opening a file renders it in the editor and hands Save to the file bar as a real handle", async ({ page }) => {
  await selectPanel(page, ".dn-folder-toggle");
  await page.locator(".dn-folder-open").click();
  await page.locator(".dn-folder-file", { hasText: "a-rule.md" }).click();

  await expect(page.locator("h1")).toHaveText("A Rule");
  await expect(page.locator(".dn-file-name")).toHaveText("content/a-rule.md");
  // A folder-opened file carries a real writable handle, same as the
  // single-file picker path — "saved", not the handle-less "downloaded".
  await expect(page.locator(".dn-file-status")).toHaveText("saved");

  await page.locator(".dn-block-render").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Edited via the folder rail.");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await expect(page.locator(".dn-file-status")).toHaveText("unsaved");

  await page.locator(".dn-file-export-menu-toggle").click();
  await page.locator(".dn-file-save").click();
  await expect(page.locator(".dn-file-status")).toHaveText("saved");
});

// file-index.ts's own side: opening a folder builds the front-matter
// index (plan §5.10) that link-picker.ts searches — checked here through
// the link picker itself, since that's the only observable consumer, not
// by reaching into folder-panel.ts's internals.
test("opening a folder builds the file index the link picker searches", async ({ page }) => {
  await selectPanel(page, ".dn-folder-toggle");
  await page.locator(".dn-folder-open").click();
  await expect(page.locator(".dn-folder-file")).toHaveCount(3);
  await page.locator(".dn-folder-close").click();

  await addBlockAfter(page, 0, "Link");

  const items = page.locator(".dn-link-item button");
  await expect(items).toHaveCount(2);
  await expect(items).toContainText(["README.md", "A Rule"]);
});

// active-store.ts's own "open this path" hook, exercised through the
// placement panel — a module listing a real, indexed id is a real
// clickable button there, opening the exact file this folder already
// has, the same as clicking it directly in this rail's own file list.
test("the modules panel can open a listed tutorial by clicking it", async ({ page }) => {
  await selectPanel(page, ".dn-folder-toggle");
  await page.locator(".dn-folder-open").click();
  await expect(page.locator(".dn-folder-file")).toHaveCount(3);
  await page.locator(".dn-folder-close").click();

  await selectPanel(page, ".dn-series-toggle");
  await expect(page.locator(".dn-series-module-title")).toHaveText("A Module");
  await expect(page.locator(".dn-series-series-title")).toHaveText("A Series");
  const link = page.locator(".dn-series-link", { hasText: "A Rule" });
  await expect(link).toBeVisible();
  await link.click();

  await expect(page.locator("h1")).toHaveText("A Rule");
  await expect(page.locator(".dn-block-render").filter({ hasText: "Where it lives." })).toBeVisible();
});

// active-store.ts's own createFile, through the folder rail's own "New
// tutorial" form. The layout is `tutorials/<id>/<id>.md` and the id is
// the folder's own name, so the id is the only placement this form asks
// for — the module, module title and series fields it used to carry went
// with dewlab's move to modules/, since writing `module:` into front
// matter would fill in a field its build ignores. A tutorial made here
// is on no module until something lists it, which dewlab builds happily.
test("the folder rail can create a new tutorial from a template, which then appears in the file list and opens", async ({
  page,
}) => {
  await selectPanel(page, ".dn-folder-toggle");
  await expect(page.locator(".dn-folder-create-button")).toBeDisabled();

  await page.locator(".dn-folder-open").click();
  await expect(page.locator(".dn-folder-create-button")).toBeEnabled();

  await page.locator(".dn-folder-create-field[placeholder^='tutorial-id']").fill("a-tutorial");
  await page.locator(".dn-folder-create-field[placeholder='Title']").fill("A Tutorial");
  await page.locator(".dn-folder-create-button").click();

  await expect(page.locator(".dn-folder-create-status")).toHaveText(
    "Created tutorials/a-tutorial/a-tutorial.md — on no module yet.",
  );
  // Fields clear on success, ready for the next one — the year field is
  // left alone (defaulted, not cleared) since it's still the right value.
  await expect(page.locator(".dn-folder-create-field[placeholder^='tutorial-id']")).toHaveValue("");

  const item = page.locator(".dn-folder-file", { hasText: "tutorials/a-tutorial/a-tutorial.md" });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator("h1")).toHaveText("A Tutorial");
});

// An id is the address of the page and the key a reader's saved work
// lives under, so a second tutorial must never quietly land in a folder
// one already occupies. Refused on the id alone, before any write.
test("creating a tutorial with an id already in use is refused, rather than silently overwriting it", async ({
  page,
}) => {
  await selectPanel(page, ".dn-folder-toggle");
  await page.locator(".dn-folder-open").click();

  await page.locator(".dn-folder-create-field[placeholder^='tutorial-id']").fill("a-tutorial");
  await page.locator(".dn-folder-create-field[placeholder='Title']").fill("A Tutorial");
  await page.locator(".dn-folder-create-button").click();
  await expect(page.locator(".dn-folder-create-status")).toHaveText(
    "Created tutorials/a-tutorial/a-tutorial.md — on no module yet.",
  );

  await page.locator(".dn-folder-create-field[placeholder^='tutorial-id']").fill("a-tutorial");
  await page.locator(".dn-folder-create-field[placeholder='Title']").fill("A Tutorial Again");
  await page.locator(".dn-folder-create-button").click();

  await expect(page.locator(".dn-folder-create-status")).toHaveText(
    '"a-tutorial" is taken — a tutorial already lives in tutorials/a-tutorial/.',
  );
});
