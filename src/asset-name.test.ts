import { describe, expect, test } from "bun:test";
import { assetNameFor, folderOf, isAssetFile, siblingPath } from "./asset-name.ts";

describe("assetNameFor", () => {
  test("an already-safe name is left alone but for its case", () => {
    expect(assetNameFor("diagram.png")).toBe("diagram.png");
    expect(assetNameFor("Diagram.PNG")).toBe("diagram.png");
  });

  test("spaces and parens are reshaped, because markdown would misread them", () => {
    // `![alt](My Photo (1).png)` ends its link at the first `)`.
    expect(assetNameFor("My Photo (1).png")).toBe("my-photo-1.png");
    expect(assetNameFor("screen shot 2026-09-14 at 10.32.png")).toBe("screen-shot-2026-09-14-at-10-32.png");
  });

  test("accents fold to ASCII rather than being dropped", () => {
    expect(assetNameFor("café.jpg")).toBe("cafe.jpg");
  });

  test("a name with nothing usable in it still gets a name", () => {
    expect(assetNameFor("___.png")).toBe("image.png");
    expect(assetNameFor("你好.png")).toBe("image.png");
  });

  test("a taken name gets a counter rather than overwriting somebody's picture", () => {
    // dewlab's tutorial_assets() reads the folder, so a name already
    // there belongs to a picture already on a page.
    expect(assetNameFor("diagram.png", ["diagram.png"])).toBe("diagram-2.png");
    expect(assetNameFor("diagram.png", ["diagram.png", "diagram-2.png"])).toBe("diagram-3.png");
  });

  test("taken names are compared without case, since a folder may not tell them apart", () => {
    expect(assetNameFor("Diagram.png", ["diagram.PNG"])).toBe("diagram-2.png");
  });

  test("a file with no extension keeps none, and a dotfile loses its leading dot", () => {
    expect(assetNameFor("LICENSE")).toBe("license");
    // The dot is part of the stem (so the name doesn't come back empty),
    // and slugify then trims the hyphen it became — a file called
    // `-gitignore` would be a worse name than `gitignore`, not a better
    // one, and nothing about an asset needs to stay hidden.
    expect(assetNameFor(".gitignore")).toBe("gitignore");
  });

  test("a double extension survives", () => {
    expect(assetNameFor("data.tar.gz")).toBe("data-tar.gz");
  });
});

describe("isAssetFile", () => {
  test("the three suffixes neither build copies", () => {
    expect(isAssetFile("notes.md")).toBe(false);
    expect(isAssetFile("a-module.yaml")).toBe(false);
    expect(isAssetFile("thing.yml")).toBe(false);
  });

  test("everything else is an asset, whatever the medium", () => {
    // dewlab's SRC_RE covers img, audio, video and source alike.
    expect(isAssetFile("diagram.png")).toBe(true);
    expect(isAssetFile("clip.mp4")).toBe(true);
    expect(isAssetFile("resume-template.html")).toBe(true);
  });
});

describe("folderOf / siblingPath", () => {
  test("a document in a tutorial folder puts its image in that folder", () => {
    expect(folderOf("tutorials/first-steps/first-steps.md")).toBe("tutorials/first-steps");
    expect(siblingPath("tutorials/first-steps/first-steps.md", "diagram.png")).toBe("tutorials/first-steps/diagram.png");
  });

  test("a practice page and a frozen release share the tutorial's own folder", () => {
    // build.py's id_of(): all three live in tutorials/<id>/, so all
    // three resolve a bare file name against the same assets.
    expect(siblingPath("tutorials/first-steps/first-steps-practice.md", "d.png")).toBe("tutorials/first-steps/d.png");
    expect(siblingPath("tutorials/first-steps/v2026.08.23.1.md", "d.png")).toBe("tutorials/first-steps/d.png");
  });

  test("a file at the root has no folder, and its sibling is a bare name", () => {
    expect(folderOf("README.md")).toBe("");
    expect(siblingPath("README.md", "diagram.png")).toBe("diagram.png");
  });
});
