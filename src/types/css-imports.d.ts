// A side-effect CSS import (`import "./app.css"`) has no runtime value —
// Bun's bundler resolves and inlines it, the same way it would a font or
// an image. TypeScript 5.9 had nothing to say about this; TypeScript 7's
// new module-resolution diagnostics do (TS2882, "Cannot find module or
// type declarations for side-effect import"), found only by actually
// installing the bump the Dependabot PR that added this file proposed,
// not by reading its changelog. Declaring the extension as a module with
// no exports is the standard fix, and is correct regardless of which
// TypeScript version reads it.
declare module "*.css";
