import { describe, expect, test } from "bun:test";
import { buildWorkerSource } from "./worker-source.ts";

describe("buildWorkerSource", () => {
  test("emits JavaScript a browser worker can parse", () => {
    expect(() => new Function(buildWorkerSource())).not.toThrow();
  });

  test("keeps the shared SQL database seed as one escaped JavaScript string", () => {
    expect(buildWorkerSource()).toContain(
      `runPythonAsync("import sqlite3, dewnote_tools\\ndewnote_tools._page_globals['db'] = sqlite3.connect(':memory:')")`,
    );
  });
});
