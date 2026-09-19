// The live-preview engine for a site group (site-cell.ts) — dewlab's own
// planning/DEWSTACK_MERGE.md §3 calls for "a new, instantiable version of
// dewmini's Site view — mount(container, {html, css, js}) returning
// {run, destroy}"; dewnote has no dewmini code to lift that from
// directly (dewmini lives in dewlab's own repository), so this is built
// fresh against the same shape and the same two conventions both
// dewstack's site=name and dewlab's own html/css/js site already settled
// on: a sandboxed iframe with `allow-scripts` only, no
// `allow-same-origin` — the script inside can never reach this page's
// own DOM, storage, or cookies — and HTML/CSS rebuild the preview
// live while JavaScript only ever runs on an explicit click (never on
// every keystroke, since a script's own side effects — a fetch, a timer,
// a DOM mutation — should not re-fire just because the reader paused to
// think in the HTML pane).
//
// `<base href="about:srcdoc">` is in the assembled document on purpose —
// its absence is a real, named bug in dewmini's own version
// (DEWSTACK_MERGE.md §3: "a relative link inside a dewmini site preview
// navigates the dewmini page itself instead of the frame"), fixed here
// from the start rather than discovered the same way twice.

export interface SiteMountOptions {
  html: string;
  css: string;
  js: string;
}

export type ConsoleLevel = "log" | "warn" | "error";
export interface ConsoleMessage {
  level: ConsoleLevel;
  text: string;
}

export interface SiteMount {
  /** Rebuilds the preview from the given HTML/CSS immediately. Never
   * runs `js` — only `run()` does that — so editing HTML or CSS never
   * re-fires a script's own side effects. */
  update(opts: SiteMountOptions): void;
  /** Runs the current JS fresh, against a freshly rebuilt HTML/CSS
   * document — the only time a `js site` pane's code executes. */
  run(): void;
  destroy(): void;
}

/** Injected into the sandboxed frame's own document, not run in this
 * page — the whole point of the sandbox is that dewnote's own code and
 * the reader's own script never share a realm. Relays console output and
 * uncaught errors back to the parent via postMessage, the same "friendly
 * console" dewstack's own site-editor.js and dewmini's Site tab both
 * already give a reader. */
function relayScript(): string {
  return `(function(){function send(level,args){try{parent.postMessage({__dnSiteConsole:true,level:level,text:Array.prototype.map.call(args,String).join(" ")},"*");}catch(e){}}["log","warn","error"].forEach(function(level){var original=console[level];console[level]=function(){send(level,arguments);if(original)original.apply(console,arguments);};});window.addEventListener("error",function(event){send("error",[event.message]);});})();`;
}

// This module's own output ends up embedded as a string inside dewnote's
// *outer* bundle — which is itself one big module-script element in
// index.html. The browser's HTML parser looks for that element's own
// closing tag with a dumb, non-JS-aware text scan: the four characters
// "less-than, slash, s, c" (spelled out here, deliberately, rather than
// written as the literal tag text this whole comment is about), found
// anywhere in the element's raw text, end it right there — including
// inside a JS string or template literal that only means to hold that
// text as data, never as markup. An escaped forward slash right after
// the opening angle bracket in the TypeScript source (the standard,
// textbook fix for exactly this) is not enough on its own: Bun's own
// minifier normalises that escape to a bare slash (the two are always
// equivalent JS escapes, so it's a legitimate simplification on its
// own), silently undoing the fix and putting the dangerous literal
// sequence right back — checked directly against a real build, not
// assumed, after that build broke every single page load with a
// SyntaxError pointing at index.html itself, the outer script element
// cut off mid-file. `String.fromCharCode(60)` for the opening angle
// bracket survives minification because it is a real function call, not
// a literal a minifier can fold back into a matching substring the way
// it folded the redundant backslash away — the tag itself is never
// written as contiguous characters anywhere in this file's source, this
// comment included.
const LT = String.fromCharCode(60);

/** Builds the sandboxed frame's whole document — exported for its own
 * unit tests, which check its shape directly rather than through a real
 * iframe (jsdom-free: this module never touches the DOM itself outside
 * `mountSite`). `js` is `null` for the HTML/CSS-only rebuild `update()`
 * does; a real string, even an empty one, only when `run()` calls this. */
export function buildSiteDocument(html: string, css: string, js: string | null): string {
  const script = `${LT}script>${relayScript()}\n${js ?? ""}${LT}/script>`;
  return `<!doctype html><html><head><base href="about:srcdoc"><meta charset="utf-8"><style>${css}</style></head><body>${html}${script}</body></html>`;
}

/** Mounts a live preview into `container`. `onConsole` is called for
 * every relayed console line or uncaught error, in order; the caller
 * owns rendering those, this module owns only the frame and the relay
 * protocol underneath it. */
export function mountSite(container: HTMLElement, onConsole: (message: ConsoleMessage) => void): SiteMount {
  const iframe = document.createElement("iframe");
  iframe.className = "dn-site-frame";
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("title", "Site preview");
  container.appendChild(iframe);

  let current: SiteMountOptions = { html: "", css: "", js: "" };

  function onMessage(event: MessageEvent) {
    if (event.source !== iframe.contentWindow) return;
    const data = event.data as { __dnSiteConsole?: boolean; level?: ConsoleLevel; text?: string } | null;
    if (data?.__dnSiteConsole) onConsole({ level: data.level ?? "log", text: data.text ?? "" });
  }
  window.addEventListener("message", onMessage);

  return {
    update(opts) {
      current = opts;
      iframe.srcdoc = buildSiteDocument(current.html, current.css, null);
    },
    run() {
      iframe.srcdoc = buildSiteDocument(current.html, current.css, current.js);
    },
    destroy() {
      window.removeEventListener("message", onMessage);
      container.innerHTML = "";
    },
  };
}
