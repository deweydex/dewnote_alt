// `import source from "./file.py" with { type: "text" }` — Bun's bundler
// inlines the file's raw text as a string at build time (checked
// directly: a backtick or `${` sequence in the source comes out
// correctly escaped). Used for dewnote_tools.py, which the Pyodide
// worker needs as a string to write into its own in-memory filesystem,
// not as something this build ever executes as TypeScript.
declare module "*.py" {
  const source: string;
  export default source;
}
