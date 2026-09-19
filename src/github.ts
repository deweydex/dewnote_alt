// The GitHub store (plan §5.5's third store, decision 5.7's token —
// step 5, previously untouched). A thin `fetch` client against the REST
// API, in FAQ's own shape (plain fetch, SHA-conflict semantics) rather
// than an SDK: read a repository's markdown tree, fetch one file's
// content and SHA, and write it back as a commit on a working branch
// (never straight to the base branch), with a draft pull request as the
// way to hand the change back. The token lives in localStorage, scoped
// to this app's origin, and is never written to a file — decision 5.7's
// own rule, carried over from FAQ and dewlab.

const API = "https://api.github.com";
const TOKEN_KEY = "dewnote:github-token";

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface RepoFile {
  /** Path within the repository, e.g. "content/tutorials/foo.md". */
  path: string;
  sha: string;
}

export class GithubApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

export function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing or blocked storage: the token just won't persist
    // past this page load, same tradeoff as everywhere else this app
    // touches localStorage.
  }
}

export function forgetToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to do if storage is blocked; there was nothing saved.
  }
}

/** Base64, the way GitHub's Contents API wants it — built on `TextEncoder`
 * rather than the `unescape(encodeURIComponent(...))` trick, so it holds
 * up for real Unicode content (a tutorial with an em dash or a µ is not
 * an edge case here). Exported and unit-tested directly, since a broken
 * encoder here means silent corruption of every file this ever saves. */
export function toBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** The same encoding for bytes that were never text — an image copied in
 * beside a tutorial. Not `toBase64` with the bytes read as a string:
 * that UTF-8 encodes first, which rewrites every byte above 0x7F into
 * two and corrupts the file. Chunked because `String.fromCharCode` is
 * called with one argument per byte, and a few hundred thousand of them
 * at once overflows the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(base64: string): string {
  const binary = atob(base64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function api(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${API}${path}`, init);
}

async function apiJson<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await api(token, method, path, body);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GithubApiError(response.status, `${method} ${path} → ${response.status}: ${detail.slice(0, 300)}`);
  }
  return response.json() as Promise<T>;
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}
interface TreeResponse {
  tree: TreeEntry[];
  truncated?: boolean;
}

function matchingBlobs(entries: TreeEntry[], prefix: string, matches: (path: string) => boolean): RepoFile[] {
  return entries
    .filter((entry) => entry.type === "blob")
    .map((entry) => ({ path: prefix ? `${prefix}/${entry.path}` : entry.path, sha: entry.sha }))
    .filter((file) => matches(file.path));
}

/** A repository too large for one recursive tree call to cover — GitHub
 * truncates rather than erroring — falls back to walking directory by
 * directory, each of which GitHub does not truncate on its own. Slower
 * (one call per directory instead of one call total), but this is the
 * honest fix for the gap the first version of this function had: a
 * truncated response was silently treated as complete, which for a
 * large repository means files simply never showing up in search with
 * no indication anything was missing. Takes the same `matches` predicate
 * `listMarkdownFiles` and `listOrderFiles` each pass their own suffix
 * check as, so the walk itself is written once. */
async function walkTree(repo: RepoRef, ref: string, token: string, matches: (path: string) => boolean): Promise<RepoFile[]> {
  const results: RepoFile[] = [];
  const queue: { sha: string; prefix: string }[] = [{ sha: ref, prefix: "" }];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const { sha, prefix } = next;
    const node = await apiJson<TreeResponse>(token, "GET", `/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(sha)}`);
    results.push(...matchingBlobs(node.tree, prefix, matches));
    for (const entry of node.tree) {
      if (entry.type !== "tree") continue;
      queue.push({ sha: entry.sha, prefix: prefix ? `${prefix}/${entry.path}` : entry.path });
    }
  }
  return results;
}

async function listMatchingFiles(repo: RepoRef, ref: string, token: string, matches: (path: string) => boolean): Promise<RepoFile[]> {
  const data = await apiJson<TreeResponse>(
    token,
    "GET",
    `/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  );
  if (!data.truncated) return matchingBlobs(data.tree, "", matches);
  return walkTree(repo, ref, token, matches);
}

/** Every markdown file in a repository at `ref`. The common case is one
 * recursive tree call — this is the search command's own index, built
 * fresh on every "Load repository" rather than cached, since the tree is
 * cheap and staleness would be the worse trade for a tool used across an
 * afternoon of edits elsewhere. A repository large enough that GitHub
 * truncates that single response falls back to `walkTree` rather than
 * returning an incomplete list silently. */
export async function listMarkdownFiles(repo: RepoRef, ref: string, token: string): Promise<RepoFile[]> {
  return listMatchingFiles(repo, ref, token, (path) => path.endsWith(".md"));
}

/** Every module file (dewlab's own `modules/*.yaml`, modules.ts) in a
 * repository at `ref` — series-panel.ts's own source, alongside
 * `listMarkdownFiles`'s front-matter index. A second, separate tree
 * fetch rather than one call serving both lists: simpler than threading
 * a second predicate through every caller of `listMarkdownFiles`, at the
 * cost of one extra (cheap, per the same reasoning above) request when
 * both are actually needed. */
export async function listModuleFiles(repo: RepoRef, ref: string, token: string): Promise<RepoFile[]> {
  return listMatchingFiles(repo, ref, token, (path) => /(^|\/)(?:courses|modules)\/[^/]+\.yaml$/.test(path));
}

export async function getFileContent(
  repo: RepoRef,
  path: string,
  ref: string,
  token: string,
): Promise<{ content: string; sha: string }> {
  const data = await apiJson<{ content: string; sha: string }>(
    token,
    "GET",
    `/repos/${repo.owner}/${repo.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
  );
  return { content: fromBase64(data.content), sha: data.sha };
}

/** Every file name directly inside `path` at `ref` — GitHub's own
 * directory listing, used to pick an asset name that isn't already
 * taken. Distinct from `listMarkdownFiles`/`listModuleFiles`, which walk
 * the whole tree and filter to what this editor opens; a picture beside
 * a tutorial is in neither of those. */
export async function listDirectory(repo: RepoRef, path: string, ref: string, token: string): Promise<string[]> {
  const data = await apiJson<{ name: string; type: string }[]>(
    token,
    "GET",
    `/repos/${repo.owner}/${repo.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
  );
  if (!Array.isArray(data)) return [];
  return data.filter((entry) => entry.type === "file").map((entry) => entry.name);
}

/** The same call, kept as bytes — an image, not text. `getFileContent`
 * decodes as UTF-8, which is right for every file it was written for and
 * destroys a PNG. */
export async function getFileBytes(repo: RepoRef, path: string, ref: string, token: string): Promise<Uint8Array<ArrayBuffer>> {
  const data = await apiJson<{ content: string }>(
    token,
    "GET",
    `/repos/${repo.owner}/${repo.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
  );
  const binary = atob(data.content.replace(/\n/g, ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function branchSha(repo: RepoRef, branch: string, token: string): Promise<string | null> {
  const response = await api(token, "GET", `/repos/${repo.owner}/${repo.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new GithubApiError(response.status, `GET ref/heads/${branch} → ${response.status}`);
  const data = (await response.json()) as { object: { sha: string } };
  return data.object.sha;
}

export async function branchExists(repo: RepoRef, branch: string, token: string): Promise<boolean> {
  return (await branchSha(repo, branch, token)) !== null;
}

export interface RepositoryChange {
  path: string;
  status: "added" | "modified" | "removed" | "renamed" | string;
  additions: number;
  deletions: number;
  previousPath?: string;
}

/** GitHub, rather than the current browser session, is authoritative for
 * what will enter a pull request. A missing working branch simply has no
 * changes yet; any other failure remains visible to the caller. */
export async function compareBranches(
  repo: RepoRef,
  base: string,
  head: string,
  token: string,
): Promise<RepositoryChange[]> {
  const response = await api(
    token,
    "GET",
    `/repos/${repo.owner}/${repo.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
  if (response.status === 404) return [];
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GithubApiError(response.status, `Compare ${base}...${head} → ${response.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    files?: { filename: string; status: string; additions: number; deletions: number; previous_filename?: string }[];
  };
  return (data.files ?? []).map((file) => ({
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
  }));
}

/** Creates `branch` from `base`'s current tip if it doesn't already
 * exist. Never writes to `base` directly — decision 5.7 and the plan's
 * step 5 both put a working branch, not the default branch, as the save
 * target; a draft pull request is the honest way to hand the result
 * back, not a silent push to `main`. */
export async function ensureBranch(repo: RepoRef, branch: string, base: string, token: string): Promise<void> {
  const existing = await branchSha(repo, branch, token);
  if (existing) return;
  const baseSha = await branchSha(repo, base, token);
  if (!baseSha) throw new GithubApiError(404, `Base branch "${base}" not found`);
  await apiJson(token, "POST", `/repos/${repo.owner}/${repo.repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  });
}

export interface PutFileResult {
  sha: string;
}

export interface AtomicFileChange {
  path: string;
  content: string | Uint8Array;
  /** The blob expected on the branch, or null when the path must not
   * exist. This makes a multi-file save obey the same no-overwrite rule
   * as the Contents API's single-file write. */
  expectedSha: string | null;
}

export interface AtomicCommitResult {
  commitSha: string;
  blobs: Record<string, string>;
}

async function fileShaAt(repo: RepoRef, path: string, ref: string, token: string): Promise<string | null> {
  const response = await api(
    token,
    "GET",
    `/repos/${repo.owner}/${repo.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GithubApiError(response.status, `GET ${path} at ${ref} → ${response.status}: ${detail.slice(0, 300)}`);
  }
  return ((await response.json()) as { sha: string }).sha;
}

/** Commit several files as one Git object transaction. All expected
 * paths are checked first, then one tree and one commit are created and
 * the branch ref advances only if it has not moved. A release therefore
 * cannot expose its frozen copy without its new live file, or vice versa. */
export async function commitFilesAtomically(
  repo: RepoRef,
  branch: string,
  base: string,
  changes: readonly AtomicFileChange[],
  message: string,
  token: string,
): Promise<AtomicCommitResult> {
  if (changes.length === 0) throw new Error("An atomic commit needs at least one file.");
  await ensureBranch(repo, branch, base, token);
  const head = await branchSha(repo, branch, token);
  if (!head) throw new GithubApiError(404, `Working branch "${branch}" not found`);

  for (const change of changes) {
    const actual = await fileShaAt(repo, change.path, branch, token);
    if (actual !== change.expectedSha) {
      throw new GithubApiError(409, `${change.path} changed on ${branch}; reload before saving.`);
    }
  }

  const commit = await apiJson<{ tree: { sha: string } }>(
    token,
    "GET",
    `/repos/${repo.owner}/${repo.repo}/git/commits/${encodeURIComponent(head)}`,
  );
  const blobs: Record<string, string> = {};
  for (const change of changes) {
    const blob = await apiJson<{ sha: string }>(token, "POST", `/repos/${repo.owner}/${repo.repo}/git/blobs`, {
      content: typeof change.content === "string" ? toBase64(change.content) : bytesToBase64(change.content),
      encoding: "base64",
    });
    blobs[change.path] = blob.sha;
  }
  const tree = await apiJson<{ sha: string }>(token, "POST", `/repos/${repo.owner}/${repo.repo}/git/trees`, {
    base_tree: commit.tree.sha,
    tree: changes.map((change) => ({ path: change.path, mode: "100644", type: "blob", sha: blobs[change.path] })),
  });
  const created = await apiJson<{ sha: string }>(token, "POST", `/repos/${repo.owner}/${repo.repo}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [head],
  });
  const update = await api(token, "PATCH", `/repos/${repo.owner}/${repo.repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    sha: created.sha,
    force: false,
  });
  if (!update.ok) {
    const detail = await update.text().catch(() => "");
    throw new GithubApiError(409, `The branch moved while saving; reload and try again. ${detail.slice(0, 200)}`.trim());
  }
  return { commitSha: created.sha, blobs };
}

/**
 * Writes `content` to `path` on `branch`. With `sha` given, this matches
 * it against the blob already there — GitHub's own optimistic-concurrency
 * check, which is what turns "someone else (or a second dewnote tab)
 * changed this file since it was opened" into a clear 409 rather than a
 * silent overwrite. This function does not catch that error; the caller
 * reports it, since recovering from it (FAQ's "show both, never pick") is
 * real UI work repo-panel.ts does for an edit to an already-open file.
 *
 * With `sha` omitted, this is instead a brand-new file: GitHub creates
 * the blob at `path` if nothing is there yet, or answers 422 ("sha"
 * wasn't supplied) if something already is — repo-panel.ts's own "start
 * a new file" flow reports that 422 distinctly, since there is no
 * existing edit's "mine" to compare it against the way a real 409 has.
 */
export async function putFileContent(
  repo: RepoRef,
  path: string,
  content: string | Uint8Array,
  sha: string | undefined,
  branch: string,
  message: string,
  token: string,
): Promise<PutFileResult> {
  const body: { message: string; content: string; branch: string; sha?: string } = {
    message,
    content: typeof content === "string" ? toBase64(content) : bytesToBase64(content),
    branch,
  };
  if (sha !== undefined) body.sha = sha;
  const data = await apiJson<{ content: { sha: string } }>(token, "PUT", `/repos/${repo.owner}/${repo.repo}/contents/${path}`, body);
  return { sha: data.content.sha };
}

export interface PullRequest {
  html_url: string;
  number: number;
}

/** Opens a draft PR from `head` to `base`; if one already exists for that
 * branch pair, finds and returns it instead of failing — GitHub's own
 * 422 for "already exists" names the PR number in prose, not a field, so
 * this asks the list endpoint rather than parsing that message. */
export async function openPullRequest(
  repo: RepoRef,
  head: string,
  base: string,
  title: string,
  token: string,
): Promise<PullRequest> {
  try {
    return await apiJson<PullRequest>(token, "POST", `/repos/${repo.owner}/${repo.repo}/pulls`, {
      title,
      head,
      base,
      draft: true,
    });
  } catch (err) {
    if (!(err instanceof GithubApiError) || err.status !== 422) throw err;
    const existing = await apiJson<PullRequest[]>(
      token,
      "GET",
      `/repos/${repo.owner}/${repo.repo}/pulls?head=${encodeURIComponent(`${repo.owner}:${head}`)}&state=open`,
    );
    const [pr] = existing;
    if (!pr) throw err;
    return pr;
  }
}
