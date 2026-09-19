// markdown-it-texmath ships no types of its own (checked: its package.json
// has no "types" field and node_modules/markdown-it-texmath has no .d.ts).
// This covers exactly the surface render-block.ts calls — decision 9's
// "a small local .d.ts rather than any."

declare module "markdown-it-texmath" {
  import type MarkdownIt from "markdown-it";

  export interface TexmathOptions {
    engine: unknown;
    delimiters?: string | string[];
    outerSpace?: boolean;
    katexOptions?: Record<string, unknown>;
  }

  export default function texmath(md: MarkdownIt, options: TexmathOptions): void;
}
