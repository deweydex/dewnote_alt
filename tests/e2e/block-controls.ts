// Reaching the one block-control cluster from a test.
//
// Every block used to carry its own "+" gap and its own toolbar, so a
// test addressed them positionally — `.dn-add-gap` nth(N) meant "the gap
// after block N-1". There is one cluster now and it moves to whichever
// block is being pointed at, so the address is the block itself.
//
// Exported from a plain module rather than repeated in seven spec files,
// which is how the old version drifted: each file had its own slightly
// different two or three lines for the same gesture.

import { expect, type Page } from "@playwright/test";

/** Points at `blockIndex`, which is what brings the controls to it. */
export async function pointAt(page: Page, blockIndex: number) {
  await page.locator(".dn-block").nth(blockIndex).hover();
  await expect(page.locator(".dn-block-controls")).toBeVisible();
}

/** Opens the add menu at `blockIndex` without choosing anything — for a
 * caller that has to set something up (a file chooser, a search overlay)
 * around its own click. */
export async function openAddMenu(page: Page, blockIndex: number) {
  await pointAt(page, blockIndex);
  await page.locator(".dn-add-btn").click();
  await expect(page.locator(".dn-add-menu.is-open")).toBeVisible();
}

/** One row of either block menu, by its label exactly.
 *
 * Exact, and against the label alone, because a row now carries a line
 * of explanation under its label and those lines mention each other:
 * Practice problem's says "a stepped hint", so a substring match on
 * "Hint" finds two rows and Playwright refuses the click. */
export function blockMenuItem(page: Page, scope: string, label: string) {
  return page.locator(`${scope} .dn-block-menu-item`).filter({ has: page.locator(`.dn-block-menu-label:text-is("${label}")`) });
}

/** Adds a block of `label` after `blockIndex`. */
export async function addBlockAfter(page: Page, blockIndex: number, label: string) {
  await openAddMenu(page, blockIndex);
  await blockMenuItem(page, ".dn-add-menu", label).click();
}

/** Arms `blockIndex` — clicking the grip, which is also what reveals the
 * delete button. */
export async function arm(page: Page, blockIndex: number) {
  await pointAt(page, blockIndex);
  await page.locator(".dn-block-grip").click();
  await expect(page.locator(".dn-block").nth(blockIndex)).toHaveClass(/is-armed/);
}

/** Deletes `blockIndex`. Two steps on purpose: delete is not in the
 * resting control set, so a block has to be armed before it can go. */
export async function deleteBlock(page: Page, blockIndex: number) {
  await arm(page, blockIndex);
  await page.locator(".dn-block-delete").click();
}
