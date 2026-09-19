// An image copied in beside the document that shows it — the half of
// plan §6 step 8's "a copy into the tutorial folder" that was open until
// the stores grew somewhere to put it.
//
// What both builds want is a bare file name resolved against the folder
// the markdown sits in: dewlab's `resolve_assets()` fails the build on a
// name with no file behind it, and dewstack copies every
// non-`.md`/`.yaml` sibling into the page's output. So the thing worth
// checking is not the markdown alone but that a real file with the real
// bytes landed at the real path — which is why each test reads back what
// reached the store rather than what the editor said it did.
//
// The data: URI fallback, for a document with no folder to write into,
// is in image-block.spec.ts.

import { addBlockAfter, blockMenuItem, deleteBlock, openAddMenu, pointAt } from "./block-controls.ts";
import { selectPanel } from "./panel-helpers.ts";
import { test as base, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_APP = "file://" + resolve(HERE, "../../dist/index.html") + "?legacy=1";

// repo-panel.spec.ts's own reasoning: the working branch not existing
// yet is how `ensureBranch` finds out it has to create one, so the 404
// is part of the normal flow rather than a fault. Filtered here for the
// same reason and no wider.
const EXPECTED_CONSOLE_NOISE = /Failed to load resource: the server responded with a status of 404/;

const test = base.extend<{ failOnConsoleErrors: void }>({
  failOnConsoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (msg) => {
        if (msg.type() === "error" && !EXPECTED_CONSOLE_NOISE.test(msg.text())) errors.push(msg.text());
      });
      await use();
      expect(errors, `console/page errors:\n${errors.join("\n")}`).toEqual([]);
    },
    { auto: true },
  ],
});

/** A real 1x1 transparent PNG. Its bytes matter here in a way they don't
 * in image-block.spec.ts: over half of them are above 0x7F, so a base64
 * taken through a UTF-8 encode (github.ts's own `toBase64`, which is for
 * text) would come back a different, longer, broken file. */
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const ONE_PIXEL_PNG = Buffer.from(ONE_PIXEL_PNG_BASE64, "base64");

const TUTORIAL = ["---", "title: First Steps", "year: 2026", "version: 2026.09.14.1", "---", "", "# First Steps", "", "Words.", ""].join("\n");

async function getSource(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __dewnote: { getSource(): string } }).__dewnote.getSource());
}

/** Picks `fileName` through the add menu's Image item, answering the
 * alt-text prompt with `alt`, and waits for the image to actually be in
 * the document.
 *
 * The wait is the point: writing the file is asynchronous — for a
 * repository it is a directory listing, a branch check, a branch create
 * and a commit — so `setFiles` returning means the picker closed, not
 * that anything has been written. Asserting straight after it passes or
 * fails on how fast the machine is. */
async function addImage(page: Page, blockIndex: number, fileName: string, alt: string) {
  page.once("dialog", (dialog) => dialog.accept(alt));
  await openAddMenu(page, blockIndex);
  const chooserPromise = page.waitForEvent("filechooser");
  await blockMenuItem(page, ".dn-add-menu", "Image").click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: fileName, mimeType: "image/png", buffer: ONE_PIXEL_PNG });
  await expect(page.locator(`.dn-block-render img[alt="${alt}"]`)).toBeVisible();
}

// ---------------------------------------------------------------- folder

/** The fake tree folder-panel.spec.ts established, holding one tutorial
 * under dewlab's current layout and one picture already beside it, so a
 * name collision is a real file rather than a hypothetical. Binary
 * writes are kept as base64 so a test can compare them to the bytes it
 * handed in. */
async function stubDirectoryPicker(page: Page) {
  await page.addInitScript(({ doc }: { doc: string }) => {
    const writes: Record<string, string> = {};

    function toBase64(bytes: Uint8Array): string {
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    }

    // Bytes are kept as bytes, not as a string: `readBytesAt` calls
    // `arrayBuffer()`, and a fake that only answered `text()` would make
    // every image look missing to the editor while the test passed on
    // the markdown alone.
    const bytes: Record<string, Uint8Array> = {};

    function fakeFileHandle(name: string, content: string) {
      return {
        kind: "file",
        name,
        async getFile() {
          const stored = bytes[name];
          return {
            text: async () => writes[name] ?? content,
            arrayBuffer: async () =>
              (stored ?? new TextEncoder().encode(writes[name] ?? content)).slice().buffer,
          };
        },
        async createWritable() {
          return {
            async write(next: string | Uint8Array) {
              if (typeof next === "string") {
                writes[name] = next;
              } else {
                bytes[name] = next;
                writes[name] = `base64:${toBase64(next)}`;
              }
            },
            async close() {},
          };
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

    const stepsFolder: Record<string, unknown> = {
      "first-steps.md": fakeFileHandle("first-steps.md", doc),
      // Already there, and not something the panel's own markdown walk
      // can see — so the editor only finds out this name is taken by
      // being refused, which is the case worth having in the tree.
      "diagram.png": fakeFileHandle("diagram.png", "existing"),
    };

    const root = fakeDirHandle("dewlab", {
      tutorials: fakeDirHandle("tutorials", { "first-steps": fakeDirHandle("first-steps", stepsFolder) }),
    });

    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = async () => root;
    (window as unknown as { __testWritten(name: string): string | null }).__testWritten = (name) => writes[name] ?? null;
    (window as unknown as { __testNames(): string[] }).__testNames = () => Object.keys(stepsFolder);
  }, { doc: TUTORIAL });
}

test.describe("against a local folder", () => {
  test.beforeEach(async ({ page }) => {
    await stubDirectoryPicker(page);
    await page.goto(BUILT_APP);
    await expect(page.locator(".dn-block").first()).toBeVisible();
    await selectPanel(page, ".dn-folder-toggle");
    await page.locator(".dn-folder-open").click();
    await expect(page.locator(".dn-folder-status")).toContainText("markdown file");
    await page.locator(".dn-folder-file", { hasText: "first-steps.md" }).click();
    await expect(page.locator(".dn-folder-status")).toContainText("Opened");
    await page.locator(".dn-folder-close").click();
    await expect(page.locator("h1")).toHaveText("First Steps");
  });

  test("the picked file is written into the tutorial's own folder, and the markdown names it bare", async ({ page }) => {
    await addImage(page, 1, "A Photo.png", "A photo");

    // The bare name dewlab's resolve_assets() resolves against the
    // folder — not a path, not a data: URI.
    const source = await getSource(page);
    expect(source).toContain("![A photo](a-photo.png)");
    expect(source).not.toContain("data:image");

    // And a real file, byte for byte what was handed to the chooser.
    const written = await page.evaluate(() => (window as unknown as { __testWritten(n: string): string | null }).__testWritten("a-photo.png"));
    expect(written).toBe(`base64:${ONE_PIXEL_PNG_BASE64}`);

    // It landed in the folder the document sits in, not the root.
    const names = await page.evaluate(() => (window as unknown as { __testNames(): string[] }).__testNames());
    expect(names).toContain("a-photo.png");
  });

  test("a name already taken in that folder is stepped past, not written over", async ({ page }) => {
    // `diagram.png` is already a picture on this page. Overwriting it
    // would change that page silently; pointing at it would put the
    // wrong picture under this alt text.
    await addImage(page, 1, "diagram.png", "Another diagram");

    expect(await getSource(page)).toContain("![Another diagram](diagram-2.png)");
    const original = await page.evaluate(() => (window as unknown as { __testWritten(n: string): string | null }).__testWritten("diagram.png"));
    expect(original, "the existing picture was left alone").toBeNull();
    const written = await page.evaluate(() => (window as unknown as { __testWritten(n: string): string | null }).__testWritten("diagram-2.png"));
    expect(written).toBe(`base64:${ONE_PIXEL_PNG_BASE64}`);
  });

  test("the preview shows the picture, read back through the store rather than fetched by name", async ({ page }) => {
    // The markdown says `photo.png`, which this page can't resolve — it
    // isn't served from the tutorial's folder. So the bytes come back
    // through the store as a blob, and the name the document actually
    // says is kept on the element rather than in its src.
    await addImage(page, 1, "photo.png", "A photo");
    const img = page.locator('.dn-block-render img[alt="A photo"]');
    await expect(img).toHaveAttribute("data-dn-asset", "photo.png");
    await expect(img).toHaveAttribute("src", /^blob:/);
    await expect(img).not.toHaveClass(/dn-image-missing/);
  });

  test("a name with no file behind it shows its alt text, not a broken icon", async ({ page }) => {
    // What dewlab's build fails on, shown honestly: no src at all, so
    // the browser renders the alt text in the picture's place.
    await page.evaluate(() => {
      (window as unknown as { __dewnote: { mount(s: string): void } }).__dewnote.mount("Before.\n\n![A missing thing](nope.png)\n\nAfter.\n");
    });
    const img = page.locator('.dn-block-render img[alt="A missing thing"]');
    await expect(img).toHaveClass(/dn-image-missing/);
    await expect(img).not.toHaveAttribute("src", /./);
  });
});

// ------------------------------------------------------------ repository

async function mockGithub(page: Page): Promise<{ puts: Record<string, unknown>[] }> {
  const puts: Record<string, unknown>[] = [];
  await page.route("https://api.github.com/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (req.method() === "GET" && /\/git\/trees\//.test(path)) {
      return json(200, { tree: [{ path: "tutorials/first-steps/first-steps.md", type: "blob", sha: "t1" }] });
    }
    if (req.method() === "GET" && /\/contents\//.test(path)) {
      return json(200, { content: Buffer.from(TUTORIAL, "utf-8").toString("base64"), sha: "file-sha" });
    }
    if (req.method() === "GET" && /\/git\/ref\/heads\/dewnote-edits$/.test(path)) return route.fulfill({ status: 404, body: "{}" });
    if (req.method() === "GET" && /\/git\/ref\/heads\/main$/.test(path)) return json(200, { object: { sha: "base" } });
    if (req.method() === "POST" && /\/git\/refs$/.test(path)) return json(201, { ref: "refs/heads/dewnote-edits" });
    if (req.method() === "PUT" && /\/contents\//.test(path)) {
      puts.push(JSON.parse(req.postData() ?? "{}") as Record<string, unknown>);
      return json(201, { content: { sha: "new-sha" } });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  return { puts };
}

test("against a repository, the image is committed as its real bytes, not a UTF-8 mangling of them", async ({ page }) => {
  // The bug this rules out is specific: github.ts's `toBase64` is for
  // text and UTF-8 encodes first, which turns every byte above 0x7F into
  // two. Over half of a PNG's bytes are above 0x7F, so that path would
  // commit a longer, broken file that still looks like base64.
  const { puts } = await mockGithub(page);
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();

  await selectPanel(page, ".dn-repo-toggle");
  await page.locator('.dn-repo-panel input[type="password"]').fill("test-token");
  const ownerRepo = page.locator(".dn-repo-owner-row input");
  await ownerRepo.nth(0).fill("deweydex");
  await ownerRepo.nth(1).fill("dewlab");
  await page.locator(".dn-repo-load").click();
  await page.locator(".dn-repo-tab", { hasText: "All files" }).click();
  await page.locator(".dn-repo-file", { hasText: "first-steps.md" }).click();
  await expect(page.locator(".dn-repo-status").first()).toContainText("Opened");
  await page.locator(".dn-repo-close").click();
  await expect(page.locator("h1")).toHaveText("First Steps");

  await addImage(page, 1, "A Photo.png", "A photo");

  expect(await getSource(page)).toContain("![A photo](a-photo.png)");
  expect(puts).toHaveLength(1);
  expect(puts[0]!["content"]).toBe(ONE_PIXEL_PNG_BASE64);
  expect(puts[0]!["branch"]).toBe("dewnote-edits");
  // Beside the document in the repository, under dewlab's own layout.
  expect(String(puts[0]!["message"])).toContain("tutorials/first-steps/a-photo.png");
  // A brand-new file, so no sha — GitHub's own create-not-update case.
  expect(puts[0]).not.toHaveProperty("sha");
});
