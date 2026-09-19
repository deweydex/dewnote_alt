import { afterEach, describe, expect, test } from "bun:test";
import { canWriteFiles, createFile, openPath, readTextFile, setActiveStore, writeTextFile } from "./active-store.ts";

describe("openPath", () => {
  afterEach(() => setActiveStore(null));

  test("with no store registered, resolves to false rather than throwing", async () => {
    expect(await openPath("anything.md")).toBe(false);
  });

  test("routes to whichever store is currently registered", async () => {
    const calls: string[] = [];
    setActiveStore({
      async openPath(path) {
        calls.push(path);
        return path === "real.md";
      },
    });
    expect(await openPath("real.md")).toBe(true);
    expect(await openPath("missing.md")).toBe(false);
    expect(calls).toEqual(["real.md", "missing.md"]);
  });

  test("registering a new store replaces the old one", async () => {
    setActiveStore({ async openPath() { return true; } });
    setActiveStore({ async openPath() { return false; } });
    expect(await openPath("x.md")).toBe(false);
  });

  test("registering null clears the active store", async () => {
    setActiveStore({ async openPath() { return true; } });
    setActiveStore(null);
    expect(await openPath("x.md")).toBe(false);
  });
});

describe("createFile", () => {
  afterEach(() => setActiveStore(null));

  test("with no store registered, throws a real message rather than silently doing nothing", async () => {
    await expect(createFile("x.md", "content")).rejects.toThrow(/isn't supported/i);
  });

  test("with a store registered but no createFile of its own, throws the same way", async () => {
    setActiveStore({ async openPath() { return true; } });
    await expect(createFile("x.md", "content")).rejects.toThrow(/isn't supported/i);
  });

  test("routes to the registered store's own createFile, forwarding path and content", async () => {
    const calls: { path: string; content: string }[] = [];
    setActiveStore({
      async openPath() {
        return true;
      },
      async createFile(path, content) {
        calls.push({ path, content });
      },
    });
    await createFile("tutorials/new-one/new-one.md", "---\ntitle: New One\n---\n");
    expect(calls).toEqual([{ path: "tutorials/new-one/new-one.md", content: "---\ntitle: New One\n---\n" }]);
  });

  test("a rejection from the store's own createFile propagates as-is", async () => {
    setActiveStore({
      async openPath() {
        return true;
      },
      async createFile() {
        throw new Error("\"tutorials/new-one/new-one.md\" already exists.");
      },
    });
    await expect(createFile("tutorials/new-one/new-one.md", "x")).rejects.toThrow('"tutorials/new-one/new-one.md" already exists.');
  });
});

// The read-modify-write pair series-panel.ts edits module files through.
// Both are optional on the interface, so the interesting cases are the
// ones where a store implements one and not the other: that is what
// `canWriteFiles` exists to tell the panel before it draws a drag handle
// it could not honour.
describe("readTextFile / writeTextFile", () => {
  afterEach(() => setActiveStore(null));

  const opener = { async openPath() { return true; } };

  test("canWriteFiles is false with no store, and false for a store with only half the pair", () => {
    expect(canWriteFiles()).toBe(false);
    setActiveStore(opener);
    expect(canWriteFiles()).toBe(false);
    setActiveStore({ ...opener, async readTextFile() { return ""; } });
    expect(canWriteFiles()).toBe(false);
    setActiveStore({ ...opener, async writeTextFile() {} });
    expect(canWriteFiles()).toBe(false);
  });

  test("canWriteFiles is true only once a store implements both", () => {
    setActiveStore({ ...opener, async readTextFile() { return ""; }, async writeTextFile() {} });
    expect(canWriteFiles()).toBe(true);
  });

  test("each throws a real message rather than silently doing nothing when unsupported", async () => {
    await expect(readTextFile("modules/a.yaml")).rejects.toThrow(/isn't supported/i);
    await expect(writeTextFile("modules/a.yaml", "x", "msg")).rejects.toThrow(/isn't supported/i);
  });

  test("routes to the registered store, forwarding the path, content and commit message", async () => {
    const written: { path: string; content: string; message: string }[] = [];
    setActiveStore({
      ...opener,
      async readTextFile(path) {
        return `read ${path}`;
      },
      async writeTextFile(path, content, message) {
        written.push({ path, content, message });
      },
    });
    expect(await readTextFile("modules/a.yaml")).toBe("read modules/a.yaml");
    await writeTextFile("modules/a.yaml", "title: A\n", "Move x in A from dewnote");
    expect(written).toEqual([{ path: "modules/a.yaml", content: "title: A\n", message: "Move x in A from dewnote" }]);
  });

  test("a rejection from the store propagates as-is — a write the reader asked for that didn't happen", async () => {
    setActiveStore({
      ...opener,
      async readTextFile() {
        return "";
      },
      async writeTextFile() {
        throw new Error("Enter a GitHub token first.");
      },
    });
    await expect(writeTextFile("modules/a.yaml", "x", "msg")).rejects.toThrow("Enter a GitHub token first.");
  });
});
