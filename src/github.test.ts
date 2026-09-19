import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fromBase64, listModuleFiles, listMarkdownFiles, putFileContent, toBase64 } from "./github.ts";

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
