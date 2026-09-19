// The store-agnostic "open this path" hook named as still open in
// PLAN.md §6 step 4 — deliberately not built when the series view first
// shipped, since neither folder-panel.ts nor repo-panel.ts exposed
// anything a third module could call to open a file by path. Each store
// already knows how to open one of its own files correctly (a real
// writable FileSystemFileHandle for a folder; a branch-aware fetch,
// eligible for the same push/conflict flow, for a repository) — this
// only routes a request to whichever store is actually open, rather
// than reimplementing either one's own open logic a second time.
//
// A module-level singleton, not something threaded through every
// caller, for the same reason app.ts's own sharedFileIndex is one:
// there is only ever one store open at a time in this single-document
// editor, and whichever was opened or loaded most recently is the one
// "open this path" should mean.

export interface ActiveStore {
  /** Opens the file at `path` into the current document, the same way a
   * click in that store's own file list already would. Resolves to
   * `false` if no file at that path exists in this store (a stale
   * series entry, an unindexed slug) rather than throwing — a caller
   * asking about a path that turns out not to exist is a normal
   * outcome, not an error. */
  openPath(path: string): Promise<boolean>;
  /** Creates a new file at `path` with `content`. Both stores implement
   * it; folder-panel.ts's "New tutorial" is its one caller today. (The
   * other was series-panel.ts's "New series", which went when a series
   * stopped being a file — decision 36.) Throws with a real
   * message on failure (the file already exists, the write itself
   * failed, or — from `createFile` below, when nothing implements
   * this — the store open right now doesn't support it at all), since
   * unlike `openPath`'s "nothing there" outcome, a failed create is
   * something the reader needs to see and act on. */
  createFile?(path: string, content: string): Promise<void>;
  /** Reads the current text of a file this store already holds — the
   * read half of a read-modify-write, for a caller editing a file it
   * never opened into the editor. The placement rail's own writes are
   * the only caller: it re-reads a module file at the moment it writes
   * it rather than trusting the copy parsed when the folder was last
   * scanned, since modules.ts's line ranges are only true of the exact
   * text they were read from. Throws when there is no such file. */
  readTextFile?(path: string): Promise<string>;
  /** Writes `content` over the file at `path`. `message` is what a store
   * that commits needs and a store that writes a file in place ignores;
   * only the caller knows what actually changed, so only the caller can
   * say it. Throws with a real message on failure — a write the reader
   * asked for that didn't happen is something they need to see. */
  writeTextFile?(path: string, content: string, message: string): Promise<void>;
  /** Creates a new file at `path` from raw bytes — an image copied in
   * beside the document that shows it. Separate from `createFile` rather
   * than widening it, because the two stores diverge exactly here: a
   * folder hands the bytes straight to a writable stream, while a
   * repository has to base64 them, and `github.ts`'s own `toBase64`
   * takes a *string* (it UTF-8 encodes first, which would corrupt every
   * byte above 0x7F). Refuses rather than overwrites, the same as
   * `createFile`. */
  createBinaryFile?(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  /** The raw bytes of a file this store holds — an image the editor has
   * to show. Separate from `readTextFile` for the same reason as the
   * write side: that one decodes as UTF-8, which destroys a PNG.
   * Resolves null when there is no such file, since an image name with
   * nothing behind it is a real state the editor renders rather than an
   * error (dewlab's build is where that becomes a failure). */
  readBinaryFile?(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  /** The store-relative path of the document open in the editor right
   * now, or null when this store has none open.
   *
   * What "beside the document" means, in other words. Only the store
   * knows it: the file bar tracks a display name, which is a full
   * relative path for a folder file and a bare file name for a dropped
   * one, and telling those apart after the fact is guesswork. */
  currentPath?(): string | null;
  /** Every file name already sitting directly inside `folder`, for
   * picking an asset name that isn't somebody else's picture
   * (asset-name.ts).
   *
   * The real directory, not whatever list the panel happens to display:
   * both panels walk for markdown and module files only, so a picture
   * already beside a tutorial appears in neither, and naming a new one
   * from those lists would call a taken name free. Empty when the store
   * can't list it — the create call refusing to overwrite is still the
   * backstop, but it is a backstop, not the plan. */
  listNamesIn?(folder: string): Promise<string[]>;
}

let active: ActiveStore | null = null;

/** Called once each store starts existing (folder-panel.ts, repo-panel.ts) —
 * not on every open/load within it, since the registered `openPath`
 * closes over that panel's own live file list and sees every later
 * refresh without needing to re-register. */
export function setActiveStore(store: ActiveStore | null): void {
  active = store;
}

export function openPath(path: string): Promise<boolean> {
  return active ? active.openPath(path) : Promise.resolve(false);
}

export async function createFile(path: string, content: string): Promise<void> {
  if (!active?.createFile) throw new Error("Creating a file isn't supported by whatever's open right now — try a local folder.");
  await active.createFile(path, content);
}

/** True when the store open right now can do a read-modify-write at all
 * — what the placement rail checks before offering a drag handle it
 * could not honour. */
export function canWriteFiles(): boolean {
  return Boolean(active?.readTextFile && active?.writeTextFile);
}

export async function readTextFile(path: string): Promise<string> {
  if (!active?.readTextFile) throw new Error("Reading a file isn't supported by whatever's open right now.");
  return active.readTextFile(path);
}

export async function writeTextFile(path: string, content: string, message: string): Promise<void> {
  if (!active?.writeTextFile) throw new Error("Saving a file isn't supported by whatever's open right now — open a folder or a repository first.");
  await active.writeTextFile(path, content, message);
}

/** True when the store open right now can copy an asset in beside the
 * open document — a store that can write bytes, and a document that has
 * somewhere for them to sit. False means an image has to be inlined as a
 * `data:` URI instead, which is a real fallback rather than a failure. */
export function canWriteAssets(): boolean {
  return Boolean(active?.createBinaryFile && active.currentPath?.());
}

export function currentPath(): string | null {
  return active?.currentPath?.() ?? null;
}

export async function listNamesIn(folder: string): Promise<string[]> {
  return (await active?.listNamesIn?.(folder)) ?? [];
}

export async function createBinaryFile(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  if (!active?.createBinaryFile) throw new Error("Saving a file isn't supported by whatever's open right now — open a folder or a repository first.");
  await active.createBinaryFile(path, bytes);
}

export async function readBinaryFile(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!active?.readBinaryFile) return null;
  return active.readBinaryFile(path);
}
