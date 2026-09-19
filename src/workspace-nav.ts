import { openPath } from "./active-store.ts";
import { defaultEntryFor, type FileIndexEntry } from "./file-index.ts";
import type { Module, ModuleSeries } from "./modules.ts";

interface NavPage {
  path: string;
  label: string;
  id: string;
  practice: boolean;
}

function pagesFor(series: ModuleSeries, index: FileIndexEntry[]): NavPage[] {
  const pages: NavPage[] = [];
  for (const id of series.tutorials) {
    const tutorial = defaultEntryFor(index, id);
    if (tutorial) pages.push({ path: tutorial.path, label: tutorial.title ?? id, id, practice: false });
    for (const practice of index.filter((entry) => entry.practiceFor === id)) {
      pages.push({ path: practice.path, label: practice.title ?? practice.id ?? practice.path, id: practice.id ?? practice.path, practice: true });
    }
  }
  return pages;
}

function mixedPages(module: Module, index: FileIndexEntry[]): NavPage[] {
  return (module.mixed ?? []).flatMap((id) => {
    const entry = defaultEntryFor(index, id);
    return entry ? [{ path: entry.path, label: entry.title ?? id, id, practice: true }] : [];
  });
}

export interface WorkspaceLocation {
  module: string;
  series: string;
  page: string;
  available: boolean;
}

export interface WorkspaceNavOptions {
  /** In the progressive shell the same controls are a transient location
   * chooser. The default preserves the old persistent test harness and
   * embedders until they opt in. */
  progressive?: boolean;
  onLocationChange?(location: WorkspaceLocation): void;
  onNavigate?(): void;
}

/** Dewlab's “where you are” structure, expressed as three dependent
 * rungs: module → series → tutorial/practice. */
export function mountWorkspaceNav(options: WorkspaceNavOptions = {}) {
  let modules: Module[] = [];
  let index: FileIndexEntry[] = [];
  let currentPath: string | null = null;
  let chosenModule = "";
  let chosenSeries = "";
  let requestedOpen = !options.progressive;

  const nav = document.createElement("nav");
  nav.className = "dn-workspace-nav";
  nav.setAttribute("aria-label", "Where this document sits");
  nav.hidden = true;
  const heading = document.createElement("span");
  heading.className = "dn-workspace-nav-heading";
  heading.textContent = "Where you are";
  const moduleSelect = document.createElement("select");
  moduleSelect.className = "dn-workspace-nav-module";
  moduleSelect.setAttribute("aria-label", "Module");
  const seriesSelect = document.createElement("select");
  seriesSelect.className = "dn-workspace-nav-series";
  seriesSelect.setAttribute("aria-label", "Series");
  const pageSelect = document.createElement("select");
  pageSelect.className = "dn-workspace-nav-page";
  pageSelect.setAttribute("aria-label", "Tutorial or practice page");
  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "dn-workspace-nav-open";
  openButton.textContent = "Open document";
  nav.append(heading, moduleSelect, seriesSelect, pageSelect, openButton);
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
    // A tutorial may intentionally appear in more than one module. Keep
    // the module the reader navigated from when it still contains the
    // opened page; only fall back to the first membership when a file was
    // opened from somewhere with no module context (All files, for example).
    const chosen = modules.find((module) => module.id === chosenModule);
    if (chosen && moduleContains(chosen, id)) return chosen;
    return modules.find((module) => moduleContains(module, id));
  }

  function fillPages(module: Module, seriesKey: string): void {
    const series = module.contents.find((item) => item.title === seriesKey);
    const pages = series ? pagesFor(series, index) : mixedPages(module, index);
    pageSelect.replaceChildren();
    for (const page of pages) {
      const option = document.createElement("option");
      option.value = page.path;
      option.textContent = `${page.practice ? "Practice · " : ""}${page.label}`;
      option.selected = page.path === currentPath;
      pageSelect.appendChild(option);
    }
    pageSelect.disabled = pages.length === 0;
  }

  function render(): void {
    const available = modules.length > 0;
    nav.hidden = !available || !requestedOpen;
    if (!available) {
      options.onLocationChange?.({ module: "", series: "", page: "", available: false });
      return;
    }
    const currentModule = moduleForCurrent();
    if (!chosenModule || !modules.some((module) => module.id === chosenModule)) chosenModule = currentModule?.id ?? modules[0]!.id;
    if (currentModule && currentPath) chosenModule = currentModule.id;

    moduleSelect.replaceChildren();
    for (const module of modules) {
      const option = document.createElement("option");
      option.value = module.id;
      option.textContent = module.title;
      option.selected = module.id === chosenModule;
      moduleSelect.appendChild(option);
    }
    const module = modules.find((item) => item.id === chosenModule) ?? modules[0]!;
    const current = currentEntry();
    const ownerId = current?.practiceFor ?? current?.id;
    const currentSeries = module.contents.find((series) => series.tutorials.includes(ownerId ?? ""));
    if (!chosenSeries || (!module.contents.some((series) => series.title === chosenSeries) && chosenSeries !== "__mixed")) {
      chosenSeries = currentSeries?.title ?? module.contents[0]?.title ?? ((module.mixed?.length ?? 0) ? "__mixed" : "");
    }
    if (currentSeries && currentPath) chosenSeries = currentSeries.title;
    if (current && (module.mixed ?? []).includes(current.id ?? "")) chosenSeries = "__mixed";

    seriesSelect.replaceChildren();
    for (const series of module.contents) {
      const option = document.createElement("option");
      option.value = series.title;
      option.textContent = series.title;
      option.selected = series.title === chosenSeries;
      seriesSelect.appendChild(option);
    }
    if (module.mixed?.length) {
      const option = document.createElement("option");
      option.value = "__mixed";
      option.textContent = "Mixed practice";
      option.selected = chosenSeries === "__mixed";
      seriesSelect.appendChild(option);
    }
    seriesSelect.disabled = seriesSelect.options.length === 0;
    fillPages(module, chosenSeries);
    if (!currentPath) {
      options.onLocationChange?.({ module: "", series: "", page: "", available: true });
      return;
    }
    const actual = currentEntry();
    if (!currentModule) {
      options.onLocationChange?.({
        module: "",
        series: "",
        page: actual?.title ?? actual?.path ?? currentPath.split("/").at(-1) ?? currentPath,
        available: true,
      });
      return;
    }
    options.onLocationChange?.({
      module: currentModule.title,
      series: chosenSeries === "__mixed" ? "Mixed practice" : chosenSeries,
      page: actual?.title ?? actual?.path ?? currentPath,
      available: true,
    });
  }

  moduleSelect.addEventListener("change", () => {
    chosenModule = moduleSelect.value;
    chosenSeries = "";
    currentPath = null;
    render();
  });
  seriesSelect.addEventListener("change", () => {
    chosenSeries = seriesSelect.value;
    currentPath = null;
    render();
  });
  async function openSelected(): Promise<void> {
    if (!pageSelect.value) return;
    if (await openPath(pageSelect.value)) {
      if (options.progressive) requestedOpen = false;
      render();
      options.onNavigate?.();
    }
  }
  pageSelect.addEventListener("change", () => { void openSelected(); });
  openButton.addEventListener("click", () => { void openSelected(); });

  return {
    setModules(next: Module[]) { modules = next; render(); },
    setIndex(next: FileIndexEntry[]) { index = next; render(); },
    setCurrentPath(path: string | null) { currentPath = path; render(); },
    open() { requestedOpen = true; render(); },
    close() { requestedOpen = false; render(); },
    toggle() { requestedOpen = !requestedOpen; render(); },
    isOpen() { return !nav.hidden; },
    element: nav,
    destroy() { nav.remove(); },
  };
}
