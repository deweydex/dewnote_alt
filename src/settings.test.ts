import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, parseSettings, settingsToRootProperties } from "./settings.ts";

describe("parseSettings", () => {
  test("returns the defaults for null, undefined, or a non-object", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(5)).toEqual(DEFAULT_SETTINGS);
  });

  test("returns the defaults for an empty object", () => {
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  test("reads every field back when they're all valid", () => {
    const saved = {
      theme: "dark",
      bodyFont: "mono",
      textSize: 20,
      measure: 30,
      margins: "compact",
      lineHeight: 1.9,
      paragraphSpacing: "loose",
      cellTint: false,
      codeFontSize: 13,
      codeFont: "humanist",
      railDisplay: "labels",
      pyodideBase: "https://example.com/pyodide/",
    };
    expect(parseSettings(saved)).toEqual(saved as never);
  });

  test("settings saved before a field existed get that field's default, not a broken object", () => {
    // What is actually in a reader's localStorage today: the shape from
    // before line height, paragraph spacing and the code font were
    // settings at all. Every field they did save survives.
    const beforeTypography = {
      theme: "dark",
      bodyFont: "mono",
      textSize: 20,
      measure: 30,
      margins: "compact",
      cellTint: false,
      codeFontSize: 13,
      pyodideBase: "",
    };
    const result = parseSettings(beforeTypography);
    expect(result.textSize).toBe(20);
    expect(result.measure).toBe(30);
    expect(result.lineHeight).toBe(DEFAULT_SETTINGS.lineHeight);
    expect(result.paragraphSpacing).toBe(DEFAULT_SETTINGS.paragraphSpacing);
    expect(result.codeFont).toBe(DEFAULT_SETTINGS.codeFont);
    expect(result.railDisplay).toBe(DEFAULT_SETTINGS.railDisplay);
  });

  test("line height is clamped to something still readable", () => {
    expect(parseSettings({ lineHeight: 0.4 }).lineHeight).toBe(1.2);
    expect(parseSettings({ lineHeight: 9 }).lineHeight).toBe(2.2);
    expect(parseSettings({ lineHeight: "roomy" }).lineHeight).toBe(DEFAULT_SETTINGS.lineHeight);
  });

  test("an unknown paragraph spacing or code font falls back rather than reaching the stylesheet", () => {
    expect(parseSettings({ paragraphSpacing: "enormous" }).paragraphSpacing).toBe("normal");
    expect(parseSettings({ codeFont: "comic" }).codeFont).toBe("mono");
  });

  test("falls back field by field, not all-or-nothing, when some fields are bad", () => {
    const result = parseSettings({ theme: "dark", textSize: "big", measure: 9999 });
    expect(result.theme).toBe("dark");
    expect(result.textSize).toBe(DEFAULT_SETTINGS.textSize);
    // measure is a real number, just out of range — clamped, not discarded.
    expect(result.measure).toBe(48);
  });

  test("clamps numeric fields to their sane range instead of accepting anything", () => {
    expect(parseSettings({ textSize: 1 }).textSize).toBe(14);
    expect(parseSettings({ textSize: 999 }).textSize).toBe(24);
    expect(parseSettings({ codeFontSize: 0 }).codeFontSize).toBe(11);
    expect(parseSettings({ codeFontSize: 999 }).codeFontSize).toBe(20);
  });

  test("rejects an unknown theme/bodyFont/margins value rather than storing it", () => {
    expect(parseSettings({ theme: "purple" }).theme).toBe("system");
    expect(parseSettings({ bodyFont: "comic-sans" }).bodyFont).toBe("serif");
    expect(parseSettings({ margins: "roomy" }).margins).toBe("comfortable");
  });
});

describe("settingsToRootProperties", () => {
  test("every property is null (removed) for the default settings", () => {
    const props = settingsToRootProperties(DEFAULT_SETTINGS);
    for (const value of Object.values(props)) expect(value).toBeNull();
  });

  test("a changed field produces a real value, not null", () => {
    const props = settingsToRootProperties({ ...DEFAULT_SETTINGS, textSize: 22 });
    expect(props["--dl-font-size"]).toBe("22px");
    // Nothing else moved.
    expect(props["--dl-line-width"]).toBeNull();
  });

  test("theme maps to data-theme, not a CSS custom property", () => {
    expect(settingsToRootProperties({ ...DEFAULT_SETTINGS, theme: "dark" })["data-theme"]).toBe("dark");
    expect(settingsToRootProperties({ ...DEFAULT_SETTINGS, theme: "system" })["data-theme"]).toBeNull();
  });

  test("sidebar presentation maps to a root data attribute", () => {
    expect(settingsToRootProperties({ ...DEFAULT_SETTINGS, railDisplay: "labels" })["data-rail-display"]).toBe("labels");
    expect(settingsToRootProperties(DEFAULT_SETTINGS)["data-rail-display"]).toBeNull();
  });

  test("cellTint false produces an explicit \"0\", not a removed property", () => {
    expect(settingsToRootProperties({ ...DEFAULT_SETTINGS, cellTint: false })["--dn-cell-tint"]).toBe("0");
  });
});
