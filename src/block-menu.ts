// The one list of things a block can be, and the one menu that offers
// them.
//
// There used to be two lists and two menus. The "+" button's list held
// six kinds; the slash menu's held three, on the reasoning that "six
// items is already a long menu"; and two more kinds — Answer and
// Practice problem — were shown only on a page whose front matter said
// `practice_for`. Three different answers to "what can go here", and a
// reader had to know which surface they were standing on to know what
// they could reach.
//
// Every one of those was a way of keeping the menu short. Shortening a
// menu by removing things from it is a trade the reader pays for: the
// kind they wanted is not missing from the app, it is missing from the
// place they looked. So the menu handles length instead of avoiding it.
// It searches, and it groups.
//
// Searching is what makes the list's length stop mattering: two letters
// reaches any item, so a tenth item costs the reader who knows what
// they want nothing at all. Grouping is what makes it stop mattering
// for the reader who does not know — "Teach" is three things to read
// rather than three of eight, and a reader scanning for a hint never
// reads past the group it is in.
//
// Both menus are this one, mounted twice: the "+" button opens it with
// its own search field, and a block whose entire content is "/answer"
// opens it with that text as the query. One item table, one ranking,
// one keyboard map, and nothing that is offered by one and not the
// other.

/** Every kind of block the editor can create. `paragraph` is the plain
 * one; `image` and `link` finish through a picker rather than a
 * template, which is why they are marked `picks` below. */
export type BlockKind =
  | "paragraph"
  | "cell"
  | "sql-cell"
  | "code-block"
  | "site"
  | "math"
  | "hint"
  | "staged-hint"
  | "answer"
  | "practice"
  | "multiple-choice"
  | "fill-in-the-blank"
  | "card"
  | "image"
  | "link";

/** The groups, in the order a menu shows them. Write first because it
 * holds the kind most blocks are; Teach last because it is the longest
 * and the one a reader most often arrives at by searching. */
export const BLOCK_MENU_GROUPS = ["Write", "Run", "Teach"] as const;
export type BlockMenuGroup = (typeof BLOCK_MENU_GROUPS)[number];

export interface BlockMenuItem {
  kind: BlockKind;
  label: string;
  group: BlockMenuGroup;
  /** One line under the label, in the imperative, saying what the item
   * leaves behind rather than what it is. A reader who does not already
   * know what "a fold" means learns it here and not from a glossary. */
  detail: string;
  /** Words the search matches besides the label — what somebody who
   * knows the thing by another name would actually type. "python" for a
   * code cell, "solution" for an answer, "latex" for maths. */
  keywords: readonly string[];
  /** True when confirming the item hands the reader to a picker — a
   * file chooser, a search overlay — instead of dropping a template in
   * straight away. The menu shows nothing different for these; the
   * callers place the finished markdown differently, and that is the
   * whole of the difference. */
  picks?: true;
}

export const BLOCK_MENU_ITEMS: readonly BlockMenuItem[] = [
  { kind: "paragraph", label: "Paragraph", group: "Write", detail: "Start writing prose.", keywords: ["text", "prose", "writing"] },
  { kind: "link", label: "Link", group: "Write", detail: "Link to another tutorial, or anywhere.", keywords: ["url", "href", "tutorial", "reference"], picks: true },
  { kind: "image", label: "Image", group: "Write", detail: "Put a picture beside this document.", keywords: ["picture", "photo", "figure", "diagram", "png", "screenshot"], picks: true },
  { kind: "code-block", label: "Code block", group: "Write", detail: "Show code without running it.", keywords: ["example", "illustrative", "fence", "snippet"] },
  { kind: "card", label: "Card", group: "Write", detail: "Add a linked Dewlab content card.", keywords: ["tile", "module", "index", "navigation"] },
  { kind: "cell", label: "Code cell", group: "Run", detail: "Run editable Python.", keywords: ["python", "code", "run", "exec"] },
  { kind: "sql-cell", label: "SQL cell", group: "Run", detail: "Run SQL against the page database.", keywords: ["database", "query", "table", "exec"] },
  { kind: "site", label: "Site playground", group: "Run", detail: "Edit HTML, CSS and JavaScript together.", keywords: ["html", "css", "javascript", "js", "web", "preview"] },
  { kind: "math", label: "Math", group: "Run", detail: "A displayed equation.", keywords: ["equation", "latex", "formula", "maths"] },
  { kind: "hint", label: "Hint", group: "Teach", detail: "A fold that opens to a nudge.", keywords: ["fold", "details", "clue", "help", "stuck"] },
  { kind: "staged-hint", label: "Staged hint", group: "Teach", detail: "Reveal a hint after repeated difficulty.", keywords: ["adaptive", "errors", "attempts", "trigger", "clue"] },
  { kind: "answer", label: "Answer", group: "Teach", detail: "A fold that opens to the working.", keywords: ["fold", "details", "solution", "worked"] },
  {
    kind: "practice",
    label: "Practice problem",
    group: "Teach",
    detail: "A problem, a stepped hint, then the answer.",
    keywords: ["exercise", "question", "problem", "task", "drill"],
  },
  {
    kind: "multiple-choice",
    label: "Multiple choice",
    group: "Teach",
    detail: "A question with one right answer, checked instantly.",
    keywords: ["question", "quiz", "choice", "options", "recognition", "check"],
  },
  {
    kind: "fill-in-the-blank",
    label: "Fill in the blank",
    group: "Teach",
    detail: "A sentence with a missing word, checked instantly.",
    keywords: ["question", "quiz", "cloze", "gap", "vocabulary", "check"],
  },
];

/** The slash menu offers everything except Paragraph — not to keep the
 * list short, but because a block you can type "/" into is already a
 * paragraph, so the command would do nothing. Everything else, the
 * pickers included, is reachable from both menus. */
export const SLASH_MENU_ITEMS: readonly BlockMenuItem[] = BLOCK_MENU_ITEMS.filter((item) => item.kind !== "paragraph");

/** How well `item` answers `query`, lower being better, or `null` for
 * no match at all. Four tiers, and the order between them is the whole
 * of the ranking: what the reader typed the start of, then what it
 * starts a word of, then what it is a nickname for, then anything it
 * merely appears inside. Typing "a" puts Answer above Math even though
 * both contain the letter, because only one of them starts with it. */
export function scoreBlockMenuItem(item: BlockMenuItem, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const label = item.label.toLowerCase();
  if (label.startsWith(q)) return 0;
  if (label.split(/\s+/).some((word) => word.startsWith(q))) return 1;
  if (item.keywords.some((word) => word.toLowerCase().startsWith(q))) return 2;
  if (label.includes(q)) return 3;
  return null;
}

/** The items `query` reaches, best first, ties keeping the table's own
 * order. An empty query is every item in table order, which is what
 * both menus show when they first open. */
export function filterBlockMenu(query: string, items: readonly BlockMenuItem[] = BLOCK_MENU_ITEMS): BlockMenuItem[] {
  return items
    .map((item, index) => ({ item, index, score: scoreBlockMenuItem(item, query) }))
    .filter((row): row is { item: BlockMenuItem; index: number; score: number } => row.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((row) => row.item);
}

/** The same items, cut into the groups a menu draws headings for.
 * Groups the filter emptied are dropped rather than drawn empty, and a
 * search that leaves one item leaves one heading above it.
 *
 * Ranked results are regrouped rather than shown as a flat best-first
 * list, and the two orders genuinely disagree: a query matching Answer
 * best and Paragraph second shows Paragraph's group first, because
 * that is where the reader's eye already knows to look. Within a group
 * the ranking is kept, and the menu's own selection starts on the
 * best-scoring item wherever it landed, so Enter still confirms what
 * the ranking chose. */
export function groupBlockMenu(items: readonly BlockMenuItem[]): { group: BlockMenuGroup; items: BlockMenuItem[] }[] {
  return BLOCK_MENU_GROUPS.map((group) => ({ group, items: items.filter((item) => item.group === group) })).filter(
    (section) => section.items.length > 0,
  );
}

/** The order the menu's own arrow keys walk, which is the order the
 * items are drawn in — grouped, not ranked. `filterBlockMenu`'s first
 * item is still the one selected when the menu opens; this is only how
 * ↑ and ↓ move from there. */
export function visualOrder(items: readonly BlockMenuItem[]): BlockMenuItem[] {
  return groupBlockMenu(items).flatMap((section) => section.items);
}

// ## The list both menus draw
//
// Only the list: the "+" button wraps it in a search field of its own,
// and the slash menu feeds it the text the reader is already typing.
// Everything below the query — ranking, grouping, which row is
// selected, what the arrow keys do, what a click does — is here once.

export interface BlockMenuList {
  element: HTMLElement;
  /** Re-filter and redraw. The selection lands on the best-ranked item,
   * which after regrouping is not always the first row drawn. */
  setQuery(query: string): void;
  /** Whether anything is showing — what a caller's own arrow-key and
   * Enter bindings check before claiming the key. */
  isOpen(): boolean;
  /** Move the selection through the rows as drawn. Returns false when
   * there is nothing showing, so a caller can let the key through. */
  move(delta: -1 | 1): boolean;
  /** Confirm the selected row. False when there is nothing to confirm. */
  confirmSelected(): boolean;
  /** Draw nothing until the next setQuery. */
  close(): void;
}

export function buildBlockMenuList(options: {
  items?: readonly BlockMenuItem[];
  onConfirm: (kind: BlockKind) => void;
  /** Kept for the slash menu, whose rows are confirmed on `mousedown`
   * rather than `click` — by the time a click fires, the editor the
   * reader is typing into has already blurred and committed "/answer"
   * as real prose. The "+" menu has no editor to lose and uses the
   * click, which is what a screen reader and a touch screen both
   * expect. */
  confirmOn?: "click" | "mousedown";
}): BlockMenuList {
  const source = options.items ?? BLOCK_MENU_ITEMS;
  const confirmEvent = options.confirmOn ?? "click";
  const element = document.createElement("div");
  element.className = "dn-block-menu-list";
  element.setAttribute("role", "listbox");

  let shown: BlockMenuItem[] = [];
  let selected = 0;

  function draw() {
    element.replaceChildren();
    for (const section of groupBlockMenu(shown)) {
      const heading = document.createElement("div");
      heading.className = "dn-block-menu-group";
      heading.textContent = section.group;
      element.appendChild(heading);
      for (const item of section.items) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "dn-block-menu-item";
        row.dataset["kind"] = item.kind;
        row.setAttribute("role", "option");
        const isSelected = shown[selected] === item;
        row.setAttribute("aria-selected", String(isSelected));
        if (isSelected) row.classList.add("is-selected");

        const label = document.createElement("span");
        label.className = "dn-block-menu-label";
        label.textContent = item.label;
        const detail = document.createElement("span");
        detail.className = "dn-block-menu-detail";
        detail.textContent = item.detail;
        row.append(label, detail);

        row.addEventListener(confirmEvent, (event) => {
          event.preventDefault();
          event.stopPropagation();
          options.onConfirm(item.kind);
        });
        element.appendChild(row);
      }
    }
    element.classList.toggle("is-open", shown.length > 0);
  }

  return {
    element,
    setQuery(query: string) {
      shown = filterBlockMenu(query, source);
      selected = 0;
      draw();
    },
    isOpen: () => shown.length > 0,
    move(delta: -1 | 1) {
      if (shown.length === 0) return false;
      // Through the rows as drawn, not as ranked — the reader is moving
      // a highlight down a list they can see.
      const order = visualOrder(shown);
      const at = order.indexOf(shown[selected]!);
      const next = order[(at + delta + order.length) % order.length]!;
      selected = shown.indexOf(next);
      draw();
      return true;
    },
    confirmSelected() {
      const item = shown[selected];
      if (!item) return false;
      options.onConfirm(item.kind);
      return true;
    },
    close() {
      shown = [];
      draw();
    },
  };
}
