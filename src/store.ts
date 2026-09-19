// The browser store (plan §5.5, decision 5's "store interface" — this is
// the first implementation of it, and the only one so far; GitHub and
// native stores are still step 5 and step 7). Two ways in — a picker or a
// drop — and one way out, chosen by what came in: a document opened
// through `showOpenFilePicker()` keeps a real, writable handle and Save
// writes straight back to it; a document opened through `<input
// type=file>`, or a browser without that API (Safari, per decision 5),
// has no such handle, and Save falls back to a download instead. Neither
// path is second-class — it is exactly the two-tier distinction §5.5
// draws, made concrete as one type with a nullable field rather than two
// document types with duplicated plumbing.

import { extractFrontMatter } from "./frontmatter.ts";

export interface OpenedDocument {
  /** The file's name, editable in the UI independent of the handle. */
  name: string;
  content: string;
  /** Present only when the File System Access API supplied a real,
   * writable handle (Chrome/Edge). Null for the `<input>` fallback and
   * for a document that has never been saved anywhere yet. */
  handle: FileSystemFileHandle | null;
}

const MARKDOWN_PICKER_TYPES = [
  { description: "Markdown", accept: { "text/markdown": [".md", ".markdown"] } },
];

/** Chrome/Edge only, per decision 5 — never assume it exists. */
export function supportsFileSystemAccess(): boolean {
  return typeof (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker === "function";
}

/**
 * Derives a filename from a document's own front matter (`slug`, then
 * `title`) rather than asking the author to type one on every new
 * document — decision 11's front-matter index is the folder-wide version
 * of this same idea; this is the single-document version. Falls back to
 * "untitled.md" for a document with neither field, which is exactly what
 * main.ts's starter document is.
 */
export function suggestedFilename(source: string): string {
  const { fields } = extractFrontMatter(source);
  const raw = typeof fields.slug === "string" ? fields.slug : typeof fields.title === "string" ? fields.title : "";
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "untitled"}.md`;
}

async function readHandle(handle: FileSystemFileHandle): Promise<OpenedDocument> {
  const file = await handle.getFile();
  return { name: file.name, content: await file.text(), handle };
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Opens the file picker (or, lacking one, an `<input type=file>`).
 * Resolves to null on cancel — never rejects for that case, since it is
 * not an error. */
export async function openFile(): Promise<OpenedDocument | null> {
  if (supportsFileSystemAccess()) {
    try {
      const [handle] = await (
        window as unknown as {
          showOpenFilePicker(opts: unknown): Promise<FileSystemFileHandle[]>;
        }
      ).showOpenFilePicker({ types: MARKDOWN_PICKER_TYPES, excludeAcceptAllOption: false });
      if (!handle) return null;
      return await readHandle(handle);
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
  }
  return openFileFallback();
}

function openFileFallback(): Promise<OpenedDocument | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,text/markdown";
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        file.text().then((content) => resolve({ name: file.name, content, handle: null }));
      },
      { once: true },
    );
    // No cancel event fires reliably across browsers, so a picker the
    // reader dismisses without choosing anything just never resolves —
    // matching the picker path's own "closed with no result" shape, not
    // an error either way.
    input.click();
  });
}

/** A file dragged onto the page. Chrome/Edge hand back a real,
 * write-through handle via `getAsFileSystemHandle()`; everything else
 * (Safari included) only has `getAsFile()`, read-only, same as the
 * `<input>` fallback above. */
export async function openDroppedItem(item: DataTransferItem): Promise<OpenedDocument | null> {
  const withHandle = item as DataTransferItem & {
    getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
  };
  if (typeof withHandle.getAsFileSystemHandle === "function") {
    const handle = await withHandle.getAsFileSystemHandle();
    if (handle && handle.kind === "file") return readHandle(handle as FileSystemFileHandle);
  }
  const file = item.getAsFile();
  if (!file) return null;
  return { name: file.name, content: await file.text(), handle: null };
}

/**
 * Writes back through the handle when there is one; otherwise triggers a
 * download under the document's current name. Either way returns the
 * `OpenedDocument` a caller should hold onto next — unchanged when
 * writing through a handle, since the handle and name are still good for
 * the next save.
 */
export async function saveDocument(opened: OpenedDocument, content: string): Promise<OpenedDocument> {
  if (opened.handle) {
    const writable = await opened.handle.createWritable();
    await writable.write(content);
    await writable.close();
    return opened;
  }
  downloadAsFile(opened.name, content);
  return opened;
}

/** Exported for export-html.ts's own download — a rendered HTML page has
 * nowhere else to go but a download, the same as a markdown save with no
 * writable handle behind it. */
export function downloadAsFile(name: string, content: string, mimeType = "text/markdown"): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
