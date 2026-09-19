// The pure half of the block menu: which items a query reaches, in what
// order, and how they fall back into their groups. The DOM half — the
// search field, the arrow keys, what a click does — is covered against
// the built app in tests/e2e/slash-menu.spec.ts and practice.spec.ts,
// the same split outline-panel.ts uses.

import { describe, expect, test } from "bun:test";
import {
  BLOCK_MENU_GROUPS,
  BLOCK_MENU_ITEMS,
  SLASH_MENU_ITEMS,
  filterBlockMenu,
  groupBlockMenu,
  scoreBlockMenuItem,
  visualOrder,
} from "./block-menu.ts";

const labels = (items: { label: string }[]) => items.map((item) => item.label);

describe("the table itself", () => {
  test("every item names a group the menu draws", () => {
    for (const item of BLOCK_MENU_ITEMS) {
      expect(BLOCK_MENU_GROUPS, `${item.label}'s group`).toContain(item.group);
    }
  });

  test("no two items share a kind, and none shares a label", () => {
    expect(new Set(BLOCK_MENU_ITEMS.map((i) => i.kind)).size).toBe(BLOCK_MENU_ITEMS.length);
    expect(new Set(BLOCK_MENU_ITEMS.map((i) => i.label)).size).toBe(BLOCK_MENU_ITEMS.length);
  });

  test("every item carries a line of explanation, ending in a full stop", () => {
    // The detail line is what lets the menu hold eight kinds without a
    // reader having to already know what a fold is. A row without one
    // is a row that only helps somebody who did not need the menu.
    for (const item of BLOCK_MENU_ITEMS) {
      expect(item.detail.length, `${item.label} has a detail line`).toBeGreaterThan(0);
      expect(item.detail, `${item.label}'s detail is a sentence`).toMatch(/\.$/);
    }
  });

  test("the slash list is the whole list bar Paragraph", () => {
    // Not a shorter menu — the same menu, minus the one command that
    // would do nothing, since a block you can type "/" into already is
    // a paragraph.
    expect(labels([...SLASH_MENU_ITEMS])).toEqual(labels([...BLOCK_MENU_ITEMS]).filter((l) => l !== "Paragraph"));
  });
});

describe("scoreBlockMenuItem", () => {
  const item = (label: string) => BLOCK_MENU_ITEMS.find((i) => i.label === label)!;

  test("an empty query matches everything equally", () => {
    expect(scoreBlockMenuItem(item("Hint"), "")).toBe(0);
    expect(scoreBlockMenuItem(item("Math"), "   ")).toBe(0);
  });

  test("the four tiers, in order", () => {
    expect(scoreBlockMenuItem(item("Answer"), "an")).toBe(0); // starts the label
    expect(scoreBlockMenuItem(item("Code cell"), "ce")).toBe(1); // starts a word in it
    expect(scoreBlockMenuItem(item("Code cell"), "py")).toBe(2); // starts a keyword
    expect(scoreBlockMenuItem(item("Math"), "at")).toBe(3); // merely inside it
  });

  test("case is not part of it", () => {
    expect(scoreBlockMenuItem(item("Hint"), "HI")).toBe(0);
    expect(scoreBlockMenuItem(item("Image"), "PHOTO")).toBe(2);
  });

  test("no match at all is null, not a large number", () => {
    expect(scoreBlockMenuItem(item("Math"), "zzz")).toBeNull();
  });
});

describe("filterBlockMenu", () => {
  test("an empty query is the whole table, in its own order", () => {
    expect(labels(filterBlockMenu(""))).toEqual(labels([...BLOCK_MENU_ITEMS]));
  });

  test("a label that starts with the query comes before one that merely contains it", () => {
    // "a" starts Answer and sits in the middle of Image, Math and
    // Practice problem. Ranked, Answer is first — which is what the
    // menu's own selection starts on.
    expect(filterBlockMenu("a")[0]!.label).toBe("Answer");
  });

  test("a keyword reaches an item whose label says nothing of the sort", () => {
    expect(labels(filterBlockMenu("python"))).toEqual(["Code cell"]);
    expect(labels(filterBlockMenu("solution"))).toEqual(["Answer"]);
    expect(labels(filterBlockMenu("screenshot"))).toEqual(["Image"]);
  });

  test("both question kinds are reachable by a name that isn't in their label", () => {
    expect(labels(filterBlockMenu("quiz"))).toEqual(["Multiple choice", "Fill in the blank"]);
    expect(labels(filterBlockMenu("cloze"))).toEqual(["Fill in the blank"]);
    expect(labels(filterBlockMenu("choice"))).toEqual(["Multiple choice"]);
  });

  test("ties keep the table's own order rather than sorting by name", () => {
    // Fill in the blank's own label starts with the letter, so it leads;
    // behind it, "figure" on Image, "formula" on Math, "fold" on both
    // Hint and Answer are four items at the same (lower) tier, so the
    // table decides their order among themselves.
    expect(labels(filterBlockMenu("f"))).toEqual(["Fill in the blank", "Image", "Math", "Hint", "Answer"]);
  });

  test("a query nothing matches is empty, not everything", () => {
    expect(filterBlockMenu("zzz")).toEqual([]);
  });

  test("it filters whichever list it is given", () => {
    expect(labels(filterBlockMenu("para", SLASH_MENU_ITEMS))).toEqual([]);
    expect(labels(filterBlockMenu("para", BLOCK_MENU_ITEMS))).toEqual(["Paragraph"]);
  });
});

describe("groupBlockMenu", () => {
  test("groups come in the menu's own order, whatever order the items arrived in", () => {
    const sections = groupBlockMenu(filterBlockMenu(""));
    expect(sections.map((s) => s.group)).toEqual([...BLOCK_MENU_GROUPS]);
  });

  test("a group the filter emptied is dropped rather than drawn empty", () => {
    const sections = groupBlockMenu(filterBlockMenu("python"));
    expect(sections.map((s) => s.group)).toEqual(["Run"]);
  });

  test("regrouping moves the best match away from the top, on purpose", () => {
    // The two orders genuinely disagree, and both are wanted: the eye
    // finds a kind where it always sits, and Enter takes what the
    // ranking chose. This is the case that proves they can differ.
    const ranked = filterBlockMenu("a", SLASH_MENU_ITEMS);
    expect(ranked[0]!.label).toBe("Answer");
    expect(labels(visualOrder(ranked))).toEqual(["Image", "Math", "Answer", "Practice problem", "Fill in the blank"]);
  });

  test("every item survives the regrouping exactly once", () => {
    const ranked = filterBlockMenu("");
    expect(labels(visualOrder(ranked)).sort()).toEqual(labels([...BLOCK_MENU_ITEMS]).sort());
  });
});
