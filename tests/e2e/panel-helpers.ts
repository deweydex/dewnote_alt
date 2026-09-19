import type { Page } from "@playwright/test";

const WORKSPACE = new Set([".dn-folder-toggle", ".dn-repo-toggle"]);
const REVIEW = new Set([".dn-outline-toggle", ".dn-linkcheck-toggle"]);

/** Choose one of the tools now housed behind a grouped rail launcher. */
export async function selectPanel(page: Page, selector: string): Promise<void> {
  const child = page.locator(selector);
  // The module organiser is now reached from the repository's Modules
  // screen rather than advertised as a third kind of workspace. Older
  // focused tests still use its internal trigger directly.
  if (selector === ".dn-series-toggle") {
    await child.evaluate((button: HTMLButtonElement) => button.click());
    return;
  }
  if (await child.isVisible()) {
    await child.click();
    return;
  }
  const groupSelector = WORKSPACE.has(selector)
    ? ".dn-workspace-toggle"
    : REVIEW.has(selector)
      ? ".dn-review-toggle"
      : null;
  if (!groupSelector) {
    await child.click();
    return;
  }
  const group = page.locator(groupSelector);
  // When a tool in this group is already open, the first click closes
  // it; the second opens the group's selector screen.
  if (await group.getAttribute("aria-expanded") === "true") await group.click();
  await group.click();
  await child.click();
}
