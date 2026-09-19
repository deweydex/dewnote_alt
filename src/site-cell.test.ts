import { describe, expect, test } from "bun:test";
import { parseDocument } from "./blocks.ts";
import { findSiteGroups, siteGroupContaining } from "./site-cell.ts";

describe("findSiteGroups", () => {
  test("groups two consecutive panes sharing one site: value", () => {
    const source = "```html site\nid: hero-markup\nsite: hero\n<button>Hi</button>\n```\n\n```css site\nid: hero-style\nsite: hero\n.btn{}\n```\n";
    const { blocks } = parseDocument(source);
    const groups = findSiteGroups(blocks);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.site).toBe("hero");
    expect(Object.keys(groups[0]!.panes)).toEqual(["html", "css"]);
  });

  test("a real, non-blank block between two same-name panes breaks the group in two", () => {
    const source = "```html site\nid: a\nsite: hero\n<div></div>\n```\n\nSome real prose in between.\n\n```css site\nid: b\nsite: hero\n.x{}\n```\n";
    const { blocks } = parseDocument(source);
    const groups = findSiteGroups(blocks);
    expect(groups).toHaveLength(2);
    expect(Object.keys(groups[0]!.panes)).toEqual(["html"]);
    expect(Object.keys(groups[1]!.panes)).toEqual(["css"]);
  });

  test("a second pane of the same language for one site starts a new group rather than overwriting the first", () => {
    const source = "```html site\nid: a\nsite: hero\n<div>1</div>\n```\n\n```html site\nid: b\nsite: hero\n<div>2</div>\n```\n";
    const { blocks } = parseDocument(source);
    const groups = findSiteGroups(blocks);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.panes.html?.info.id).toBe("a");
    expect(groups[1]!.panes.html?.info.id).toBe("b");
  });

  test("panes with different site: values never group, even when consecutive", () => {
    const source = "```html site\nid: a\nsite: hero\n<div></div>\n```\n\n```css site\nid: b\nsite: footer\n.x{}\n```\n";
    const { blocks } = parseDocument(source);
    const groups = findSiteGroups(blocks);
    expect(groups).toHaveLength(2);
  });

  test("an ordinary fence never counts as a pane, and a document with none has no groups", () => {
    const { blocks } = parseDocument("```python exec\nid: c\n1\n```\n");
    expect(findSiteGroups(blocks)).toEqual([]);
  });

  test("three panes (html, css, js) sharing a name all join one group", () => {
    const source = [
      "```html site\nid: a\nsite: hero\n<div></div>\n```\n\n",
      "```css site\nid: b\nsite: hero\n.x{}\n```\n\n",
      "```js site\nid: c\nsite: hero\nconsole.log(1);\n```\n",
    ].join("");
    const { blocks } = parseDocument(source);
    const groups = findSiteGroups(blocks);
    expect(groups).toHaveLength(1);
    expect(Object.keys(groups[0]!.panes).sort()).toEqual(["css", "html", "js"]);
  });
});

describe("siteGroupContaining", () => {
  test("finds the group owning a given block index, or null outside any group", () => {
    const source = "```html site\nid: a\nsite: hero\n<div></div>\n```\n\nProse.\n";
    const { blocks } = parseDocument(source);
    const groups = findSiteGroups(blocks);
    expect(siteGroupContaining(groups, 0)).toBe(groups[0]!);
    expect(siteGroupContaining(groups, blocks.length - 1)).toBeNull();
  });
});
