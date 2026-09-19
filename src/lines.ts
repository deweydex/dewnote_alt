// A tiny line index: every line's exact span, newline included, so that
// concatenating every line's text reconstructs the source exactly (the
// last line has no trailing newline if the source doesn't end in one).
// The block splitter (blocks.ts) works entirely in terms of these spans
// rather than re-slicing the source by hand, so there is exactly one
// place that decides where a line starts and ends.

export interface Line {
  /** 0-based index into the `lines` array this came from. */
  index: number;
  /** Byte offset of the first character of the line. */
  start: number;
  /** Byte offset one past the line's trailing newline (or past the last
   * character, for a final line with no trailing newline). */
  end: number;
  /** The line's own text, newline included when there is one. */
  text: string;
  /** The line's text with any trailing \r\n or \n removed. */
  content: string;
}

export function splitLines(source: string, from = 0): Line[] {
  const lines: Line[] = [];
  let pos = from;
  let index = 0;
  while (pos < source.length) {
    const nl = source.indexOf("\n", pos);
    const end = nl === -1 ? source.length : nl + 1;
    const text = source.slice(pos, end);
    const content = nl === -1 ? text : text.slice(0, -1).replace(/\r$/, "");
    lines.push({ index, start: pos, end, text, content });
    pos = end;
    index++;
  }
  return lines;
}

export function isBlank(content: string): boolean {
  return content.trim().length === 0;
}
