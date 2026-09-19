import { expect, test } from "@playwright/test";
import { selectPanel } from "./panel-helpers.ts";

const BUILT_APP = new URL("../../dist/index.html?legacy=1", import.meta.url).href;

test.beforeEach(async ({ page }) => {
  await page.goto(BUILT_APP);
  await expect(page.locator(".dn-block").first()).toBeVisible();
});

test("grouped right-side bubbles open, switch, and close one drawer", async ({ page }) => {
  await expect(page.locator(".dn-outline-panel")).toBeHidden();
  await page.locator(".dn-settings-toggle").click();
  await expect(page.locator(".dn-settings-panel")).toBeVisible();
  await expect(page.locator(".dn-outline-panel")).toBeHidden();
  await expect(page.locator(".dn-settings-toggle")).toHaveAttribute("aria-selected", "true");

  await selectPanel(page, ".dn-outline-toggle");
  await expect(page.locator(".dn-settings-panel")).toBeHidden();
  await expect(page.locator(".dn-outline-panel")).toBeVisible();
  await expect(page.locator(".dn-review-toggle")).toHaveClass(/is-active/);

  await page.locator(".dn-review-toggle").click();
  await expect(page.locator(".dn-outline-panel")).toBeHidden();
  await expect(page.locator(".dn-outline-toggle")).toHaveAttribute("aria-selected", "false");
});

test("the rail presents four purposeful menus instead of every tool as a peer", async ({ page }) => {
  const launchers = page.locator(".dn-icon-rail > button");
  await expect(launchers).toHaveCount(4);
  expect(await launchers.evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).dataset.label))).toEqual([
    "Workspace", "Review", "Source", "Settings",
  ]);

  await page.locator(".dn-workspace-toggle").click();
  const workspace = page.locator("#dn-workspace-panel");
  await expect(workspace).toBeVisible();
  expect((await workspace.boundingBox())!.x).toBeGreaterThan(page.viewportSize()!.width / 2);
  await expect(page.locator("#dn-workspace-panel .dn-dock-group-option")).toHaveCount(2);
  expect(await page.locator("#dn-workspace-panel [data-label]").evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).dataset.label))).toEqual([
    "Folder", "GitHub",
  ]);

  await page.locator(".dn-workspace-toggle").click();
  await page.locator(".dn-review-toggle").click();
  const review = page.locator("#dn-review-panel");
  expect((await review.boundingBox())!.x).toBeGreaterThan(page.viewportSize()!.width / 2);
  await expect(review.locator(".dn-dock-group-option")).toHaveCount(2);
  expect(await page.locator("#dn-review-panel [data-label]").evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).dataset.label))).toEqual([
    "Outline", "Links",
  ]);
});

test("legacy GitHub and Source surfaces use the same right-side drawer position", async ({ page }) => {
  const cases = [
    [".dn-repo-toggle", ".dn-repo-panel"],
    [".dn-source-toggle", ".dn-source-overlay"],
    [".dn-series-toggle", ".dn-series-panel"],
    [".dn-settings-toggle", ".dn-settings-panel"],
  ] as const;

  for (const [toggle, panel] of cases) {
    await selectPanel(page, toggle);
    const drawer = page.locator(panel);
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThan(page.viewportSize()!.width / 2);
  }
});

test("the sidebar divider advertises horizontal resizing and responds to the keyboard", async ({ page }) => {
  const divider = page.locator(".dn-inspector-resizer");
  await expect(divider).toBeHidden();
  await selectPanel(page, ".dn-outline-toggle");
  await expect(divider).toBeVisible();
  await expect(divider).toHaveAttribute("role", "separator");
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect(divider).toHaveAttribute("title", "Drag to resize sidebar");
  const grip = divider.locator(".dn-inspector-resizer-grip");
  const restingOpacity = Number(await grip.evaluate((node) => getComputedStyle(node).opacity));
  expect(restingOpacity).toBeLessThan(0.5);
  await divider.hover();
  await expect.poll(async () => Number(await grip.evaluate((node) => getComputedStyle(node).opacity))).toBeGreaterThan(0.9);
  const before = await page.locator(".dn-outline-panel").evaluate((node) => node.getBoundingClientRect().width);
  await divider.focus();
  await page.keyboard.press("ArrowLeft");
  const after = await page.locator(".dn-outline-panel").evaluate((node) => node.getBoundingClientRect().width);
  expect(after).toBeGreaterThan(before);
  await expect(grip).toHaveText("•••");
  await page.locator(".dn-review-toggle").click();
  await expect(divider).toBeHidden();
});

test("Import and Export share one bottom-right Transfer selector", async ({ page }) => {
  const rail = page.locator(".dn-file-action-rail");
  await expect(rail).toBeVisible();
  await expect(rail.locator("button")).toHaveCount(1);
  await expect(rail.locator("button")).toHaveAttribute("data-label", "Transfer");
  await expect(page.locator(".dn-brand-name")).toHaveText("dewnote");
  await expect(page.locator(".dn-file-name")).toBeVisible();
  await expect(page.locator(".dn-file-name")).toHaveText("Untitled");

  await page.locator(".dn-file-transfer-toggle").click();
  const panel = page.locator(".dn-transfer-panel");
  await expect(panel).toBeVisible();
  expect((await panel.boundingBox())!.x).toBeGreaterThan(page.viewportSize()!.width / 2);
  await expect(panel.locator("h3")).toHaveText(["Import", "Export"]);
  await expect(panel.locator("button")).toContainText([
    "×",
    "Markdown file…",
    "Jupyter notebook…",
    "Markdown file",
    "Standalone HTML",
    "Jupyter notebook",
  ]);
});
