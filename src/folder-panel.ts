// The rest of step 4's own "done when" line: a module folder from
// dewlab opened and worked on for an afternoon — Chrome/Edge only, per
// decision 5, with the toggle itself disabled and saying so where the
// picker doesn't exist (Safari, on any Apple platform). Search and
// open here; Save and the dirty indicator are the file bar's own,
// unchanged, since an opened folder file is exactly the single-file
// case #18 already built — a name, content, and a real writable handle.

import { chooseFolder, createFile, listModuleFiles, listMarkdownFiles, listNamesIn, readBytesAt, readFile, supportsDirectoryPicker, writeFile, type FolderFile } from "./folder-store.ts";
import type { FileBar } from "./file-bar.ts";
import { buildFileIndex, type FileIndexEntry } from "./file-index.ts";
import { parseModuleFiles, parseModuleIndex, type Module } from "./modules.ts";
import { createFile as createActiveFile, setActiveStore } from "./active-store.ts";
import { dockPanel, iconRail, labelToggle } from "./icon-rail.ts";
import { todayVersion } from "./dialect.ts";

export interface FolderPanel {
  choose(): Promise<boolean>;
  reset(): void;
  destroy(): void;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function textInput(placeholder: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  return input;
}

/** Mounted once, independently of any particular document. Takes the
 * file bar itself, not a `{getSource, loadDocument}` host — opening a
 * folder file is adopting it into the file bar's own Save/dirty
 * machinery, not a second way of driving the editor. `onIndexChange`,
 * when given, is handed plan §5.10's own front-matter index every time
 * it's (re)built — main.ts wires it to app.ts's setFileIndex so the link
 * picker (link-picker.ts) has something to search once a folder is
 * open. `onModulesChange`, when given, is handed modules.ts's own read
 * of every `modules/*.yaml` file in the folder the same way, for
 * series-panel.ts. */
export function mountFolderPanel(
  fileBar: FileBar,
  onIndexChange?: (index: FileIndexEntry[]) => void,
  onModulesChange?: (modules: Module[]) => void,
  onSessionOpen?: (name: string) => void,
): FolderPanel {
  let files: FolderFile[] = [];
  let folderName = "";
  /** The directory handle from the last successful `chooseFolder()` —
   * kept so `refreshButton` can re-walk the same folder without making
   * the reader click through the OS picker again. There is no live
   * filesystem-watch API a browser can call to notice a change on its
   * own (unlike a GitHub repository, where "Load repository" already
   * doubles as its own refresh, since it re-reads whatever the form
   * fields already say rather than reopening any picker), so a manual
   * re-scan is the whole mechanism — closed until asked, the same as
   * every other action here. */
  let currentRoot: FileSystemDirectoryHandle | null = null;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "dn-folder-toggle";
  toggle.setAttribute("aria-label", "Folder");
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = "Folder";
  toggle.textContent = "▤";

  const supported = supportsDirectoryPicker();
  if (!supported) {
    toggle.disabled = true;
    toggle.title = "Opening a real folder needs Chrome or Edge — Safari has no directory picker (decision 5).";
  }

  const panel = document.createElement("div");
  panel.className = "dn-folder-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", "Folder");
  panel.hidden = true;
  toggle.setAttribute("aria-controls", (panel.id = "dn-folder-panel"));

  toggle.addEventListener("click", () => {
    if (!supported) return;
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
  });

  const header = document.createElement("div");
  header.className = "dn-folder-header";
  const heading = document.createElement("h2");
  heading.textContent = "Folder";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "dn-folder-close";
  closeButton.setAttribute("aria-label", "Close folder panel");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", () => {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  });
  header.append(heading, closeButton);
  panel.appendChild(header);

  const openSection = document.createElement("section");
  openSection.className = "dn-folder-section";
  const openRow = document.createElement("div");
  openRow.className = "dn-folder-open-row";
  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "dn-folder-open";
  openButton.textContent = "Open folder…";
  openRow.appendChild(openButton);

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "dn-folder-refresh";
  refreshButton.textContent = "Refresh";
  refreshButton.disabled = true;
  refreshButton.title = "Re-scan the open folder for changes made outside dewnote.";
  openRow.appendChild(refreshButton);
  openSection.appendChild(openRow);

  const status = document.createElement("p");
  status.className = "dn-folder-hint dn-folder-status";
  openSection.appendChild(status);
  panel.appendChild(openSection);

  // "New tutorial". The layout is `tutorials/<id>/<id>.md` and the id is
  // the folder's name, so the id is the only placement this form asks
  // for — and it isn't front matter, it's where the file goes.
  //
  // The module, module title and series fields this used to carry are
  // gone with them: dewlab reads placement from `modules/*.yaml` now, so
  // a form that wrote `module:` into the front matter would be filling in
  // a field its build ignores. Listing the new tutorial on a module is a
  // write into a module file, which is the writer that follows this; a
  // tutorial created here is simply on no module yet, which dewlab
  // builds happily and the panel shows under "On no module".
  //
  // `version` isn't a form field either — DIALECTS.md's own
  // `2026.09.04.1` form is a release date no reader would type by hand
  // for a brand-new file, so `todayVersion()` stamps today's date with a
  // fresh `.1` instead, the only sane default for something that has no
  // prior release to be the second of. Written through
  // `active-store.ts`'s own generic `createFile` rather than
  // `folder-store.ts` directly: this has no separate knowledge of which
  // store is actually open, and folder-panel.ts's own registered handler
  // (above) already re-runs `loadFromRoot` afterward.
  const tutorialSection = document.createElement("section");
  tutorialSection.className = "dn-folder-section dn-folder-create";
  const tutorialHeading = document.createElement("h3");
  tutorialHeading.className = "dn-folder-create-heading";
  tutorialHeading.textContent = "New tutorial";
  tutorialSection.appendChild(tutorialHeading);

  const tutorialIdInput = textInput("tutorial-id (its folder, and its address)");
  tutorialIdInput.className = "dn-folder-create-field";
  const tutorialTitleInput = textInput("Title");
  tutorialTitleInput.className = "dn-folder-create-field";
  const tutorialYearInput = textInput("Year");
  tutorialYearInput.className = "dn-folder-create-field";
  tutorialYearInput.value = String(new Date().getFullYear());
  tutorialSection.append(
    tutorialIdInput,
    tutorialTitleInput,
    tutorialYearInput,
  );

  const tutorialCreateButton = document.createElement("button");
  tutorialCreateButton.type = "button";
  tutorialCreateButton.className = "dn-folder-create-button";
  tutorialCreateButton.textContent = "Create";
  tutorialCreateButton.disabled = true;
  tutorialCreateButton.title = "Open a folder first.";
  tutorialSection.appendChild(tutorialCreateButton);

  const tutorialStatus = document.createElement("p");
  tutorialStatus.className = "dn-folder-create-status";
  tutorialSection.appendChild(tutorialStatus);
  panel.appendChild(tutorialSection);

  tutorialCreateButton.addEventListener("click", async () => {
    const id = tutorialIdInput.value.trim();
    const title = tutorialTitleInput.value.trim();
    const year = tutorialYearInput.value.trim();
    if (!SLUG_RE.test(id)) {
      tutorialStatus.textContent = "Tutorial id must be lowercase letters, digits, and hyphens.";
      return;
    }
    if (!title || !year) {
      tutorialStatus.textContent = "Title and year are both required.";
      return;
    }
    // An id is taken if any file already sits in `tutorials/<id>/`, and
    // it's the address of the page and the key a reader's saved work
    // lives under — so this refuses rather than quietly writing a second
    // tutorial into an existing folder.
    const taken = files.some((file) => file.path.includes(`tutorials/${id}/`));
    if (taken) {
      tutorialStatus.textContent = `"${id}" is taken — a tutorial already lives in tutorials/${id}/.`;
      return;
    }
    const path = `tutorials/${id}/${id}.md`;
    const content = `---
title: ${title}
year: "${year}"
version: ${todayVersion()}
---

# ${title}

Start writing.

\`\`\`python exec
id: ${id}-first-cell
1 + 1
\`\`\`
`;
    tutorialCreateButton.disabled = true;
    tutorialStatus.textContent = "Creating…";
    try {
      await createActiveFile(path, content);
      tutorialStatus.textContent = `Created ${path} — on no module yet.`;
      tutorialIdInput.value = "";
      tutorialTitleInput.value = "";
    } catch (err) {
      tutorialStatus.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      tutorialCreateButton.disabled = false;
    }
  });

  const searchSection = document.createElement("section");
  searchSection.className = "dn-folder-section";
  const searchInput = textInput("Search files…");
  searchInput.className = "dn-folder-search";
  searchSection.appendChild(searchInput);

  const fileList = document.createElement("ul");
  fileList.className = "dn-folder-files";
  searchSection.appendChild(fileList);
  panel.appendChild(searchSection);

  function renderFiles() {
    const query = searchInput.value.trim().toLowerCase();
    const matches = query ? files.filter((f) => f.path.toLowerCase().includes(query)) : files;
    fileList.replaceChildren();
    for (const file of matches.slice(0, 300)) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dn-folder-file";
      button.textContent = file.path;
      button.addEventListener("click", () => openFolderFile(file));
      item.appendChild(button);
      fileList.appendChild(item);
    }
    if (files.length > 0 && matches.length === 0) {
      const empty = document.createElement("li");
      empty.className = "dn-folder-empty";
      empty.textContent = "No files match.";
      fileList.appendChild(empty);
    }
  }
  searchInput.addEventListener("input", renderFiles);

  /** The folder-relative path of the file this panel last opened, or
   * null if it hasn't opened one. */
  let openedPath: string | null = null;

  async function openFolderFile(file: FolderFile) {
    status.textContent = `Opening ${file.path}…`;
    try {
      const content = await readFile(file.handle);
      fileBar.open({ name: file.path, content, handle: file.handle });
      // What "beside this document" means, for an image copied in
      // (app.ts's insertImageAfter). Set only on a real open from this
      // folder: a file dropped onto the editor has no folder to sit in,
      // and must not inherit whichever one was opened before it.
      openedPath = file.path;
      status.textContent = `Opened ${file.path}.`;
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  /** §5.10's own "this is a real cost, not a free improvement" — every
   * markdown file's content is read once, right here, so the index has
   * something to search before the reader ever opens one of them. Errors
   * reading an individual file (permissions, a file removed mid-scan)
   * just leave that one file out of the index rather than failing the
   * whole folder open — the file list itself (already built) still
   * works regardless. Takes `markdownFiles` explicitly rather than
   * reading the shared `files` — that list also carries the module files
   * now (the click handler's own comment explains why), and a module
   * file has no front matter worth indexing at all, so reading its
   * content again here would only ever produce a bare `{path}` entry.
   *
   * `modules` is what lets each entry carry the modules that list its id
   * (file-index.ts's own join), so the modules are read first and this
   * runs after them. */
  async function refreshIndex(markdownFiles: FolderFile[], modules: Module[]) {
    if (!onIndexChange) return;
    const entries = await Promise.all(
      markdownFiles.map(async (file) => {
        try {
          return { path: file.path, content: await readFile(file.handle) };
        } catch {
          return null;
        }
      }),
    );
    onIndexChange(
      buildFileIndex(
        entries.filter((e): e is { path: string; content: string } => e !== null),
        modules,
      ),
    );
  }

  /** Mirrors refreshIndex's own shape, over the module files
   * `openButton`'s own click handler already listed — there are a
   * handful of them, so no attempt is made to fold this into the same
   * pass as `refreshIndex`. Returns the parsed modules as well as
   * handing them on, since the index needs them too. */
  async function refreshModules(moduleFiles: FolderFile[]): Promise<Module[]> {
    const entries = await Promise.all(
      moduleFiles.map(async (file) => {
        try {
          return { path: file.path, content: await readFile(file.handle) };
        } catch {
          return null;
        }
      }),
    );
    const read = entries.filter((e): e is { path: string; content: string } => e !== null);
    const index = read.find((file) => /(?:^|\/)(?:courses|modules)\/index\.yaml$/.test(file.path));
    const modules = parseModuleFiles(read, index ? parseModuleIndex(index.content) : []);
    onModulesChange?.(modules);
    return modules;
  }

  /** The whole "read this folder and rebuild everything" pass, shared by
   * `openButton` (against a freshly chosen folder) and `refreshButton`
   * (against `currentRoot`, already held) — the same work either way,
   * just with or without a new `chooseFolder()` in front of it. Listed
   * and read separately (folder-store.ts's own two functions, one walk
   * each), but merged into one browsable/searchable list: a module file
   * is a plain text file like any other, and opening one hands it to the
   * same editor and Save path every other file already gets — the
   * whole-file source view (Cmd+/) shows its raw YAML untouched by any
   * markdown rendering, which is exactly what hand-editing a module
   * (inserting an id, reordering two lines) actually wants, with no new
   * UI needed. */
  async function loadFromRoot(root: FileSystemDirectoryHandle, name: string, verb: "Reading" | "Refreshing") {
    status.textContent = `${verb} folder…`;
    try {
      const [markdownFiles, moduleFiles] = await Promise.all([
        listMarkdownFiles(root),
        listModuleFiles(root),
      ]);
      files = [...markdownFiles, ...moduleFiles];
      status.textContent = `${markdownFiles.length} markdown file${markdownFiles.length === 1 ? "" : "s"}, ${moduleFiles.length} module file${moduleFiles.length === 1 ? "" : "s"}, in "${name}".`;
      renderFiles();
      // Modules first: the index joins each entry to the modules that
      // list its id, so it needs them already parsed.
      const modules = await refreshModules(moduleFiles);
      await refreshIndex(markdownFiles, modules);
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  async function choose(): Promise<boolean> {
    const root = await chooseFolder();
    if (!root) return false;
    currentRoot = root;
    folderName = root.name;
    openButton.textContent = `Open folder… (${folderName})`;
    refreshButton.disabled = false;
    tutorialCreateButton.disabled = false;
    tutorialCreateButton.title = "";
    // active-store.ts's own "open this path" hook — registered once a
    // folder is actually open, not at mount time (nothing to open yet),
    // and closing over the live `files` binding rather than a snapshot,
    // so a later Refresh's own reassignment is seen without registering
    // again. Reuses openFolderFile itself rather than a second "open a
    // file" implementation — a click here is exactly a click on this
    // same file in `fileList`. `createFile` re-runs the whole
    // `loadFromRoot` pass afterward rather than splicing the one new
    // file into `files` by hand — simpler, and correct even when the
    // new file landed in a module folder that didn't exist a moment ago
    // (a fresh directory `loadFromRoot`'s own walk needs to see).
    setActiveStore({
      async openPath(path) {
        const file = files.find((f) => f.path === path);
        if (!file) return false;
        await openFolderFile(file);
        return true;
      },
      async createFile(path, content) {
        await createFile(root, path, content);
        await loadFromRoot(root, folderName, "Refreshing");
      },
      // The read-modify-write half, for a caller editing a file it never
      // opened into the editor — series-panel.ts writing a module file.
      // `files` is the live binding, so a file added by a Refresh since
      // this was registered is found without registering again.
      async readTextFile(path) {
        const file = files.find((f) => f.path === path);
        if (!file) throw new Error(`There is no ${path} in this folder.`);
        return readFile(file.handle);
      },
      async writeTextFile(path, content) {
        const file = files.find((f) => f.path === path);
        if (!file) throw new Error(`There is no ${path} in this folder.`);
        await writeFile(file.handle, content);
        await loadFromRoot(root, folderName, "Refreshing");
      },
      async createBinaryFile(path, bytes) {
        await createFile(root, path, bytes);
        await loadFromRoot(root, folderName, "Refreshing");
      },
      // Walked fresh rather than looked up in `files`, which holds only
      // the markdown and module files this panel lists — an image is
      // neither, so it was never in there to find.
      async readBinaryFile(path) {
        return readBytesAt(root, path);
      },
      currentPath: () => openedPath,
      listNamesIn: (folder) => listNamesIn(root, folder),
    });
    await loadFromRoot(root, folderName, "Reading");
    onSessionOpen?.(folderName);
    return true;
  }

  openButton.addEventListener("click", () => { void choose(); });

  refreshButton.addEventListener("click", () => {
    if (currentRoot) void loadFromRoot(currentRoot, folderName, "Refreshing");
  });

  labelToggle(toggle, "Folder");
  iconRail().appendChild(toggle);
  document.body.appendChild(panel);
  if (supported) dockPanel(toggle, panel);
  renderFiles();

  return {
    choose,
    reset() {
      files = [];
      folderName = "";
      currentRoot = null;
      openedPath = null;
      openButton.textContent = "Open folder…";
      refreshButton.disabled = true;
      tutorialCreateButton.disabled = true;
      tutorialCreateButton.title = "Open a folder first.";
      status.textContent = "";
      tutorialStatus.textContent = "";
      renderFiles();
      if (!panel.hidden) closeButton.click();
    },
    destroy() {
      toggle.remove();
      panel.remove();
    },
  };
}
