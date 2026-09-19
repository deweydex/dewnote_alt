// The placement view: which module lists a tutorial, in which series,
// in what order — read from dewlab's own `modules/*.yaml` (modules.ts).
//
// This used to read one `<series>.order.yaml` per series and group them
// by the module folder they sat in. dewlab moved placement into module
// files, so the grouping is now the real one: a module, its series in
// the order the module file lists them, and each series' tutorials in
// the order it lists those. Nothing is sorted here any more — an order
// file's own order was the point before and a module file's is now, and
// sorting series alphabetically (as this did) was only ever standing in
// for an order the old format didn't record.
//
// Kept from before: mounted the same independent way outline-panel.ts
// is, a toggle and a docked rail, closed until asked; fed a whole list
// via `setModules` rather than pulling from the open document, since
// placement is a property of the open folder or repository and not of
// whichever tutorial happens to be on screen; and each listed tutorial
// is a real button that opens it through active-store.ts's own hook,
// falling back to plain text for an id with no file behind it.
//
// `defaultEntryFor` still picks which file an id means, because an id
// can still be several files: a frozen release `v<version>.md` carries
// the id of the folder it sits in, the same as the live tutorial beside
// it (build.py's own `id_of`). Picking whichever was indexed first would
// show a frozen release's title as often as the real one.
//
// ## Two things this can now say that the old panel could not
//
// A module file naming an id, and a `tutorials/<id>/` folder, are two
// halves that can disagree. So the panel reports both halves of that:
// an id a module lists with nothing indexed for it, and an indexed
// tutorial no module lists. dewlab builds the second happily — "published
// but on no module" is a real state — so it reads as a list to place
// rather than as an error.
//
// ## Editing, and why it reads the file again first
//
// A tutorial can be dragged within its series, dragged into a sibling
// series on the same module, added to a series, or taken off the module
// — all four are one splice of the lines that series' `tutorials:` list
// occupies (module-writer.ts). Every one of them re-reads the module
// file and re-parses it immediately before writing, rather than writing
// against the copy parsed when the folder was last scanned. Two reasons,
// and the first is the serious one: modules.ts's line ranges are only
// true of the exact text they were read from, so splicing a stale range
// into a file somebody edited in the meantime would write over whatever
// had moved into those lines. The second is that it makes a second drag
// build on the first one's result rather than on the state before it.
//
// Positions survive that re-read by name, not by number: a tutorial is
// found again by its id and a series by its title, both of which dewlab
// requires to be unique within a module. A drag whose tutorial is no
// longer where it was refuses and says so instead of moving whatever
// took its place.
//
// ## What it will not do
//
// **Delete a tutorial.** "Remove" here takes a tutorial off a module.
// The file stays, and a tutorial on no module still builds. The id is
// the address of the page and the key a reader's saved work lives under,
// so throwing the file away is a much heavier act than taking it out of
// a reading order, and it is not one to offer behind the same small ×.
//
// Creating, renaming and reordering series all preserve the module file's
// untouched text. The module heading opens the descriptor itself for the
// remaining metadata (code, status, card and description), while the
// module arrows rewrite only `modules/index.yaml`.

import { canWriteFiles, createFile, openPath, readTextFile, writeTextFile } from "./active-store.ts";
import { parseModuleFile, type Module, type ModuleSeries } from "./modules.ts";
import { addSeries, addTutorial, findSeries, locateTutorial, moveSeries, moveTutorial, renameSeries, removeTutorial, idsListedBy, type WriteResult } from "./module-writer.ts";
import { defaultEntryFor, type FileIndexEntry } from "./file-index.ts";
import { dockPanel, iconRail, labelToggle } from "./icon-rail.ts";

/** What a drag carries: enough to find the tutorial again in a file
 * re-read since the drag started. Serialised through the one
 * `text/plain` slot HTML drag and drop reliably gives, the same as
 * app.ts's own block drag. */
interface DragPayload {
  modulePath: string;
  seriesTitle: string;
  id: string;
}

export interface SeriesPanel {
  /** Replaces the whole listing — called every time folder-panel.ts or
   * repo-panel.ts (re)reads the open store's module files, the same
   * "handed the whole thing every time" shape app.ts's setFileIndex
   * already has. */
  setModules(modules: Module[]): void;
  destroy(): void;
}

/** Every indexed tutorial that no module lists, one entry per id (the
 * one `defaultEntryFor` would pick), in path order.
 *
 * Only meaningful once module files have actually been read: an entry
 * whose `modules` is undefined was never cross-referenced, which is not
 * the same as being on no module, and counting those would report every
 * tutorial the moment a folder without a `modules/` directory is open.
 *
 * Exported for its own unit test — the rendering around it is covered
 * against the built app in tests/e2e/series-panel.spec.ts, the same
 * split outline-panel.ts uses, but the rule itself is worth checking
 * directly rather than only through a browser. */
export function tutorialsOnNoModule(index: FileIndexEntry[]): FileIndexEntry[] {
  const seen = new Set<string>();
  const out: FileIndexEntry[] = [];
  for (const entry of index) {
    if (!entry.id || entry.modules === undefined || entry.modules.length > 0) continue;
    if (!entry.path.includes("tutorials/")) continue;
    // Practice pages follow their owning tutorial, or a module's `mixed:`
    // list. They are never loose tutorials to place independently.
    if (entry.practiceFor || entry.practiceAcross?.length) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const best = defaultEntryFor(index, entry.id);
    if (best) out.push(best);
  }
  return out;
}

/** Mounted once, independently of any particular document or store.
 * `getFileIndex` is read fresh on every render, not cached at mount
 * time, so a module rendered before a folder's index finishes building
 * still gets titles once it catches up. */
export function mountSeriesPanel(getFileIndex: () => FileIndexEntry[]): SeriesPanel {
  let modules: Module[] = [];

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "dn-series-toggle";
  toggle.setAttribute("aria-label", "Modules");
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = "Modules";
  toggle.textContent = "☰";

  const panel = document.createElement("div");
  panel.className = "dn-series-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", "Modules");
  panel.hidden = true;
  toggle.setAttribute("aria-controls", (panel.id = "dn-series-panel"));

  const header = document.createElement("div");
  header.className = "dn-series-header";
  const heading = document.createElement("h2");
  heading.textContent = "Modules";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "dn-series-close";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", () => {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  });
  header.append(heading, closeButton);
  panel.appendChild(header);

  const body = document.createElement("div");
  panel.appendChild(body);

  const empty = document.createElement("p");
  empty.className = "dn-series-empty";
  empty.textContent = "No module files found — open a Dewlab folder or repository containing its module descriptors.";
  panel.appendChild(empty);

  /** What the last edit did, or why it didn't happen. One line for the
   * whole panel rather than one per series: only one edit is ever in
   * flight, and a message that stays where the reader's eye already is
   * beats one that appears wherever they happened to drop something. */
  const status = document.createElement("p");
  status.className = "dn-series-status";
  status.setAttribute("role", "status");
  panel.appendChild(status);

  /** Which series, if any, has its "add a tutorial" list open —
   * identified by module path and series title rather than by position,
   * so a re-render after a write reopens the same one. */
  let adding: { modulePath: string; seriesTitle: string } | null = null;
  /** Which module, if any, has its "New series" form open. */
  let addingSeriesTo: string | null = null;
  let writing = false;

  function say(message: string): void {
    status.textContent = message;
  }

  /**
   * Re-reads the module file, applies `edit` to what it actually says
   * right now, and writes the result back.
   *
   * `edit` is handed the freshly parsed module, never the one the panel
   * rendered from, which is what makes every caller here look up its
   * tutorial by id and its series by title rather than by the index it
   * drew. `describe` runs only on a write that happened.
   */
  async function applyEdit(module: Module, message: string, edit: (fresh: Module, content: string) => WriteResult, describe: (fresh: Module) => string): Promise<void> {
    if (writing) return;
    writing = true;
    try {
      const content = await readTextFile(module.path);
      const fresh = parseModuleFile(module.path, content);
      if (!fresh) {
        say(`${module.path} isn't readable as a module file any more — nothing was changed.`);
        return;
      }
      const result = edit(fresh, content);
      if (!result.ok) {
        say(result.reason);
        return;
      }
      await writeTextFile(module.path, result.content, message);
      // Re-parse what was written and swap it in, rather than waiting
      // for the store to hand the whole list back: a folder refreshes
      // itself after a write and a repository does not, and either way
      // the next drag needs line ranges that match the file on disk now.
      const after = parseModuleFile(module.path, result.content);
      if (after) modules = modules.map((one) => (one.path === module.path ? after : one));
      render();
      say(describe(after ?? fresh));
    } catch (err) {
      say(err instanceof Error ? err.message : String(err));
    } finally {
      writing = false;
    }
  }

  function titleOf(id: string): string {
    return defaultEntryFor(getFileIndex(), id)?.title ?? id;
  }

  /** The insert position a drop at `clientY` means, as an index into the
   * list as it is drawn: the first item whose middle is below the
   * pointer, or the end. Measured rather than tracked through dragenter
   * on each row, so an empty list and the gap under the last row both
   * work without a row to have entered. */
  function dropIndexFor(list: HTMLOListElement, clientY: number): number {
    const rows = [...list.querySelectorAll<HTMLLIElement>("li")];
    for (const [at, row] of rows.entries()) {
      const box = row.getBoundingClientRect();
      if (clientY < box.top + box.height / 2) return at;
    }
    return rows.length;
  }

  function onDrop(module: Module, series: ModuleSeries, list: HTMLOListElement, event: DragEvent): void {
    event.preventDefault();
    const raw = event.dataTransfer?.getData("text/plain");
    if (!raw) return;
    let payload: DragPayload;
    try {
      payload = JSON.parse(raw) as DragPayload;
    } catch {
      return;
    }
    // Across two modules a move would be two files, and the second one
    // could fail after the first had already been written. Refused
    // rather than half-done; a tutorial can be taken off one module and
    // added to the other, which is two deliberate acts.
    if (payload.modulePath !== module.path) {
      say("A tutorial can only be dragged within one module — take it off one and add it to the other.");
      return;
    }
    const visualIndex = dropIndexFor(list, event.clientY);
    const targetTitle = series.title;
    void applyEdit(
      module,
      `Move ${payload.id} in ${module.title} from dewnote`,
      (fresh, content) => {
        const from = locateTutorial(fresh, payload.id);
        if (!from) return { ok: false, reason: `${payload.id} isn't on ${fresh.title} any more — nothing was moved.` };
        const to = findSeries(fresh, targetTitle);
        if (to === -1) return { ok: false, reason: `"${targetTitle}" isn't on ${fresh.title} any more — nothing was moved.` };
        // The drawn index counts the dragged row itself; the writer's
        // does not, since it reads its index against the list with the
        // tutorial already taken out.
        const index = from.series === to && from.index < visualIndex ? visualIndex - 1 : visualIndex;
        return moveTutorial(fresh, content, from, { series: to, index });
      },
      (fresh) => `Moved ${titleOf(payload.id)} into "${targetTitle}" on ${fresh.title}.`,
    );
  }

  function renderSeriesList(module: Module, series: ModuleSeries, writable: boolean): HTMLOListElement {
    const index = getFileIndex();
    const list = document.createElement("ol");
    list.className = "dn-series-list";
    list.dataset["series"] = series.title;

    for (const id of series.tutorials) {
      const entry = defaultEntryFor(index, id);
      const item = document.createElement("li");
      item.className = "dn-series-item";
      item.dataset["id"] = id;

      if (writable) {
        // The grip is the draggable element, not the row: a row here is
        // a button that opens a tutorial, and making the whole row
        // draggable turns every mis-aimed click into the start of a
        // drag. app.ts arms a block first for the same reason — a
        // document block has text to select — but a one-line row needs
        // only a handle to take hold of, not a mode to enter.
        const grip = document.createElement("span");
        grip.className = "dn-series-grip";
        grip.draggable = true;
        grip.title = `Drag to move ${entry?.title ?? id}`;
        grip.textContent = "⠿";
        grip.addEventListener("dragstart", (event) => {
          const payload: DragPayload = { modulePath: module.path, seriesTitle: series.title, id };
          event.dataTransfer?.setData("text/plain", JSON.stringify(payload));
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          item.classList.add("dn-series-dragging");
        });
        grip.addEventListener("dragend", () => item.classList.remove("dn-series-dragging"));
        item.appendChild(grip);
      }

      if (entry) {
        const link = document.createElement("button");
        link.type = "button";
        link.className = "dn-series-link";
        link.textContent = entry.title ?? id;
        link.addEventListener("click", () => void openPath(entry.path));
        item.appendChild(link);
      } else {
        // A module listing an id with no file behind it — dewlab's own
        // build stops on this, so it's worth naming rather than showing
        // as a bare id that looks like any other line.
        const missing = document.createElement("span");
        missing.className = "dn-series-missing";
        missing.textContent = `${id} — no file`;
        item.appendChild(missing);
      }

      if (writable) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "dn-series-remove";
        // "Take off", not "Delete": this unlists a tutorial and the file
        // stays. The label is the whole difference between the two, so
        // it says which one this is rather than leaving a bare ×.
        remove.setAttribute("aria-label", `Take ${entry?.title ?? id} off ${module.title}`);
        remove.title = `Take off ${module.title} — the tutorial itself is kept`;
        remove.textContent = "×";
        remove.addEventListener("click", () => {
          void applyEdit(
            module,
            `Take ${id} off ${module.title} from dewnote`,
            (fresh, content) => {
              const at = findSeries(fresh, series.title);
              if (at === -1) return { ok: false, reason: `"${series.title}" isn't on ${fresh.title} any more — nothing was changed.` };
              return removeTutorial(fresh, content, at, id);
            },
            (fresh) => `Took ${titleOf(id)} off ${fresh.title}. The tutorial itself is still there, on no module.`,
          );
        });
        item.appendChild(remove);
      }

      list.appendChild(item);
    }

    if (writable) {
      // The whole list is the drop target, not each row: that is what
      // makes dropping under the last row, and dropping into a series
      // with nothing in it yet, work without a row to aim at.
      list.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        list.classList.add("dn-series-list-over");
      });
      list.addEventListener("dragleave", () => list.classList.remove("dn-series-list-over"));
      list.addEventListener("drop", (event) => {
        list.classList.remove("dn-series-list-over");
        onDrop(module, series, list, event);
      });
    }

    return list;
  }

  /** The "add a tutorial" row under one series: everything indexed that
   * this module doesn't already list, filtered as you type. Only what
   * the module doesn't list, because dewlab fails the build on a module
   * that lists a tutorial twice — offering one would be offering a file
   * that stops building. */
  function renderAddRow(module: Module, series: ModuleSeries): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "dn-series-add";

    const open = adding?.modulePath === module.path && adding.seriesTitle === series.title;
    const toggleAdd = document.createElement("button");
    toggleAdd.type = "button";
    toggleAdd.className = "dn-series-add-toggle";
    toggleAdd.textContent = open ? "Cancel" : "Add a tutorial";
    toggleAdd.addEventListener("click", () => {
      adding = open ? null : { modulePath: module.path, seriesTitle: series.title };
      addingSeriesTo = null;
      render();
    });
    wrap.appendChild(toggleAdd);
    if (!open) return wrap;

    const listed = idsListedBy(module);
    const candidates = getFileIndex().filter((entry) => entry.id && entry.path.includes("tutorials/") && !listed.has(entry.id));
    const seen = new Set<string>();
    const unique = candidates.filter((entry) => (seen.has(entry.id!) ? false : (seen.add(entry.id!), true)));

    const search = document.createElement("input");
    search.type = "text";
    search.className = "dn-series-add-search";
    search.placeholder = "Search tutorials not on this module…";
    wrap.appendChild(search);

    const results = document.createElement("ul");
    results.className = "dn-series-add-list";
    wrap.appendChild(results);

    function renderResults() {
      const query = search.value.trim().toLowerCase();
      results.replaceChildren();
      const matches = unique.filter((entry) => `${entry.title ?? ""} ${entry.path}`.toLowerCase().includes(query));
      if (matches.length === 0) {
        const none = document.createElement("li");
        none.className = "dn-series-add-empty";
        none.textContent = unique.length === 0 ? "Every indexed tutorial is already on this module." : "No matches.";
        results.appendChild(none);
        return;
      }
      for (const entry of matches.slice(0, 50)) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "dn-series-add-item";
        button.textContent = entry.title ?? entry.id!;
        button.addEventListener("click", () => {
          adding = null;
          void applyEdit(
            module,
            `List ${entry.id} on ${module.title} from dewnote`,
            (fresh, content) => {
              const at = findSeries(fresh, series.title);
              if (at === -1) return { ok: false, reason: `"${series.title}" isn't on ${fresh.title} any more — nothing was added.` };
              return addTutorial(fresh, content, at, entry.id!);
            },
            (fresh) => `Added ${entry.title ?? entry.id} to "${series.title}" on ${fresh.title}.`,
          );
        });
        item.appendChild(button);
        results.appendChild(item);
      }
    }
    search.addEventListener("input", renderResults);
    renderResults();
    queueMicrotask(() => search.focus());
    return wrap;
  }

  /** "New series" at the foot of a module. Appends to the end of its
   * `contents:`, which is where a new one belongs: a module's series are
   * a reading order, and the next thing to teach goes after the last
   * thing taught. Same shape as the per-series "Add a tutorial" row
   * above it, so the rail has one way of adding things rather than two.
   *
   * Only for a module whose `contents:` block modules.ts could bound. A
   * module it could not is still read, opened and shown; it just isn't
   * written. */
  function renderNewSeriesRow(module: Module): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "dn-series-add dn-series-new";

    const open = addingSeriesTo === module.path;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "dn-series-add-toggle";
    toggle.textContent = open ? "Cancel" : "New series";
    toggle.addEventListener("click", () => {
      addingSeriesTo = open ? null : module.path;
      adding = null;
      render();
    });
    wrap.appendChild(toggle);
    if (!open) return wrap;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "dn-series-add-search dn-series-new-title";
    input.placeholder = "Series title";
    wrap.appendChild(input);

    const create = document.createElement("button");
    create.type = "button";
    create.className = "dn-series-add-item dn-series-new-create";
    create.textContent = "Create";
    function submit() {
      const title = input.value;
      addingSeriesTo = null;
      void applyEdit(
        module,
        `Add the series "${title.trim()}" to ${module.title} from dewnote`,
        (fresh, content) => addSeries(fresh, content, title),
        (fresh) => `Added "${title.trim()}" to ${fresh.title}. It has no tutorials yet — drop one in, or use its own "Add a tutorial".`,
      );
    }
    create.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
    wrap.appendChild(create);
    queueMicrotask(() => input.focus());
    return wrap;
  }

  async function moveModule(from: number, to: number): Promise<void> {
    if (writing || to < 0 || to >= modules.length) return;
    writing = true;
    try {
      const next = [...modules];
      const [moved] = next.splice(from, 1);
      if (!moved) return;
      next.splice(to, 0, moved);
      const slash = moved.path.lastIndexOf("/");
      const indexPath = `${slash === -1 ? "modules" : moved.path.slice(0, slash)}/index.yaml`;
      const content = `order:\n${next.map((entry) => `  - ${entry.id}`).join("\n")}\n`;
      try {
        await readTextFile(indexPath);
        await writeTextFile(indexPath, content, "Reorder modules from dewnote");
      } catch {
        await createFile(indexPath, content);
      }
      modules = next;
      render();
      say(`Moved ${moved.title} ${to < from ? "up" : "down"}.`);
    } catch (err) {
      say(err instanceof Error ? err.message : String(err));
    } finally {
      writing = false;
    }
  }

  function render() {
    const writable = canWriteFiles();
    body.replaceChildren();
    empty.hidden = modules.length > 0;

    for (const [moduleIndex, module] of modules.entries()) {
      const section = document.createElement("section");
      section.className = "dn-series-module";
      const moduleHeader = document.createElement("div");
      moduleHeader.className = "dn-series-module-header";
      const moduleHeading = document.createElement("button");
      moduleHeading.type = "button";
      moduleHeading.className = "dn-series-module-title";
      moduleHeading.textContent = module.title;
      moduleHeading.title = `Open ${module.path} to edit its details`;
      moduleHeading.addEventListener("click", () => void openPath(module.path));
      moduleHeader.appendChild(moduleHeading);
      if (writable) {
        for (const [label, offset] of [["Move module up", -1], ["Move module down", 1]] as const) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "dn-series-order";
          button.textContent = offset < 0 ? "↑" : "↓";
          button.setAttribute("aria-label", `${label}: ${module.title}`);
          button.disabled = moduleIndex + offset < 0 || moduleIndex + offset >= modules.length;
          button.addEventListener("click", () => void moveModule(moduleIndex, moduleIndex + offset));
          moduleHeader.appendChild(button);
        }
      }
      section.appendChild(moduleHeader);

      for (const [seriesIndex, series] of module.contents.entries()) {
        const seriesBlock = document.createElement("div");
        seriesBlock.className = "dn-series-block";
        const seriesHeader = document.createElement("div");
        seriesHeader.className = "dn-series-series-header";
        const seriesHeading = document.createElement("button");
        seriesHeading.type = "button";
        seriesHeading.className = "dn-series-series-title";
        seriesHeading.textContent = series.title;
        seriesHeading.title = "Rename series";
        seriesHeading.addEventListener("click", () => {
          const next = prompt("Series title", series.title);
          if (next === null || next.trim() === series.title) return;
          void applyEdit(
            module,
            `Rename ${series.title} in ${module.title} from dewnote`,
            (fresh, content) => {
              const at = findSeries(fresh, series.title);
              return at === -1
                ? { ok: false, reason: "That series is no longer in the module — reopen it." }
                : renameSeries(fresh, content, at, next);
            },
            () => `Renamed “${series.title}” to “${next.trim()}”.`,
          );
        });
        seriesHeader.appendChild(seriesHeading);
        if (writable && series.entryRange) {
          for (const [label, offset] of [["Move series up", -1], ["Move series down", 1]] as const) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "dn-series-order";
            button.textContent = offset < 0 ? "↑" : "↓";
            button.setAttribute("aria-label", `${label}: ${series.title}`);
            button.disabled = seriesIndex + offset < 0 || seriesIndex + offset >= module.contents.length;
            button.addEventListener("click", () => void applyEdit(
              module,
              `Move ${series.title} in ${module.title} from dewnote`,
              (fresh, content) => {
                const at = findSeries(fresh, series.title);
                return at === -1
                  ? { ok: false, reason: "That series is no longer in the module — reopen it." }
                  : moveSeries(fresh, content, at, at + offset);
              },
              () => `Moved “${series.title}” ${offset < 0 ? "up" : "down"}.`,
            ));
            seriesHeader.appendChild(button);
          }
        }
        seriesBlock.appendChild(seriesHeader);
        // A series modules.ts couldn't record a range for reads and
        // opens like any other; it just can't be written. Said once,
        // here, rather than by silently leaving the controls off.
        const editable = writable && series.tutorialsRange !== null;
        seriesBlock.appendChild(renderSeriesList(module, series, editable));
        if (writable && !editable) {
          const note = document.createElement("p");
          note.className = "dn-series-readonly";
          note.textContent = "Written in a form dewnote can't rewrite safely — edit the module file directly.";
          seriesBlock.appendChild(note);
        }
        if (editable) seriesBlock.appendChild(renderAddRow(module, series));
        section.appendChild(seriesBlock);
      }
      if (writable && module.contentsRange) section.appendChild(renderNewSeriesRow(module));
      body.appendChild(section);
    }

    const loose = tutorialsOnNoModule(getFileIndex());
    if (loose.length > 0) {
      const section = document.createElement("section");
      section.className = "dn-series-module dn-series-unlisted";
      const looseHeading = document.createElement("h3");
      looseHeading.textContent = "On no module";
      section.appendChild(looseHeading);

      const list = document.createElement("ol");
      list.className = "dn-series-list";
      for (const entry of loose) {
        const item = document.createElement("li");
        item.className = "dn-series-item";
        const link = document.createElement("button");
        link.type = "button";
        link.className = "dn-series-link";
        link.textContent = entry.title ?? entry.id ?? entry.path;
        link.addEventListener("click", () => void openPath(entry.path));
        item.appendChild(link);
        list.appendChild(item);
      }
      section.appendChild(list);
      body.appendChild(section);
    }
  }

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) render();
  });

  labelToggle(toggle, "Modules");
  iconRail().appendChild(toggle);
  document.body.appendChild(panel);
  dockPanel(toggle, panel);

  return {
    setModules(next) {
      modules = next;
      if (!panel.hidden) render();
    },
    destroy() {
      toggle.remove();
      panel.remove();
    },
  };
}
