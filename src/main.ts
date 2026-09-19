import "katex/dist/katex.min.css";
import "./theme/dewlab-tokens.css";
import "./brand.css";
import "./app.css";
import { getFileIndex, mountDocument, setFileIndex, type MountedDocument } from "./app.ts";
import { applySettings, loadSettings } from "./settings.ts";
import { mountSettingsPanel } from "./settings-panel.ts";
import { mountFileBar, type FileBarState } from "./file-bar.ts";
import { mountRepoPanel, type RepoPanel } from "./repo-panel.ts";
import { mountFolderPanel, type FolderPanel } from "./folder-panel.ts";
import { mountOutlinePanel } from "./outline-panel.ts";
import { mountSourceView } from "./source-view.ts";
import { mountLinkCheckPanel } from "./link-check.ts";
import { mountSeriesPanel } from "./series-panel.ts";
import { mountCommandPalette } from "./command-palette.ts";
import { todayVersion } from "./dialect.ts";
import { activeDockContains, closeDockPanels, groupDockPanels, iconRail } from "./icon-rail.ts";
import { mountWorkspaceNav } from "./workspace-nav.ts";
import { mountWorkflowShell, type WorkflowShell } from "./workflow-shell.ts";
import { setActiveStore } from "./active-store.ts";

// Applied before the document mounts, not after, so there is never a
// flash of default texture before a returning reader's own saved
// choice takes effect.
applySettings(loadSettings());

// dewlab, not plain markdown: dewnote's own default texture is already
// dewlab's (§5.3), and a first-time reader who never sets year: or
// module_title: never sees the per-field form (decision 11) or any
// other dialect-aware polish gated on a real dialect — the very things
// most worth showing in a first five minutes (decision 29's own note).
// Decision 31: the starter models a real dialect rather than plain
// markdown, and the dialect is dewlab — so a first-time reader meets the
// per-field form rather than the raw-YAML caption plain markdown gets.
//
// Which fields, though, is dewlab's to say, and dewlab's answer changed:
// `slug`, `module`, `module_title` and `series` went when placement moved
// into `modules/*.yaml` (decision 36). They survived here after the form
// stopped showing them, which made them worse than visible-and-wrong —
// every document started from this one carried four fields nobody could
// see and dewlab's build ignores. `version` is dewlab's own dated form
// now too (`2026.09.14.1`), stamped when the editor loads rather than
// frozen at whatever day this string was last edited.
const STARTER_DOCUMENT = `---
title: Untitled
year: "${new Date().getFullYear()}"
version: ${todayVersion()}
---

# Untitled

Start writing. Click this paragraph, or any other, to edit its markdown
source directly; click away to see it rendered again.

\`\`\`python exec
id: first-cell
1 + 1
\`\`\`

<details class="dl-hint"><summary>hint</summary>

This is a hint fold — the same one dewlab uses.

</details>
`;

const page = document.querySelector<HTMLDivElement>("#dn-page");
if (!page) throw new Error("index.html is missing #dn-page");

let current: MountedDocument = mountDocument(page, STARTER_DOCUMENT);
const legacyShell = new URLSearchParams(window.location.search).has("legacy");
let workflow: WorkflowShell | null = null;
let latestFileState: FileBarState | null = null;
const workspaceNav = mountWorkspaceNav({
  progressive: !legacyShell,
  onLocationChange: (location) => workflow?.setLocation(location),
  onNavigate: () => workflow?.closeTransient(),
});
let session: "local" | "github" | null = null;

function chooseSession(next: "local" | "github"): void {
  if (session && session !== next) return;
  session = next;
  const folder = document.querySelector<HTMLButtonElement>(".dn-folder-toggle");
  const repository = document.querySelector<HTMLButtonElement>(".dn-repo-toggle");
  if (folder) {
    folder.dataset["baseDisabled"] ??= String(folder.disabled);
    folder.dataset["baseTitle"] ??= folder.title;
    folder.disabled = folder.dataset["baseDisabled"] === "true" || next === "github";
    if (next === "github") folder.title = "This session is connected to GitHub. Choose Change workspace to start a local session.";
  }
  if (repository) {
    repository.dataset["baseTitle"] ??= repository.title;
    repository.disabled = next === "local";
    if (repository.disabled) repository.title = "This is a local session. Choose Change workspace to connect a GitHub repository.";
  }
  document.body.dataset["workspaceSession"] = next;
}

mountSettingsPanel();
let repoPanel: RepoPanel | null = null;
const fileBar = mountFileBar({
  getSource: () => current.getSource(),
  loadDocument(source, name) {
    current.destroy();
    current = mountDocument(page, source);
    workspaceNav.setCurrentPath(name);
  },
  onLocalOpen: () => {
    if (session === "github") {
      window.alert("This session is connected to GitHub. Reload Dewnote to start a separate local session.");
      return false;
    }
    chooseSession("local");
    return true;
  },
  onExternalSave: () => repoPanel?.pushCurrent() ?? false,
  onStateChange: (state) => {
    latestFileState = state;
    workflow?.setFileState(state);
  },
});
const seriesPanel = mountSeriesPanel(getFileIndex);
const updateIndex = (index: Parameters<typeof setFileIndex>[0]) => {
  setFileIndex(index);
  workspaceNav.setIndex(index);
};
const updateModules = (modules: Parameters<typeof seriesPanel.setModules>[0]) => {
  seriesPanel.setModules(modules);
  workspaceNav.setModules(modules);
};
let folderPanel: FolderPanel | null = null;
folderPanel = mountFolderPanel(fileBar, updateIndex, updateModules, (name) => {
  chooseSession("local");
  workflow?.setSession("local", name, "Local folder");
});
repoPanel = mountRepoPanel({
  getSource: () => current.getSource(),
  loadDocument(source, name) {
    current.destroy();
    current = mountDocument(page, source);
    workspaceNav.setCurrentPath(name);
    fileBar.openExternal(name);
  },
  onIndexChange: updateIndex,
  onModulesChange: updateModules,
  onSessionOpen: (context) => {
    chooseSession("github");
    if (!legacyShell) repoPanel?.hide();
    workflow?.setRepoContext(context);
    workflow?.setSession("github", context.label, `${context.base} → ${context.branch}`);
  },
  onChooserClose: () => {
    if (!session) workflow?.cancelSourceChoice();
  },
  onDocumentOpen: (path) => {
    workspaceNav.setCurrentPath(path);
    fileBar.openExternal(path);
  },
  onDocumentSaved: () => {
    fileBar.markSaved();
    workflow?.documentSaved();
  },
  onBranchChange: (path) => workflow?.noteBranchChange(path),
  onOpenSource: () => document.querySelector<HTMLButtonElement>(".dn-source-toggle")?.click(),
  onOrganizeModules: () => document.querySelector<HTMLButtonElement>(".dn-series-toggle")?.click(),
});
mountOutlinePanel({ getSource: () => current.getSource() });
mountSourceView({
  getSource: () => current.getSource(),
  loadDocument(source, _name) {
    current.destroy();
    current = mountDocument(page, source);
  },
});
mountLinkCheckPanel({ getSource: () => current.getSource(), getFileIndex });

// Four purposeful rail launchers instead of seven peer circles. Workspace is
// where content comes from and where its module structure is managed;
// Review holds non-editing views over the current document. Source and
// Settings remain direct because each is a distinct, frequently used
// mode rather than a choice among related tools.
if (legacyShell) {
  const workspaceToggle = groupDockPanels("Workspace", "▤", "dn-workspace-toggle", [
    { selector: ".dn-folder-toggle", description: "Start a local session from a Dewlab folder." },
    { selector: ".dn-repo-toggle", description: "Start a repository session with module navigation and publishing." },
  ]);
  const reviewToggle = groupDockPanels("Review", "✓", "dn-review-toggle", [
    { selector: ".dn-outline-toggle", description: "Navigate the headings in the current document." },
    { selector: ".dn-linkcheck-toggle", description: "Check tutorial links against the open workspace." },
  ]);
  const rail = iconRail();
  rail.prepend(reviewToggle);
  rail.prepend(workspaceToggle);
  const sourceToggle = rail.querySelector(".dn-source-toggle");
  const settingsToggle = rail.querySelector(".dn-settings-toggle");
  if (sourceToggle) rail.appendChild(sourceToggle);
  if (settingsToggle) rail.appendChild(settingsToggle);
}
// Module organisation is entered from the active repository rather than
// presented as a third kind of workspace. The real toggle remains as the
// dock controller used by the repository's “Arrange” action.
const legacyModulesToggle = document.querySelector<HTMLButtonElement>(".dn-series-toggle");
if (legacyModulesToggle) {
  legacyModulesToggle.hidden = true;
  // It remains a private dock controller for “Arrange modules and
  // series”, but it is no longer a fifth rail item in the UI or the
  // accessibility tree.
  document.body.appendChild(legacyModulesToggle);
}

if (!legacyShell) {
  const clickToggle = (selector: string) => document.querySelector<HTMLButtonElement>(selector)?.click();
  workflow = mountWorkflowShell({
    chooseLocal: () => folderPanel?.choose() ?? Promise.resolve(false),
    chooseGithub: () => repoPanel?.showChooser(),
    saveCurrent: () => fileBar.saveCurrent(),
    saveNewVersion: () => repoPanel?.pushNewVersion() ?? Promise.resolve(false),
    canSaveNewVersion: () => repoPanel?.canPushNewVersion() ?? false,
    previewNewVersion: () => repoPanel?.previewNewVersion() ?? { error: "Open a live tutorial before creating a new version." },
    openPullRequest: () => repoPanel?.openPullRequest() ?? Promise.resolve(null),
    listRepositoryChanges: () => repoPanel?.listChanges() ?? Promise.resolve([]),
    toggleLocation: () => workspaceNav.toggle(),
    openLocation: () => workspaceNav.open(),
    closeLocation: () => workspaceNav.close(),
    locationIsOpen: () => workspaceNav.isOpen(),
    locationContains: (target) => workspaceNav.element.contains(target),
    closePanels: closeDockPanels,
    panelContains: activeDockContains,
    openRawFiles: () => session === "github" ? repoPanel?.showChooser() : clickToggle(".dn-folder-toggle"),
    openDocumentSource: () => clickToggle(".dn-source-toggle"),
    openOutline: () => clickToggle(".dn-outline-toggle"),
    openLinkCheck: () => clickToggle(".dn-linkcheck-toggle"),
    openModuleOrganizer: () => clickToggle(".dn-series-toggle"),
    openSettings: () => clickToggle(".dn-settings-toggle"),
    openDeviceFile: () => fileBar.openDeviceFile(),
    importNotebook: () => fileBar.importNotebook(),
    exportNotebook: () => fileBar.exportNotebook(),
    exportHtml: () => fileBar.exportHtml(),
    resetWorkspace: () => {
      // The shell has already handled unsaved-work confirmation. Reset
      // the stores and identities in place so changing source is a real
      // workflow transition, not a disguised page reload.
      closeDockPanels();
      setActiveStore(null);
      folderPanel?.reset();
      repoPanel?.reset();
      setFileIndex([]);
      seriesPanel.setModules([]);
      workspaceNav.setIndex([]);
      workspaceNav.setModules([]);
      workspaceNav.setCurrentPath(null);
      workspaceNav.close();
      current.destroy();
      current = mountDocument(page, STARTER_DOCUMENT);
      fileBar.reset();
      session = null;
      delete document.body.dataset["workspaceSession"];
      const folder = document.querySelector<HTMLButtonElement>(".dn-folder-toggle");
      const repository = document.querySelector<HTMLButtonElement>(".dn-repo-toggle");
      if (folder) {
        folder.disabled = folder.dataset["baseDisabled"] === "true";
        folder.title = folder.dataset["baseTitle"] ?? "Folder";
      }
      if (repository) {
        repository.disabled = false;
        repository.title = repository.dataset["baseTitle"] ?? "Repository";
      }
    },
  });
  if (latestFileState) workflow.setFileState(latestFileState);
}
mountCommandPalette();

// Playwright (tests/e2e/) drives this same built page directly rather than
// a second harness entry point, remounting whatever source a test needs
// through this. Nothing else in the app reads window.__dewnote.
interface DewnoteTestHook {
  mount(source: string): void;
  getSource(): string;
  setFileIndex(index: Parameters<typeof setFileIndex>[0]): void;
  setModules(modules: Parameters<typeof seriesPanel.setModules>[0]): void;
}
(window as unknown as { __dewnote: DewnoteTestHook }).__dewnote = {
  mount(source: string): void {
    current.destroy();
    current = mountDocument(page, source);
  },
  getSource(): string {
    return current.getSource();
  },
  setFileIndex,
  setModules: seriesPanel.setModules,
};
