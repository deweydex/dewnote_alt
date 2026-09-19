import { describe, expect, test } from "bun:test";
import { createFile, listModuleFiles, listMarkdownFiles, readFile, type DirectoryLike } from "./folder-store.ts";

/** A hand-built fake — no real FileSystemDirectoryHandle needed to
 * verify the walk itself, the same split github.ts's own truncation
 * fallback test uses against a mocked fetch rather than a real API. */
function fakeDir(entries: Record<string, DirectoryLike | { kind: "file" }>): DirectoryLike {
  return {
    async *entries() {
      for (const [name, value] of Object.entries(entries)) {
        yield [name, value as unknown as FileSystemHandle];
      }
    },
  };
}

describe("listMarkdownFiles", () => {
  test("finds markdown files at the root, ignoring non-markdown ones", async () => {
    const root = fakeDir({
      "README.md": { kind: "file" },
      "logo.png": { kind: "file" },
    });
    const files = await listMarkdownFiles(root);
    expect(files.map((f) => f.path)).toEqual(["README.md"]);
  });

  test("walks nested directories, building a full relative path", async () => {
    const root = fakeDir({
      "README.md": { kind: "file" },
      content: fakeDir({
        "a.md": { kind: "file" },
        sub: fakeDir({
          "b.md": { kind: "file" },
        }),
      }),
    });
    const files = await listMarkdownFiles(root);
    expect(files.map((f) => f.path).sort()).toEqual(["README.md", "content/a.md", "content/sub/b.md"]);
  });

  test("an empty folder yields no files", async () => {
    expect(await listMarkdownFiles(fakeDir({}))).toEqual([]);
  });
});

describe("listModuleFiles", () => {
  test("finds current courses/*.yaml and legacy modules/*.yaml", async () => {
    const root = fakeDir({
      "README.md": { kind: "file" },
      modules: fakeDir({
        "computational-methods.yaml": { kind: "file" },
        "index.yaml": { kind: "file" },
      }),
      courses: fakeDir({
        "web-authoring.yaml": { kind: "file" },
        "index.yaml": { kind: "file" },
      }),
      tutorials: fakeDir({
        "first-steps": fakeDir({
          "first-steps.md": { kind: "file" },
          // A tutorial's own glossary is yaml too, and is not a module.
          "first-steps.glossary.yaml": { kind: "file" },
        }),
      }),
    });
    const files = await listModuleFiles(root);
    expect(files.map((f: { path: string }) => f.path).sort()).toEqual([
      "courses/index.yaml",
      "courses/web-authoring.yaml",
      "modules/computational-methods.yaml",
      "modules/index.yaml",
    ]);
  });

  test("only directly inside either descriptor directory, not one level deeper", async () => {
    const root = fakeDir({
      modules: fakeDir({
        "web-authoring.yaml": { kind: "file" },
        archive: fakeDir({ "old-module.yaml": { kind: "file" } }),
      }),
      courses: fakeDir({
        "database-methods.yaml": { kind: "file" },
        archive: fakeDir({ "old-course.yaml": { kind: "file" } }),
      }),
    });
    const files = await listModuleFiles(root);
    expect(files.map((f: { path: string }) => f.path).sort()).toEqual([
      "courses/database-methods.yaml",
      "modules/web-authoring.yaml",
    ]);
  });
});

/** A hand-built, genuinely writable fake — real `getDirectoryHandle`/
 * `getFileHandle` semantics (create-on-demand, or reject when `create`
 * isn't set and nothing's there), backed by a plain in-memory Map
 * rather than a real filesystem, the same "verify the logic, not the
 * browser API" split `fakeDir` above already uses for reading. */
function fakeWritableDir(): FileSystemDirectoryHandle {
  const children = new Map<string, unknown>();
  const dir = {
    kind: "directory",
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      let child = children.get(name);
      if (!child) {
        if (!options?.create) throw new Error(`"${name}" not found`);
        child = fakeWritableDir();
        children.set(name, child);
      }
      return child;
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      let child = children.get(name);
      if (!child) {
        if (!options?.create) throw new Error(`"${name}" not found`);
        child = fakeWritableFile();
        children.set(name, child);
      }
      return child;
    },
  };
  return dir as unknown as FileSystemDirectoryHandle;
}

function fakeWritableFile(): FileSystemFileHandle {
  let content = "";
  const file = {
    kind: "file",
    async createWritable() {
      return {
        async write(data: string) {
          content = data;
        },
        async close() {},
      };
    },
    async getFile() {
      return { text: async () => content };
    },
  };
  return file as unknown as FileSystemFileHandle;
}

describe("createFile", () => {
  test("creates a file at the root, readable back through the handle it returns", async () => {
    const root = fakeWritableDir();
    const file = await createFile(root, "a-series.order.yaml", "series: A Series\norder: []\n");
    expect(file.path).toBe("a-series.order.yaml");
    expect(await readFile(file.handle)).toBe("series: A Series\norder: []\n");
  });

  test("creates any missing intermediate directories along the way", async () => {
    const root = fakeWritableDir();
    const file = await createFile(root, "computational-methods/python-fundamentals.order.yaml", "series: Python fundamentals\norder: []\n");
    expect(file.path).toBe("computational-methods/python-fundamentals.order.yaml");
    // The directory really was created, not merely assumed — a second
    // file in the same directory reuses it rather than failing.
    const second = await createFile(root, "computational-methods/second.order.yaml", "series: Second\norder: []\n");
    expect(second.path).toBe("computational-methods/second.order.yaml");
  });

  test("refuses to overwrite a file that already exists", async () => {
    const root = fakeWritableDir();
    await createFile(root, "x.order.yaml", "series: X\norder: []\n");
    await expect(createFile(root, "x.order.yaml", "series: Overwritten\norder: []\n")).rejects.toThrow(/already exists/);
  });

  test("an empty path has no file name to create, and is rejected", async () => {
    const root = fakeWritableDir();
    await expect(createFile(root, "", "content")).rejects.toThrow(/no file name/);
  });
});
