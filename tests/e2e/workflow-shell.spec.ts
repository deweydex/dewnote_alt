import { expect, test, type Page, type Route } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT_APP = "file://" + resolve(HERE, "../../dist/index.html");

async function stubDirectoryPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    function file(name: string, content: string) {
      return {
        kind: "file",
        name,
        async getFile() { return { text: async () => content }; },
        async createWritable() { return { async write() {}, async close() {} }; },
      };
    }
    function directory(name: string, children: Record<string, unknown>) {
      return {
        kind: "directory",
        name,
        async *entries() { for (const entry of Object.entries(children)) yield entry; },
      };
    }
    const root = directory("Teaching notes", {
      modules: directory("modules", {
        "foundations.yaml": file("foundations.yaml", "title: Foundations\ncontents:\n- title: First steps\n  tutorials:\n  - a-rule\n"),
      }),
      tutorials: directory("tutorials", {
        "a-rule": directory("a-rule", {
          "a-rule.md": file("a-rule.md", "---\ntitle: A Rule\n---\n\n# A Rule\n"),
        }),
      }),
    });
    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker = async () => root;
  });
}

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function stubGithub(page: Page, changes: unknown[] = []): Promise<void> {
  await page.route("https://api.github.com/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (/\/compare\//.test(path)) return json(route, { files: changes });
    if (/\/git\/ref\/heads\/dewnote-edits$/.test(path)) {
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    }
    if (/\/git\/trees\//.test(path)) {
      return json(route, { tree: [
        { path: "tutorials/a-rule/a-rule.md", type: "blob", sha: "document-sha" },
        { path: "modules/foundations.yaml", type: "blob", sha: "module-sha" },
      ] });
    }
    if (/\/contents\/modules\/foundations\.yaml$/.test(path)) {
      return json(route, { content: Buffer.from("title: Foundations\ncontents:\n- title: First steps\n  tutorials:\n  - a-rule\n").toString("base64"), sha: "module-sha" });
    }
    if (/\/contents\/tutorials\/a-rule\/a-rule\.md$/.test(path)) {
      return json(route, { content: Buffer.from("---\ntitle: A Rule\n---\n\n# A Rule\n").toString("base64"), sha: "document-sha" });
    }
    throw new Error(`Unexpected GitHub request: ${route.request().method()} ${path}`);
  });
}

test.beforeEach(async ({ page }) => {
  await stubDirectoryPicker(page);
  await page.goto(BUILT_APP);
});

test("starts with one source decision and no editing chrome", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "What are you working on?" })).toBeVisible();
  await expect(page.locator(".dn-source-choice")).toHaveCount(2);
  await expect(page.locator(".dn-workflow-header")).toBeHidden();
  await expect(page.locator(".dn-icon-rail")).toBeHidden();
  await expect(page.locator(".dn-file-action-rail")).toBeHidden();
});

test("a local choice asks for a real document before showing its breadcrumb", async ({ page }) => {
  await page.getByRole("button", { name: /Open a local folder/ }).click();
  await expect(page.locator(".dn-source-gate")).toBeHidden();
  await expect(page.locator(".dn-workflow-header")).toBeVisible();
  await expect(page.locator(".dn-workflow-identity strong")).toHaveText("Teaching notes");
  await expect(page.locator(".dn-workflow-file-name")).toHaveText("No document selected");
  await expect(page.locator(".dn-workflow-location")).toHaveText("Choose a document");
  await expect(page.locator(".dn-page")).toBeHidden();
  await expect(page.locator(".dn-workflow-save-area")).toBeHidden();
  await expect(page.locator(".dn-workspace-nav")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Foundations" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".dn-workspace-nav-series h2")).toHaveText("First steps");

  await page.locator(".dn-workspace-nav-document").click();
  await expect(page.locator(".dn-workspace-nav")).toBeHidden();
  await expect(page.locator(".dn-workflow-file-name")).toHaveText("tutorials/a-rule/a-rule.md");
  await expect(page.locator(".dn-workflow-location")).toContainText("Foundations › First steps › A Rule");
  await expect(page.locator(".dn-page h1")).toHaveText("A Rule");
  await expect(page.locator(".dn-workflow-save-area")).toBeVisible();
});

test("workspace and save choices are mutually exclusive and dismiss with Escape", async ({ page }) => {
  await page.getByRole("button", { name: /Open a local folder/ }).click();
  await page.locator(".dn-workspace-nav-document").click();
  await page.locator(".dn-workflow-menu-button").click();
  await expect(page.locator(".dn-workflow-menu")).toBeVisible();
  await expect(page.locator(".dn-workflow-menu")).toContainText("Import Jupyter notebook");
  await expect(page.locator(".dn-workflow-menu")).toContainText("Export standalone HTML");
  await expect(page.locator(".dn-workflow-menu-section h2")).toHaveText(["Open", "Transfer", "Document", "Workspace"]);

  await page.locator(".dn-workflow-save-more").click();
  await expect(page.locator(".dn-workflow-menu")).toBeHidden();
  await expect(page.locator(".dn-workflow-save-menu")).toBeVisible();
  await expect(page.locator(".dn-workflow-save-menu").getByText("Save as a new version…")).toBeHidden();

  await page.keyboard.press("Escape");
  await expect(page.locator(".dn-workflow-save-menu")).toBeHidden();

  await page.locator(".dn-workflow-menu-button").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator(".dn-settings-panel")).toBeVisible();
  await page.locator(".dn-workflow-menu-button").click();
  await expect(page.locator(".dn-settings-panel")).toBeHidden();
  await expect(page.locator(".dn-workflow-menu")).toBeVisible();
});

test("GitHub connection discovers modules, then yields to the document workflow", async ({ page }) => {
  await stubGithub(page);
  await page.getByRole("button", { name: /Connect a GitHub repository/ }).click();
  const repository = page.locator(".dn-repo-panel");
  await expect(repository).toBeVisible();
  await repository.locator('input[type="password"]').fill("test-token");
  const ownerRepo = repository.locator(".dn-repo-owner-row input");
  await ownerRepo.nth(0).fill("deweydex");
  await ownerRepo.nth(1).fill("dewlab");
  await repository.locator(".dn-repo-load").click();

  await expect(page.locator(".dn-source-gate")).toBeHidden();
  await expect(repository).toBeHidden();
  await expect(page.locator(".dn-workflow-identity strong")).toHaveText("deweydex/dewlab");
  await expect(page.locator(".dn-workflow-file-name")).toHaveText("No document selected");
  await expect(page.locator(".dn-workspace-nav")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Foundations" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".dn-workspace-nav-document")).toHaveCount(1);
  await page.locator(".dn-workspace-nav-document").click();
  await expect(page.locator(".dn-workflow-file-name")).toHaveText("tutorials/a-rule/a-rule.md");
  await expect(page.locator(".dn-workflow-location")).toContainText("Foundations › First steps › A Rule");

  await page.locator(".dn-workflow-menu-button").click();
  await expect(page.getByRole("button", { name: "Open a Markdown or YAML file…" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Import Jupyter notebook…" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Export standalone HTML" })).toBeVisible();
});

test("repository review reads the real branch comparison, including changes from before this session", async ({ page }) => {
  await stubGithub(page, [
    { filename: "courses/foundations.yaml", status: "modified", additions: 2, deletions: 1 },
    { filename: "tutorials/new/new.md", status: "added", additions: 18, deletions: 0 },
  ]);
  await page.getByRole("button", { name: /Connect a GitHub repository/ }).click();
  const repository = page.locator(".dn-repo-panel");
  await repository.locator('input[type="password"]').fill("test-token");
  const ownerRepo = repository.locator(".dn-repo-owner-row input");
  await ownerRepo.nth(0).fill("deweydex");
  await ownerRepo.nth(1).fill("dewlab");
  await repository.locator(".dn-repo-load").click();

  const changesButton = page.locator(".dn-workflow-changes");
  await expect(changesButton).toBeVisible();
  await changesButton.click();
  await expect(page.locator(".dn-change-review")).toBeVisible();
  await expect(page.locator(".dn-change-review-list li")).toHaveCount(2);
  await expect(page.locator(".dn-change-review-list li").nth(0)).toContainText("Modified module descriptor · +2 −1");
  await expect(page.locator(".dn-change-review-list li").nth(1)).toContainText("Added document or asset · +18 −0");
});

test("the document chooser searches across module, series, title, and path", async ({ page }) => {
  await page.getByRole("button", { name: /Open a local folder/ }).click();
  const chooser = page.locator(".dn-workspace-nav");
  await chooser.getByRole("searchbox", { name: "Search documents" }).fill("a-rule.md");
  await expect(chooser.locator(".dn-workspace-nav-document")).toHaveCount(1);
  await expect(chooser.locator(".dn-workspace-nav-document")).toContainText("A Rule");
  await chooser.getByRole("searchbox", { name: "Search documents" }).fill("nothing here");
  await expect(chooser.locator(".dn-workspace-nav-empty")).toBeVisible();
});

test("closing repository setup returns to the source choice", async ({ page }) => {
  await page.getByRole("button", { name: /Connect a GitHub repository/ }).click();
  await page.locator(".dn-repo-close").click();
  await expect(page.getByRole("heading", { name: "What are you working on?" })).toBeVisible();
  await expect(page.locator(".dn-source-choice")).toHaveCount(2);
});

test("changing workspace returns to source choice without reloading the app", async ({ page }) => {
  await page.getByRole("button", { name: /Open a local folder/ }).click();
  await expect(page.locator(".dn-workflow-header")).toBeVisible();

  await page.locator(".dn-workflow-menu-button").click();
  await page.getByRole("button", { name: "Change workspace…" }).click();

  await expect(page.getByRole("heading", { name: "What are you working on?" })).toBeVisible();
  await expect(page.locator(".dn-workflow-header")).toBeHidden();
  await expect(page.locator("body")).not.toHaveAttribute("data-workspace-session", /.+/);
  await expect(page.locator(".dn-page h1")).toHaveText("Untitled");

  await page.getByRole("button", { name: /Connect a GitHub repository/ }).click();
  await expect(page.locator(".dn-repo-panel")).toBeVisible();
});
