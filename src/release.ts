import { extractFrontMatter, setFrontMatterField } from "./frontmatter.ts";

const VERSION_RE = /^(\d{4})\.(\d{2})\.(\d{2})\.(\d+)$/;

/** The next Dewlab release on a date, including a second release made on
 * the same day rather than always assuming `.1`. */
export function nextVersion(existing: Array<string | undefined>, now: Date = new Date()): string {
  const stem = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join(".");
  const counters = existing.flatMap((version) => {
    const match = VERSION_RE.exec(version ?? "");
    return match && match.slice(1, 4).join(".") === stem ? [Number(match[4])] : [];
  });
  return `${stem}.${counters.length ? Math.max(...counters) + 1 : 1}`;
}

export interface PreparedRelease {
  currentPath: string;
  frozenPath: string;
  frozenContent: string;
  releasedContent: string;
  previousVersion: string;
  nextVersion: string;
}

/** Prepare Dewlab's two-file release operation. The committed live source is
 * frozen as `v<old>.md`; the edited source keeps the canonical `<id>.md`
 * address and receives the new version plus `supersedes`. */
export function prepareRelease(
  path: string,
  committed: string,
  edited: string,
  existingVersions: Array<string | undefined>,
  now: Date = new Date(),
): PreparedRelease | { error: string } {
  const match = /^(.*\/tutorials\/([^/]+))\/\2\.md$/.exec(`/${path}`);
  if (!match) return { error: "Only a live tutorials/<id>/<id>.md file can be saved as a new version." };
  if (committed === edited) return { error: "Nothing has changed, so a new version would be identical." };
  const committedFm = extractFrontMatter(committed);
  const editedFm = extractFrontMatter(edited);
  const previous = typeof committedFm.fields["version"] === "string" ? committedFm.fields["version"] : "";
  const committedStatus = typeof committedFm.fields["status"] === "string" ? committedFm.fields["status"] : "live";
  const editedStatus = typeof editedFm.fields["status"] === "string" ? editedFm.fields["status"] : "live";
  if (!VERSION_RE.test(previous)) return { error: "The committed tutorial has no valid version to freeze." };
  if (committedStatus !== "live" || editedStatus !== "live") {
    return { error: "Only a live tutorial can be saved as a new version." };
  }
  const next = nextVersion([...existingVersions, previous], now);
  let released = setFrontMatterField(edited, "version", next);
  released = setFrontMatterField(released, "supersedes", previous);
  const folder = match[1]!.slice(1);
  return {
    currentPath: path,
    frozenPath: `${folder}/v${previous}.md`,
    frozenContent: committed,
    releasedContent: released,
    previousVersion: previous,
    nextVersion: next,
  };
}
