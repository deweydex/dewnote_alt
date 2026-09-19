import { describe, expect, test } from "bun:test";
import { buildStandaloneHtmlPage, renderBlocksToHtml } from "./export-html.ts";

describe("renderBlocksToHtml", () => {
  test("front matter is never shown, matching the live page", () => {
    const html = renderBlocksToHtml("---\ntitle: Hidden\n---\n\nBody.\n");
    expect(html).not.toContain("Hidden");
    expect(html).not.toContain("---");
  });

  test("prose renders as real markdown, wrapped for the shared stylesheet", () => {
    const html = renderBlocksToHtml("# A Rule\n\nWhere it lives.\n");
    expect(html).toContain('<div class="dn-block dn-block-prose">');
    expect(html).toContain("<h1>A Rule</h1>");
    expect(html).toContain("<p>Where it lives.</p>");
  });

  test("a hint fold renders as a real <details>, its body as real markdown", () => {
    const source = '<details class="dl-hint"><summary>hint</summary>\n\nTry again.\n\n</details>\n';
    const html = renderBlocksToHtml(source);
    expect(html).toContain('<div class="dn-block dn-block-fold">');
    expect(html).toContain("<summary>hint</summary>");
    expect(html).toContain("<p>Try again.</p>");
  });

  test("an exec cell's id: header is stripped, its code shown as a labelled, escaped block", () => {
    const source = "```python exec\nid: first\nprint('<hi>')\n```\n";
    const html = renderBlocksToHtml(source);
    expect(html).toContain('<div class="dn-block dn-block-fence">');
    expect(html).toContain('<pre><code class="language-python">');
    expect(html).toContain("print('&lt;hi&gt;')");
    expect(html).not.toContain("id: first");
  });

  test("an illustrative (non-exec) fence keeps its full body, header lines included", () => {
    const source = "```python\nid: not-a-header-here\n1 + 1\n```\n";
    const html = renderBlocksToHtml(source);
    expect(html).toContain("id: not-a-header-here");
    expect(html).toContain("1 + 1");
  });
});

describe("buildStandaloneHtmlPage", () => {
  test("uses the front matter title, inlines the given CSS, and wraps the rendered body", () => {
    const source = "---\ntitle: A Rule\n---\n\n# A Rule\n\nWhere it lives.\n";
    const page = buildStandaloneHtmlPage(source, ".dn-page { color: red; }");
    expect(page).toContain("<title>A Rule</title>");
    expect(page).toContain("<style>.dn-page { color: red; }</style>");
    expect(page).toContain('<div class="dn-page">');
    expect(page).toContain("<h1>A Rule</h1>");
    expect(page).toStartWith("<!doctype html>");
  });

  test("falls back to Untitled with no title field", () => {
    const page = buildStandaloneHtmlPage("Just a paragraph.\n", "");
    expect(page).toContain("<title>Untitled</title>");
  });

  test("escapes a title containing HTML-significant characters", () => {
    const page = buildStandaloneHtmlPage('---\ntitle: A <script> & "quotes"\n---\n\nBody.\n', "");
    expect(page).toContain('<title>A &lt;script&gt; &amp; "quotes"</title>');
    expect(page).not.toContain("<script>");
  });
});
