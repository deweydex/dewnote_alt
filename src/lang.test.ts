import { describe, expect, test } from "bun:test";
import { fenceLanguageToken, languageExtensionFor } from "./lang.ts";

describe("fenceLanguageToken", () => {
  test("takes the first word of the info string", () => {
    expect(fenceLanguageToken("python exec")).toBe("python");
    expect(fenceLanguageToken("sql cell=totals persist")).toBe("sql");
    expect(fenceLanguageToken("html site=box")).toBe("html");
  });

  test("is empty for a bare fence", () => {
    expect(fenceLanguageToken("")).toBe("");
  });

  test("lower-cases its result", () => {
    expect(fenceLanguageToken("Python exec")).toBe("python");
  });
});

describe("languageExtensionFor", () => {
  test("returns an extension for a recognised language", () => {
    expect(languageExtensionFor("python exec").length).toBe(1);
    expect(languageExtensionFor("sql cell=x").length).toBe(1);
    expect(languageExtensionFor("js app=x").length).toBe(1);
  });

  test("returns nothing for an unrecognised or absent language, rather than throwing", () => {
    expect(languageExtensionFor("sql-check db=x task=y").length).toBe(0);
    expect(languageExtensionFor("").length).toBe(0);
  });
});
