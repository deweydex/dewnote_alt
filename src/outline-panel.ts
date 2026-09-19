// Step 8's outline rail — PLAN.md §5.3's own "a right rail for outline
// and settings, both closed until asked," and §6 step 8's own list of
// what "Finish" still needs. Reads headings straight out of the
// document's prose blocks (blocks.ts's own kind, not a second markdown
// parse of the rendered HTML) and lets a click scroll the corresponding
// block into view.
//
// Mounted the same independent way every other rail is, and given the
// same narrow host every read-only rail needs — just {getSource} here,
// not the live MountedDocument — because jumping to a block only needs
// the block already on screen: app.ts renders every block wrapper with
// its `data-index` set to its position (app.ts's own renderBlockWrapper),
// and that attribute is the only hook this needs into the mounted
// document. Nothing here knows app.ts exists beyond that one selector.

import { parseDocument } from "./blocks.ts";
import { dockPanel, iconRail, labelToggle } from "./icon-rail.ts";

export interface OutlinePanelHost {
  getSource(): string;
}

export interface OutlinePanel {
  destroy(): void;
}

interface Heading {
  level: number;
  text: string;
  blockIndex: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/** Prose only — a fence's `#` is a comment or a shell prompt, not a
 * heading, and math/fold/frontmatter blocks don't carry headings at all
 * in any dialect DIALECTS.md describes. */
function headingsFrom(source: string): Heading[] {
  const doc = parseDocument(source);
  const headings: Heading[] = [];
  doc.blocks.forEach((block, blockIndex) => {
    if (block.kind !== "prose") return;
    for (const line of block.text.split("\n")) {
      const match = HEADING_RE.exec(line);
      if (match) headings.push({ level: match[1]!.length, text: match[2]!, blockIndex });
    }
  });
  return headings;
}

/** Mounted once, independently of any particular document. */
export function mountOutlinePanel(host: OutlinePanelHost): OutlinePanel {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "dn-outline-toggle";
  toggle.setAttribute("aria-label", "Outline");
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = "Outline";
  toggle.textContent = "≡";

  const panel = document.createElement("div");
  panel.className = "dn-outline-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", "Outline");
  panel.hidden = true;
  toggle.setAttribute("aria-controls", (panel.id = "dn-outline-panel"));

  const header = document.createElement("div");
  header.className = "dn-outline-header";
  const heading = document.createElement("h2");
  heading.textContent = "Outline";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "dn-outline-close";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", () => {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  });
  header.append(heading, closeButton);
  panel.appendChild(header);

  const list = document.createElement("ul");
  list.className = "dn-outline-list";
  panel.appendChild(list);

  const empty = document.createElement("p");
  empty.className = "dn-outline-empty";
  empty.textContent = "No headings yet.";
  panel.appendChild(empty);

  function jumpTo(blockIndex: number) {
    const target = document.querySelector<HTMLElement>(`.dn-block[data-index="${blockIndex}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.querySelector<HTMLElement>(".dn-block-render, .cm-content")?.focus();
  }

  function render() {
    const headings = headingsFrom(host.getSource());
    list.replaceChildren();
    empty.hidden = headings.length > 0;
    for (const item of headings) {
      const li = document.createElement("li");
      li.className = `dn-outline-item dn-outline-item-${item.level}`;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.text;
      button.addEventListener("click", () => jumpTo(item.blockIndex));
      li.appendChild(button);
      list.appendChild(li);
    }
  }

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) render();
  });

  // Refreshed on an interval, but only while the panel is actually open —
  // headings change as the author types, and this rail is exactly the
  // kind of thing plan §3 wants "closed until asked," not a permanent
  // listener running against every keystroke whether the rail is visible
  // or not.
  const interval = setInterval(() => {
    if (!panel.hidden) render();
  }, 500);

  labelToggle(toggle, "Outline");
  iconRail().appendChild(toggle);
  document.body.appendChild(panel);
  dockPanel(toggle, panel);

  return {
    destroy() {
      clearInterval(interval);
      toggle.remove();
      panel.remove();
    },
  };
}
