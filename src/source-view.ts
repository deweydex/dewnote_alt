// Step 6 step 2's own "the whole-file source view (Cmd+/)" — named as
// still open there since this section was first drafted, now built.
// Every block already edits as raw markdown on focus (decision 2); this
// is the same idea at the scale of the whole document, for the times an
// edit spans more than one block at once — reordering a run of
// paragraphs, fixing front matter and a fence header together — rather
// than one block's own click-to-edit.
//
// Mounted the same independent way every other panel is, on the same
// {getSource, loadDocument} host repo-panel.ts and dialect-panel.ts
// already take: opening this view is "read the current source," closing
// it after an edit is "load a new source into the current document" —
// blocks.ts's own round-trip guarantee is what makes reparsing the
// whole thing back in on close safe, the same guarantee every other
// commit in app.ts already leans on.
//
// A full-screen overlay, like command-palette.ts's own, not a docked
// side rail like outline-panel.ts's or dialect-panel.ts's — those stay
// open *alongside* the still-editable document underneath, which is
// fine for a read-only outline or a one-shot convert; this view is a
// second, complete editing surface over the very same content, and
// letting both it and the block surface accept edits at once would mean
// whichever closes last silently wins. Taking over the screen while
// open removes the ambiguity rather than trying to reconcile it.
//
// Applies its edit on close, not on every keystroke: reparsing the
// whole document as the reader types would tear this very editor down
// mid-edit, the same reason app.ts's own per-block commit only ever
// fires on blur, applied here to the one block that happens to be the
// entire file.

import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sourceLanguageExtension } from "./lang.ts";
import { dockPanel, iconRail, labelToggle } from "./icon-rail.ts";

export interface SourceViewHost {
  getSource(): string;
  loadDocument(source: string, name: string): void;
}

export interface SourceViewPanel {
  destroy(): void;
}

/** Mounted once, independently of any particular document. */
export function mountSourceView(host: SourceViewHost): SourceViewPanel {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "dn-source-toggle";
  toggle.setAttribute("aria-label", "Whole-file source");
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = "Whole-file source";
  toggle.textContent = "</>";

  const overlay = document.createElement("div");
  overlay.className = "dn-source-overlay";
  overlay.hidden = true;

  const box = document.createElement("div");
  box.className = "dn-source-box";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "Whole-file source");
  overlay.appendChild(box);
  toggle.setAttribute("aria-controls", (box.id = "dn-source-box"));

  const header = document.createElement("div");
  header.className = "dn-source-header";
  const heading = document.createElement("h2");
  heading.textContent = "Source";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "dn-source-close";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.textContent = "×";
  header.append(heading, closeButton);
  box.appendChild(header);

  const editorHost = document.createElement("div");
  editorHost.className = "dn-source-editor";
  box.appendChild(editorHost);

  let view: EditorView | null = null;

  /** Reads the editor's current text back into the mounted document —
   * the same "reparse the whole thing" path every structural edit in
   * app.ts already takes, since this view can touch anything from one
   * character to every block at once. */
  function commit() {
    if (view) {
      host.loadDocument(view.state.doc.toString(), "source.md");
      view.destroy();
      view = null;
    }
  }

  function open() {
    editorHost.replaceChildren();
    view = new EditorView({
      state: EditorState.create({
        doc: host.getSource(),
        extensions: [history(), keymap.of([...defaultKeymap, ...historyKeymap]), sourceLanguageExtension(), EditorView.lineWrapping],
      }),
      parent: editorHost,
    });
    queueMicrotask(() => view?.focus());
  }

  function onGlobalKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === "/") {
      event.preventDefault();
      if (overlay.hidden) toggle.click();
      else closeButton.click();
    } else if (event.key === "Escape" && !overlay.hidden) {
      closeButton.click();
    }
  }
  document.addEventListener("keydown", onGlobalKeydown);

  labelToggle(toggle, "Source");
  iconRail().appendChild(toggle);
  document.body.appendChild(overlay);
  dockPanel(toggle, overlay, false, { onActivate: open, onDeactivate: commit });

  return {
    destroy() {
      document.removeEventListener("keydown", onGlobalKeydown);
      view?.destroy();
      toggle.remove();
      overlay.remove();
    },
  };
}
