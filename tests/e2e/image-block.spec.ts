// Step 8's image add-menu item (src/app.ts's insertImageAfter) — plan §6
// step 8's own "images with an alt prompt." Drives the real built app:
// pick a real file through the browser's own file chooser, answer the
// alt-text prompt, and check both the inserted markdown and the
// rendered <img>.
//
// This file is the *fallback* half: no store open, so there is no folder
// to put a file in and the image is inlined as a `data:` URI. The other
// half — a real copy written beside the document, which is what both
// builds actually want — is in image-asset.spec.ts, against the fake
// folder and the mocked GitHub API.

import { addBlockAfter, blockMenuItem, deleteBlock, openAddMenu, pointAt } from "./block-controls.ts";
import { test as base, expect } from "@playwright/test";
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

// A minimal, real 1x1 transparent PNG — not a placeholder string, an
// actual file the browser's own file chooser hands back and FileReader
// actually decodes.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function mount(page: import("@playwright/test").Page, source: string) {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
  await page.evaluate(
    (src) => (window as unknown as { __dewnote: { mount(source: string): void } }).__dewnote.mount(src),
    source,
  );
}

async function getSource(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __dewnote: { getSource(): string } }).__dewnote.getSource());
}

test("with nowhere to write a file, an image is inlined as a data: URI", async ({ page }) => {
  await mount(page, "One.\n\nTwo.\n");

  page.once("dialog", (dialog) => dialog.accept("A test image"));

  await openAddMenu(page, 0);

  const chooserPromise = page.waitForEvent("filechooser");
  await blockMenuItem(page, ".dn-add-menu", "Image").click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "pixel.png", mimeType: "image/png", buffer: ONE_PIXEL_PNG });

  await expect(page.locator('.dn-block-render img[alt="A test image"]')).toBeVisible();

  const source = await getSource(page);
  expect(source).toContain("![A test image](data:image/png;base64,");
  expect(source.indexOf("One.")).toBeLessThan(source.indexOf("![A test image]"));
  expect(source.indexOf("![A test image]")).toBeLessThan(source.indexOf("Two."));
});

test("cancelling the alt-text prompt still inserts the image, with empty alt text", async ({ page }) => {
  await mount(page, "One.\n");

  page.once("dialog", (dialog) => dialog.dismiss());

  await openAddMenu(page, 0);

  const chooserPromise = page.waitForEvent("filechooser");
  await blockMenuItem(page, ".dn-add-menu", "Image").click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "pixel.png", mimeType: "image/png", buffer: ONE_PIXEL_PNG });

  // Waited for rather than assumed: `setFiles` returning means the
  // picker closed, not that the file has been read. Reading it is a
  // FileReader round trip, and the dismissed prompt no longer sits in
  // between to cover for it — the prompt comes first now, so the image
  // can be written beside the document under its real name rather than
  // after the bytes have already been inlined.
  await expect(page.locator('.dn-block-render img[alt=""]')).toBeVisible();

  const source = await getSource(page);
  expect(source).toContain("![](data:image/png;base64,");
});
