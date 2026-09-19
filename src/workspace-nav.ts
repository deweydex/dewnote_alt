import { openPath } from "./active-store.ts";
import { defaultEntryFor, type FileIndexEntry } from "./file-index.ts";
import type { Module, ModuleSeries } from "./modules.ts";

interface NavPage {
  path: string;
  label: string;
  id: string;
  practice: boolean;
}

interface NavResult {
  module: Module;
  series: string;
  page: NavPage;
}

function readableId(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

function pagesFor(series: ModuleSeries, index: FileIndexEntry[]): NavPage[] {
  const pages: NavPage[] = [];
  for (const id of series.tutorials) {
    const tutorial = defaultEntryFor(index, id);
    if (tutorial) pages.push({ path: tutorial.path, label: tutorial.title ?? readableId(id), id, practice: false });
    for (const practice of index.filter((entry) => entry.practiceFor === id)) {
      const practiceId = practice.id ?? practice.path;
      pages.push({ path: practice.path, label: practice.title ?? readableId(practiceId), id: practiceId, practice: true });
    }
  }
  return pages;
}

function mixedPages(module: Module, index: FileIndexEntry[]): NavPage[] {
  return (module.mixed ?? []).flatMap((id) => {
    const entry = defaultEntryFor(index, id);
    return entry ? [{ path: entry.path, label: entry.title ?? readableId(id), id, practice: true }] : [];
  });
}

export interface WorkspaceLocation {
  module: string;
  series: string;
  page: string;
  available: boolean;
}

export interface WorkspaceNavOptions {
  progressive?: boolean;
  onLocationChange?(location: WorkspaceLocation): void;
  onNavigate?(): void;
}

/** A module-first document picker. Modules are the primary choice, series
 * provide readable groups, and search spans the entire curriculum without
 * exposing repository paths unless the user asks to browse all files. */
export function mountWorkspaceNav(options: WorkspaceNavOptions = {}) {
  let modules: Module[] = [];
  let index: FileIndexEntry[] = [];
  let currentPath: string | null = null;
  let currentModuleId = "";
  let chosenModule = "";
  let requestedOpen = !options.progressive;

  const nav = document.createElement("nav");
  nav.className = "dn-workspace-nav";
  nav.setAttribute("aria-label", "Choose a document");
  nav.hidden = true;

  const header = document.createElement("header");
  header.className = "dn-workspace-nav-header";
  const heading = document.createElement("strong");
  heading.className = "dn-workspace-nav-heading";
  heading.textContent = "Choose a document";
  const hint = document.createElement("span");
  hint.textContent = "Modules keep tutorials and practice in their intended order.";
  header.append(heading, hint);

  const search = document.createElement("input");
  search.type = "search";
  search.className = "dn-workspace-nav-search";
  search.placeholder = "Search titles, modules, or series…";
  search.setAttribute("aria-label", "Search documents");

  const moduleTabs = document.createElement("div");
  moduleTabs.className = "dn-workspace-nav-modules";
  moduleTabs.setAttribute("role", "tablist");
  moduleTabs.setAttribute("aria-label", "Modules");

  const results = document.createElement("div");
  results.className = "dn-workspace-nav-results";
  const empty = document.createElement("p");
  empty.className = "dn-workspace-nav-empty";
  empty.textContent = "No documents match that search.";

  nav.append(header, search, moduleTabs, results, empty);
  document.body.appendChild(nav);

  function currentEntry(): FileIndexEntry | undefined {
    return currentPath ? index.find((entry) => entry.path === currentPath) : undefined;
  }

  function moduleContains(module: Module, id: string): boolean {
    return module.contents.some((series) => series.tutorials.includes(id)) || (module.mixed ?? []).includes(id);
  }

  function moduleForCurrent(): Module | undefined {
    const entry = currentEntry();
    const id = entry?.practiceFor ?? entry?.id;
    if (!id) return undefined;
    const remembered = modules.find((module) => module.id === currentModuleId);
    if (remembered && moduleContains(remembered, id)) return remembered;
    return modules.find((module) => moduleContains(module, id));
  }

  function allResults(): NavResult[] {
    return modules.flatMap((module) => [
      ...module.contents.flatMap((series) => pagesFor(series, index).map((page) => ({ module, series: series.title, page }))),
      ...mixedPages(module, index).map((page) => ({ module, series: "Mixed practice", page })),
    ]);
  }

  async function openPage(result: NavResult): Promise<void> {
    if (await openPath(result.page.path)) {
      chosenModule = result.module.id;
      currentModuleId = result.module.id;
      currentPath = result.page.path;
      if (options.progressive) requestedOpen = false;
      render();
      options.onNavigate?.();
    }
  }

  function pageButton(result: NavResult, showContext: boolean): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dn-workspace-nav-document";
    button.classList.toggle("is-current", result.page.path === currentPath);
    if (result.page.path === currentPath) button.setAttribute("aria-current", "page");
    const title = document.createElement("span");
    title.textContent = result.page.label;
    const meta = document.createElement("small");
    const context = showContext ? `${result.module.title} · ${result.series}` : result.series;
    meta.textContent = `${result.page.practice ? "Practice · " : "Tutorial · "}${context}`;
    button.append(title, meta);
    button.addEventListener("click", () => { void openPage(result); });
    return button;
  }

  function renderLocation(): void {
    if (!currentPath) {
      options.onLocationChange?.({ module: "", series: "", page: "", available: modules.length > 0 });
      return;
    }
    const entry = currentEntry();
    const module = moduleForCurrent();
    if (!module) {
      options.onLocationChange?.({
        module: "",
        series: "",
        page: entry?.title ?? entry?.path ?? currentPath.split("/").at(-1) ?? currentPath,
        available: modules.length > 0,
      });
      return;
    }
    const ownerId = entry?.practiceFor ?? entry?.id ?? "";
    const series = module.contents.find((candidate) => candidate.tutorials.includes(ownerId));
    options.onLocationChange?.({
      module: module.title,
      series: series?.title ?? ((module.mixed ?? []).includes(ownerId) ? "Mixed practice" : ""),
      page: entry?.title ?? entry?.path ?? currentPath,
      available: true,
    });
  }

  function render(): void {
    const available = modules.length > 0;
    nav.hidden = !available || !requestedOpen;
    renderLocation();
    if (!available) return;

    const currentModule = moduleForCurrent();
    if (!chosenModule || !modules.some((module) => module.id === chosenModule)) {
      chosenModule = currentModule?.id ?? modules[0]!.id;
    }

    moduleTabs.replaceChildren(...modules.map((module) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "dn-workspace-nav-module";
      tab.textContent = module.title;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(module.id === chosenModule));
      tab.classList.toggle("is-active", module.id === chosenModule);
      tab.addEventListener("click", () => {
        chosenModule = module.id;
        search.value = "";
        render();
      });
      return tab;
    }));

    const query = search.value.trim().toLocaleLowerCase();
    const matches = allResults().filter((result) => !query || [
      result.page.label,
      result.page.path,
      result.module.title,
      result.series,
    ].some((value) => value.toLocaleLowerCase().includes(query)));

    const sections: HTMLElement[] = [];
    if (query) {
      if (matches.length > 0) {
        const list = document.createElement("div");
        list.className = "dn-workspace-nav-document-list";
        list.append(...matches.map((result) => pageButton(result, true)));
        sections.push(list);
      }
    } else {
      const selected = modules.find((module) => module.id === chosenModule) ?? modules[0]!;
      for (const series of selected.contents) {
        const pages = pagesFor(series, index);
        if (pages.length === 0) continue;
        const section = document.createElement("section");
        section.className = "dn-workspace-nav-series";
        const title = document.createElement("h2");
        title.textContent = series.title;
        const list = document.createElement("div");
        list.className = "dn-workspace-nav-document-list";
        list.append(...pages.map((page) => pageButton({ module: selected, series: series.title, page }, false)));
        section.append(title, list);
        sections.push(section);
      }
      const mixed = mixedPages(selected, index);
      if (mixed.length) {
        const section = document.createElement("section");
        section.className = "dn-workspace-nav-series";
        const title = document.createElement("h2");
        title.textContent = "Mixed practice";
        const list = document.createElement("div");
        list.className = "dn-workspace-nav-document-list";
        list.append(...mixed.map((page) => pageButton({ module: selected, series: "Mixed practice", page }, false)));
        section.append(title, list);
        sections.push(section);
      }
    }
    results.replaceChildren(...sections);
    empty.hidden = sections.length > 0;
  }

  search.addEventListener("input", render);

  return {
    setModules(next: Module[]) { modules = next; render(); },
    setIndex(next: FileIndexEntry[]) { index = next; render(); },
    setCurrentPath(path: string | null) {
      currentPath = path;
      if (!moduleForCurrent()) currentModuleId = "";
      render();
    },
    open() {
      requestedOpen = true;
      render();
      queueMicrotask(() => search.focus());
    },
    close() { requestedOpen = false; render(); },
    toggle() {
      requestedOpen = !requestedOpen;
      render();
      if (requestedOpen) queueMicrotask(() => search.focus());
    },
    isOpen() { return !nav.hidden; },
    element: nav,
    destroy() { nav.remove(); },
  };
}
