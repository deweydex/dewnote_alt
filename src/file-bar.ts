// The quiet file bar — step 4's first slice, and the thing main.ts never
// actually had: until this, dewnote could only edit an in-memory starter
// document, with no way in or out except the Playwright test hook. This
// mounts a filename control (Open, current name, Save) the same way
// settings-panel.ts mounts its own gear icon: quiet, fixed, always there,
// never boxed. Dropping a file anywhere on the page opens it, matching
// the plan's "single-file build that opens a dropped file" line for step
// 2 that nothing before this actually delivered.

import { downloadAsFile, openDroppedItem, openFile, saveDocument, suggestedFilename, type OpenedDocument } from "./store.ts";
import { buildStandaloneHtmlPage, collectPageCss } from "./export-html.ts";
import { exportToNotebook, importFromNotebook, type Notebook } from "./jupyter.ts";
import { dockPanel, fileActionRail, labelToggle } from "./icon-rail.ts";

export interface FileBarHost {
  /** The mounted document's current source, live-editor content included. */
  getSource(): string;
  /** Tears down the current mount and mounts `source` in its place. */
  loadDocument(source: string, name: string): void;
  /** A file from the device, rather than a repository, became the session. */
  onLocalOpen?(name: string): boolean | void;
  /** Cmd/Ctrl+S while a repository document is open means “push this
   * document”, not “download an unrelated local copy”. */
  onExternalSave?(): Promise<boolean> | boolean;
  /** The progressive header is the visible owner of file identity and
   * dirty state. The legacy bar still detects both; hand its state up
   * rather than making the new shell poll its DOM. */
  onStateChange?(state: FileBarState): void;
}

export interface FileBarState {
  name: string;
  dirty: boolean;
  external: boolean;
  status: string;
}

export interface FileBar {
  destroy(): void;
  /** Adopts a document opened by another source — the folder rail's own
   * "open a file from the mounted folder" — as if Open had been clicked
   * here. Feeds the same Save button and dirty indicator a single-file
   * open already has, rather than a second, parallel save mechanism. */
  open(opened: OpenedDocument): void;
  /** Tracks a document owned by another store (currently GitHub) without
   * pretending the local Save button owns a writable file handle. */
  openExternal(name: string): void;
  /** The owning store successfully persisted the current source. */
  markSaved(): void;
  getState(): FileBarState;
  saveCurrent(): Promise<boolean>;
  openDeviceFile(): Promise<void>;
  importNotebook(): Promise<void>;
  exportHtml(): void;
  exportNotebook(): void;
}

function isMarkdownDrag(event: DragEvent): boolean {
  return Boolean(event.dataTransfer?.types.includes("Files"));
}

/** An `<input type=file>` scoped to `.ipynb`, the same fallback shape
 * store.ts's own `openFileFallback` uses for markdown — there is no
 * File System Access equivalent worth reaching for here, since an
 * imported notebook becomes a new markdown document, never a file this
 * app could write a `.ipynb` back to. */
function promptForNotebookFile(): Promise<{ name: string; markdown: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".ipynb,application/x-ipynb+json";
    input.addEventListener(
      "change",
      async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        try {
          const notebook = JSON.parse(await file.text()) as Notebook;
          resolve({ name: file.name.replace(/\.ipynb$/i, ".md"), markdown: importFromNotebook(notebook) });
        } catch {
          // A file that isn't real notebook JSON just doesn't open —
          // no partial import, nothing half-converted to clean up.
          resolve(null);
        }
      },
      { once: true },
    );
    input.click();
  });
}

/** Mounted once, independently of any particular document — like the
 * settings panel, this outlives `main.ts`'s own `mountDocument` calls. */
export function mountFileBar(host: FileBarHost): FileBar {
  let opened: OpenedDocument | null = null;
  let externalName: string | null = null;
  let dirty = false;
  let lastSeen = host.getSource();

  const bar = document.createElement("div");
  bar.className = "dn-file-bar";

  // The product mark and current file name form one compact, persistent
  // identity. Repository paths are especially important here: a heading
  // says what the document is called, not which file a push will replace.
  const brand = document.createElement("span");
  brand.className = "dn-brand";
  brand.innerHTML = `<svg viewBox="0 0 512 512" aria-hidden="true" focusable="false">
    <rect class="dn-brand-field" width="512" height="512" rx="104" />
    <path class="dn-brand-mark" d="M256 76c-67 68-111 132-111 210 0 65 41 111 88 132l23 31 23-31c47-21 88-67 88-132 0-78-44-142-111-210Z" />
    <circle class="dn-brand-cut-fill" cx="256" cy="256" r="22" />
    <path class="dn-brand-cut-stroke" d="M256 278v126" />
  </svg><span class="dn-brand-name">dewnote</span>`;

  const nameLabel = document.createElement("span");
  nameLabel.className = "dn-file-name";

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "dn-file-open";
  openButton.textContent = "Open";

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "dn-file-save";
  saveButton.textContent = "Save";

  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "dn-file-export dn-file-export-html";
  exportButton.textContent = "Export HTML";
  exportButton.title = "Downloads a standalone HTML page — the rendered document, no editor, nothing to run.";

  const exportIpynbButton = document.createElement("button");
  exportIpynbButton.type = "button";
  exportIpynbButton.className = "dn-file-export dn-file-export-ipynb";
  exportIpynbButton.textContent = "Export ipynb";
  exportIpynbButton.title = "Downloads this document as a Jupyter notebook — exec cells become real code cells.";

  const importIpynbButton = document.createElement("button");
  importIpynbButton.type = "button";
  importIpynbButton.className = "dn-file-export dn-file-import-ipynb";
  importIpynbButton.textContent = "Import ipynb";
  importIpynbButton.title = "Opens a .ipynb file as a new document, converted to markdown.";

  saveButton.textContent = "Markdown file";
  openButton.textContent = "Markdown file…";
  importIpynbButton.textContent = "Jupyter notebook…";
  exportButton.textContent = "Standalone HTML";
  exportIpynbButton.textContent = "Jupyter notebook";

  const status = document.createElement("span");
  status.className = "dn-file-status dn-visually-hidden";
  status.setAttribute("aria-live", "polite");

  function actionPanel(
    label: string,
    glyph: string,
    className: string,
    groups: Array<{ heading: string; items: Array<{ button: HTMLButtonElement; description: string }> }>,
  ): { toggle: HTMLButtonElement; panel: HTMLDivElement } {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = className;
    toggle.textContent = glyph;
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-expanded", "false");
    labelToggle(toggle, label);

    const panel = document.createElement("div");
    panel.className = `dn-file-action-panel dn-${label.toLowerCase()}-panel`;
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", label);
    toggle.setAttribute("aria-controls", (panel.id = `dn-${label.toLowerCase()}-panel`));

    const header = document.createElement("div");
    header.className = "dn-file-panel-header";
    const heading = document.createElement("h2");
    heading.textContent = label;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "dn-file-panel-close";
    close.textContent = "×";
    close.setAttribute("aria-label", `Close ${label.toLowerCase()} panel`);
    header.append(heading, close);
    panel.appendChild(header);

    const list = document.createElement("div");
    list.className = "dn-file-action-list";
    for (const group of groups) {
      const section = document.createElement("section");
      section.className = "dn-file-action-section";
      const subheading = document.createElement("h3");
      subheading.textContent = group.heading;
      section.appendChild(subheading);
      for (const item of group.items) {
        const row = document.createElement("div");
        row.className = "dn-file-action-choice";
        const description = document.createElement("p");
        description.textContent = item.description;
        row.append(item.button, description);
        section.appendChild(row);
      }
      list.appendChild(section);
    }
    panel.appendChild(list);
    fileActionRail().appendChild(toggle);
    document.body.appendChild(panel);
    dockPanel(toggle, panel);
    return { toggle, panel };
  }

  // Import and Export are one transfer task, not two unrelated global
  // actions. Keep the old class hooks as aliases so existing keyboard
  // commands and integrations still open this same selector.
  const transferAction = actionPanel("Transfer", "⇅", "dn-file-transfer-toggle dn-file-import-menu-toggle dn-file-export-menu-toggle", [
    {
      heading: "Import",
      items: [
        { button: openButton, description: "Open a Markdown or YAML document from this device." },
        { button: importIpynbButton, description: "Convert a Jupyter notebook into an editable document." },
      ],
    },
    {
      heading: "Export",
      items: [
        { button: saveButton, description: "Save the editable Markdown or YAML source." },
        { button: exportButton, description: "Download a self-contained rendered web page." },
        { button: exportIpynbButton, description: "Download executable cells as a Jupyter notebook." },
      ],
    },
  ]);
  bar.append(brand, nameLabel, status);
  document.body.appendChild(bar);

  function render() {
    const name = externalName ?? opened?.name ?? "Untitled";
    nameLabel.textContent = name;
    nameLabel.classList.toggle("is-dirty", dirty);
    status.textContent = dirty ? "unsaved" : externalName ? "pushed" : opened ? (opened.handle ? "saved" : "downloaded") : "";
    document.title = `${name}${dirty ? " •" : ""} — dewnote`;
    host.onStateChange?.({ name, dirty, external: externalName !== null, status: status.textContent });
  }

  function markDirty() {
    dirty = true;
    render();
  }

  function markSaved() {
    dirty = false;
    lastSeen = host.getSource();
    render();
  }

  async function open(next: OpenedDocument | null) {
    if (!next) return;
    if (host.onLocalOpen?.(next.name) === false) return;
    opened = next;
    externalName = null;
    dirty = false;
    host.loadDocument(next.content, next.name);
    lastSeen = host.getSource();
    render();
  }

  async function save(): Promise<boolean> {
    const content = host.getSource();
    const current = opened ?? { name: suggestedFilename(content), content, handle: null };
    saveButton.disabled = true;
    try {
      opened = await saveDocument(current, content);
      externalName = null;
      dirty = false;
      lastSeen = content;
      render();
      return true;
    } catch {
      return false;
    } finally {
      saveButton.disabled = false;
    }
  }

  const openDeviceFile = async () => { await open(await openFile()); };
  openButton.addEventListener("click", () => { void openDeviceFile(); });
  saveButton.addEventListener("click", () => {
    save();
  });
  const exportHtml = () => {
    const content = host.getSource();
    const html = buildStandaloneHtmlPage(content, collectPageCss());
    const baseName = (opened?.name ?? suggestedFilename(content)).replace(/\.md$/i, "");
    downloadAsFile(`${baseName}.html`, html, "text/html");
  };
  exportButton.addEventListener("click", exportHtml);
  const exportNotebook = () => {
    const content = host.getSource();
    const notebook = exportToNotebook(content);
    const baseName = (opened?.name ?? suggestedFilename(content)).replace(/\.md$/i, "");
    downloadAsFile(`${baseName}.ipynb`, JSON.stringify(notebook, null, 1), "application/x-ipynb+json");
  };
  exportIpynbButton.addEventListener("click", exportNotebook);
  const importNotebook = async () => {
    const result = await promptForNotebookFile();
    if (!result) return;
    await open({ name: result.name, content: result.markdown, handle: null });
  };
  importIpynbButton.addEventListener("click", () => { void importNotebook(); });

  async function onKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (externalName && host.onExternalSave) {
        if (await host.onExternalSave()) markSaved();
      } else {
        await save();
      }
    }
  }
  document.addEventListener("keydown", onKeydown);

  // Any edit that reaches a block's commit changes the document's source;
  // there is no change event to listen for, so this polls at a human
  // interaction cadence rather than wiring a callback through every one
  // of app.ts's own commit paths for a status label that only needs to be
  // roughly right.
  const dirtyCheck = window.setInterval(() => {
    const current = host.getSource();
    if (current !== lastSeen) {
      lastSeen = current;
      if (!dirty) markDirty();
    }
  }, 500);

  function onDragOver(event: DragEvent) {
    if (!isMarkdownDrag(event)) return;
    event.preventDefault();
    bar.classList.add("is-drag-target");
  }
  function onDragLeave() {
    bar.classList.remove("is-drag-target");
  }
  async function onDrop(event: DragEvent) {
    if (!isMarkdownDrag(event)) return;
    event.preventDefault();
    bar.classList.remove("is-drag-target");
    const item = event.dataTransfer?.items[0];
    if (!item) return;
    open(await openDroppedItem(item));
  }
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("dragleave", onDragLeave);
  document.addEventListener("drop", onDrop);

  window.addEventListener("beforeunload", (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  render();

  return {
    open,
    openExternal(name) {
      opened = null;
      externalName = name;
      dirty = false;
      lastSeen = host.getSource();
      render();
    },
    markSaved,
    getState() {
      const name = externalName ?? opened?.name ?? "Untitled";
      return {
        name,
        dirty,
        external: externalName !== null,
        status: dirty ? "unsaved" : externalName ? "pushed" : opened ? (opened.handle ? "saved" : "downloaded") : "",
      };
    },
    async saveCurrent() {
      if (externalName && host.onExternalSave) {
        const saved = await host.onExternalSave();
        if (saved) markSaved();
        return saved;
      }
      return save();
    },
    openDeviceFile,
    importNotebook,
    exportHtml,
    exportNotebook,
    destroy() {
      window.clearInterval(dirtyCheck);
      document.removeEventListener("keydown", onKeydown);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
      transferAction.toggle.remove();
      transferAction.panel.remove();
      bar.remove();
    },
  };
}
