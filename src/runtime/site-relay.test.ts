import { describe, expect, test } from "bun:test";
import { buildSiteDocument } from "./site-relay.ts";

describe("buildSiteDocument", () => {
  test("assembles a full HTML document with the CSS inlined and the HTML in the body", () => {
    const doc = buildSiteDocument("<button>Hi</button>", ".btn { color: red; }", null);
    expect(doc).toContain("<style>.btn { color: red; }</style>");
    expect(doc).toContain("<button>Hi</button>");
  });

  test("always carries base href=about:srcdoc — the dewmini bug this is built to not repeat", () => {
    const doc = buildSiteDocument("", "", null);
    expect(doc).toContain('<base href="about:srcdoc">');
  });

  test("with js null, the script tag still carries the console relay but no reader-authored code", () => {
    const doc = buildSiteDocument("", "", null);
    expect(doc).toContain("<script>");
    expect(doc).toContain("__dnSiteConsole");
  });

  test("with real js, it's appended after the relay, inside the same script tag", () => {
    const doc = buildSiteDocument("", "", "console.log('hi');");
    expect(doc).toContain("console.log('hi');");
    const scriptStart = doc.indexOf("<script>");
    const relayIndex = doc.indexOf("__dnSiteConsole");
    const jsIndex = doc.indexOf("console.log('hi');");
    expect(scriptStart).toBeLessThan(relayIndex);
    expect(relayIndex).toBeLessThan(jsIndex);
  });
});
