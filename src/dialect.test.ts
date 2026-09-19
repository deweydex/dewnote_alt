// `detectDialect` itself is covered against every real fixture in
// roundtrip.test.ts ("dialect detection"), which is the test worth
// having for it — a rule about front matter, checked against front
// matter people actually wrote. This file is for the other half of the
// same inventory: what a dewlab `version:` looks like.

import { describe, expect, test } from "bun:test";
import { todayVersion } from "./dialect.ts";

describe("todayVersion", () => {
  test("dewlab's own dated form, zero-padded, with a .1 release counter", () => {
    expect(todayVersion(new Date(2026, 8, 4))).toBe("2026.09.04.1");
    expect(todayVersion(new Date(2026, 11, 31))).toBe("2026.12.31.1");
  });

  test("matches the shape build.py reads a frozen release's file name as", () => {
    // file-index.ts's own VERSION_FILE_RE, minus the leading `v` a file
    // name carries — the two have to agree or a released tutorial's
    // file stops being recognised as one version of its folder's id.
    expect(todayVersion(new Date(2026, 0, 1))).toMatch(/^\d{4}\.\d{2}\.\d{2}\.\d+$/);
  });
});
