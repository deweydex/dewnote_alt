import { describe, expect, test } from "bun:test";
import { parseDocument } from "./blocks.ts";
import {
  declaredPackages,
  execCellLanguage,
  isCardFence,
  isHintFence,
  isQuestionFence,
  isRunnableFence,
  isSitePaneFence,
  parseCardFence,
  parseCellSource,
  parseCellSourceFromFenceText,
  parseHintFence,
  parseQuestionFence,
  parseSitePaneInfo,
  parseSqlCellInfo,
  replaceCellCode,
  setCellHeaderField,
  sqlPersistStorageKey,
  sqlScriptFromFenceText,
  wrapSqlExecCode,
} from "./cell.ts";

function fenceBlock(source: string) {
  const doc = parseDocument(source);
  const block = doc.blocks.find((b) => b.kind === "fence");
  if (!block) throw new Error("no fence block in fixture");
  return block;
}

const NO_HEADERS = { hint: null, expect: null, name: null };

describe("parseCellSource", () => {
  test("reads an id and hint header off the fence body", () => {
    const block = fenceBlock("```python exec\nid: totals\nhint: sum the list\nprint(sum(xs))\n```\n");
    expect(parseCellSource(block)).toEqual({ id: "totals", hint: "sum the list", expect: null, name: null, code: "print(sum(xs))" });
  });

  test("works with just an id, no hint", () => {
    const block = fenceBlock("```python exec\nid: totals\nprint(1)\n```\n");
    expect(parseCellSource(block)).toEqual({ id: "totals", ...NO_HEADERS, code: "print(1)" });
  });

  test("is fine with no header lines at all", () => {
    const block = fenceBlock("```python exec\nprint(1)\n```\n");
    expect(parseCellSource(block)).toEqual({ id: null, ...NO_HEADERS, code: "print(1)" });
  });

  test("keeps multi-line code intact, headers and all", () => {
    const block = fenceBlock("```python exec\nid: c\nx = 1\ny = 2\nprint(x + y)\n```\n");
    expect(parseCellSource(block).code).toBe("x = 1\ny = 2\nprint(x + y)");
  });

  test("does not treat a code line that merely contains a colon as a header", () => {
    const block = fenceBlock("```python exec\nid: c\nd = {'a': 1}\n```\n");
    expect(parseCellSource(block)).toEqual({ id: "c", ...NO_HEADERS, code: "d = {'a': 1}" });
  });

  test("stops reading headers at the first non-header line, even if a later line looks like one", () => {
    const block = fenceBlock("```python exec\nid: c\nprint('id: not a header')\n```\n");
    expect(parseCellSource(block)).toEqual({ id: "c", ...NO_HEADERS, code: "print('id: not a header')" });
  });

  // dewlab's own header grammar as of d2a21ed (2026-09-10) — DIALECTS.md
  // §1. Not recognising these used to mean the line fell through into
  // `code`, and `expect: len(xs) == 4` is not valid Python.
  test("reads expect: and name: headers, in either order, without swallowing them into code", () => {
    const block = fenceBlock("```python exec\nid: c\nexpect: total == 6\nname: totals\nprint(total)\n```\n");
    expect(parseCellSource(block)).toEqual({ id: "c", hint: null, expect: "total == 6", name: "totals", code: "print(total)" });
  });

  test("a name: line containing = is real code, not a header — dewlab's own ca6e16e fix", () => {
    const block = fenceBlock('```python exec\nid: c\nname: str = "Ada"\nprint(name)\n```\n');
    expect(parseCellSource(block)).toEqual({ id: "c", ...NO_HEADERS, code: 'name: str = "Ada"\nprint(name)' });
  });

  test("an expect: line may itself contain =, and still reads as a header", () => {
    const block = fenceBlock("```python exec\nid: c\nexpect: total == 6\nprint(total)\n```\n");
    expect(parseCellSource(block).expect).toBe("total == 6");
  });
});

describe("parseCellSourceFromFenceText", () => {
  test("agrees with parseCellSource on the same text", () => {
    const text = "```python exec\nid: totals\nhint: sum the list\nprint(sum(xs))\n```\n";
    expect(parseCellSourceFromFenceText(text)).toEqual(parseCellSource(fenceBlock(text)));
  });

  test("reads a live editor's un-committed text directly, no trailing newline required", () => {
    expect(parseCellSourceFromFenceText("```python exec\nid: c\nprint(1)\n```")).toEqual({
      id: "c",
      ...NO_HEADERS,
      code: "print(1)",
    });
  });
});

const CELL_FENCE = "```python exec\nid: filter-evening\nhint: Try it first.\nreadings\n```\n";

describe("setCellHeaderField", () => {
  test("updates an existing header field's value, touching only that line", () => {
    const result = setCellHeaderField(CELL_FENCE, "hint", "A new hint.");
    expect(result).toBe("```python exec\nid: filter-evening\nhint: A new hint.\nreadings\n```\n");
  });

  test("adds a field that wasn't present, just before the code", () => {
    const noExpect = "```python exec\nid: c\nreadings\n```\n";
    const result = setCellHeaderField(noExpect, "expect", "len(readings) > 0");
    expect(result).toBe("```python exec\nid: c\nexpect: len(readings) > 0\nreadings\n```\n");
  });

  test("clears an existing optional field by removing its line", () => {
    const result = setCellHeaderField(CELL_FENCE, "hint", "");
    expect(result).toBe("```python exec\nid: filter-evening\nreadings\n```\n");
  });

  test("clearing a field that was never present is a no-op", () => {
    expect(setCellHeaderField(CELL_FENCE, "expect", "")).toBe(CELL_FENCE);
  });

  test("setting a field to the value it already has is a no-op, byte for byte", () => {
    expect(setCellHeaderField(CELL_FENCE, "hint", "Try it first.")).toBe(CELL_FENCE);
  });

  test("never touches the code, whatever it contains", () => {
    const withHeaderLikeCode = "```python exec\nid: c\nname: str = \"Ada\"\n```\n";
    const result = setCellHeaderField(withHeaderLikeCode, "hint", "A hint.");
    // "name: str = ..." is real code (the `=` disambiguation), not a
    // header field — it must survive untouched, and the new hint line
    // lands after id, before that code line.
    expect(result).toBe('```python exec\nid: c\nhint: A hint.\nname: str = "Ada"\n```\n');
  });

  test("preserves everything up to and including the colon, one space before the new value", () => {
    // Matches setFrontMatterField's own convention: the key's exact
    // spelling and any space before the colon survive untouched; the gap
    // between colon and value normalises to one space on an edit, the
    // same as every other field this form ever writes.
    const loose = "```python exec\nid  :   c\nreadings\n```\n";
    const result = setCellHeaderField(loose, "id", "renamed");
    expect(result).toBe("```python exec\nid  : renamed\nreadings\n```\n");
  });

});

describe("replaceCellCode", () => {
  test("replaces the code, keeping every header line untouched", () => {
    const result = replaceCellCode(CELL_FENCE, "readings[readings > 0]");
    expect(result).toBe("```python exec\nid: filter-evening\nhint: Try it first.\nreadings[readings > 0]\n```\n");
  });

  test("multi-line code round-trips through as multiple lines", () => {
    const result = replaceCellCode(CELL_FENCE, "a = 1\nb = 2\na + b");
    expect(result).toBe("```python exec\nid: filter-evening\nhint: Try it first.\na = 1\nb = 2\na + b\n```\n");
  });

  test("agrees with parseCellSourceFromFenceText: reading back what was just written returns the same code", () => {
    const written = replaceCellCode(CELL_FENCE, "new code here");
    expect(parseCellSourceFromFenceText(written).code).toBe("new code here");
    expect(parseCellSourceFromFenceText(written).hint).toBe("Try it first.");
  });

  test("an untouched cell with no code lines at all round-trips byte for byte", () => {
    // parseHeaderAndCode reads *both* "no code lines at all" and "one
    // blank code line" as code: "" — mounting this fence's own parsed
    // code (here, "") into a live editor and immediately writing it back
    // unedited must reproduce this exact fence, not the other shape "".
    const noCodeAtAll = "```python exec\nid: x\n```\n";
    expect(parseCellSourceFromFenceText(noCodeAtAll).code).toBe("");
    expect(replaceCellCode(noCodeAtAll, "")).toBe(noCodeAtAll);
  });

  test("an untouched cell with a single blank code line round-trips byte for byte too", () => {
    const oneBlankLine = "```python exec\nid: x\n\n```\n";
    expect(parseCellSourceFromFenceText(oneBlankLine).code).toBe("");
    expect(replaceCellCode(oneBlankLine, "")).toBe(oneBlankLine);
  });

  test("clearing real code back down to nothing removes the line entirely, not a blank one", () => {
    const result = replaceCellCode(CELL_FENCE, "");
    expect(result).toBe("```python exec\nid: filter-evening\nhint: Try it first.\n```\n");
  });
});

describe("declaredPackages", () => {
  test("reads a list of package names", () => {
    expect(declaredPackages({ packages: ["sympy", "requests"] })).toEqual(["sympy", "requests"]);
  });

  test("is empty when the field is absent", () => {
    expect(declaredPackages({ title: "A doc" })).toEqual([]);
  });

  test("is empty rather than throwing when the field isn't a list", () => {
    expect(declaredPackages({ packages: "sympy" })).toEqual([]);
    expect(declaredPackages({ packages: 5 })).toEqual([]);
  });

  test("drops non-string entries from an otherwise valid list", () => {
    expect(declaredPackages({ packages: ["sympy", 5, null] })).toEqual(["sympy"]);
  });
});

describe("parseSqlCellInfo", () => {
  test("reads the database name a cell=name fence shares", () => {
    expect(parseSqlCellInfo("sql cell=products")).toEqual({ name: "products", persist: false });
  });

  test("is null for a plain sql fence with no cell=", () => {
    expect(parseSqlCellInfo("sql")).toBeNull();
  });

  test("is null for a python exec fence", () => {
    expect(parseSqlCellInfo("python exec")).toBeNull();
  });

  test("is null for an empty info string", () => {
    expect(parseSqlCellInfo("")).toBeNull();
  });

  test("tolerates trailing whitespace", () => {
    expect(parseSqlCellInfo("sql cell=totals  ")).toEqual({ name: "totals", persist: false });
  });

  test("reads persist as a real flag, not just tolerated syntax", () => {
    expect(parseSqlCellInfo("sql cell=totals persist")).toEqual({ name: "totals", persist: true });
  });
});

describe("sqlPersistStorageKey", () => {
  test("namespaces the key so it can't collide with anything else in localStorage", () => {
    expect(sqlPersistStorageKey("totals")).toBe("dewnote-sql:totals");
  });

  test("two different cell names get two different keys", () => {
    expect(sqlPersistStorageKey("a")).not.toBe(sqlPersistStorageKey("b"));
  });
});

describe("sqlScriptFromFenceText", () => {
  test("returns the whole body, no header lines to peel off", () => {
    const text = "```sql cell=products\nCREATE TABLE products (id INTEGER);\nSELECT * FROM products;\n```\n";
    expect(sqlScriptFromFenceText(text)).toBe("CREATE TABLE products (id INTEGER);\nSELECT * FROM products;");
  });

  test("works against a live editor's text with no trailing newline", () => {
    expect(sqlScriptFromFenceText("```sql cell=c\nSELECT 1;\n```")).toBe("SELECT 1;");
  });
});

describe("isRunnableFence", () => {
  test("is true when exec is one of the info string's tokens", () => {
    expect(isRunnableFence("python exec")).toBe(true);
    expect(isRunnableFence("exec")).toBe(true);
    expect(isRunnableFence("python exec id=c")).toBe(true);
  });

  test("is false for a plain illustrative fence", () => {
    expect(isRunnableFence("python")).toBe(false);
    expect(isRunnableFence("")).toBe(false);
  });

  test("does not match exec as a substring of another token", () => {
    expect(isRunnableFence("nonexec")).toBe(false);
    expect(isRunnableFence("execute")).toBe(false);
  });
});

describe("execCellLanguage", () => {
  test("is sql only when the fence's first word is literally sql", () => {
    expect(execCellLanguage("sql exec")).toBe("sql");
  });

  test("is python for python exec, and for anything else, dewlab's own default", () => {
    expect(execCellLanguage("python exec")).toBe("python");
    expect(execCellLanguage("exec")).toBe("python");
    expect(execCellLanguage("javascript exec")).toBe("python");
  });
});

describe("wrapSqlExecCode", () => {
  test("wraps the script as a bare expression against the shared db, not an assignment", () => {
    const wrapped = wrapSqlExecCode("select * from readings;");
    expect(wrapped).toBe('import dewnote_sql_tools as _dn_sql\n_dn_sql.run_sql_cell(db, "select * from readings;")');
  });

  test("JSON-escapes the script, so quotes and newlines in it survive as real Python string content", () => {
    const wrapped = wrapSqlExecCode("select 'a' as x;\nselect 2;");
    expect(wrapped).toContain('"select \'a\' as x;\\nselect 2;"');
  });
});

describe("isHintFence", () => {
  test("is true when the fence's first info word is literally hint", () => {
    expect(isHintFence("hint")).toBe(true);
  });

  test("is false for anything else, including a fence that merely mentions hint", () => {
    expect(isHintFence("python exec")).toBe(false);
    expect(isHintFence("")).toBe(false);
    expect(isHintFence("hinted")).toBe(false);
  });
});

describe("parseHintFence", () => {
  test("reads for:, after:, and title:, and the body beneath them", () => {
    const block = fenceBlock("```hint\nfor: totals\nafter: 3 errors\ntitle: Try this\n\nCheck your column names.\n```\n");
    expect(parseHintFence(block)).toEqual({ for: "totals", after: "3 errors", title: "Try this", body: "Check your column names." });
  });

  test("defaults after: and title: when absent, and for: stays null rather than guessed", () => {
    const block = fenceBlock("```hint\nCheck your column names.\n```\n");
    expect(parseHintFence(block)).toEqual({
      for: null,
      after: "errors:5",
      title: "Let’s slow down a moment…",
      body: "Check your column names.",
    });
  });

  test("a hint with no header lines at all is still read correctly, body only", () => {
    const block = fenceBlock("```hint\nJust the body, no headers.\n```\n");
    expect(parseHintFence(block).body).toBe("Just the body, no headers.");
  });
});

describe("isCardFence", () => {
  test("is true only when the fence's whole info string is card", () => {
    expect(isCardFence("card")).toBe(true);
  });

  test("is false for anything else, including a fence that merely mentions card", () => {
    expect(isCardFence("python exec")).toBe(false);
    expect(isCardFence("")).toBe(false);
    expect(isCardFence("card wide")).toBe(false);
  });
});

describe("parseCardFence", () => {
  test("reads url:, status:, meta:, the heading, and the body beneath them", () => {
    const block = fenceBlock(
      "```card\nurl: computational-methods.html\nstatus: beta\nmeta: 5N0554 · QQI Level 5\n### Computational Methods\nWe work through matrices and simulation.\n```\n",
    );
    expect(parseCardFence(block)).toEqual({
      url: "computational-methods.html",
      status: "beta",
      meta: "5N0554 · QQI Level 5",
      wide: false,
      heading: "Computational Methods",
      body: "We work through matrices and simulation.",
    });
  });

  test("wide: true/yes both count; anything else does not", () => {
    const wide = fenceBlock("```card\nurl: a.html\nwide: true\n### A\n```\n");
    expect(parseCardFence(wide).wide).toBe(true);
    const alsoWide = fenceBlock("```card\nurl: a.html\nwide: yes\n### A\n```\n");
    expect(parseCardFence(alsoWide).wide).toBe(true);
    const notWide = fenceBlock("```card\nurl: a.html\nwide: no\n### A\n```\n");
    expect(parseCardFence(notWide).wide).toBe(false);
  });

  test("status:, meta:, and wide: are all optional, and absent ones stay null/false", () => {
    const block = fenceBlock("```card\nurl: features.html\n### What dewlab can do\n```\n");
    expect(parseCardFence(block)).toEqual({
      url: "features.html",
      status: null,
      meta: null,
      wide: false,
      heading: "What dewlab can do",
      body: "",
    });
  });

  test("a card with no url: still reads its heading and body, url just stays null", () => {
    const block = fenceBlock("```card\n### A Card\nSome text.\n```\n");
    const card = parseCardFence(block);
    expect(card.url).toBeNull();
    expect(card.heading).toBe("A Card");
    expect(card.body).toBe("Some text.");
  });

  test("a body with no heading at all reads heading as null rather than throwing", () => {
    const block = fenceBlock("```card\nurl: a.html\nJust prose, no heading.\n```\n");
    const card = parseCardFence(block);
    expect(card.heading).toBeNull();
    expect(card.body).toBe("Just prose, no heading.");
  });

  test("skips leading blank lines before looking for the heading, like dewlab's own parser", () => {
    const block = fenceBlock("```card\nurl: a.html\n\n\n### A Card\nBody.\n```\n");
    const card = parseCardFence(block);
    expect(card.heading).toBe("A Card");
    expect(card.body).toBe("Body.");
  });
});

describe("isSitePaneFence", () => {
  test("is true for html/css/js site, and false for anything else", () => {
    expect(isSitePaneFence("html site")).toBe(true);
    expect(isSitePaneFence("css site")).toBe(true);
    expect(isSitePaneFence("js site")).toBe(true);
    expect(isSitePaneFence("html")).toBe(false);
    expect(isSitePaneFence("python exec")).toBe(false);
    expect(isSitePaneFence("site html")).toBe(false);
    expect(isSitePaneFence("")).toBe(false);
  });
});

describe("parseSitePaneInfo", () => {
  test("reads id:, site:, and the body beneath them", () => {
    const block = fenceBlock("```html site\nid: hero-markup\nsite: hero\n<button>Hover me</button>\n```\n");
    expect(parseSitePaneInfo(block)).toEqual({ language: "html", id: "hero-markup", site: "hero", body: "<button>Hover me</button>" });
  });

  test("reads the language from the fence's own first word", () => {
    const block = fenceBlock("```css site\nid: hero-style\nsite: hero\n.btn { color: red; }\n```\n");
    expect(parseSitePaneInfo(block).language).toBe("css");
  });

  test("id and site are null when absent, body is whatever remains", () => {
    const block = fenceBlock("```js site\nconsole.log(1);\n```\n");
    expect(parseSitePaneInfo(block)).toEqual({ language: "js", id: null, site: null, body: "console.log(1);" });
  });
});

describe("isQuestionFence", () => {
  test("is true only when the fence's whole info string is question", () => {
    expect(isQuestionFence("question")).toBe(true);
  });

  test("is false for anything else", () => {
    expect(isQuestionFence("python exec")).toBe(false);
    expect(isQuestionFence("")).toBe(false);
    expect(isQuestionFence("questionnaire")).toBe(false);
  });
});

describe("parseQuestionFence", () => {
  test("reads id:/type:/correct: and splits a multiple-choice body into a prompt and its options", () => {
    const block = fenceBlock(
      "```question\nid: right-angle\ntype: multiple-choice\ncorrect: 2\n\n"
        + "Which of these is a right angle?\n\n- 45 degrees\n- 90 degrees\n- 180 degrees\n```\n",
    );
    expect(parseQuestionFence(block)).toEqual({
      id: "right-angle",
      type: "multiple-choice",
      correct: 2,
      prompt: "Which of these is a right angle?",
      options: ["45 degrees", "90 degrees", "180 degrees"],
      body: "Which of these is a right angle?\n\n- 45 degrees\n- 90 degrees\n- 180 degrees",
    });
  });

  test("a fill-in-the-blank question keeps its whole body as-is, with no options split", () => {
    const block = fenceBlock(
      "```question\nid: angle-names\ntype: fill-in-the-blank\n\n"
        + "An angle of 90 degrees is a {right angle|straight angle}.\n- not an option, just a list in the sentence\n```\n",
    );
    const question = parseQuestionFence(block);
    expect(question.type).toBe("fill-in-the-blank");
    expect(question.options).toEqual([]);
    expect(question.prompt).toBe("");
    expect(question.body).toBe("An angle of 90 degrees is a {right angle|straight angle}.\n- not an option, just a list in the sentence");
  });

  test("splits a body that reads as multiple-choice even before type: is typed", () => {
    const block = fenceBlock("```question\nid: q\n\nA question?\n\n- one\n- two\n```\n");
    const question = parseQuestionFence(block);
    expect(question.type).toBeNull();
    expect(question.prompt).toBe("A question?");
    expect(question.options).toEqual(["one", "two"]);
  });

  test("a missing or unparseable correct: is null, not a guess", () => {
    const block = fenceBlock("```question\nid: q\ntype: multiple-choice\ncorrect: not-a-number\n\nQ?\n\n- a\n- b\n```\n");
    expect(parseQuestionFence(block).correct).toBeNull();
  });

  test("id and type are null when absent", () => {
    const block = fenceBlock("```question\nJust a question, no headers yet.\n```\n");
    const question = parseQuestionFence(block);
    expect(question.id).toBeNull();
    expect(question.type).toBeNull();
    expect(question.prompt).toBe("Just a question, no headers yet.");
  });
});
