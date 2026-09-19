import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { commitFilesAtomically, compareBranches, fromBase64, listModuleFiles, listMarkdownFiles, putFileContent, toBase64 } from "./github.ts";

describe("toBase64/fromBase64", () => {
  test("round-trips plain ASCII", () => {
    const text = "# A Rule\n\nWhere it lives.\n";
    expect(fromBase64(toBase64(text))).toBe(text);
  });

  test("round-trips real Unicode — an em dash, a µ, a checkmark", () => {
    const text = "A tutorial — with µs and ✓, not just ASCII.\n";
    expect(fromBase64(toBase64(text))).toBe(text);
  });

  test("round-trips an empty string", () => {
    expect(fromBase64(toBase64(""))).toBe("");
  });

  test("fromBase64 tolerates GitHub's own newline-wrapped base64", () => {
    const text = "line one\nline two\n";
    const wrapped = toBase64(text).replace(/(.{4})/g, "$1\n");
    expect(fromBase64(wrapped)).toBe(text);
  });
});

describe("listMarkdownFiles", () => {
  const originalFetch = globalThis.fetch;
  let calls: string[] = [];

  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function respond(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  test("the common case is one recursive call, filtered to .md blobs", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      expect(url).toContain("/git/trees/main?recursive=1");
      return respond({
        truncated: false,
        tree: [
          { path: "README.md", type: "blob", sha: "s1" },
          { path: "content/a.md", type: "blob", sha: "s2" },
          { path: "assets/logo.png", type: "blob", sha: "s3" },
        ],
      });
    }) as typeof fetch;

    const files = await listMarkdownFiles({ owner: "dewlab", repo: "dewlab" }, "main", "tok");
    expect(files).toEqual([
      { path: "README.md", sha: "s1" },
      { path: "content/a.md", sha: "s2" },
    ]);
    expect(calls).toHaveLength(1);
  });

  test("a truncated response falls back to walking every directory, missing nothing", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("recursive=1")) {
        return respond({ truncated: true, tree: [] });
      }
      if (url.endsWith("/git/trees/main")) {
        return respond({
          tree: [
            { path: "README.md", type: "blob", sha: "s1" },
            { path: "content", type: "tree", sha: "tree-content" },
          ],
        });
      }
      if (url.endsWith("/git/trees/tree-content")) {
        return respond({
          tree: [
            { path: "a.md", type: "blob", sha: "s2" },
            { path: "sub", type: "tree", sha: "tree-sub" },
            { path: "image.png", type: "blob", sha: "s3" },
          ],
        });
      }
      if (url.endsWith("/git/trees/tree-sub")) {
        return respond({ tree: [{ path: "b.md", type: "blob", sha: "s4" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const files = await listMarkdownFiles({ owner: "dewlab", repo: "dewlab" }, "main", "tok");
    expect(files.map((f) => f.path).sort()).toEqual(["README.md", "content/a.md", "content/sub/b.md"]);
    // One recursive probe plus one call per directory (root, content, sub) — never silently incomplete.
    expect(calls).toHaveLength(4);
  });
});

describe("listModuleFiles", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function respond(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  test("filters to current courses/*.yaml and legacy modules/*.yaml blobs", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      respond({
        truncated: false,
        tree: [
          { path: "modules/computational-methods.yaml", type: "blob", sha: "s1" },
          { path: "courses/web-authoring.yaml", type: "blob", sha: "s5" },
          { path: "tutorials/filtering/filtering.md", type: "blob", sha: "s2" },
          // Yaml outside modules/, and yaml a level deeper inside it,
          // are both something else.
          { path: "tutorials/filtering/filtering.glossary.yaml", type: "blob", sha: "s3" },
          { path: "modules/archive/old.yaml", type: "blob", sha: "s4" },
        ],
      })) as typeof fetch;

    const files = await listModuleFiles({ owner: "dewlab", repo: "dewlab" }, "main", "tok");
    expect(files).toEqual([
      { path: "modules/computational-methods.yaml", sha: "s1" },
      { path: "courses/web-authoring.yaml", sha: "s5" },
    ]);
  });
});

describe("putFileContent", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function respond(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  // decision 32: a brand-new file has no sha to match against yet — the
  // request body itself has to leave the field out entirely, not send it
  // as an explicit `null` or `undefined`, since GitHub's own "create"
  // vs. "update" branch keys off whether the JSON key is present at all.
  test("with no sha given, the request body omits the field entirely", async () => {
    let sentBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return respond({ content: { sha: "new-sha" } });
    }) as typeof fetch;

    const result = await putFileContent(
      { owner: "dewlab", repo: "dewlab" },
      "tutorials/new.md",
      "# New\n",
      undefined,
      "dewnote-edits",
      "Add tutorials/new.md from dewnote",
      "tok",
    );
    expect(result).toEqual({ sha: "new-sha" });
    expect(sentBody).not.toBeNull();
    expect(Object.keys(sentBody!)).not.toContain("sha");
  });

  test("with a sha given, the request body includes it, matching the existing blob", async () => {
    let sentBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return respond({ content: { sha: "updated-sha" } });
    }) as typeof fetch;

    await putFileContent(
      { owner: "dewlab", repo: "dewlab" },
      "tutorials/existing.md",
      "# Existing\n",
      "old-sha",
      "dewnote-edits",
      "Edit tutorials/existing.md from dewnote",
      "tok",
    );
    expect(sentBody!).toEqual({
      message: "Edit tutorials/existing.md from dewnote",
      content: toBase64("# Existing\n"),
      branch: "dewnote-edits",
      sha: "old-sha",
    });
  });
});

describe("compareBranches", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("returns the repository's real added, modified, deleted and renamed files", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ files: [
      { filename: "tutorials/new.md", status: "added", additions: 12, deletions: 0 },
      { filename: "courses/module.yaml", status: "modified", additions: 2, deletions: 1 },
      { filename: "old.md", status: "removed", additions: 0, deletions: 8 },
      { filename: "new-name.md", previous_filename: "old-name.md", status: "renamed", additions: 1, deletions: 1 },
    ] }), { status: 200 })) as unknown as typeof fetch;

    expect(await compareBranches({ owner: "deweydex", repo: "dewlab" }, "main", "dewnote-edits", "tok")).toEqual([
      { path: "tutorials/new.md", status: "added", additions: 12, deletions: 0 },
      { path: "courses/module.yaml", status: "modified", additions: 2, deletions: 1 },
      { path: "old.md", status: "removed", additions: 0, deletions: 8 },
      { path: "new-name.md", previousPath: "old-name.md", status: "renamed", additions: 1, deletions: 1 },
    ]);
  });

  test("a working branch that does not exist yet has no changes", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await compareBranches({ owner: "deweydex", repo: "dewlab" }, "main", "missing", "tok")).toEqual([]);
  });
});

describe("commitFilesAtomically", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("checks both paths and advances the branch with one commit", async () => {
    const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
    let blob = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ method, path: `${url.pathname}${url.search}`, ...(body ? { body } : {}) });
      if (url.pathname.endsWith("/git/ref/heads/dewnote-edits")) return new Response(JSON.stringify({ object: { sha: "head-sha" } }), { status: 200 });
      if (url.pathname.includes("/contents/frozen.md")) return new Response("{}", { status: 404 });
      if (url.pathname.includes("/contents/live.md")) return new Response(JSON.stringify({ sha: "live-sha" }), { status: 200 });
      if (url.pathname.endsWith("/git/commits/head-sha")) return new Response(JSON.stringify({ tree: { sha: "base-tree" } }), { status: 200 });
      if (url.pathname.endsWith("/git/blobs")) return new Response(JSON.stringify({ sha: `blob-${++blob}` }), { status: 201 });
      if (url.pathname.endsWith("/git/trees")) return new Response(JSON.stringify({ sha: "new-tree" }), { status: 201 });
      if (url.pathname.endsWith("/git/commits")) return new Response(JSON.stringify({ sha: "new-commit" }), { status: 201 });
      if (url.pathname.endsWith("/git/refs/heads/dewnote-edits")) return new Response(JSON.stringify({ object: { sha: "new-commit" } }), { status: 200 });
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    }) as typeof fetch;

    const result = await commitFilesAtomically(
      { owner: "deweydex", repo: "dewlab" },
      "dewnote-edits",
      "main",
      [
        { path: "frozen.md", content: "old", expectedSha: null },
        { path: "live.md", content: "new", expectedSha: "live-sha" },
      ],
      "Release",
      "tok",
    );
    expect(result).toEqual({ commitSha: "new-commit", blobs: { "frozen.md": "blob-1", "live.md": "blob-2" } });
    expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/commits"))).toHaveLength(1);
    expect(calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/git/refs/heads/dewnote-edits"))).toHaveLength(1);
  });

  test("refuses the whole commit before creating blobs when an expected path changed", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith("/git/ref/heads/dewnote-edits")) return new Response(JSON.stringify({ object: { sha: "head-sha" } }), { status: 200 });
      if (url.pathname.includes("/contents/live.md")) return new Response(JSON.stringify({ sha: "someone-elses-sha" }), { status: 200 });
      throw new Error(`Unexpected ${url.pathname}`);
    }) as typeof fetch;

    await expect(commitFilesAtomically(
      { owner: "deweydex", repo: "dewlab" },
      "dewnote-edits",
      "main",
      [{ path: "live.md", content: "new", expectedSha: "old-sha" }],
      "Release",
      "tok",
    )).rejects.toMatchObject({ status: 409 });
    expect(calls.some((path) => path.endsWith("/git/blobs"))).toBe(false);
  });
});
