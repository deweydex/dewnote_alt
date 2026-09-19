// Which dialect a document is written in, decided from its front matter
// alone. See planning/DIALECTS.md for the full inventory this follows;
// this module is deliberately the only place that inventory turns into
// code, per DECISIONS.md 3 (a dialect is data, not a code path spread
// through the editor).

import type { FrontMatter } from "./frontmatter.ts";

export type DialectName = "dewlab" | "dewstack" | "plain";

/**
 * dewlab requires `year`; dewstack requires `module_title` but never
 * `year`. A document with neither (or no front matter at all) is treated
 * as plain markdown — the safe default, since plain markdown is a strict
 * subset of what either site's dialect can hold.
 */
export function detectDialect(frontMatter: FrontMatter): DialectName {
  if (!frontMatter.present) return "plain";
  const { fields } = frontMatter;
  if (typeof fields["year"] !== "undefined") return "dewlab";
  if (typeof fields["module_title"] !== "undefined") return "dewstack";
  return "plain";
}

/**
 * dewlab's own `version` form (DIALECTS.md §1: `2026.09.04.1`) — today's
 * date plus a `.1` release counter, since a document being written for
 * the first time has no prior release to be the second of.
 *
 * Here rather than beside either caller because it is part of the same
 * inventory `detectDialect` reads: what a dewlab `version:` looks like.
 * Computed on each call rather than once at module load, so an editor
 * left open overnight stamps the day it is actually used on.
 */
export function todayVersion(now: Date = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd}.1`;
}
