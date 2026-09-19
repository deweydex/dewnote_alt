// The repository rail (src/repo-panel.ts, src/github.ts) — step 5's
// first slice. Drives the real built app with GitHub's REST API stubbed
// via page.route, the same "real browser, no mock DOM" discipline every
// other spec in this folder follows (decision 9), just with the one
// external service this feature actually talks to intercepted rather
// than reached over the network.

import { addBlockAfter } from "./block-controls.ts";
import { selectPanel } from "./panel-helpers.ts";
import { test as base, expect, type Page, type Route } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_APP = "file://" + resolve(HERE, "../../dist/index.html") + "?legacy=1";

// A 404 checking whether the working branch already exists
// (ensureBranch's own "does this ref exist" probe), a 409 on a
// conflicting push, and a 422 on a new-file push whose path already has
// something there (decision 32) are all Chromium's own devtools noise
// for any non-2xx fetch, not an application error — the code treats all
// three as normal, handled outcomes, so they're filtered here rather
// than silencing console errors generally the way the other specs in
// this folder do not.
const EXPECTED_CONSOLE_NOISE = /Failed to load resource: the server responded with a status of (404|409|422)/;

const test = base.extend<{ failOnConsoleErrors: void }>({
  failOnConsoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (msg) => {
        if (msg.type() === "error" && !EXPECTED_CONSOLE_NOISE.test(msg.text())) errors.push(msg.text());
      });
      await use();
      expect(errors, `console/page errors:\n${errors.join("\n")}`).toEqual([]);
    },
    { auto: true },
  ],
});

function toBase64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

interface MockOptions {
  fileContent: string;
  fileSha: string;
  /** Content GitHub reports for this same path on the working branch
   * (`dewnote-edits`) specifically — distinct from `fileContent`, which
   * is what `main` (or whatever `ref` the file was opened from) has.
   * Used to simulate the branch having moved since the file was opened. */
  branchContent?: string;
  branchContentSha?: string;
  /** The first PUT to this path returns 409 (a stale SHA); every PUT
   * after that succeeds — simulating a conflict that clears once the
   * reader picks a version and retries. */
  conflictOnFirstPush?: boolean;
  /** decision 32: a PUT with no `sha` in its body (repo-panel.ts's own
   * "start a new file") gets GitHub's real 422 back, as if something
   * were already sitting at that path — every other PUT still succeeds. */
  newFileAlreadyExists?: boolean;
  /** Include a focused practice page so the module-aware view can prove
   * it derives practice placement from `practice_for`. */
  includePractice?: boolean;
}

/** Stubs the exact GitHub calls this slice makes, keyed by method + a
 * pattern against the path. Anything unmatched 404s loudly rather than
 * hitting the real network — a route this test doesn't expect is a bug
 * in the test, not something to fall through on. Returns every PUT's own
 * decoded request body, in order, so a test can check exactly what a
 * push actually sent (whether `sha` was included at all) without
 * reaching into repo-panel.ts's own state. */
async function mockGithub(page: Page, opts: MockOptions): Promise<{ putBodies: Record<string, unknown>[]; putPaths: string[] }> {
  let putCalls = 0;
  const putBodies: Record<string, unknown>[] = [];
  const putPaths: string[] = [];
  await page.route("https://api.github.com/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const path = url.pathname;

    if (method === "GET" && /\/git\/trees\//.test(path)) {
      return fulfillJson(route, 200, {
        tree: [
          { path: "tutorials/a-rule/a-rule.md", type: "blob", sha: "tree-sha-1" },
          { path: "tutorials/b-page/b-page.md", type: "blob", sha: "tree-sha-2" },
          ...(opts.includePractice ? [{ path: "tutorials/a-rule/a-rule-practice.md", type: "blob", sha: "tree-sha-practice" }] : []),
          { path: "assets/logo.png", type: "blob", sha: "tree-sha-3" },
          { path: "courses/a-module.yaml", type: "blob", sha: "tree-sha-4" },
        ],
      });
    }

    if (method === "GET" && /\/contents\//.test(path)) {
      // The module file is read too (refreshModules), and handing it the
      // markdown fixture would have modules.ts parsing prose — the panel
      // swallows that per file, so the test would pass while proving
      // nothing about a module actually being read.
      if (path.endsWith(".yaml")) {
        return fulfillJson(route, 200, { content: toBase64(MODULE_YAML), sha: "module-sha" });
      }
      if (path.endsWith("a-rule-practice.md")) {
        return fulfillJson(route, 200, {
          content: toBase64(["---", "title: A Rule — Practice", "practice_for: a-rule", "---", "", "# Practice", ""].join("\n")),
          sha: "practice-sha",
        });
      }
      const onBranch = url.searchParams.get("ref") === "dewnote-edits";
      if (onBranch && opts.branchContent !== undefined) {
        return fulfillJson(route, 200, { content: toBase64(opts.branchContent), sha: opts.branchContentSha ?? "branch-sha" });
      }
      return fulfillJson(route, 200, { content: toBase64(opts.fileContent), sha: opts.fileSha });
    }

    if (method === "GET" && /\/git\/ref\/heads\/dewnote-edits$/.test(path)) {
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    }
    if (method === "GET" && /\/git\/ref\/heads\/main$/.test(path)) {
      return fulfillJson(route, 200, { object: { sha: "base-sha" } });
    }
    if (method === "POST" && /\/git\/refs$/.test(path)) {
      return fulfillJson(route, 201, { ref: "refs/heads/dewnote-edits" });
    }

    if (method === "PUT" && /\/contents\//.test(path)) {
      putCalls += 1;
      const body = req.postDataJSON() as Record<string, unknown>;
      putBodies.push(body);
      putPaths.push(decodeURIComponent(path.split("/contents/")[1] ?? ""));
      if (opts.conflictOnFirstPush && putCalls === 1) {
        return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "sha does not match" }) });
      }
      if (opts.newFileAlreadyExists && !("sha" in body)) {
        return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ message: '"sha" wasn\'t supplied.' }) });
      }
      return fulfillJson(route, 200, { content: { sha: `new-sha-${putCalls}` } });
    }

    if (method === "POST" && /\/pulls$/.test(path)) {
      return fulfillJson(route, 201, { html_url: "https://github.com/dewlab/dewlab/pull/42", number: 42 });
    }

    throw new Error(`repo-panel.spec.ts: unexpected GitHub call ${method} ${path}`);
  });
  return { putBodies, putPaths };
}

async function setup(page: Page, opts: MockOptions): Promise<{ putBodies: Record<string, unknown>[]; putPaths: string[] }> {
  // Stubbed before navigation, so anything main.ts fires on load is covered too.
  const mock = await mockGithub(page, opts);
  // window.open would try to pop a real tab; no-op it before any click reaches it.
  await page.addInitScript(() => {
    (window as unknown as { open: () => null }).open = () => null;
  });
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
  await selectPanel(page, ".dn-repo-toggle");
  await page.locator('.dn-repo-panel input[type="password"]').fill("test-token");
  const ownerRepo = page.locator(".dn-repo-owner-row input");
  await ownerRepo.nth(0).fill("dewlab");
  await ownerRepo.nth(1).fill("dewlab");
  return mock;
}

const DEFAULT_OPTS: MockOptions = { fileContent: "# A Rule\n\nWhere it lives.\n", fileSha: "file-sha-1" };

/** What the refactored repo's root `courses/a-module.yaml` holds — one module, one series,
 * listing the id of the one markdown file in the tree that has one. */
const MODULE_YAML = ["title: A Module", "contents:", "- title: First steps", "  tutorials:", "  - a-rule", "  - b-page", ""].join("\n");

async function showAllFiles(page: Page): Promise<void> {
  await page.locator(".dn-repo-tab", { hasText: "All files" }).click();
}

test("a repository opens as modules, pairs practice with its tutorial, and locks the session to GitHub", async ({ page }) => {
  await setup(page, { ...DEFAULT_OPTS, includePractice: true });
  await page.locator(".dn-repo-load").click();

  await expect(page.locator(".dn-repo-tab", { hasText: "Modules" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".dn-repo-module-choice")).toHaveText("A Module");
  const series = page.locator(".dn-repo-module-series", { hasText: "First steps" });
  await expect(series).toBeVisible();
  await expect(series.locator(".dn-repo-module-page")).toHaveCount(3);
  await expect(series.locator(".dn-repo-module-page.is-practice button")).toHaveText("A Rule — Practice");

  const nav = page.locator(".dn-workspace-nav");
  await expect(nav).toBeVisible();
  await expect(nav.locator(".dn-workspace-nav-module")).toHaveValue("a-module");
  await expect(nav.locator(".dn-workspace-nav-series")).toHaveValue("First steps");
  await expect(nav.locator(".dn-workspace-nav-page option")).toHaveCount(3);
  await expect(page.locator(".dn-folder-toggle")).toBeDisabled();

  await series.locator(".dn-repo-module-page:not(.is-practice) button").first().click();
  await expect(page.locator("h1")).toHaveText("A Rule");
  await expect(nav.locator(".dn-workspace-nav-page")).toHaveValue("tutorials/a-rule/a-rule.md");
});

test("loading a repository lists its markdown and module files, and search filters them", async ({ page }) => {
  await setup(page, DEFAULT_OPTS);
  await page.locator(".dn-repo-load").click();
  await expect(page.locator(".dn-repo-status").first()).toHaveText("2 markdown files, 1 module file.");
  await showAllFiles(page);

  const items = page.locator(".dn-repo-file");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveText("tutorials/a-rule/a-rule.md");
  await expect(items.nth(1)).toHaveText("tutorials/b-page/b-page.md");

  await page.locator(".dn-repo-search").fill("b-page");
  await expect(page.locator(".dn-repo-file")).toHaveCount(1);
  await expect(page.locator(".dn-repo-file")).toHaveText("tutorials/b-page/b-page.md");
});

// Step 4's own follow-up, raised alongside the series view: a module
// file is just another file in the browsable list — opening one hands
// it to the same editor and push path every markdown file already gets,
// no new UI needed to hand-edit a reading order.
test("a module file opens and pushes through the ordinary repo panel, same as a markdown file", async ({ page }) => {
  await setup(page, DEFAULT_OPTS);
  await page.locator(".dn-repo-load").click();
  await showAllFiles(page);
  await page.locator(".dn-repo-file", { hasText: "a-module.yaml" }).click();

  await expect(page.locator(".dn-repo-status").first()).toHaveText("Opened courses/a-module.yaml.");
  await expect(page.locator(".dn-repo-push")).toHaveText("Push to dewnote-edits");
  await page.locator(".dn-repo-push").click();

  const pushStatus = page.locator(".dn-repo-section", { has: page.locator(".dn-repo-push") }).locator(".dn-repo-status");
  await expect(pushStatus).toHaveText("Pushed to dewnote-edits.");
});

// file-index.ts's own side: loading a repository builds the front-matter
// index (plan §5.10) the link picker searches, one getFileContent per
// markdown file (repo-panel.ts's own refreshIndex) — checked through the
// link picker itself, the only observable consumer.
test("loading a repository builds the file index the link picker searches", async ({ page }) => {
  await setup(page, DEFAULT_OPTS);
  await page.locator(".dn-repo-load").click();
  await expect(page.locator(".dn-repo-status").first()).toHaveText("2 markdown files, 1 module file.");
  await page.locator(".dn-repo-close").click();

  await addBlockAfter(page, 0, "Link");

  const items = page.locator(".dn-link-item button");
  await expect(items).toHaveCount(2);
  await expect(items).toContainText(["tutorials/a-rule/a-rule.md", "tutorials/b-page/b-page.md"]);
});

test("opening a file renders its real content in the editor", async ({ page }) => {
  await setup(page, DEFAULT_OPTS);
  await page.locator(".dn-repo-load").click();
  await showAllFiles(page);
  await page.locator(".dn-repo-file", { hasText: "a-rule.md" }).click();

  await expect(page.locator("h1")).toHaveText("A Rule");
  await expect(page.locator(".dn-block-render").filter({ hasText: "Where it lives." })).toBeVisible();
});

test("pushing an edit creates the working branch, commits, and offers a draft PR", async ({ page }) => {
  await setup(page, DEFAULT_OPTS);
  await page.locator(".dn-repo-load").click();
  await showAllFiles(page);
  await page.locator(".dn-repo-file", { hasText: "a-rule.md" }).click();
  await expect(page.locator("h1")).toHaveText("A Rule");

  await expect(page.locator(".dn-repo-push")).toHaveText("Push to dewnote-edits");
  await page.locator(".dn-repo-push").click();

  const pushStatus = page.locator(".dn-repo-section", { has: page.locator(".dn-repo-push") }).locator(".dn-repo-status");
  await expect(pushStatus).toHaveText("Pushed to dewnote-edits.");
  await expect(page.locator(".dn-repo-pr")).toBeVisible();

  await page.locator(".dn-repo-pr").click();
  await expect(pushStatus).toContainText("https://github.com/dewlab/dewlab/pull/42");
});

test("pushing as a new version freezes the committed release and updates the live file", async ({ page }) => {
  const original = ["---", "title: A Rule", "version: 2026.09.15.1", "---", "", "# A Rule", "", "Original.", ""].join("\n");
  const { putBodies, putPaths } = await setup(page, { fileContent: original, fileSha: "file-sha-1" });
  await page.locator(".dn-repo-load").click();
  await showAllFiles(page);
  await page.locator(".dn-repo-file", { hasText: "a-rule.md" }).click();
  await page.locator(".dn-block-render", { hasText: "Original." }).click();
  const prose = page.locator(".dn-block-prose-source .cm-content");
  await prose.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("Revised.");
  expect(await page.evaluate(() => {
    return (window as unknown as { __dewnote: { getSource(): string } }).__dewnote.getSource();
  })).toContain("Revised.");

  await page.locator(".dn-repo-release").click();
  const pushStatus = page.locator(".dn-repo-section", { has: page.locator(".dn-repo-push") }).locator(".dn-repo-status");
  const today = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date())
    .replaceAll("-", ".");
  await expect(pushStatus).toContainText(`Pushed version ${today}.1`);
  expect(putPaths).toEqual([
    "tutorials/a-rule/v2026.09.15.1.md",
    "tutorials/a-rule/a-rule.md",
  ]);
  expect(Buffer.from(putBodies[0]!["content"] as string, "base64").toString("utf-8")).toBe(original);
  expect(putBodies[0]).not.toHaveProperty("sha");
  const released = Buffer.from(putBodies[1]!["content"] as string, "base64").toString("utf-8");
  expect(released).toContain(`version: ${today}.1`);
  expect(released).toContain("supersedes: 2026.09.15.1");
  expect(released).toContain("Revised.");
  expect(putBodies[1]).toHaveProperty("sha", "file-sha-1");
});

test("a conflicting push shows both versions, and keeping mine overwrites theirs", async ({ page }) => {
  await setup(page, {
    ...DEFAULT_OPTS,
    conflictOnFirstPush: true,
    branchContent: "# A Rule\n\nSomeone else's edit, already on the branch.\n",
    branchContentSha: "branch-sha-1",
  });
  await page.locator(".dn-repo-load").click();
  await showAllFiles(page);
  await page.locator(".dn-repo-file", { hasText: "a-rule.md" }).click();
  await expect(page.locator("h1")).toHaveText("A Rule");

  await page.locator(".dn-repo-push").click();

  const pushStatus = page.locator(".dn-repo-section", { has: page.locator(".dn-repo-push") }).locator(".dn-repo-status");
  await expect(pushStatus).toHaveText("Conflict — choose a version below.");

  const conflictTexts = page.locator(".dn-repo-conflict-text");
  await expect(conflictTexts).toHaveCount(2);
  await expect(conflictTexts.nth(0)).toContainText("Where it lives.");
  await expect(conflictTexts.nth(1)).toContainText("Someone else's edit, already on the branch.");

  await page.locator("button", { hasText: "Keep mine, overwrite theirs" }).click();
  await expect(pushStatus).toHaveText("Pushed to dewnote-edits.");
  await expect(page.locator(".dn-repo-conflict")).toBeHidden();
  await expect(page.locator(".dn-repo-pr")).toBeVisible();
});

test("a conflicting push can also discard mine and load theirs into the editor", async ({ page }) => {
  await setup(page, {
    ...DEFAULT_OPTS,
    conflictOnFirstPush: true,
    branchContent: "# A Rule\n\nSomeone else's edit, already on the branch.\n",
    branchContentSha: "branch-sha-1",
  });
  await page.locator(".dn-repo-load").click();
  await showAllFiles(page);
  await page.locator(".dn-repo-file", { hasText: "a-rule.md" }).click();
  await page.locator(".dn-repo-push").click();
  await expect(page.locator(".dn-repo-conflict-text")).toHaveCount(2);

  await page.locator("button", { hasText: "Discard mine, load theirs" }).click();

  await expect(page.locator(".dn-block-render").filter({ hasText: "Someone else's edit, already on the branch." })).toBeVisible();
  await expect(page.locator(".dn-repo-conflict")).toBeHidden();
});

// Decision 32: the counterpart to every test above — none of them ever
// open a file first, since a document composed in dewnote from nothing
// (the starter document, untouched here) had no way into a repository
// at all before this.
test("starting a new file points a push at a path with no existing sha, and creates it", async ({ page }) => {
  const { putBodies } = await setup(page, DEFAULT_OPTS);

  await page.locator(".dn-repo-new-file-path").fill("tutorials/brand-new.md");
  await page.locator(".dn-repo-new-file").click();
  await expect(page.locator(".dn-repo-status").first()).toHaveText("Ready to push a new file at tutorials/brand-new.md.");
  await expect(page.locator(".dn-repo-push")).toHaveText("Push new file to dewnote-edits");

  await page.locator(".dn-repo-push").click();
  const pushStatus = page.locator(".dn-repo-section", { has: page.locator(".dn-repo-push") }).locator(".dn-repo-status");
  await expect(pushStatus).toHaveText("Pushed to dewnote-edits.");
  await expect(page.locator(".dn-repo-pr")).toBeVisible();

  expect(putBodies).toHaveLength(1);
  expect(putBodies[0]).not.toHaveProperty("sha");
  expect(putBodies[0]!["message"]).toBe("Add tutorials/brand-new.md from dewnote");

  // The push just gave this path a real sha (decision 32's own "upgrade"
  // from create to edit) — pushing again is now an ordinary edit, sha
  // included, not a second create.
  await expect(page.locator(".dn-repo-push")).toHaveText("Push to dewnote-edits");
  await page.locator(".dn-repo-push").click();
  await expect(pushStatus).toHaveText("Pushed to dewnote-edits.");
  expect(putBodies).toHaveLength(2);
  expect(putBodies[1]).toHaveProperty("sha", "new-sha-1");
});

test("pushing a new file to a path that already has one reports it plainly, not as a diff conflict", async ({ page }) => {
  await setup(page, { ...DEFAULT_OPTS, newFileAlreadyExists: true });

  await page.locator(".dn-repo-new-file-path").fill("tutorials/a-rule.md");
  await page.locator(".dn-repo-new-file").click();
  await page.locator(".dn-repo-push").click();

  const pushStatus = page.locator(".dn-repo-section", { has: page.locator(".dn-repo-push") }).locator(".dn-repo-status");
  await expect(pushStatus).toContainText("A file already exists at tutorials/a-rule.md on dewnote-edits");
  await expect(page.locator(".dn-repo-conflict")).toBeHidden();
});

// active-store.ts's read-modify-write pair against a repository, driven
// the way a reader reaches it: the placement rail, reordering a module.
// A folder writes a handle in place; a repository has to create the
// working branch, find the blob sha that branch holds right now, and
// commit — so what is checked here is the request that actually went
// out, not just that the rail said something.
//
// The three tests that used to sit here drove the same interface's
// `createFile` through series-panel.ts's "New series". That form wrote
// `<series>.order.yaml` files and went with them (decision 36); a series
// is an entry in a module file now, and making one needs a line range
// modules.ts doesn't record, so `createFile` still has no caller here.
test("reordering a module writes it back through the working branch, with the sha that branch holds", async ({ page }) => {
  const { putBodies } = await setup(page, DEFAULT_OPTS);
  await page.locator(".dn-repo-load").click();
  await expect(page.locator(".dn-repo-status").first()).toHaveText("2 markdown files, 1 module file.");
  await page.locator(".dn-repo-close").click();

  await selectPanel(page, ".dn-series-toggle");
  const list = page.locator(".dn-series-list").first();
  await expect(list.locator("li")).toHaveCount(2);
  await list.locator("li").nth(1).locator(".dn-series-grip").dragTo(list.locator("li").nth(0), { targetPosition: { x: 5, y: 1 } });

  await expect(page.locator(".dn-series-status")).toContainText("Moved b-page");
  expect(putBodies).toHaveLength(1);
  expect(putBodies[0]!["sha"]).toBe("module-sha");
  expect(putBodies[0]!["branch"]).toBe("dewnote-edits");
  const content = Buffer.from(putBodies[0]!["content"] as string, "base64").toString("utf-8");
  expect(content).toBe(["title: A Module", "contents:", "- title: First steps", "  tutorials:", "  - b-page", "  - a-rule", ""].join("\n"));

  // A descriptor-only change still has a complete publishing route; it
  // no longer depends on pushing an unrelated editor document first.
  await page.locator(".dn-series-close").click();
  await selectPanel(page, ".dn-repo-toggle");
  await expect(page.locator(".dn-repo-pr")).toBeVisible();
});

test("a write against a repository never disturbs an already-open file's own push target", async ({ page }) => {
  await setup(page, DEFAULT_OPTS);
  await page.locator(".dn-repo-load").click();
  await showAllFiles(page);
  await page.locator(".dn-repo-file", { hasText: "a-rule.md" }).click();
  await expect(page.locator(".dn-repo-push")).toHaveText("Push to dewnote-edits");
  await page.locator(".dn-repo-close").click();

  await selectPanel(page, ".dn-series-toggle");
  await page.locator(".dn-series-list").first().locator("li").nth(0).locator(".dn-series-remove").click();
  await expect(page.locator(".dn-series-status")).toContainText("still there, on no module");

  // Still pointed at a-rule.md, not silently repointed at the module file.
  await page.locator(".dn-series-close").click();
  await selectPanel(page, ".dn-repo-toggle");
  await expect(page.locator(".dn-repo-push")).toHaveText("Push to dewnote-edits");
  await expect(page.locator("h1")).toHaveText("A Rule");
});

test("starting a new file with no owner/repo, or no path, is refused with a clear status instead of a silent no-op", async ({ page }) => {
  await setup(page, DEFAULT_OPTS);

  const ownerRepo = page.locator(".dn-repo-owner-row input");
  await ownerRepo.nth(0).fill("");
  await page.locator(".dn-repo-new-file-path").fill("tutorials/brand-new.md");
  await page.locator(".dn-repo-new-file").click();
  await expect(page.locator(".dn-repo-status").first()).toHaveText("Enter an owner and repo.");

  await ownerRepo.nth(0).fill("dewlab");
  await page.locator(".dn-repo-new-file-path").fill("");
  await page.locator(".dn-repo-new-file").click();
  await expect(page.locator(".dn-repo-status").first()).toHaveText("Enter a path for the new file.");
});
