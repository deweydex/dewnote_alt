import { describe, expect, test } from "bun:test";
import { editableFoldSource, parseFold, renderBlockPreview, renderCardFencePreview, renderHintFencePreview, renderQuestionFencePreview, replaceFoldBody } from "./render-block.ts";
import { parseDocument } from "./blocks.ts";

function firstBlockOfKind(source: string, kind: string) {
  const { blocks } = parseDocument(source);
  const block = blocks.find((b) => b.kind === kind);
  if (!block) throw new Error(`no ${kind} block in fixture`);
  return block;
}

describe("renderBlockPreview: prose", () => {
  test("renders markdown and inline maths", () => {
    const block = firstBlockOfKind("A paragraph with *emphasis* and $x^2$ in it.\n", "prose");
    const html = renderBlockPreview(block, "plain");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("katex");
  });

  test("does not treat a price as maths", () => {
    // DIALECTS.md §1: dewlab's own rule is that inline maths never matches
    // against whitespace on either side — texmath's default rule agrees,
    // checked here rather than assumed.
    const block = firstBlockOfKind("It costs $5 or maybe $10, depending.\n", "prose");
    const html = renderBlockPreview(block, "dewlab");
    expect(html).not.toContain("katex");
    expect(html).toContain("$5");
  });

  test("a blank-only prose block (blocks.ts's own orphan-line case) renders a real, hoverable placeholder", () => {
    // A fence doesn't absorb its own trailing blank run the way a paragraph
    // does, so the blank line right after one is a real prose block of its
    // own — md.render() of pure whitespace is "", which collapses to zero
    // height in the DOM and leaves nothing for a mouse to hover to reach
    // its delete button (PLAN.md §6 step 2's own "still open" note). This
    // checks the fix, not just the fence fixture that first surfaced it:
    // any prose block whose markdown renders empty gets the same
    // placeholder, whatever put it there.
    const block = firstBlockOfKind("```python exec\nid: x\n1\n```\n\nMore.\n", "prose");
    expect(block.text.trim()).toBe("");
    const html = renderBlockPreview(block, "plain");
    expect(html).toBe('<p class="dn-blank-line">&nbsp;</p>');
  });
});

describe("renderBlockPreview: math", () => {
  test("renders a single-line display block", () => {
    const block = firstBlockOfKind("$$a^2 + b^2 = c^2$$\n", "math");
    const html = renderBlockPreview(block, "dewlab");
    expect(html).toContain("katex");
  });

  test("renders a multi-line display block", () => {
    const source = "$$\nx = 1, \\quad\ny = 2\n$$\n";
    const block = firstBlockOfKind(source, "math");
    const html = renderBlockPreview(block, "dewlab");
    expect(html).toContain("katex");
  });
});

describe("parseFold", () => {
  test("splits a dl-hint fold with an inline summary", () => {
    const text = '<details class="dl-hint"><summary>hint</summary>\n\nTry *this*.\n\n</details>\n';
    const parts = parseFold(text);
    expect(parts.tag).toBe("details");
    expect(parts.className).toBe("dl-hint");
    expect(parts.summaryHtml).toBe("hint");
    expect(parts.bodyMarkdown).toBe("Try *this*.");
  });

  test("finds the last closing tag when the body itself mentions the tag name", () => {
    const text =
      '<details class="dl-answer"><summary>answer</summary>\n\n' +
      "Wrap it in `</details>` as text, then explain.\n\n</details>\n";
    const parts = parseFold(text);
    expect(parts.bodyMarkdown).toContain("as text, then explain.");
  });

  test("handles a fold with no inline summary", () => {
    const text = '<aside class="dl-note" id="x">\n\nSome text.\n\n</aside>\n';
    const parts = parseFold(text);
    expect(parts.tag).toBe("aside");
    expect(parts.className).toBe("dl-note");
    expect(parts.summaryHtml).toBe("");
    expect(parts.bodyMarkdown).toBe("Some text.");
  });
});

describe("renderBlockPreview: fold", () => {
  test("renders a real <details> with the body as markdown", () => {
    const source = '<details class="dl-hint"><summary>hint</summary>\n\nName the *columns*.\n\n</details>\n';
    const block = firstBlockOfKind(source, "fold");
    const html = renderBlockPreview(block, "dewlab");
    expect(html).toStartWith('<details class="dl-hint">');
    expect(html).toContain("<summary>hint</summary>");
    expect(html).toContain("<em>columns</em>");
  });

  test("falls back to the class name as a label when there is no inline summary", () => {
    const source = '<details class="dl-answer">\n\nThe answer is 4.\n\n</details>\n';
    const block = firstBlockOfKind(source, "fold");
    const html = renderBlockPreview(block, "dewlab");
    expect(html).toContain("<summary>answer</summary>");
  });

  test("a fence quoted inside a fold's body still renders (as markdown-it's own fence, not a live cell)", () => {
    const source = '<details class="dl-answer"><summary>answer</summary>\n\n```python\n1 + 1\n```\n\n</details>\n';
    const block = firstBlockOfKind(source, "fold");
    const html = renderBlockPreview(block, "dewlab");
    expect(html).toContain("<pre>");
    expect(html).toContain("1 + 1");
  });
});

describe("editableFoldSource", () => {
  test("exposes only the Markdown body and preserves the wrapper byte for byte", () => {
    const source = '<details class="dl-answer"><summary>answer</summary>\n\nThe **answer**.\n\n</details>\n';
    expect(editableFoldSource(source)?.body).toBe("The **answer**.");
    expect(replaceFoldBody(source, "A changed **answer**.")).toBe(
      '<details class="dl-answer"><summary>answer</summary>\n\nA changed **answer**.\n\n</details>\n',
    );
  });
});

describe("renderBlockPreview: frontmatter", () => {
  test("summarises the field count without dumping raw YAML", () => {
    const source = "---\ntitle: A tutorial\nslug: a-tutorial\n---\n\nBody.\n";
    const block = firstBlockOfKind(source, "frontmatter");
    const html = renderBlockPreview(block, "plain");
    expect(html).toContain("2 fields");
    expect(html).not.toContain("title:");
  });
});

describe("renderBlockPreview: fence", () => {
  test("throws — fences have no rendered state to produce", () => {
    const block = firstBlockOfKind("```python\n1\n```\n", "fence");
    expect(() => renderBlockPreview(block, "plain")).toThrow();
  });
});

describe("renderHintFencePreview", () => {
  test("renders the title and markdown body as an open dl-hint dl-hint-staged fold", () => {
    const block = firstBlockOfKind("```hint\nafter: 3 errors\ntitle: Slow down\n\nCheck your *column names*.\n```\n", "fence");
    const html = renderHintFencePreview(block);
    expect(html).toContain('class="dl-hint dl-hint-staged"');
    expect(html).toContain("open");
    expect(html).toContain("<summary>Slow down</summary>");
    expect(html).toContain("<em>column names</em>");
    // Never `hidden` — dewnote has no reader-side trigger to gate on, so
    // showing the hint openly is the honest choice, not a simulation.
    expect(html).not.toContain("hidden");
  });

  test("uses dewlab's own default title when none is given", () => {
    const block = firstBlockOfKind("```hint\nJust the body.\n```\n", "fence");
    const html = renderHintFencePreview(block);
    expect(html).toContain("Let’s slow down a moment…");
  });

  test("escapes a title that happens to contain HTML-significant characters", () => {
    const block = firstBlockOfKind('```hint\ntitle: <b>& "quotes"\n\nBody.\n```\n', "fence");
    const html = renderHintFencePreview(block);
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>&");
  });
});

describe("renderCardFencePreview", () => {
  test("renders dewlab's own .dl-module-card markup, with a status badge and meta line", () => {
    const block = firstBlockOfKind(
      "```card\nurl: computational-methods.html\nstatus: beta\nmeta: 5N0554 · QQI Level 5\n### Computational Methods\nWe work through *matrices*.\n```\n",
      "fence",
    );
    const html = renderCardFencePreview(block);
    expect(html).toContain('<a class="dl-module-card" href="computational-methods.html">');
    expect(html).toContain("<h3>Computational Methods");
    expect(html).toContain('<span class="dl-module-card-badge" data-status="beta">Beta</span>');
    expect(html).toContain('<span class="dl-module-card-meta">5N0554 · QQI Level 5</span>');
    expect(html).toContain("<em>matrices</em>");
  });

  test("a wide card gets the wide class and no badge or meta when neither is given", () => {
    const block = firstBlockOfKind("```card\nurl: features.html\nwide: true\n### What dewlab can do\n```\n", "fence");
    const html = renderCardFencePreview(block);
    expect(html).toContain('class="dl-module-card dl-module-card-wide"');
    expect(html).not.toContain("dl-module-card-badge");
    expect(html).not.toContain("dl-module-card-meta");
  });

  test("a missing heading or url shows a placeholder rather than breaking", () => {
    const block = firstBlockOfKind("```card\nJust prose, no url or heading.\n```\n", "fence");
    const html = renderCardFencePreview(block);
    expect(html).toContain("(no heading yet)");
    expect(html).toContain('href="#"');
  });

  test("escapes a url and status that happen to contain HTML-significant characters", () => {
    const block = firstBlockOfKind('```card\nurl: a.html?x="y"&z=1\nstatus: <b>\n### A\n```\n', "fence");
    const html = renderCardFencePreview(block);
    expect(html).toContain("&quot;y&quot;");
    expect(html).toContain("&amp;z=1");
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("renderQuestionFencePreview", () => {
  test("renders a multiple-choice question with the correct option marked", () => {
    const block = firstBlockOfKind(
      "```question\nid: right-angle\ntype: multiple-choice\ncorrect: 2\n\n"
        + "Which of these is a right angle?\n\n- 45 degrees\n- 90 degrees\n- 180 degrees\n```\n",
      "fence",
    );
    const html = renderQuestionFencePreview(block);
    expect(html).toContain('class="dl-question" data-question-type="multiple-choice"');
    expect(html).toContain("<p>Which of these is a right angle?</p>");
    expect(html).toContain('<button type="button" class="dl-question-option">45 degrees</button>');
    expect(html).toContain('<button type="button" class="dl-question-option" data-correct="true">90 degrees</button>');
    expect(html).toContain('<button type="button" class="dl-question-option">180 degrees</button>');
    // Never a Check button or feedback slot — no reader, no click, so no
    // simulated mechanism (the same choice renderHintFencePreview makes
    // about a staged hint's own reveal trigger).
    expect(html).not.toContain("dl-question-check");
  });

  test("markdown in the prompt and an option is converted, not left as literal text", () => {
    const block = firstBlockOfKind(
      "```question\nid: q\ntype: multiple-choice\ncorrect: 1\n\nWhich prints `1`?\n\n- `print(1)`\n- `print(2)`\n```\n",
      "fence",
    );
    const html = renderQuestionFencePreview(block);
    expect(html).toContain("Which prints <code>1</code>?");
    expect(html).toContain('<button type="button" class="dl-question-option" data-correct="true"><code>print(1)</code></button>');
  });

  test("a fill-in-the-blank gap shows its correct word, dropdown or typing box alike", () => {
    const block = firstBlockOfKind(
      "```question\nid: angle-names\ntype: fill-in-the-blank\n\n"
        + "An angle of 90 degrees is a {right angle|straight angle|acute angle}.\n"
        + "The {mitochondrion} is the site of aerobic respiration.\n```\n",
      "fence",
    );
    const html = renderQuestionFencePreview(block);
    expect(html).toContain('data-question-type="fill-in-the-blank"');
    expect(html).toContain('<span class="dn-question-gap">right angle</span>');
    expect(html).toContain('<span class="dn-question-gap">mitochondrion</span>');
    // Only the first, correct choice shows — this is a preview of the
    // answer, not the reader's own dropdown.
    expect(html).not.toContain("straight angle");
    expect(html).not.toContain("dl-question-options");
  });

  test("missing content shows a placeholder rather than breaking", () => {
    const block = firstBlockOfKind("```question\nJust prose, no headers yet.\n```\n", "fence");
    const html = renderQuestionFencePreview(block);
    expect(html).toContain("Just prose, no headers yet.");
  });

  test("a correct: naming no option marks nothing, rather than guessing", () => {
    const block = firstBlockOfKind("```question\nid: q\ntype: multiple-choice\ncorrect: 9\n\nQ?\n\n- a\n- b\n```\n", "fence");
    const html = renderQuestionFencePreview(block);
    expect(html).not.toContain("data-correct");
  });
});
