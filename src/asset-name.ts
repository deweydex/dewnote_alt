// What to call an image copied in beside the document that shows it.
//
// Both builds resolve an asset the same way: the markdown names a bare
// file, and the build looks for it in the folder the markdown sits in —
// dewlab's `resolve_assets()` (which *fails the build* on a name with no
// file behind it) and dewstack's own copy of every non-`.md`/`.yaml`
// sibling into the page's output directory. So the name this picks is
// the name a reader types into a URL bar, and it has two jobs.
//
// ## It has to survive markdown
//
// `![alt](My Photo (1).png)` does not mean what it looks like: the first
// `)` closes the link, and the rest is literal text. Spaces break it in
// the same way. Percent-encoding would work and reads terribly in a
// folder listing, so the name is reshaped instead — lowercase, one
// hyphen where any run of unsafe characters was.
//
// ## It has to not be somebody else's file
//
// dewlab's `tutorial_assets()` reads the folder rather than a declared
// list, precisely so the two can't disagree. The flip side is that a
// name already in use belongs to a picture already on the page: writing
// over it would change that page silently, and pointing at it without
// writing would put the wrong picture under this alt text. Neither is
// something to do quietly, so a taken name gets a counter instead.

/** Suffixes neither build treats as an asset — dewlab's own
 * `NON_ASSET_SUFFIXES`, and the same three dewstack's copy step skips.
 * An image named `notes.md` would be copied by neither. */
const NON_ASSET_SUFFIXES = new Set([".md", ".yaml", ".yml"]);

/** Splits `photo.PNG` into `["photo", ".png"]`, and `README` into
 * `["README", ""]`. A leading dot is part of the stem, not a suffix, so
 * `.gitignore` doesn't become an empty name. */
function splitExtension(fileName: string): [string, string] {
  const at = fileName.lastIndexOf(".");
  if (at <= 0) return [fileName, ""];
  return [fileName.slice(0, at), fileName.slice(at).toLowerCase()];
}

/** The safe form of one name part: lowercase, ASCII letters, digits and
 * hyphens only, no leading or trailing hyphen, never empty. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining marks, so "café" becomes "cafe" rather than "caf".
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "image";
}

/**
 * A file name safe to write beside a document and to name in markdown.
 *
 * `taken` is every name already in that folder, compared case-insensitively
 * — a folder on macOS would treat `Photo.png` and `photo.png` as one file,
 * and a name that works on one machine and collides on another is worse
 * than one that is simply free everywhere.
 */
export function assetNameFor(originalName: string, taken: Iterable<string> = []): string {
  const [rawStem, rawSuffix] = splitExtension(originalName);
  const stem = slugify(rawStem);
  // A suffix that isn't a plain extension (`.tar.gz` is fine; `.p n g`
  // isn't) is slugified too rather than carried through unchecked.
  const suffix = rawSuffix && /^\.[a-z0-9.]+$/.test(rawSuffix) ? rawSuffix : "";

  const used = new Set([...taken].map((name) => name.toLowerCase()));
  const candidate = (n: number) => (n === 1 ? `${stem}${suffix}` : `${stem}-${n}${suffix}`);
  let n = 1;
  while (used.has(candidate(n).toLowerCase())) n += 1;
  return candidate(n);
}

/** Whether a sibling file is one the build would copy — what `taken`
 * should be built from. A `.md` beside the document is a different
 * tutorial, not a name an image could clash with in the output. */
export function isAssetFile(fileName: string): boolean {
  const [, suffix] = splitExtension(fileName);
  return !NON_ASSET_SUFFIXES.has(suffix);
}

/** The folder part of a store path, without its trailing slash — `""`
 * for a file at the root, which is what makes `join` below produce a
 * bare name rather than a leading slash. */
export function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/** A sibling of `path`, named `fileName`. */
export function siblingPath(path: string, fileName: string): string {
  const folder = folderOf(path);
  return folder ? `${folder}/${fileName}` : fileName;
}
