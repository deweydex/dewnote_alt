// Groups consecutive `html site`/`css site`/`js site` fences sharing one
// `site:` value into a single editor unit (DIALECTS.md §1) — the
// consecutive-fence grouping plan §6 step 3 named and deferred, and plan
// §8 item 3's own note on why it belongs here rather than in blocks.ts:
// deciding which fences group together means reading a `site:` header
// *inside* a fence's own body, and blocks.ts only ever looks at a
// fence's info string to split the document correctly (cell.ts's own
// header comment already states this as the general rule for every
// other fence kind's header lines — this is the same rule, just for a
// grouping decision instead of a single fence's own meaning).
//
// A blank-only prose block between two site panes doesn't break the
// group — blocks.ts's own "a fence never owns its trailing blank line"
// rule (see blocks.ts's module comment) means an ordinary blank line
// between two fences in the source is its own orphan prose block, not
// part of either fence, and dewlab's own adjacency rule already allows
// whitespace between panes (`extract_blocks()`'s own
// `not body[last_site_pane_end:match.start()].strip()` check). Any other
// block kind, or a prose block with real content, ends the group.

import type { Block } from "./blocks.ts";
import { isSitePaneFence, parseSitePaneInfo, type SiteLanguage, type SitePaneInfo } from "./cell.ts";

export interface SitePane {
  blockIndex: number;
  info: SitePaneInfo;
}

export interface SiteGroup {
  /** The block index range this group spans, inclusive — every block in
   * `[startIndex, endIndex]` is either a pane in `panes` or a
   * blank-only gap between two panes. */
  startIndex: number;
  endIndex: number;
  /** The shared `site:` value every pane in this group carries — the
   * empty string when none of them declared one, which still groups
   * consecutive unnamed panes together (the adjacency itself is the
   * signal an author is grouping them, not the name). */
  site: string;
  panes: Partial<Record<SiteLanguage, SitePane>>;
}

/** dewlab's own rule: at most one pane per language per site — a second
 * fence for a language already claimed starts a new group instead of
 * silently overwriting the first, the same "never guess, never
 * overwrite" discipline this whole file follows. */
export function findSiteGroups(blocks: Block[]): SiteGroup[] {
  const groups: SiteGroup[] = [];
  let current: SiteGroup | null = null;

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;

    if (block.kind === "prose" && block.text.trim() === "") continue; // a whitespace-only gap never breaks a group

    if (block.kind === "fence" && isSitePaneFence(block.fence?.info ?? "")) {
      const info = parseSitePaneInfo(block);
      const site = info.site ?? "";
      if (current && current.site === site && !current.panes[info.language]) {
        current.endIndex = index;
        current.panes[info.language] = { blockIndex: index, info };
        continue;
      }
      current = { startIndex: index, endIndex: index, site, panes: { [info.language]: { blockIndex: index, info } } };
      groups.push(current);
      continue;
    }

    current = null;
  }

  return groups;
}

/** Finds the group a given block index belongs to, or null — app.ts's
 * own render loop uses this once per fence block rather than building
 * (and discarding) the full group list per block. */
export function siteGroupContaining(groups: SiteGroup[], blockIndex: number): SiteGroup | null {
  return groups.find((g) => blockIndex >= g.startIndex && blockIndex <= g.endIndex) ?? null;
}
