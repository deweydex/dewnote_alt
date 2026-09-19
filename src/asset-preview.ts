// Showing an image the markdown names by bare file name.
//
// Both builds resolve `![alt](diagram.png)` against the folder the
// markdown sits in, and that is the right thing for the document to say
// — it is what dewlab's `resolve_assets()` reads and what ends up beside
// the published page. It is also a name this editor's own page cannot
// resolve: dewnote is one HTML file served from somewhere else entirely,
// so the browser looks for `diagram.png` next to *it* and finds nothing.
//
// Without this, every image in a tutorial renders as a broken icon the
// moment the document is reopened — including one dewnote itself wrote a
// minute earlier. So the bytes are read back through whichever store is
// open and handed to the preview as an object URL. The markdown is never
// touched: what the document says stays the bare name, and only the
// `src` attribute of the rendered `<img>` differs from it.
//
// ## What it deliberately does not resolve
//
// Anything with a scheme (`https:`, `data:`), anything root-relative,
// and anything with a `/` in it. The first two already work as they are,
// and the third is not what either build resolves — dewlab's own
// `href` rule skips a name containing a slash for the same reason.

import { currentPath, readBinaryFile } from "./active-store.ts";
import { folderOf } from "./asset-name.ts";

/** Object URLs by the store path they were read from. Kept because a
 * document re-renders on every edit and a block may be rebuilt many
 * times a second while typing — reading and re-encoding an image each
 * time would be visible. */
const urls = new Map<string, string>();
/** Paths already looked up and found to hold nothing, so a missing
 * image is asked about once rather than on every render. */
const missing = new Set<string>();

/** Drops every cached URL. Called when the open document changes, since
 * a new document means a new folder and the same bare name may well mean
 * a different picture. Revokes as it goes: an object URL holds its blob
 * alive until it is revoked, and an editor left open all day would
 * otherwise accumulate every image it ever showed. */
export function forgetAssetUrls(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  missing.clear();
}

/** True for a reference this module can resolve — a bare file name, the
 * only form either build treats as a sibling asset. */
export function isSiblingAsset(src: string): boolean {
  if (!src) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return false;
  if (src.startsWith("/") || src.startsWith("#") || src.startsWith("?")) return false;
  return !src.includes("/");
}

/** An object URL for the sibling asset `name`, or null when there is no
 * document path, no store that reads bytes, or no such file. */
export async function assetUrlFor(name: string): Promise<string | null> {
  const documentPath = currentPath();
  if (!documentPath) return null;
  const folder = folderOf(documentPath);
  const path = folder ? `${folder}/${name}` : name;

  const cached = urls.get(path);
  if (cached) return cached;
  if (missing.has(path)) return null;

  const bytes = await readBinaryFile(path);
  if (!bytes) {
    missing.add(path);
    return null;
  }
  const url = URL.createObjectURL(new Blob([bytes]));
  urls.set(path, url);
  return url;
}

/** Points every sibling-named `<img>` inside `root` at the bytes the
 * store actually holds.
 *
 * The `src` comes *off* first, and that is the important part. A browser
 * starts fetching the moment a `src` is set, so leaving the bare name in
 * place while the bytes are read would fire a request for `diagram.png`
 * against wherever dewnote itself is served from — one guaranteed 404
 * per image per render, in the console and on the network. The name it
 * came from is kept in `data-dn-asset`, which is also what tells a later
 * callback whether this is still the same image it was asked about.
 *
 * Fire-and-forget: rendering a block is synchronous and reading a file
 * is not, so the picture appears a tick later rather than the whole
 * block waiting on it.
 *
 * An image whose file isn't there keeps no `src` at all, which is what
 * makes the browser show its `alt` text in place of the picture — a more
 * useful thing for an author to see than a broken icon, and an honest
 * one: a name with no file behind it is exactly what fails dewlab's
 * build. */
export function resolveSiblingImages(root: HTMLElement): void {
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (!isSiblingAsset(src)) continue;
    img.removeAttribute("src");
    img.dataset["dnAsset"] = src;
    img.title = src;
    void assetUrlFor(src).then((url) => {
      // Re-checked because the document may have re-rendered in the tick
      // this took, and the same element may now stand for another image.
      if (img.dataset["dnAsset"] !== src) return;
      if (url) img.src = url;
      else img.classList.add("dn-image-missing");
    });
  }
}
