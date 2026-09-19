// Step 8's command palette — plan §5.3's own "a command palette on Cmd+K
// that reaches everything the rails do. No toolbar." Deliberately not a
// second implementation of what each rail already does: every command
// here is "find the button that rail already put in the DOM and click
// it," the same DOM-hook approach outline-panel.ts uses to jump to a
// block. That keeps this the one place that has to know every rail's
// toggle exists, while none of them have to know the palette exists.

interface Command {
  id: string;
  label: string;
  selector: string;
}

const COMMANDS: Command[] = [
  { id: "open", label: "Import Markdown file…", selector: ".dn-file-open" },
  { id: "save", label: "Export Markdown file", selector: ".dn-file-save" },
  { id: "export-html", label: "Export as HTML", selector: ".dn-file-export-html" },
  { id: "export-ipynb", label: "Export as Jupyter notebook", selector: ".dn-file-export-ipynb" },
  { id: "import-ipynb", label: "Import Jupyter notebook…", selector: ".dn-file-import-ipynb" },
  { id: "folder", label: "Open a folder…", selector: ".dn-folder-toggle" },
  { id: "repo", label: "GitHub repository…", selector: ".dn-repo-toggle" },
  { id: "outline", label: "Outline", selector: ".dn-outline-toggle" },
  { id: "source", label: "Whole-file source", selector: ".dn-source-toggle" },
  { id: "check-links", label: "Check links", selector: ".dn-linkcheck-toggle" },
  { id: "series", label: "Modules", selector: ".dn-series-toggle" },
  { id: "settings", label: "Settings", selector: ".dn-settings-toggle" },
];

export interface CommandPalette {
  destroy(): void;
}

/** Mounted once. Reads which rails actually exist in the DOM at the
 * moment the palette opens, not at mount time, so a rail whose toggle
 * is disabled (folder-panel.ts's own Safari case) or not yet mounted is
 * simply left out rather than shown as a command that does nothing. */
export function mountCommandPalette(): CommandPalette {
  const overlay = document.createElement("div");
  overlay.className = "dn-palette-overlay";
  overlay.hidden = true;

  const box = document.createElement("div");
  box.className = "dn-palette-box";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "Command palette");
  overlay.appendChild(box);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "dn-palette-input";
  input.setAttribute("placeholder", "Type a command…");
  input.setAttribute("aria-label", "Type a command");
  box.appendChild(input);

  const list = document.createElement("ul");
  list.className = "dn-palette-list";
  box.appendChild(list);

  let current: { command: Command; target: HTMLElement }[] = [];
  let activeIndex = 0;

  function availableCommands(): { command: Command; target: HTMLElement }[] {
    return COMMANDS.flatMap((command) => {
      const target = document.querySelector<HTMLElement>(command.selector);
      if (!target || (target instanceof HTMLButtonElement && target.disabled)) return [];
      return [{ command, target }];
    });
  }

  function run(entry: { command: Command; target: HTMLElement }) {
    close();
    entry.target.click();
  }

  function renderList() {
    const query = input.value.trim().toLowerCase();
    current = availableCommands().filter((entry) => entry.command.label.toLowerCase().includes(query));
    activeIndex = 0;
    list.replaceChildren();
    for (const [index, entry] of current.entries()) {
      const li = document.createElement("li");
      li.className = "dn-palette-item";
      if (index === activeIndex) li.classList.add("is-active");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = entry.command.label;
      button.addEventListener("mouseenter", () => setActive(index));
      button.addEventListener("click", () => run(entry));
      li.appendChild(button);
      list.appendChild(li);
    }
  }

  function setActive(index: number) {
    activeIndex = index;
    for (const [i, li] of Array.from(list.children).entries()) li.classList.toggle("is-active", i === index);
  }

  function open() {
    overlay.hidden = false;
    input.value = "";
    renderList();
    queueMicrotask(() => input.focus());
  }

  function close() {
    overlay.hidden = true;
  }

  input.addEventListener("input", renderList);

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (current.length > 0) setActive((activeIndex + 1) % current.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (current.length > 0) setActive((activeIndex - 1 + current.length) % current.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = current[activeIndex];
      if (entry) run(entry);
    }
  });

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });

  function onGlobalKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (overlay.hidden) open();
      else close();
    }
  }
  document.addEventListener("keydown", onGlobalKeydown);

  document.body.appendChild(overlay);

  return {
    destroy() {
      document.removeEventListener("keydown", onGlobalKeydown);
      overlay.remove();
    },
  };
}
