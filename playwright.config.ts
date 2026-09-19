import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

// The browser surface — decision 9's "Playwright drives the built app for
// anything with a cursor in it," because dewlab's own Milkdown traps were
// invisible from the API and found only by actually clicking. This runs
// against the real single-file build (`bun run build`), opened straight
// off disk with file://, which is also the mode the build is meant to
// support — not a dev server standing in for it.

// One development sandbox ships a pre-baked Chromium at this fixed path,
// which is worth pinning to directly there since it can miss Playwright's
// own revision lookup for a pre-baked browser that doesn't exactly match
// this package version. Everywhere else — a contributor's own machine, a
// CI runner — has no such path, and should fall back to whatever
// `playwright install` put where Playwright itself expects it.
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const executablePath = existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
