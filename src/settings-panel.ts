// The settings panel — decision 7's "every one of those values is a user
// setting" made into an actual UI, closed until asked (plan §3's third
// rule already names "front matter forms" and rails as things that
// "appear on hover, on focus, or on one keystroke, and go away again";
// a settings panel is exactly that same kind of thing). One toggle
// button, always visible but quiet; the panel itself is a real dialog,
// not a hover reveal, since a reader adjusting several settings in a row
// needs it to stay open between changes.
//
// Mounted once, independently of any particular document — settings are
// a page-wide, not a per-document, concept, so this has nothing to do
// with mountDocument's own lifecycle in app.ts.

import {
  applySettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from "./settings.ts";
import { restartInterpreter, setPyodideBase } from "./runtime/pyodide-engine.ts";
import { dockPanel, iconRail, labelToggle } from "./icon-rail.ts";

function row(labelText: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "dn-settings-row";
  const span = document.createElement("span");
  span.textContent = labelText;
  label.append(span, control);
  return label;
}

function select<T extends string>(options: { value: T; label: string }[], current: T): HTMLSelectElement {
  const el = document.createElement("select");
  for (const { value, label } of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = value === current;
    el.appendChild(option);
  }
  return el;
}

function range(min: number, max: number, step: number, current: number): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "range";
  el.min = String(min);
  el.max = String(max);
  el.step = String(step);
  el.value = String(current);
  return el;
}

export interface SettingsPanel {
  destroy(): void;
}

/** Builds the toggle button and panel, applies whatever was saved before
 * this call (mirroring the `applySettings(loadSettings())` call main.ts
 * makes before first paint — that one avoids the flash; this one keeps
 * the panel's own controls in sync with it), and wires every control to
 * update, apply, and save on change. The toggle joins the shared icon
 * rail; the panel itself is appended to `document.body` directly rather
 * than `#dn-page`, since a document's own remount (main.ts's
 * `__dewnote.mount`) has no reason to tear this down too. */
export function mountSettingsPanel(): SettingsPanel {
  let settings = loadSettings();

  function commit(next: Settings) {
    settings = next;
    applySettings(settings);
    saveSettings(settings);
  }

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "dn-settings-toggle";
  toggle.setAttribute("aria-label", "Settings");
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = "Settings";
  toggle.textContent = "⚙";

  const panel = document.createElement("div");
  panel.className = "dn-settings-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", "Settings");
  panel.hidden = true;
  toggle.setAttribute("aria-controls", (panel.id = "dn-settings-panel"));

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
  });

  const header = document.createElement("div");
  header.className = "dn-settings-header";
  const heading = document.createElement("h2");
  heading.textContent = "Settings";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "dn-settings-close";
  closeButton.setAttribute("aria-label", "Close settings");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", () => {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  });
  header.append(heading, closeButton);
  panel.appendChild(header);

  // ---------------------------------------------------------- appearance
  const appearance = document.createElement("section");
  appearance.className = "dn-settings-section";
  const appearanceHeading = document.createElement("h3");
  appearanceHeading.textContent = "Appearance";
  appearance.appendChild(appearanceHeading);

  const themeSelect = select(
    [
      { value: "system", label: "Match system" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ] as const,
    settings.theme,
  );
  themeSelect.addEventListener("change", () => commit({ ...settings, theme: themeSelect.value as Settings["theme"] }));
  appearance.appendChild(row("Theme", themeSelect));

  const railDisplaySelect = select(
    [
      { value: "icons-and-labels", label: "Icons and labels" },
      { value: "icons", label: "Icons only" },
      { value: "labels", label: "Labels only" },
    ] as const,
    settings.railDisplay,
  );
  railDisplaySelect.addEventListener("change", () =>
    commit({ ...settings, railDisplay: railDisplaySelect.value as Settings["railDisplay"] }),
  );
  appearance.appendChild(row("Sidebar buttons", railDisplaySelect));

  const fontSelect = select(
    [
      { value: "serif", label: "Serif (dewlab's own)" },
      { value: "sans", label: "Sans-serif" },
      { value: "mono", label: "Monospace" },
    ] as const,
    settings.bodyFont,
  );
  fontSelect.addEventListener("change", () =>
    commit({ ...settings, bodyFont: fontSelect.value as Settings["bodyFont"] }),
  );
  appearance.appendChild(row("Body font", fontSelect));

  const textSizeInput = range(14, 24, 1, settings.textSize);
  textSizeInput.addEventListener("input", () => commit({ ...settings, textSize: Number(textSizeInput.value) }));
  appearance.appendChild(row("Text size", textSizeInput));

  const measureInput = range(24, 48, 1, settings.measure);
  measureInput.addEventListener("input", () => commit({ ...settings, measure: Number(measureInput.value) }));
  appearance.appendChild(row("Line width", measureInput));

  const lineHeightInput = range(1.2, 2.2, 0.05, settings.lineHeight);
  lineHeightInput.addEventListener("input", () =>
    commit({ ...settings, lineHeight: Number(lineHeightInput.value) }),
  );
  appearance.appendChild(row("Line height", lineHeightInput));

  const paragraphSpacingSelect = select(
    [
      { value: "tight", label: "Tight" },
      { value: "normal", label: "Normal" },
      { value: "loose", label: "Loose" },
    ] as const,
    settings.paragraphSpacing,
  );
  paragraphSpacingSelect.addEventListener("change", () =>
    commit({ ...settings, paragraphSpacing: paragraphSpacingSelect.value as Settings["paragraphSpacing"] }),
  );
  appearance.appendChild(row("Paragraph spacing", paragraphSpacingSelect));

  const marginsSelect = select(
    [
      { value: "comfortable", label: "Comfortable" },
      { value: "compact", label: "Compact" },
    ] as const,
    settings.margins,
  );
  marginsSelect.addEventListener("change", () =>
    commit({ ...settings, margins: marginsSelect.value as Settings["margins"] }),
  );
  appearance.appendChild(row("Margins", marginsSelect));

  const cellTintInput = document.createElement("input");
  cellTintInput.type = "checkbox";
  cellTintInput.checked = settings.cellTint;
  cellTintInput.addEventListener("change", () => commit({ ...settings, cellTint: cellTintInput.checked }));
  appearance.appendChild(row("Tinted cells", cellTintInput));

  panel.appendChild(appearance);

  // -------------------------------------------------------- code editor
  const codeSection = document.createElement("section");
  codeSection.className = "dn-settings-section";
  const codeHeading = document.createElement("h3");
  codeHeading.textContent = "Code editor";
  codeSection.appendChild(codeHeading);

  const codeFontSizeInput = range(11, 20, 1, settings.codeFontSize);
  codeFontSizeInput.addEventListener("input", () =>
    commit({ ...settings, codeFontSize: Number(codeFontSizeInput.value) }),
  );
  codeSection.appendChild(row("Code font size", codeFontSizeInput));

  const codeFontSelect = select(
    [
      { value: "mono", label: "System monospace" },
      { value: "humanist", label: "Humanist (JetBrains, Fira)" },
      { value: "slab", label: "Slab (IBM Plex, Source Code)" },
    ] as const,
    settings.codeFont,
  );
  codeFontSelect.addEventListener("change", () =>
    commit({ ...settings, codeFont: codeFontSelect.value as Settings["codeFont"] }),
  );
  codeFontSelect.title = "Each falls back to the system monospace where the named families aren't installed.";
  codeSection.appendChild(row("Code font", codeFontSelect));

  panel.appendChild(codeSection);

  // ------------------------------------------------------ running python
  const pythonSection = document.createElement("section");
  pythonSection.className = "dn-settings-section";
  const pythonHeading = document.createElement("h3");
  pythonHeading.textContent = "Running Python";
  pythonSection.appendChild(pythonHeading);

  const pyodideBaseInput = document.createElement("input");
  pyodideBaseInput.type = "text";
  pyodideBaseInput.placeholder = "Default (jsDelivr)";
  pyodideBaseInput.value = settings.pyodideBase;
  pyodideBaseInput.addEventListener("change", () => {
    setPyodideBase(pyodideBaseInput.value);
    commit({ ...settings, pyodideBase: pyodideBaseInput.value });
  });
  pythonSection.appendChild(row("Pyodide source URL", pyodideBaseInput));

  const restartButton = document.createElement("button");
  restartButton.type = "button";
  restartButton.className = "dn-settings-restart";
  restartButton.textContent = "Restart Python interpreter";
  restartButton.title = "Ends the running interpreter — the next cell run starts fresh, with an empty namespace.";
  restartButton.addEventListener("click", () => restartInterpreter());
  pythonSection.appendChild(restartButton);

  panel.appendChild(pythonSection);

  // ------------------------------------------------------------- reset
  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "dn-settings-reset";
  resetButton.textContent = "Reset to defaults";
  resetButton.addEventListener("click", () => {
    commit({ ...DEFAULT_SETTINGS });
    themeSelect.value = DEFAULT_SETTINGS.theme;
    railDisplaySelect.value = DEFAULT_SETTINGS.railDisplay;
    fontSelect.value = DEFAULT_SETTINGS.bodyFont;
    textSizeInput.value = String(DEFAULT_SETTINGS.textSize);
    measureInput.value = String(DEFAULT_SETTINGS.measure);
    marginsSelect.value = DEFAULT_SETTINGS.margins;
    cellTintInput.checked = DEFAULT_SETTINGS.cellTint;
    codeFontSizeInput.value = String(DEFAULT_SETTINGS.codeFontSize);
    pyodideBaseInput.value = DEFAULT_SETTINGS.pyodideBase;
    setPyodideBase(DEFAULT_SETTINGS.pyodideBase);
  });
  panel.appendChild(resetButton);

  labelToggle(toggle, "Settings");
  iconRail().appendChild(toggle);
  document.body.appendChild(panel);
  dockPanel(toggle, panel);
  applySettings(settings);
  setPyodideBase(settings.pyodideBase);

  return {
    destroy() {
      toggle.remove();
      panel.remove();
    },
  };
}
