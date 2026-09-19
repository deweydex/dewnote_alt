// The repository rail — step 5's first slice: browse a real GitHub
// repository's markdown (dewlab's tutorials and practice pages, by
// default any repo the token can reach), search it by path, open one
// into the editor, and push an edit back as a commit on a working
// branch with a draft PR to hand it back — never a silent push to the
// base branch. Mounted the same quiet, independent way settings-panel.ts
// and file-bar.ts are; this is the plan's own "left rail for files"
// (§5.3), closed until asked.
//
// A push that lands on a 409 (someone — another dewnote tab, or a commit
// made straight on GitHub — changed the file on this branch since it was
// opened) shows both versions rather than picking one, FAQ's own rule:
// the reader chooses to keep their edit and overwrite, or take the
// remote copy and lose theirs, but nothing is ever silently clobbered.
//
// Decision 32's own slice: a document composed in dewnote from nothing
// (the starter document, or anything typed fresh) had no way into a
// repository at all before this — every push here used to require
// `opened` to already carry a real file's own sha, which only existed
// because some earlier `openRepoFile` had fetched it. "New file" sets
// `opened` to a path with no sha instead, and `putFileContent` treats
// that as GitHub's own create-not-update case.
//
// What this slice still does not do, on purpose rather than by
// oversight: no front-matter index or module/series picker (decision 11
// — needs step 4's fuller multi-file concept); no OPFS or local-clone
// mode, only the REST API.

import {
  branchExists,
  commitFilesAtomically,
  compareBranches,
  ensureBranch,
  forgetToken,
  getFileBytes,
  listDirectory,
  getFileContent,
  GithubApiError,
  listMarkdownFiles,
  listModuleFiles,
  loadToken,
  openPullRequest,
  putFileContent,
  saveToken,
  type RepositoryChange,
  type RepoFile,
  type RepoRef,
} from "./github.ts";
import { buildFileIndex, defaultEntryFor, type FileIndexEntry } from "./file-index.ts";
import { isModuleFile, parseModuleFile, parseModuleFiles, parseModuleIndex, type Module } from "./modules.ts";
import { setActiveStore } from "./active-store.ts";
import { dockPanel, iconRail, labelToggle } from "./icon-rail.ts";
import { prepareRelease } from "./release.ts";

export interface RepoPanelHost {
  getSource(): string;
  loadDocument(source: string, name: string): void;
  /** §5.10's own front-matter index, handed the same list every time
   * loadRepoFiles rebuilds it — optional, since a caller with no link
   * picker (a test host, say) has nothing to do with it. */
  onIndexChange?(index: FileIndexEntry[]): void;
  /** modules.ts's own read of every `modules/*.yaml` file in the
   * repository, handed the same way, for series-panel.ts. */
  onModulesChange?(modules: Module[]): void;
  /** A repository has become the active workspace session. */
  onSessionOpen?(context: RepoSessionContext): void;
  /** The initial repository chooser was dismissed before a session was
   * selected, so the source-choice screen can become interactive again. */
  onChooserClose?(): void;
  /** A repository file was opened into the editor. */
  onDocumentOpen?(path: string): void;
  /** The current repository document was persisted successfully. */
  onDocumentSaved?(): void;
  /** Any commit made through the repository store, including module and
   * asset writes that do not involve the open editor document. */
  onBranchChange?(path: string): void;
  /** A raw descriptor should open in the whole-document source editor. */
  onOpenSource?(): void;
  onOrganizeModules?(): void;
}

export interface RepoSessionContext {
  label: string;
  base: string;
  branch: string;
}

export type VersionPreview =
  | { previousVersion: string; nextVersion: string; frozenPath: string; currentPath: string }
  | { error: string };

export interface RepoPanel {
  pushCurrent(): Promise<boolean>;
  pushNewVersion(): Promise<boolean>;
  canPushNewVersion(): boolean;
  previewNewVersion(): VersionPreview;
  openPullRequest(): Promise<string | null>;
  listChanges(): Promise<RepositoryChange[]>;
  showChooser(): void;
  hide(): void;
  reset(): void;
  getContext(): RepoSessionContext;
  destroy(): void;
}

const REPO_STORAGE_KEY = "dewnote:github-repo";

interface SavedRepoSettings {
  owner: string;
  repo: string;
  base: string;
  branch: string;
}

function loadRepoSettings(): SavedRepoSettings {
  try {
    const raw = localStorage.getItem(REPO_STORAGE_KEY);
    if (raw) return { base: "main", branch: "dewnote-edits", ...JSON.parse(raw) };
  } catch {
    // fall through to defaults
  }
  return { owner: "", repo: "", base: "main", branch: "dewnote-edits" };
}

function saveRepoSettings(settings: SavedRepoSettings): void {
  try {
    localStorage.setItem(REPO_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Not persisted this session; the fields just start blank next time.
  }
}

function field(labelText: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "dn-repo-field";
  const span = document.createElement("span");
  span.textContent = labelText;
  label.append(span, control);
  return label;
}

function textInput(placeholder: string, value: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.value = value;
  input.autocomplete = "off";
  input.spellcheck = false;
  return input;
}

/** GitHub's contents endpoint has to be called once per document to build
 * the searchable index. Keep that work bounded: an unbounded Promise.all
 * turns a medium-sized teaching repository into an API burst and makes a
 * secondary-rate-limit failure look like missing content. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, read: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const at = next++;
      results[at] = await read(items[at]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** Mounted once, independently of any particular document. */
export function mountRepoPanel(host: RepoPanelHost): RepoPanel {
  const settings = loadRepoSettings();
  let files: RepoFile[] = [];
  let modules: Module[] = [];
  let fileIndex: FileIndexEntry[] = [];
  let selectedModuleId = "";
  let browseRef = settings.base || "main";
  /** `file.sha` is only absent for a document `startNewFile` just pointed
   * at a path with nothing there yet (decision 32) — every other path
   * here (`openRepoFile`, a conflict's own keep/take) always has a real
   * sha, since it came from a file GitHub already told us about. */
  let opened: { repo: RepoRef; file: { path: string; sha?: string }; ref: string; originalContent?: string } | null = null;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "dn-repo-toggle";
  toggle.setAttribute("aria-label", "Repository");
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = "Repository";
  toggle.textContent = "⌂";

  const panel = document.createElement("div");
  panel.className = "dn-repo-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", "Repository");
  panel.hidden = true;
  toggle.setAttribute("aria-controls", (panel.id = "dn-repo-panel"));

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
  });

  const header = document.createElement("div");
  header.className = "dn-repo-header";
  const heading = document.createElement("h2");
  heading.textContent = "Repository";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "dn-repo-close";
  closeButton.setAttribute("aria-label", "Close repository panel");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", () => {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    host.onChooserClose?.();
  });
  header.append(heading, closeButton);
  panel.appendChild(header);

  // ------------------------------------------------------------- token
  const tokenSection = document.createElement("section");
  tokenSection.className = "dn-repo-section";
  const tokenInput = document.createElement("input");
  tokenInput.type = "password";
  tokenInput.placeholder = "GitHub token";
  tokenInput.autocomplete = "off";
  tokenInput.value = loadToken() ?? "";
  const forgetButton = document.createElement("button");
  forgetButton.type = "button";
  forgetButton.className = "dn-repo-forget";
  forgetButton.textContent = "Forget";
  forgetButton.title = "Removes the saved token from this browser.";
  forgetButton.addEventListener("click", () => {
    forgetToken();
    tokenInput.value = "";
  });
  tokenInput.addEventListener("change", () => saveToken(tokenInput.value.trim()));
  const tokenRow = document.createElement("div");
  tokenRow.className = "dn-repo-token-row";
  tokenRow.append(tokenInput, forgetButton);
  tokenSection.appendChild(field("Token", tokenRow));
  tokenSection.appendChild(
    (() => {
      const p = document.createElement("p");
      p.className = "dn-repo-hint";
      p.textContent = "A fine-grained personal access token, scoped to contents and pull requests. Kept in this browser only.";
      return p;
    })(),
  );
  panel.appendChild(tokenSection);

  // -------------------------------------------------------- repository
  const repoSection = document.createElement("section");
  repoSection.className = "dn-repo-section";
  const ownerInput = textInput("owner", settings.owner);
  const repoInput = textInput("repo", settings.repo);
  const baseInput = textInput("main", settings.base);
  const ownerRepoRow = document.createElement("div");
  ownerRepoRow.className = "dn-repo-owner-row";
  ownerRepoRow.append(ownerInput, repoInput);
  repoSection.appendChild(field("Owner / repo", ownerRepoRow));
  repoSection.appendChild(field("Base branch", baseInput));

  const loadButton = document.createElement("button");
  loadButton.type = "button";
  loadButton.className = "dn-repo-load";
  loadButton.textContent = "Load files";
  repoSection.appendChild(loadButton);

  const repoStatus = document.createElement("p");
  repoStatus.className = "dn-repo-hint dn-repo-status";
  repoSection.appendChild(repoStatus);
  panel.appendChild(repoSection);

  // ---------------------------------------------------- repository views
  // A known Dewlab repository opens onto its curriculum, not a dump of
  // paths. The complete file list remains one click away for assets,
  // module descriptors and unusual files that do not sit on a module.
  const viewTabs = document.createElement("div");
  viewTabs.className = "dn-repo-tabs";
  viewTabs.setAttribute("role", "tablist");
  viewTabs.setAttribute("aria-label", "Repository view");
  const modulesTab = document.createElement("button");
  modulesTab.type = "button";
  modulesTab.className = "dn-repo-tab is-active";
  modulesTab.textContent = "Modules";
  modulesTab.setAttribute("role", "tab");
  modulesTab.setAttribute("aria-selected", "true");
  const filesTab = document.createElement("button");
  filesTab.type = "button";
  filesTab.className = "dn-repo-tab";
  filesTab.textContent = "All files";
  filesTab.setAttribute("role", "tab");
  filesTab.setAttribute("aria-selected", "false");
  viewTabs.append(modulesTab, filesTab);
  viewTabs.hidden = true;
  panel.appendChild(viewTabs);

  const moduleSection = document.createElement("section");
  moduleSection.className = "dn-repo-section dn-repo-modules";
  moduleSection.hidden = true;
  const moduleList = document.createElement("div");
  moduleList.className = "dn-repo-module-list";
  const organizeModules = document.createElement("button");
  organizeModules.type = "button";
  organizeModules.className = "dn-repo-organize-modules";
  organizeModules.textContent = "Arrange modules and series";
  organizeModules.addEventListener("click", () => host.onOrganizeModules?.());
  const moduleDetail = document.createElement("div");
  moduleDetail.className = "dn-repo-module-detail";
  moduleSection.append(organizeModules, moduleList, moduleDetail);
  panel.appendChild(moduleSection);

  // -------------------------------------------------------- search
  const searchSection = document.createElement("section");
  searchSection.className = "dn-repo-section";
  searchSection.hidden = true;
  const searchInput = textInput("Search files…", "");
  searchInput.className = "dn-repo-search";
  searchSection.appendChild(searchInput);

  const fileList = document.createElement("ul");
  fileList.className = "dn-repo-files";
  searchSection.appendChild(fileList);
  panel.appendChild(searchSection);

  // ----------------------------------------------------------- new file
  // Decision 32: the counterpart to opening one of the files listed
  // above. Doesn't touch the editor's own content (host.getSource() at
  // push time is whatever the reader already composed, starter document
  // or not) — this only decides where a push, whenever it happens, lands.
  const newFileSection = document.createElement("section");
  newFileSection.className = "dn-repo-section";
  const newFileInput = textInput("tutorials/new-tutorial/new-tutorial.md", "");
  newFileInput.className = "dn-repo-new-file-path";
  newFileSection.appendChild(field("New file path", newFileInput));

  const newFileButton = document.createElement("button");
  newFileButton.type = "button";
  newFileButton.className = "dn-repo-new-file";
  newFileButton.textContent = "Start new file";
  newFileButton.title = "Points a later push at this path instead of an existing file — nothing is created until you push.";
  newFileSection.appendChild(newFileButton);
  panel.appendChild(newFileSection);

  newFileButton.addEventListener("click", () => {
    const repo = currentRepo();
    if (!repo.owner || !repo.repo) {
      repoStatus.textContent = "Enter an owner and repo.";
      return;
    }
    const path = newFileInput.value.trim();
    if (!path) {
      repoStatus.textContent = "Enter a path for the new file.";
      return;
    }
    const ref = baseInput.value.trim() || "main";
    opened = { repo, file: { path }, ref };
    host.onSessionOpen?.({ label: `${repo.owner}/${repo.repo}`, base: ref, branch: branchInput.value.trim() || "dewnote-edits" });
    host.onDocumentOpen?.(path);
    hideConflict();
    renderPush();
    repoStatus.textContent = `Ready to push a new file at ${path}.`;
  });

  function currentRepo(): RepoRef {
    return { owner: ownerInput.value.trim(), repo: repoInput.value.trim() };
  }

  function currentToken(): string | null {
    const token = tokenInput.value.trim();
    return token.length > 0 ? token : null;
  }

  function renderFiles() {
    const query = searchInput.value.trim().toLowerCase();
    const matches = query ? files.filter((f) => f.path.toLowerCase().includes(query)) : files;
    fileList.replaceChildren();
    for (const file of matches.slice(0, 300)) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dn-repo-file";
      button.textContent = file.path;
      button.addEventListener("click", () => openRepoFile(file));
      item.appendChild(button);
      fileList.appendChild(item);
    }
    if (files.length > 0 && matches.length === 0) {
      const empty = document.createElement("li");
      empty.className = "dn-repo-empty";
      empty.textContent = "No files match.";
      fileList.appendChild(empty);
    }
  }
  searchInput.addEventListener("input", renderFiles);

  function openIndexed(entry: FileIndexEntry): void {
    const file = files.find((candidate) => candidate.path === entry.path);
    if (file) void openRepoFile(file);
  }

  function appendPageButton(parent: HTMLElement, entry: FileIndexEntry | undefined, fallback: string, practice = false): void {
    const row = document.createElement("div");
    row.className = `dn-repo-module-page${practice ? " is-practice" : ""}`;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = entry?.title ?? fallback;
    if (entry) button.addEventListener("click", () => openIndexed(entry));
    else {
      button.disabled = true;
      button.title = "The module lists this id, but no matching tutorial file was found.";
    }
    row.appendChild(button);
    if (!entry) {
      const missing = document.createElement("span");
      missing.textContent = "No file";
      row.appendChild(missing);
    }
    parent.appendChild(row);
  }

  function renderModuleDetail(module: Module): void {
    moduleDetail.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "dn-repo-module-detail-heading";
    const title = document.createElement("h3");
    title.textContent = module.title;
    const descriptor = document.createElement("button");
    descriptor.type = "button";
    descriptor.textContent = "Edit module details";
    descriptor.addEventListener("click", async () => {
      const file = files.find((candidate) => candidate.path === module.path);
      if (file && await openRepoFile(file)) host.onOpenSource?.();
    });
    heading.append(title, descriptor);
    moduleDetail.appendChild(heading);

    for (const series of module.contents) {
      const block = document.createElement("section");
      block.className = "dn-repo-module-series";
      const seriesTitle = document.createElement("h4");
      seriesTitle.textContent = series.title;
      block.appendChild(seriesTitle);
      for (const id of series.tutorials) {
        appendPageButton(block, defaultEntryFor(fileIndex, id), id);
        for (const practice of fileIndex.filter((entry) => entry.practiceFor === id)) {
          appendPageButton(block, practice, practice.id ?? practice.path, true);
        }
      }
      moduleDetail.appendChild(block);
    }

    if (module.mixed?.length) {
      const block = document.createElement("section");
      block.className = "dn-repo-module-series";
      const title = document.createElement("h4");
      title.textContent = "Mixed practice";
      block.appendChild(title);
      for (const id of module.mixed) appendPageButton(block, defaultEntryFor(fileIndex, id), id, true);
      moduleDetail.appendChild(block);
    }
  }

  function renderModules(): void {
    moduleList.replaceChildren();
    if (!selectedModuleId || !modules.some((module) => module.id === selectedModuleId)) selectedModuleId = modules[0]?.id ?? "";
    for (const module of modules) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dn-repo-module-choice";
      button.classList.toggle("is-active", module.id === selectedModuleId);
      button.textContent = module.title;
      button.setAttribute("aria-pressed", String(module.id === selectedModuleId));
      button.addEventListener("click", () => {
        selectedModuleId = module.id;
        renderModules();
      });
      moduleList.appendChild(button);
    }
    const selected = modules.find((module) => module.id === selectedModuleId);
    if (selected) renderModuleDetail(selected);
    else {
      moduleDetail.replaceChildren();
      const empty = document.createElement("p");
      empty.className = "dn-repo-hint";
      empty.textContent = "No modules were found in this repository.";
      moduleDetail.appendChild(empty);
    }
  }

  function selectRepoView(view: "modules" | "files"): void {
    const showingModules = view === "modules";
    modulesTab.classList.toggle("is-active", showingModules);
    filesTab.classList.toggle("is-active", !showingModules);
    modulesTab.setAttribute("aria-selected", String(showingModules));
    filesTab.setAttribute("aria-selected", String(!showingModules));
    moduleSection.hidden = !showingModules;
    searchSection.hidden = showingModules;
  }
  modulesTab.addEventListener("click", () => selectRepoView("modules"));
  filesTab.addEventListener("click", () => selectRepoView("files"));

  /** §5.10's own index, over the repository this time — one
   * getFileContent per markdown file, the only way to read front matter
   * through the REST API at all (there is no "just the first few lines"
   * endpoint). A real cost for a large repository, same as
   * folder-panel.ts's own version of this, and the same "one file's
   * failure doesn't fail the rest" handling. Takes `markdownFiles`
   * explicitly rather than reading the shared `files` — that list also
   * carries the module files now (loadRepoFiles's own comment explains
   * why), and a module file has no front matter worth indexing at all,
   * so fetching its content again here would spend a real API call on a
   * bare `{path}` entry.
   *
   * `modules` is what lets each entry carry the modules that list its id
   * (file-index.ts's own join), so the modules are read first and this
   * runs after them. */
  async function refreshIndex(repo: RepoRef, ref: string, token: string, markdownFiles: RepoFile[], modules: Module[]): Promise<{ index: FileIndexEntry[]; failures: string[] }> {
    const failures: string[] = [];
    const entries = await mapWithConcurrency(
      markdownFiles,
      8,
      async (file) => {
        try {
          const { content } = await getFileContent(repo, file.path, ref, token);
          return { path: file.path, content };
        } catch (error) {
          failures.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      },
    );
    fileIndex = buildFileIndex(
      entries.filter((e): e is { path: string; content: string } => e !== null),
      modules,
    );
    host.onIndexChange?.(fileIndex);
    renderModules();
    return { index: fileIndex, failures };
  }

  /** Mirrors refreshIndex's own shape, over the module files
   * loadRepoFiles's own tree walk already listed — no separate fetch of
   * the tree a second time just for this. Returns the parsed modules as
   * well as handing them on, since the index needs them too. */
  async function refreshModules(repo: RepoRef, ref: string, token: string, moduleFiles: RepoFile[]): Promise<{ modules: Module[]; failures: string[]; invalid: string[] }> {
    const failures: string[] = [];
    const entries = await mapWithConcurrency(
      moduleFiles,
      6,
      async (file) => {
        try {
          const { content } = await getFileContent(repo, file.path, ref, token);
          return { path: file.path, content };
        } catch (error) {
          failures.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      },
    );
    const read = entries.filter((e): e is { path: string; content: string } => e !== null);
    const index = read.find((file) => /(?:^|\/)(?:courses|modules)\/index\.yaml$/.test(file.path));
    modules = parseModuleFiles(read, index ? parseModuleIndex(index.content) : []);
    const invalid = read.filter((file) => isModuleFile(file.path) && !parseModuleFile(file.path, file.content)).map((file) => file.path);
    host.onModulesChange?.(modules);
    return { modules, failures, invalid };
  }

  async function loadRepoFiles() {
    const token = currentToken();
    const repo = currentRepo();
    if (!token) {
      repoStatus.textContent = "Enter a token first.";
      return;
    }
    if (!repo.owner || !repo.repo) {
      repoStatus.textContent = "Enter an owner and repo.";
      return;
    }
    const base = baseInput.value.trim() || "main";
    const branch = branchInput.value.trim() || "dewnote-edits";
    saveRepoSettings({ owner: repo.owner, repo: repo.repo, base, branch });
    loadButton.disabled = true;
    repoStatus.textContent = "Loading…";
    try {
      // Resume an existing editing session from its working branch. The
      // base remains the comparison and pull-request target, but showing
      // base content here would hide the author's own earlier commits
      // and invite conflicts on the next save.
      const ref = await branchExists(repo, branch, token) ? branch : base;
      browseRef = ref;
      // Listed separately (github.ts's own two functions, one tree fetch
      // each), but merged into one browsable/searchable list: a
      // module file is a plain text file like any other, and opening one
      // hands it to the same editor and push path every other file
      // already gets — the whole-file source view (Cmd+/) shows its raw
      // YAML untouched by any markdown rendering, exactly what
      // hand-editing a module actually wants, no new UI.
      const [markdownFiles, moduleFiles] = await Promise.all([listMarkdownFiles(repo, ref, token), listModuleFiles(repo, ref, token)]);
      files = [...markdownFiles, ...moduleFiles];
      repoStatus.textContent = `${markdownFiles.length} markdown file${markdownFiles.length === 1 ? "" : "s"}, ${moduleFiles.length} module file${moduleFiles.length === 1 ? "" : "s"}.`;
      renderFiles();
      // active-store.ts's own "open this path" hook — the repository's
      // own version of the same registration folder-panel.ts makes,
      // reusing openRepoFile itself (the branch/token/ref it needs are
      // read fresh from the form on every call, the same as loadRepoFiles
      // itself already does, so a later change to any of them is seen
      // without registering again).
      setActiveStore({
        async openPath(path) {
          const file = files.find((f) => f.path === path);
          if (!file) return false;
          await openRepoFile(file);
          return true;
        },
        // decision 33: the repository's own implementation of
        // active-store.ts's generic createFile. Nothing in the editor
        // calls it right now — its one caller was series-panel.ts's
        // "New series", which wrote a `<series>.order.yaml` file, and
        // that form went with the files it wrote (decision 36). The
        // writer restores a caller: a new series is an entry in a module
        // file's `contents:` now, and a new module is still a file.
        // Kept rather than deleted and written again a PR later, and
        // flagged here rather than left looking load-bearing.
        //
        // Deliberately does not touch `opened`/renderPush/repoStatus — a
        // reader creating a file while a real edit is already open in
        // this same panel should never have that edit's own push target
        // silently swapped out from under them; the caller's own status
        // line is what reports success or failure here, the same as it
        // already does for a local folder. Writes straight to the
        // working branch, not the base `ref` this panel browses — a
        // freshly created file exists only there until a PR merges it,
        // so it deliberately never appears in `files`/the browsable list
        // the way a folder's own newly created file immediately would;
        // opening it back up through this same panel is follow-up scope,
        // not silently promised here.
        async createFile(path, content) {
          const token = currentToken();
          if (!token) throw new Error("Enter a GitHub token first.");
          const repo = currentRepo();
          const branch = branchInput.value.trim() || "dewnote-edits";
          const base = baseInput.value.trim() || "main";
          await ensureBranch(repo, branch, base, token);
          await putFileContent(repo, path, content, undefined, branch, `Add ${path} from dewnote`, token);
          markBranchChanged(path);
        },
        // The read-modify-write half, for a caller editing a file it
        // never opened into the editor — series-panel.ts writing a
        // module file. Reads the working branch first and the browsed
        // `ref` only as a fallback: a second edit to the same module has
        // to build on the first one's commit, not on the base branch
        // that still predates it. Like `createFile` above, it leaves
        // `opened`/renderPush alone, so an edit already open in this
        // panel keeps its own push target.
        async readTextFile(path) {
          const token = currentToken();
          if (!token) throw new Error("Enter a GitHub token first.");
          const repo = currentRepo();
          const branch = branchInput.value.trim() || "dewnote-edits";
          const ref = baseInput.value.trim() || "main";
          try {
            return (await getFileContent(repo, path, branch, token)).content;
          } catch {
            return (await getFileContent(repo, path, ref, token)).content;
          }
        },
        async writeTextFile(path, content, message) {
          const token = currentToken();
          if (!token) throw new Error("Enter a GitHub token first.");
          const repo = currentRepo();
          const branch = branchInput.value.trim() || "dewnote-edits";
          const base = baseInput.value.trim() || "main";
          await ensureBranch(repo, branch, base, token);
          // The sha the branch holds right now, not the one the base
          // does: GitHub wants the blob being replaced, and a file this
          // branch hasn't touched yet simply has none there.
          let sha: string | undefined;
          try {
            sha = (await getFileContent(repo, path, branch, token)).sha;
          } catch {
            sha = undefined;
          }
          await putFileContent(repo, path, content, sha, branch, message, token);
          markBranchChanged(path);
        },
        // An image copied in beside a tutorial, committed to the working
        // branch like any other new file. `putFileContent` base64s the
        // bytes directly rather than through `toBase64`, which would
        // UTF-8 encode them first and corrupt every byte above 0x7F.
        async createBinaryFile(path, bytes) {
          const token = currentToken();
          if (!token) throw new Error("Enter a GitHub token first.");
          const repo = currentRepo();
          const branch = branchInput.value.trim() || "dewnote-edits";
          const base = baseInput.value.trim() || "main";
          await ensureBranch(repo, branch, base, token);
          await putFileContent(repo, path, bytes, undefined, branch, `Add ${path} from dewnote`, token);
          markBranchChanged(path);
        },
        async readBinaryFile(path) {
          const token = currentToken();
          if (!token) return null;
          const repo = currentRepo();
          const branch = branchInput.value.trim() || "dewnote-edits";
          const ref = baseInput.value.trim() || "main";
          // The working branch first, then the browsed ref — the same
          // order `readTextFile` uses, and for the same reason: an image
          // added in this session exists only on the branch.
          try {
            return await getFileBytes(repo, path, branch, token);
          } catch {
            try {
              return await getFileBytes(repo, path, ref, token);
            } catch {
              return null;
            }
          }
        },
        currentPath: () => opened?.file.path ?? null,
        // GitHub's own directory listing, not this panel's tree walk —
        // that walk keeps markdown and module files only, so a picture
        // already committed beside a tutorial appears in neither list.
        // One extra request, on a path a reader takes by hand.
        async listNamesIn(folder) {
          const token = currentToken();
          if (!token) return [];
          const repo = currentRepo();
          const branch = branchInput.value.trim() || "dewnote-edits";
          const ref = baseInput.value.trim() || "main";
          // The working branch first: an image added earlier in this
          // session is committed there and nowhere else yet, and missing
          // it would hand the next one the same name.
          for (const at of [branch, ref]) {
            try {
              return await listDirectory(repo, folder, at, token);
            } catch {
              // Try the base ref, then give up — an unreadable listing
              // just means the create call is the only guard left.
            }
          }
          return [];
        },
      });
      // Modules first: the index joins each entry to the modules that
      // list its id, so it needs them already parsed.
      repoStatus.textContent = `Reading ${moduleFiles.length} module descriptor${moduleFiles.length === 1 ? "" : "s"}…`;
      const moduleResult = await refreshModules(repo, ref, token, moduleFiles);
      repoStatus.textContent = `Indexing ${markdownFiles.length} document${markdownFiles.length === 1 ? "" : "s"}…`;
      const indexResult = await refreshIndex(repo, ref, token, markdownFiles, moduleResult.modules);
      viewTabs.hidden = false;
      selectRepoView("modules");
      host.onSessionOpen?.({ label: `${repo.owner}/${repo.repo}`, base, branch });
      const warnings = [
        ...moduleResult.failures,
        ...moduleResult.invalid.map((path) => `${path}: invalid module YAML`),
        ...indexResult.failures,
      ];
      const summary = `${markdownFiles.length} markdown file${markdownFiles.length === 1 ? "" : "s"}, ${moduleFiles.length} module file${moduleFiles.length === 1 ? "" : "s"}.`;
      repoStatus.textContent = warnings.length
        ? `${summary} ${warnings.length} file${warnings.length === 1 ? "" : "s"} could not be indexed. First problem: ${warnings[0]}`
        : summary;
    } catch (err) {
      repoStatus.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      loadButton.disabled = false;
    }
  }
  loadButton.addEventListener("click", () => loadRepoFiles());

  async function openRepoFile(file: RepoFile): Promise<boolean> {
    const token = currentToken();
    if (!token) {
      repoStatus.textContent = "Enter a token first.";
      return false;
    }
    const repo = currentRepo();
    const ref = browseRef;
    repoStatus.textContent = `Opening ${file.path}…`;
    try {
      const { content, sha } = await getFileContent(repo, file.path, ref, token);
      opened = { repo, file: { path: file.path, sha }, ref, originalContent: content };
      host.loadDocument(content, file.path);
      host.onDocumentOpen?.(file.path);
      hideConflict();
      renderPush();
      repoStatus.textContent = `Opened ${file.path}.`;
      return true;
    } catch (err) {
      repoStatus.textContent = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  // ------------------------------------------------------------- push
  const pushSection = document.createElement("section");
  pushSection.className = "dn-repo-section";
  const branchInput = textInput("dewnote-edits", settings.branch);
  pushSection.appendChild(field("Working branch", branchInput));

  const pushButton = document.createElement("button");
  pushButton.type = "button";
  pushButton.className = "dn-repo-push";
  pushSection.appendChild(pushButton);

  const releaseButton = document.createElement("button");
  releaseButton.type = "button";
  releaseButton.className = "dn-repo-release";
  releaseButton.textContent = "Push as new version";
  releaseButton.title = "Freeze the committed release and push these edits as the new live version.";
  pushSection.appendChild(releaseButton);
  // A pointer click moves focus before `click` fires. Capture the live
  // editor source first so a blur/commit cannot make the release compare
  // against a transiently re-rendered document. Keyboard activation has
  // no pointerdown and reads the source normally in the click handler.
  let releaseSourceOnPointerDown: string | null = null;
  releaseButton.addEventListener("pointerdown", () => {
    releaseSourceOnPointerDown = host.getSource();
  });

  const prButton = document.createElement("button");
  prButton.type = "button";
  prButton.className = "dn-repo-pr";
  prButton.textContent = "Open pull request";
  prButton.hidden = true;
  pushSection.appendChild(prButton);

  const pushStatus = document.createElement("p");
  pushStatus.className = "dn-repo-hint dn-repo-status";
  pushSection.appendChild(pushStatus);
  panel.appendChild(pushSection);

  // ---------------------------------------------------------- conflict
  // FAQ's own rule, ported here rather than invented: on a 409 (the
  // branch moved under this file since it was opened, or since the last
  // push), show both versions and let the reader choose — never pick
  // one, and never silently overwrite either.
  interface Conflict {
    mine: string;
    theirsContent: string;
    theirsSha: string;
    branch: string;
  }
  let conflict: Conflict | null = null;

  const conflictSection = document.createElement("section");
  conflictSection.className = "dn-repo-section dn-repo-conflict";
  conflictSection.hidden = true;

  const conflictHeading = document.createElement("p");
  conflictHeading.className = "dn-repo-hint";
  conflictHeading.textContent = "Someone changed this file on the branch since it was opened.";
  conflictSection.appendChild(conflictHeading);

  const mineLabel = document.createElement("p");
  mineLabel.className = "dn-repo-hint";
  mineLabel.textContent = "Your edit:";
  const minePre = document.createElement("pre");
  minePre.className = "dn-repo-conflict-text";
  const theirsLabel = document.createElement("p");
  theirsLabel.className = "dn-repo-hint";
  theirsLabel.textContent = "Theirs, currently on the branch:";
  const theirsPre = document.createElement("pre");
  theirsPre.className = "dn-repo-conflict-text";
  conflictSection.append(mineLabel, minePre, theirsLabel, theirsPre);

  const keepMineButton = document.createElement("button");
  keepMineButton.type = "button";
  keepMineButton.className = "dn-repo-conflict-keep";
  keepMineButton.textContent = "Keep mine, overwrite theirs";
  const takeTheirsButton = document.createElement("button");
  takeTheirsButton.type = "button";
  takeTheirsButton.className = "dn-repo-conflict-take";
  takeTheirsButton.textContent = "Discard mine, load theirs";
  conflictSection.append(keepMineButton, takeTheirsButton);
  panel.appendChild(conflictSection);

  function showConflict(next: Conflict) {
    conflict = next;
    minePre.textContent = next.mine;
    theirsPre.textContent = next.theirsContent;
    conflictSection.hidden = false;
    pushStatus.textContent = "Conflict — choose a version below.";
  }
  function hideConflict() {
    conflict = null;
    conflictSection.hidden = true;
  }

  keepMineButton.addEventListener("click", async () => {
    if (!opened || !conflict) return;
    const token = currentToken();
    if (!token) {
      pushStatus.textContent = "Enter a token first.";
      return;
    }
    const { mine, theirsSha, branch } = conflict;
    keepMineButton.disabled = true;
    try {
      const result = await putFileContent(opened.repo, opened.file.path, mine, theirsSha, branch, `Edit ${opened.file.path} from dewnote`, token);
      opened = { ...opened, file: { path: opened.file.path, sha: result.sha }, originalContent: mine };
      hideConflict();
      renderPush();
      pushStatus.textContent = `Pushed to ${branch}.`;
      markBranchChanged(opened.file.path);
      host.onDocumentSaved?.();
    } catch (err) {
      pushStatus.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      keepMineButton.disabled = false;
    }
  });

  takeTheirsButton.addEventListener("click", () => {
    if (!opened || !conflict) return;
    host.loadDocument(conflict.theirsContent, opened.file.path);
    opened = { ...opened, file: { path: opened.file.path, sha: conflict.theirsSha }, originalContent: conflict.theirsContent };
    pushStatus.textContent = "Loaded their version — your edit was discarded.";
    hideConflict();
  });

  function renderPush() {
    // A module descriptor can be changed without opening a tutorial in
    // the editor. Keep the publishing section available in that case so
    // its pull-request action is not hidden by its own parent.
    pushSection.hidden = !opened && prButton.hidden;
    pushButton.hidden = !opened;
    releaseButton.hidden = !opened;
    if (!opened) return;
    const branch = branchInput.value.trim() || "dewnote-edits";
    pushButton.textContent = opened.file.sha ? `Push to ${branch}` : `Push new file to ${branch}`;
    releaseButton.hidden = !opened.file.sha || !opened.originalContent || !/^(?:.*\/)?tutorials\/([^/]+)\/\1\.md$/.test(opened.file.path);
  }
  branchInput.addEventListener("input", renderPush);

  function markBranchChanged(path = opened?.file.path ?? "Repository changes"): void {
    prButton.hidden = false;
    pushSection.hidden = false;
    host.onBranchChange?.(path);
  }

  async function pushCurrent(): Promise<boolean> {
    if (!opened) return false;
    const token = currentToken();
    if (!token) {
      pushStatus.textContent = "Enter a token first.";
      return false;
    }
    const branch = branchInput.value.trim() || "dewnote-edits";
    const base = baseInput.value.trim() || "main";
    saveRepoSettings({ owner: opened.repo.owner, repo: opened.repo.repo, base, branch });
    const mine = host.getSource();
    const isNewFile = !opened.file.sha;
    pushButton.disabled = true;
    pushStatus.textContent = `Pushing to ${branch}…`;
    try {
      await ensureBranch(opened.repo, branch, base, token);
      const message = `${isNewFile ? "Add" : "Edit"} ${opened.file.path} from dewnote`;
      const result = await putFileContent(opened.repo, opened.file.path, mine, opened.file.sha, branch, message, token);
      opened = { ...opened, file: { path: opened.file.path, sha: result.sha }, originalContent: mine };
      renderPush();
      pushStatus.textContent = `Pushed to ${branch}.`;
      markBranchChanged(opened.file.path);
      host.onDocumentSaved?.();
      return true;
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 409 && !isNewFile) {
        try {
          const theirs = await getFileContent(opened.repo, opened.file.path, branch, token);
          showConflict({ mine, theirsContent: theirs.content, theirsSha: theirs.sha, branch });
        } catch (fetchErr) {
          pushStatus.textContent = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        }
      } else if (err instanceof GithubApiError && err.status === 422 && isNewFile) {
        // No sha was ever fetched for this path, so there is no "theirs"
        // to show the way an edit's own 409 conflict has — a plain
        // message and a different path or a real open is the fix here,
        // not a diff view built for a case with nothing to diff against.
        pushStatus.textContent = `A file already exists at ${opened.file.path} on ${branch} — pick a different path, or open that file from the list above to edit it instead.`;
      } else {
        pushStatus.textContent = err instanceof Error ? err.message : String(err);
      }
      return false;
    } finally {
      pushButton.disabled = false;
    }
  }
  pushButton.addEventListener("click", () => void pushCurrent());

  async function pushNewVersion(): Promise<boolean> {
    if (!opened?.file.sha || opened.originalContent === undefined) return false;
    const token = currentToken();
    if (!token) {
      pushStatus.textContent = "Enter a token first.";
      return false;
    }
    const mine = releaseSourceOnPointerDown ?? host.getSource();
    releaseSourceOnPointerDown = null;
    const entry = fileIndex.find((item) => item.path === opened!.file.path);
    const family = fileIndex.filter((item) => item.id && item.id === entry?.id).map((item) => item.version);
    const prepared = prepareRelease(opened.file.path, opened.originalContent, mine, family);
    if ("error" in prepared) {
      pushStatus.textContent = prepared.error;
      return false;
    }
    const branch = branchInput.value.trim() || "dewnote-edits";
    const base = baseInput.value.trim() || "main";
    releaseButton.disabled = true;
    pushButton.disabled = true;
    pushStatus.textContent = `Creating version ${prepared.nextVersion} on ${branch}…`;
    try {
      await ensureBranch(opened.repo, branch, base, token);
      const result = await commitFilesAtomically(
        opened.repo,
        branch,
        base,
        [
          { path: prepared.frozenPath, content: prepared.frozenContent, expectedSha: null },
          { path: prepared.currentPath, content: prepared.releasedContent, expectedSha: opened.file.sha },
        ],
        `Release ${entry?.title ?? entry?.id ?? opened.file.path} as ${prepared.nextVersion} from dewnote`,
        token,
      );
      if (!files.some((file) => file.path === prepared.frozenPath)) {
        files.push({ path: prepared.frozenPath, sha: result.blobs[prepared.frozenPath]! });
      }
      fileIndex = fileIndex.map((item) => item.path === prepared.currentPath ? { ...item, version: prepared.nextVersion } : item);
      opened = {
        ...opened,
        file: { path: prepared.currentPath, sha: result.blobs[prepared.currentPath]! },
        originalContent: prepared.releasedContent,
      };
      host.loadDocument(prepared.releasedContent, prepared.currentPath);
      host.onDocumentOpen?.(prepared.currentPath);
      renderFiles();
      renderModules();
      renderPush();
      pushStatus.textContent = `Pushed version ${prepared.nextVersion}. ${prepared.previousVersion} is preserved as ${prepared.frozenPath}.`;
      markBranchChanged(prepared.currentPath);
      host.onDocumentSaved?.();
      return true;
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 409) {
        pushStatus.textContent = "The live file changed on the working branch. Reload it before creating a new version.";
      } else {
        pushStatus.textContent = err instanceof Error ? err.message : String(err);
      }
      return false;
    } finally {
      releaseButton.disabled = false;
      pushButton.disabled = false;
    }
  }
  releaseButton.addEventListener("click", () => { void pushNewVersion(); });

  async function openCurrentPullRequest(): Promise<string | null> {
    const token = currentToken();
    if (!token) {
      pushStatus.textContent = "Enter a token first.";
      return null;
    }
    const branch = branchInput.value.trim() || "dewnote-edits";
    const base = baseInput.value.trim() || "main";
    prButton.disabled = true;
    try {
      const repo = currentRepo();
      if (!repo.owner || !repo.repo) {
        pushStatus.textContent = "Enter an owner and repo.";
        return null;
      }
      const title = opened ? `Edit ${opened.file.path} from dewnote` : "Update modules from dewnote";
      const pr = await openPullRequest(repo, branch, base, title, token);
      pushStatus.textContent = `Draft PR: ${pr.html_url}`;
      window.open(pr.html_url, "_blank", "noopener");
      return pr.html_url;
    } catch (err) {
      pushStatus.textContent = err instanceof Error ? err.message : String(err);
      return null;
    } finally {
      prButton.disabled = false;
    }
  }
  prButton.addEventListener("click", () => { void openCurrentPullRequest(); });

  async function listChanges(): Promise<RepositoryChange[]> {
    const token = currentToken();
    if (!token) throw new Error("Enter a GitHub token first.");
    const repo = currentRepo();
    if (!repo.owner || !repo.repo) throw new Error("Enter an owner and repo.");
    return compareBranches(
      repo,
      baseInput.value.trim() || "main",
      branchInput.value.trim() || "dewnote-edits",
      token,
    );
  }

  labelToggle(toggle, "GitHub");
  iconRail().appendChild(toggle);
  document.body.appendChild(panel);
  dockPanel(toggle, panel);
  renderFiles();
  renderPush();

  return {
    pushCurrent,
    pushNewVersion,
    canPushNewVersion() {
      return Boolean(opened?.file.sha && opened.originalContent !== undefined && /^(?:.*\/)?tutorials\/([^/]+)\/\1\.md$/.test(opened.file.path));
    },
    previewNewVersion() {
      if (!opened?.file.sha || opened.originalContent === undefined) {
        return { error: "Open a live tutorial before creating a new version." };
      }
      const entry = fileIndex.find((item) => item.path === opened!.file.path);
      const family = fileIndex.filter((item) => item.id && item.id === entry?.id).map((item) => item.version);
      const prepared = prepareRelease(opened.file.path, opened.originalContent, host.getSource(), family);
      if ("error" in prepared) return prepared;
      return {
        previousVersion: prepared.previousVersion,
        nextVersion: prepared.nextVersion,
        frozenPath: prepared.frozenPath,
        currentPath: prepared.currentPath,
      };
    },
    openPullRequest: openCurrentPullRequest,
    listChanges,
    showChooser() {
      if (panel.hidden) toggle.click();
    },
    hide() {
      if (!panel.hidden) closeButton.click();
    },
    reset() {
      files = [];
      modules = [];
      fileIndex = [];
      selectedModuleId = "";
      browseRef = baseInput.value.trim() || "main";
      opened = null;
      hideConflict();
      prButton.hidden = true;
      viewTabs.hidden = true;
      repoStatus.textContent = "";
      renderFiles();
      renderModules();
      renderPush();
      if (!panel.hidden) closeButton.click();
    },
    getContext() {
      const repo = currentRepo();
      return {
        label: repo.owner && repo.repo ? `${repo.owner}/${repo.repo}` : "GitHub repository",
        base: baseInput.value.trim() || "main",
        branch: branchInput.value.trim() || "dewnote-edits",
      };
    },
    destroy() {
      toggle.remove();
      panel.remove();
    },
  };
}
